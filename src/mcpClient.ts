import * as vscode from 'vscode';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { Logger } from './logger';
import type { McpServerConfig, McpTool, McpToolCallResult } from './types';

/**
 * Minimal MCP (Model Context Protocol) client.
 *
 * Spawns MCP servers as child processes communicating via JSON-RPC over stdio.
 * Supports:
 *   - List tools from a server
 *   - Call a tool on a server
 *
 * Note: This is a simplified implementation that handles the common case
 * (stdio transport, tools capability). Full MCP spec compliance is out of scope
 * for v0.3.0 — but the API surface is forward-compatible.
 */

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface McpServerProcess {
  config: McpServerConfig;
  process: ChildProcessWithoutNullStreams;
  nextId: number;
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  initialized: boolean;
  tools: McpTool[];
  buffer: string;
}

export class McpClient {
  private servers = new Map<string, McpServerProcess>();
  private onDidToolsChanged = new vscode.EventEmitter<void>();
  readonly onDidToolsChangedEvent = this.onDidToolsChanged.event;

  /**
   * Get configured MCP servers from settings.
   */
  static getConfiguredServers(): McpServerConfig[] {
    return vscode.workspace
      .getConfiguration('anythingllm')
      .get<McpServerConfig[]>('mcpServers', []);
  }

  /**
   * Start a single MCP server.
   */
  async startServer(config: McpServerConfig): Promise<void> {
    if (this.servers.has(config.id)) {
      await this.stopServer(config.id);
    }
    if (!config.enabled) return;

    try {
      const child = spawn(config.command, config.args ?? [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...config.env },
      });

      const server: McpServerProcess = {
        config,
        process: child,
        nextId: 1,
        pending: new Map(),
        initialized: false,
        tools: [],
        buffer: '',
      };

      child.stdout.on('data', (chunk: Buffer) => this.handleStdout(server, chunk));
      child.stderr.on('data', (chunk: Buffer) => {
        Logger.warn(`MCP server "${config.name}" stderr: ${chunk.toString('utf-8').trim()}`);
      });
      child.on('exit', (code) => {
        Logger.info(`MCP server "${config.name}" exited with code ${code}`);
        this.servers.delete(config.id);
        this.onDidToolsChanged.fire();
      });
      child.on('error', (err) => {
        Logger.error(`MCP server "${config.name}" failed to start`, err);
        this.servers.delete(config.id);
      });

      this.servers.set(config.id, server);

      // Send initialize handshake
      await this.sendRequest(server, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'anythingllm-vscode', version: '0.3.0' },
      });
      // Send initialized notification
      this.sendNotification(server, 'notifications/initialized', {});
      server.initialized = true;

      // List tools
      await this.refreshTools(config.id);
      Logger.info(`MCP server "${config.name}" started (${server.tools.length} tools)`);
    } catch (err) {
      Logger.error(`Failed to start MCP server "${config.name}"`, err);
      throw err;
    }
  }

  async stopServer(id: string): Promise<void> {
    const server = this.servers.get(id);
    if (!server) return;
    try {
      this.sendNotification(server, 'shutdown', {});
      setTimeout(() => server.process.kill('SIGTERM'), 100);
    } catch {
      // best effort
    }
    this.servers.delete(id);
    this.onDidToolsChanged.fire();
  }

  async stopAll(): Promise<void> {
    const ids = Array.from(this.servers.keys());
    await Promise.all(ids.map((id) => this.stopServer(id)));
  }

  /**
   * Start all configured MCP servers.
   */
  async startAll(): Promise<void> {
    const configs = McpClient.getConfiguredServers();
    for (const c of configs) {
      if (c.enabled) {
        try {
          await this.startServer(c);
        } catch (err) {
          Logger.warn(`Skipping MCP server ${c.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  /**
   * Get all tools from all running servers.
   */
  getAllTools(): McpTool[] {
    const tools: McpTool[] = [];
    for (const server of this.servers.values()) {
      for (const t of server.tools) {
        tools.push({
          serverId: server.config.id,
          serverName: server.config.name,
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        });
      }
    }
    return tools;
  }

  /**
   * Call a tool on a server.
   */
  async callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<string> {
    const server = this.servers.get(serverId);
    if (!server) throw new Error(`MCP server "${serverId}" not running`);

    const result = await this.sendRequest(server, 'tools/call', {
      name: toolName,
      arguments: args,
    }) as McpToolCallResult | undefined;

    if (!result) return '(no result)';
    if (result.isError) {
      throw new Error(result.content.map((c) => c.text ?? '').join('\n'));
    }
    return result.content.map((c) => c.text ?? '').join('\n');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private implementation
  // ─────────────────────────────────────────────────────────────────────────────

  private async refreshTools(serverId: string): Promise<void> {
    const server = this.servers.get(serverId);
    if (!server) return;
    const result = await this.sendRequest(server, 'tools/list', {}) as { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> } | undefined;
    server.tools = (result?.tools ?? []).map((t) => ({
      serverId,
      serverName: server.config.name,
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
    }));
    this.onDidToolsChanged.fire();
  }

  private handleStdout(server: McpServerProcess, chunk: Buffer): void {
    server.buffer += chunk.toString('utf-8');
    // Split on newlines — each line is one JSON-RPC message
    let idx: number;
    while ((idx = server.buffer.indexOf('\n')) >= 0) {
      const line = server.buffer.slice(0, idx).trim();
      server.buffer = server.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcResponse;
        const pending = server.pending.get(msg.id);
        if (pending) {
          server.pending.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(`${msg.error.message} (code ${msg.error.code})`));
          } else {
            pending.resolve(msg.result);
          }
        }
      } catch (err) {
        Logger.warn(`MCP server "${server.config.name}" invalid JSON: ${line.slice(0, 200)}`, err);
      }
    }
  }

  private sendRequest(server: McpServerProcess, method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = server.nextId++;
      const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
      server.pending.set(id, { resolve, reject });
      try {
        server.process.stdin.write(JSON.stringify(req) + '\n');
      } catch (err) {
        server.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
      // Timeout 30s
      setTimeout(() => {
        if (server.pending.has(id)) {
          server.pending.delete(id);
          reject(new Error(`MCP request timeout: ${method}`));
        }
      }, 30_000);
    });
  }

  private sendNotification(server: McpServerProcess, method: string, params: Record<string, unknown>): void {
    try {
      const notif = { jsonrpc: '2.0', method, params };
      server.process.stdin.write(JSON.stringify(notif) + '\n');
    } catch (err) {
      Logger.warn(`MCP notification failed: ${method}`, err);
    }
  }
}
