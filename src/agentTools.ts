import * as vscode from 'vscode';
import { AnythingLLMClient } from './anythingllmClient';
import { isAnythingLLMError } from './agent';
import { Logger } from './logger';
import { requestPermission } from './agentPermissions';
import type { VectorSearchResult, NativeToolDefinition } from './types';

/**
 * Agent tool definitions + executors (v0.3.0).
 *
 * Setiap tool:
 *   - Punya schema JSON (OpenAI-style)
 *   - Punya executor async (args, ctx) => string
 *   - Deklarasikan apakah butuh permission
 *   - Bisa emit progress callback
 */

export type ToolProgressFn = (message: string) => void;

export interface ToolContext {
  workspaceSlug: string;
  client: AnythingLLMClient;
  signal?: AbortSignal;
  /** MCP call function (provided by MCP client) */
  mcpCall?: (serverId: string, toolName: string, args: Record<string, unknown>) => Promise<string>;
}

export interface ToolResult {
  ok: boolean;
  output: string;
  /** Optional structured data to accumulate as context */
  structured?: unknown;
  /** Sources to surface as citations */
  sources?: Array<{ title?: string; source: string; text?: string }>;
}

export interface AgentTool {
  name: string;
  description: string;
  /** OpenAI function calling schema */
  parameters: Record<string, unknown>;
  /** Whether this tool requires explicit user permission */
  requiresPermission?: boolean;
  /** Risk level for the permission dialog UI */
  risk?: 'low' | 'medium' | 'high';
  /** Executor */
  execute: (args: Record<string, unknown>, ctx: ToolContext, progress?: ToolProgressFn) => Promise<ToolResult>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper utilities
// ─────────────────────────────────────────────────────────────────────────────

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n... [truncated, ${s.length - max} more chars]`;
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function asNumber(v: unknown, fallback = 0): number {
  return typeof v === 'number' && !isNaN(v) ? v : fallback;
}

async function readFileContent(uri: vscode.Uri, maxBytes = 100_000): Promise<string> {
  const stat = await vscode.workspace.fs.stat(uri);
  const bytes = Math.min(stat.size, maxBytes);
  const buf = await vscode.workspace.fs.readFile(uri);
  return Buffer.from(buf.slice(0, bytes)).toString('utf-8');
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: file_read
// ─────────────────────────────────────────────────────────────────────────────

const fileReadTool: AgentTool = {
  name: 'file_read',
  description: 'Read the contents of a file in the VS Code workspace. Returns UTF-8 text (truncated to 100KB).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative or absolute path to the file' },
      maxBytes: { type: 'number', description: 'Max bytes to read (default 100000)', default: 100000 },
    },
    required: ['path'],
  },
  risk: 'low',
  async execute(args, _ctx, progress) {
    const rawPath = asString(args.path);
    if (!rawPath) return { ok: false, output: 'Path is required.' };
    progress?.(`Reading ${rawPath}...`);

    try {
      let uri: vscode.Uri;
      if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, rawPath);
      } else {
        uri = vscode.Uri.file(rawPath);
      }

      const content = await readFileContent(uri, asNumber(args.maxBytes, 100_000));
      return {
        ok: true,
        output: `--- ${rawPath} (${content.length} chars) ---\n${truncate(content, 50_000)}`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, output: `Failed to read ${rawPath}: ${msg}` };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Tool: file_write
// ─────────────────────────────────────────────────────────────────────────────

const fileWriteTool: AgentTool = {
  name: 'file_write',
  description: 'Write or overwrite a file in the VS Code workspace. Requires user permission.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path (within workspace) or absolute path' },
      content: { type: 'string', description: 'Full file content (UTF-8)' },
      createIfMissing: { type: 'boolean', default: true },
    },
    required: ['path', 'content'],
  },
  requiresPermission: true,
  risk: 'high',
  async execute(args, _ctx, progress) {
    const rawPath = asString(args.path);
    const content = asString(args.content);
    if (!rawPath) return { ok: false, output: 'Path is required.' };
    if (!content) return { ok: false, output: 'Content is required.' };

    progress?.(`Preparing to write ${rawPath}...`);

    // Get diff preview for permission dialog
    let existingContent = '';
    try {
      let uri: vscode.Uri;
      if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, rawPath);
      } else {
        uri = vscode.Uri.file(rawPath);
      }
      existingContent = await readFileContent(uri, 500_000);
    } catch {
      // File doesn't exist yet — that's OK
    }

    const diffPreview = existingContent
      ? generateDiffPreview(existingContent, content)
      : `(new file, ${content.length} chars)`;

    const decision = await requestPermission({
      tool: 'file_write',
      summary: `Write ${content.length} chars to ${rawPath}`,
      detail: existingContent ? 'Existing file will be overwritten' : 'New file will be created',
      risk: 'high',
      diffPreview,
    });

    if (decision.decision === 'deny') {
      return { ok: false, output: `Permission denied for file_write: ${rawPath}` };
    }

    progress?.(`Writing ${rawPath}...`);
    try {
      let uri: vscode.Uri;
      if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, rawPath);
      } else {
        uri = vscode.Uri.file(rawPath);
      }

      const buf = Buffer.from(content, 'utf-8');
      await vscode.workspace.fs.writeFile(uri, new Uint8Array(buf));

      // Open the file in editor
      await vscode.window.showTextDocument(uri, { preview: false });

      return {
        ok: true,
        output: `Successfully wrote ${content.length} chars to ${rawPath}`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, output: `Failed to write ${rawPath}: ${msg}` };
    }
  },
};

function generateDiffPreview(oldText: string, newText: string): string {
  // Simple line-based diff — not full Myers algorithm, just for preview
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const maxLines = Math.min(Math.max(oldLines.length, newLines.length), 30);

  const lines: string[] = [];
  for (let i = 0; i < maxLines; i++) {
    const o = oldLines[i];
    const n = newLines[i];
    if (o === n) continue;
    if (o !== undefined && n === undefined) lines.push(`- ${o}`);
    else if (o === undefined && n !== undefined) lines.push(`+ ${n}`);
    else lines.push(`- ${o}\n+ ${n}`);
  }
  return lines.join('\n') || '(no changes)';
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: grep_search
// ─────────────────────────────────────────────────────────────────────────────

const grepSearchTool: AgentTool = {
  name: 'grep_search',
  description: 'Search file contents in the VS Code workspace using ripgrep regex.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern (ripgrep syntax)' },
      glob: { type: 'string', description: 'Glob pattern to filter files, e.g. "*.ts"', default: '**/*' },
      maxResults: { type: 'number', default: 50 },
      caseSensitive: { type: 'boolean', default: false },
    },
    required: ['pattern'],
  },
  risk: 'low',
  async execute(args, _ctx, progress) {
    const pattern = asString(args.pattern);
    if (!pattern) return { ok: false, output: 'Pattern is required.' };

    progress?.(`Searching for /${pattern}/...`);

    try {
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!cwd) return { ok: false, output: 'No workspace folder open.' };

      // Use VS Code's built-in findFiles2 API (since 1.85) or fallback to ripgrep via child_process
      const include = asString(args.glob, '**/*');
      const maxResults = asNumber(args.maxResults, 50);

      // Use vscode.commands.executeCommand('workbench.action.findInFiles', ...) — too interactive
      // Better: spawn ripgrep directly
      const { execFile } = await import('child_process');
      const rgArgs = [
        '--json',
        '--max-count', String(maxResults),
        '-i',
      ];
      if (args.caseSensitive) rgArgs.push('-S'); // smart case
      else rgArgs.push('-i');
      rgArgs.push('-g', include, pattern, cwd);

      const result = await new Promise<string>((resolve, reject) => {
        execFile('rg', rgArgs, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
          if (err && err.code === 1) {
            // exit code 1 = no matches
            resolve('[]');
            return;
          }
          if (err) {
            reject(err);
            return;
          }
          resolve(stdout);
        });
      });

      const matches: Array<{ file: string; line: number; text: string }> = [];
      for (const line of result.split('\n')) {
        if (!line.startsWith('{')) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'match' && obj.data) {
            matches.push({
              file: obj.data.path?.text ?? '',
              line: obj.data.line_number ?? 0,
              text: (obj.data.lines?.text ?? '').trim().slice(0, 300),
            });
          }
        } catch {
          // skip
        }
      }

      if (matches.length === 0) {
        return { ok: true, output: `No matches found for /${pattern}/` };
      }

      const out = matches
        .slice(0, maxResults)
        .map((m, i) => `${i + 1}. ${m.file}:${m.line}\n    ${m.text}`)
        .join('\n');

      return {
        ok: true,
        output: `Found ${matches.length} matches for /${pattern}/:\n${out}`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, output: `Search failed: ${msg}` };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Tool: find_references
// ─────────────────────────────────────────────────────────────────────────────

const findReferencesTool: AgentTool = {
  name: 'find_references',
  description: 'Use VS Code\'s reference provider to find all references to a symbol at a location.',
  parameters: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Path to the file containing the symbol' },
      line: { type: 'number', description: '0-indexed line number' },
      character: { type: 'number', description: '0-indexed column' },
    },
    required: ['file', 'line', 'character'],
  },
  risk: 'low',
  async execute(args, _ctx, progress) {
    const file = asString(args.file);
    const line = asNumber(args.line, -1);
    const character = asNumber(args.character, -1);
    if (!file || line < 0 || character < 0) {
      return { ok: false, output: 'file, line, character are all required.' };
    }

    progress?.(`Finding references at ${file}:${line}:${character}...`);
    try {
      let uri: vscode.Uri;
      if (vscode.workspace.workspaceFolders?.[0]) {
        uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, file);
      } else {
        uri = vscode.Uri.file(file);
      }

      const pos = new vscode.Position(line, character);
      const refs = await vscode.commands.executeCommand<vscode.Location[]>(
        'vscode.executeReferenceProvider',
        uri,
        pos
      );

      if (!refs || refs.length === 0) {
        return { ok: true, output: 'No references found.' };
      }

      const lines = refs.slice(0, 50).map((r, i) => {
        const f = vscode.workspace.asRelativePath(r.uri);
        return `${i + 1}. ${f}:${r.range.start.line + 1}:${r.range.start.character + 1}`;
      });
      return {
        ok: true,
        output: `Found ${refs.length} references:\n${lines.join('\n')}`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, output: `find_references failed: ${msg}` };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Tool: terminal_exec
// ─────────────────────────────────────────────────────────────────────────────

const terminalExecTool: AgentTool = {
  name: 'terminal_exec',
  description: 'Execute a shell command in the integrated terminal. HIGH RISK — requires explicit permission each time.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      cwd: { type: 'string', description: 'Working directory (default: workspace root)' },
      timeoutMs: { type: 'number', default: 30000, description: 'Max execution time' },
    },
    required: ['command'],
  },
  requiresPermission: true,
  risk: 'high',
  async execute(args, _ctx, progress) {
    const command = asString(args.command);
    if (!command) return { ok: false, output: 'Command is required.' };

    const timeoutMs = asNumber(args.timeoutMs, 30000);
    const cwd = asString(args.cwd) || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    progress?.(`Requesting permission for: ${command.slice(0, 80)}...`);

    const decision = await requestPermission({
      tool: 'terminal_exec',
      summary: `Run: ${command.slice(0, 100)}`,
      detail: `Working dir: ${cwd ?? '(none)'}\nTimeout: ${timeoutMs}ms`,
      risk: 'high',
      diffPreview: command,
    });

    if (decision.decision === 'deny') {
      return { ok: false, output: 'Permission denied for terminal_exec.' };
    }

    progress?.(`Executing: ${command}...`);

    try {
      const { exec } = await import('child_process');
      const result = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
        const child = exec(command, {
          cwd,
          maxBuffer: 5 * 1024 * 1024,
          timeout: timeoutMs,
        }, (err, stdout, stderr) => {
          resolve({
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            code: err ? (err as { code?: number }).code ?? 1 : 0,
          });
        });
        _ctx.signal?.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
      });

      let out = '';
      if (result.stdout) out += `STDOUT:\n${truncate(result.stdout, 20_000)}\n`;
      if (result.stderr) out += `STDERR:\n${truncate(result.stderr, 10_000)}\n`;
      out += `Exit code: ${result.code}`;

      return {
        ok: result.code === 0,
        output: out,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, output: `terminal_exec failed: ${msg}` };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Tool: web_fetch
// ─────────────────────────────────────────────────────────────────────────────

const webFetchTool: AgentTool = {
  name: 'web_fetch',
  description: 'Fetch a URL and return its text content (HTML stripped, max 50KB).',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'HTTP(S) URL to fetch' },
      maxBytes: { type: 'number', default: 50000 },
    },
    required: ['url'],
  },
  risk: 'low',
  async execute(args, _ctx, progress) {
    const url = asString(args.url);
    if (!url) return { ok: false, output: 'URL is required.' };

    progress?.(`Fetching ${url}...`);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      _ctx.signal?.addEventListener('abort', () => controller.abort(), { once: true });

      const res = await fetch(url, {
        headers: { 'User-Agent': 'AnythingLLM-VSCode-Agent/0.3' },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        return { ok: false, output: `HTTP ${res.status} ${res.statusText}` };
      }

      const text = await res.text();
      const maxBytes = asNumber(args.maxBytes, 50_000);

      // Strip HTML tags if response is HTML
      const contentType = res.headers.get('content-type') ?? '';
      let processed = text;
      if (contentType.includes('text/html')) {
        processed = stripHtml(text);
      }

      return {
        ok: true,
        output: `--- ${url} (${contentType || 'unknown'}) ---\n${truncate(processed, maxBytes)}`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, output: `web_fetch failed: ${msg}` };
    }
  },
};

function stripHtml(html: string): string {
  return html
    // Remove scripts and styles
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    // Remove tags
    .replace(/<[^>]+>/g, ' ')
    // Decode entities
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: run_diagnostics
// ─────────────────────────────────────────────────────────────────────────────

const runDiagnosticsTool: AgentTool = {
  name: 'run_diagnostics',
  description: 'Get VS Code diagnostics (errors/warnings) for a file or the whole workspace.',
  parameters: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Optional file path. If omitted, returns all workspace diagnostics.' },
      severity: { type: 'string', enum: ['error', 'warning', 'info', 'hint', 'all'], default: 'all' },
    },
  },
  risk: 'low',
  async execute(args, _ctx, _progress) {
    const file = asString(args.file);
    const severity = asString(args.severity, 'all');

    let targetUri: vscode.Uri | undefined;
    if (file) {
      targetUri = vscode.workspace.workspaceFolders?.[0]
        ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, file)
        : vscode.Uri.file(file);
    }

    // VS Code API:
    //   getDiagnostics() → [Uri, Diagnostic[]][]  (all workspace diagnostics)
    //   getDiagnostics(resource: Uri) → Diagnostic[]  (single file)
    const allDiag: Array<[vscode.Uri, vscode.Diagnostic[]]> = targetUri
      ? [[targetUri, vscode.languages.getDiagnostics(targetUri)]]
      : vscode.languages.getDiagnostics();

    const lines: string[] = [];
    let totalShown = 0;
    for (const [uri, diags] of allDiag) {
      if (diags.length === 0) continue;
      const relPath = vscode.workspace.asRelativePath(uri);
      for (const d of diags) {
        if (severity !== 'all' && vscode.DiagnosticSeverity[d.severity].toLowerCase() !== severity) continue;
        lines.push(`${relPath}:${d.range.start.line + 1}:${d.range.start.character + 1} [${vscode.DiagnosticSeverity[d.severity]}] ${d.message}`);
        totalShown++;
        if (totalShown >= 100) {
          lines.push('... (truncated at 100 diagnostics)');
          break;
        }
      }
      if (totalShown >= 100) break;
    }

    if (lines.length === 0) {
      return { ok: true, output: 'No diagnostics found.' };
    }

    return {
      ok: true,
      output: `Found ${totalShown} diagnostics:\n${lines.join('\n')}`,
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Tool: git_status / git_diff
// ─────────────────────────────────────────────────────────────────────────────

async function runGit(args: string[], cwd?: string): Promise<{ ok: boolean; out: string; err: string; code: number }> {
  const { execFile } = await import('child_process');
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (err as { code?: number }).code ?? 1 : 0;
      resolve({ ok: code === 0, out: stdout ?? '', err: stderr ?? '', code });
    });
  });
}

const gitStatusTool: AgentTool = {
  name: 'git_status',
  description: 'Run `git status --porcelain` in the workspace root. Returns modified/untracked files.',
  parameters: { type: 'object', properties: {} },
  risk: 'low',
  async execute(_args, _ctx, _progress) {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) return { ok: false, output: 'No workspace folder open.' };
    const r = await runGit(['status', '--porcelain'], cwd);
    if (!r.ok) return { ok: false, output: `git status failed: ${r.err}` };
    const out = r.out.trim() || '(clean working tree)';
    return { ok: true, output: `git status:\n${out}` };
  },
};

const gitDiffTool: AgentTool = {
  name: 'git_diff',
  description: 'Run `git diff` to show uncommitted changes. Can be staged or unstaged.',
  parameters: {
    type: 'object',
    properties: {
      staged: { type: 'boolean', default: false, description: 'If true, run --staged' },
      file: { type: 'string', description: 'Optional file path to diff' },
    },
  },
  risk: 'low',
  async execute(args, _ctx, _progress) {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) return { ok: false, output: 'No workspace folder open.' };
    const argList = ['diff'];
    if (args.staged) argList.push('--staged');
    if (args.file) argList.push('--', asString(args.file));
    const r = await runGit(argList, cwd);
    if (!r.ok) return { ok: false, output: `git diff failed: ${r.err}` };
    const out = r.out.trim() || '(no changes)';
    return { ok: true, output: `git diff:\n${truncate(out, 50_000)}` };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Tool: open_file
// ─────────────────────────────────────────────────────────────────────────────

const openFileTool: AgentTool = {
  name: 'open_file',
  description: 'Open a file in the VS Code editor (read-only is just opening; doesn\'t modify).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      line: { type: 'number', description: 'Line to reveal (1-indexed)' },
      column: { type: 'number', description: 'Column to reveal (1-indexed)' },
    },
    required: ['path'],
  },
  risk: 'low',
  async execute(args, _ctx, progress) {
    const path = asString(args.path);
    if (!path) return { ok: false, output: 'Path is required.' };
    progress?.(`Opening ${path}...`);
    try {
      const uri = vscode.workspace.workspaceFolders?.[0]
        ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, path)
        : vscode.Uri.file(path);
      const line = asNumber(args.line, 1) - 1;
      const col = asNumber(args.column, 1) - 1;
      await vscode.window.showTextDocument(uri, {
        selection: new vscode.Range(line, col, line, col),
        preview: false,
      });
      return { ok: true, output: `Opened ${path} at line ${line + 1}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, output: `Failed to open ${path}: ${msg}` };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Tool: list_directory
// ─────────────────────────────────────────────────────────────────────────────

const listDirectoryTool: AgentTool = {
  name: 'list_directory',
  description: 'List files and directories in the given path. Returns names + sizes + types.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', default: '.', description: 'Relative path within workspace' },
      recursive: { type: 'boolean', default: false },
      maxEntries: { type: 'number', default: 200 },
    },
  },
  risk: 'low',
  async execute(args, _ctx, progress) {
    const relPath = asString(args.path, '.');
    const recursive = Boolean(args.recursive);
    const maxEntries = asNumber(args.maxEntries, 200);
    progress?.(`Listing ${relPath}...`);

    try {
      const rootUri = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!rootUri) return { ok: false, output: 'No workspace folder open.' };

      const targetUri = vscode.Uri.joinPath(rootUri, relPath);
      const entries = await vscode.workspace.fs.readDirectory(targetUri);

      const lines: string[] = [];
      let count = 0;
      for (const [name, type] of entries.sort((a, b) => a[0].localeCompare(b[0]))) {
        if (count >= maxEntries) {
          lines.push(`... (truncated at ${maxEntries} entries)`);
          break;
        }
        const isDir = type === vscode.FileType.Directory;
        lines.push(`${isDir ? '📁' : '📄'} ${name}${isDir ? '/' : ''}`);
        count++;

        if (recursive && isDir) {
          try {
            const sub = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(targetUri, name));
            for (const [sname, stype] of sub.sort((a, b) => a[0].localeCompare(b[0]))) {
              if (count >= maxEntries) break;
              const sIsDir = stype === vscode.FileType.Directory;
              lines.push(`  ${sIsDir ? '📁' : '📄'} ${sname}${sIsDir ? '/' : ''}`);
              count++;
            }
          } catch {
            // skip
          }
        }
      }

      return {
        ok: true,
        output: `Contents of ${relPath} (${count} entries):\n${lines.join('\n')}`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, output: `list_directory failed: ${msg}` };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Tool: mcp_call
// ─────────────────────────────────────────────────────────────────────────────

const mcpCallTool: AgentTool = {
  name: 'mcp_call',
  description: 'Call a tool exposed by an MCP (Model Context Protocol) server.',
  parameters: {
    type: 'object',
    properties: {
      serverId: { type: 'string', description: 'MCP server identifier' },
      toolName: { type: 'string', description: 'Tool name exposed by the server' },
      args: { type: 'object', description: 'Arguments object for the tool', additionalProperties: true },
    },
    required: ['serverId', 'toolName', 'args'],
  },
  risk: 'medium',
  requiresPermission: true,
  async execute(args, ctx, progress) {
    if (!ctx.mcpCall) {
      return { ok: false, output: 'MCP is not enabled or no MCP client is configured.' };
    }
    const serverId = asString(args.serverId);
    const toolName = asString(args.toolName);
    const toolArgs = (args.args as Record<string, unknown>) ?? {};

    progress?.(`Calling MCP tool ${serverId}/${toolName}...`);
    try {
      const result = await ctx.mcpCall(serverId, toolName, toolArgs);
      return { ok: true, output: truncate(result, 30_000) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, output: `MCP call failed: ${msg}` };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Tool: vector_search (AnythingLLM-specific, uses AnythingLLMClient)
// ─────────────────────────────────────────────────────────────────────────────

const vectorSearchTool: AgentTool = {
  name: 'vector_search',
  description: 'Search the active AnythingLLM workspace for documents relevant to the query. Returns ranked text chunks.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Natural-language query' },
      topN: { type: 'number', default: 6, description: 'Max results to return' },
    },
    required: ['query'],
  },
  risk: 'low',
  async execute(args, ctx, progress) {
    const query = asString(args.query);
    if (!query) return { ok: false, output: 'Query is required.' };
    const topN = asNumber(args.topN, 6);

    progress?.(`Searching workspace "${ctx.workspaceSlug}" for: ${query.slice(0, 60)}...`);

    try {
      const results: VectorSearchResult[] = await ctx.client.vectorSearch(ctx.workspaceSlug, query, topN);
      if (results.length === 0) {
        return { ok: true, output: 'No documents found.' };
      }

      const blocks = results.map((r, i) => {
        const score = (r.score * 100).toFixed(1);
        return `### Source ${i + 1}: ${r.document.name} (score: ${score}%)\n${r.text.slice(0, 1200)}`;
      });

      const sources = results.map((r) => ({
        title: r.document.name,
        source: r.document.id,
        text: r.text.slice(0, 300),
      }));

      return {
        ok: true,
        output: `Found ${results.length} documents:\n\n${blocks.join('\n\n')}`,
        sources,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isAnythingLLMError(err)) {
        return { ok: false, output: `Vector search API error: ${msg}` };
      }
      return { ok: false, output: `Vector search failed: ${msg}` };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────────────────────

const ALL_TOOLS: AgentTool[] = [
  fileReadTool,
  fileWriteTool,
  grepSearchTool,
  findReferencesTool,
  terminalExecTool,
  webFetchTool,
  runDiagnosticsTool,
  gitStatusTool,
  gitDiffTool,
  openFileTool,
  listDirectoryTool,
  mcpCallTool,
  vectorSearchTool,
];

const TOOL_MAP = new Map<string, AgentTool>(ALL_TOOLS.map((t) => [t.name, t]));

export function getTool(name: string): AgentTool | undefined {
  return TOOL_MAP.get(name);
}

export function listTools(): AgentTool[] {
  return ALL_TOOLS;
}

/**
 * Convert internal tool definitions to OpenAI-style native function calling format.
 */
export function toNativeToolDefinitions(filter?: string[]): NativeToolDefinition[] {
  return ALL_TOOLS
    .filter((t) => !filter || filter.includes(t.name))
    .map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
}

/**
 * Execute a tool by name with args.
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  progress?: ToolProgressFn
): Promise<ToolResult> {
  const tool = TOOL_MAP.get(name);
  if (!tool) {
    return { ok: false, output: `Unknown tool: ${name}` };
  }
  try {
    return await tool.execute(args, ctx, progress);
  } catch (err) {
    Logger.error(`Tool ${name} threw unexpectedly`, err);
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, output: `Tool ${name} crashed: ${msg}` };
  }
}
