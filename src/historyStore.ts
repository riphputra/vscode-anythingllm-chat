import * as vscode from 'vscode';
import { Logger } from './logger';
import type { ChatMessage, ChatSession } from './types';

/**
 * Chat history persistence to VS Code globalState.
 *
 * - One session per workspace
 * - Auto-saves on every new message
 * - Multi-turn context: sends the last N messages to the LLM as history
 * - Supports pin / bookmark
 * - Supports export to Markdown / JSON
 */

const STORAGE_KEY_PREFIX = 'anythingllm.chatHistory.';
const ACTIVE_SESSION_KEY_PREFIX = 'anythingllm.activeSession.';
const MAX_SESSIONS_PER_WORKSPACE = 5;
const MAX_MESSAGES_PER_SESSION = 200;
const MAX_CONTEXT_MESSAGES = 10; // Last N messages sent as multi-turn context

export class HistoryStore {
  constructor(private context: vscode.ExtensionContext) {}

  // ─────────────────────────────────────────────────────────────────────────────
  // Session management
  // ─────────────────────────────────────────────────────────────────────────────

  private sessionKey(workspaceSlug: string): string {
    return `${STORAGE_KEY_PREFIX}${workspaceSlug}`;
  }

  private activeKey(workspaceSlug: string): string {
    return `${ACTIVE_SESSION_KEY_PREFIX}${workspaceSlug}`;
  }

  /**
   * Get or create active session for a workspace.
   */
  async getOrCreateSession(workspaceSlug: string): Promise<ChatSession> {
    const activeId = this.context.globalState.get<string | undefined>(this.activeKey(workspaceSlug));
    const sessions = await this.listSessions(workspaceSlug);

    if (activeId) {
      const existing = sessions.find((s) => s.id === activeId);
      if (existing) return existing;
    }

    // Create new session
    const session: ChatSession = {
      id: this.generateId(),
      workspaceSlug,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      title: 'New Chat',
      messages: [],
    };
    sessions.unshift(session);
    await this.saveSessions(workspaceSlug, sessions);
    await this.setActiveSession(workspaceSlug, session.id);
    return session;
  }

  /**
   * Start a brand new session (clearing active).
   */
  async newSession(workspaceSlug: string): Promise<ChatSession> {
    const session: ChatSession = {
      id: this.generateId(),
      workspaceSlug,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      title: 'New Chat',
      messages: [],
    };
    const sessions = await this.listSessions(workspaceSlug);
    sessions.unshift(session);
    // Trim old sessions
    const trimmed = sessions.slice(0, MAX_SESSIONS_PER_WORKSPACE);
    await this.saveSessions(workspaceSlug, trimmed);
    await this.setActiveSession(workspaceSlug, session.id);
    return session;
  }

  async listSessions(workspaceSlug: string): Promise<ChatSession[]> {
    return this.context.globalState.get<ChatSession[]>(this.sessionKey(workspaceSlug), []);
  }

  async setActiveSession(workspaceSlug: string, sessionId: string): Promise<void> {
    await this.context.globalState.update(this.activeKey(workspaceSlug), sessionId);
  }

  private async saveSessions(workspaceSlug: string, sessions: ChatSession[]): Promise<void> {
    await this.context.globalState.update(this.sessionKey(workspaceSlug), sessions);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Message management
  // ─────────────────────────────────────────────────────────────────────────────

  async addMessage(workspaceSlug: string, message: ChatMessage): Promise<void> {
    const session = await this.getOrCreateSession(workspaceSlug);
    session.messages.push(message);
    session.updatedAt = Date.now();

    // Auto-title from first user message
    if (session.title === 'New Chat' && message.role === 'user') {
      session.title = message.content.slice(0, 60) + (message.content.length > 60 ? '...' : '');
    }

    // Trim if exceeds max
    if (session.messages.length > MAX_MESSAGES_PER_SESSION) {
      session.messages = session.messages.slice(-MAX_MESSAGES_PER_SESSION);
    }

    const sessions = await this.listSessions(workspaceSlug);
    const idx = sessions.findIndex((s) => s.id === session.id);
    if (idx >= 0) {
      sessions[idx] = session;
      await this.saveSessions(workspaceSlug, sessions);
    }
  }

  async updateMessage(workspaceSlug: string, messageId: string, patch: Partial<ChatMessage>): Promise<void> {
    const session = await this.getOrCreateSession(workspaceSlug);
    const idx = session.messages.findIndex((m) => m.id === messageId);
    if (idx >= 0) {
      session.messages[idx] = { ...session.messages[idx], ...patch };
      const sessions = await this.listSessions(workspaceSlug);
      const sIdx = sessions.findIndex((s) => s.id === session.id);
      if (sIdx >= 0) {
        sessions[sIdx] = session;
        await this.saveSessions(workspaceSlug, sessions);
      }
    }
  }

  async togglePin(workspaceSlug: string, messageId: string): Promise<boolean> {
    const session = await this.getOrCreateSession(workspaceSlug);
    const msg = session.messages.find((m) => m.id === messageId);
    if (!msg) return false;
    msg.pinned = !msg.pinned;
    const sessions = await this.listSessions(workspaceSlug);
    const idx = sessions.findIndex((s) => s.id === session.id);
    if (idx >= 0) {
      sessions[idx] = session;
      await this.saveSessions(workspaceSlug, sessions);
    }
    return !!msg.pinned;
  }

  async clearSession(workspaceSlug: string): Promise<void> {
    const session = await this.getOrCreateSession(workspaceSlug);
    // Keep pinned messages only
    session.messages = session.messages.filter((m) => m.pinned);
    const sessions = await this.listSessions(workspaceSlug);
    const idx = sessions.findIndex((s) => s.id === session.id);
    if (idx >= 0) {
      sessions[idx] = session;
      await this.saveSessions(workspaceSlug, sessions);
    }
  }

  /**
   * Get the most recent N messages for multi-turn context.
   * Excludes system messages and only returns those with content.
   */
  async getMultiTurnContext(workspaceSlug: string, n: number = MAX_CONTEXT_MESSAGES): Promise<ChatMessage[]> {
    const session = await this.getOrCreateSession(workspaceSlug);
    return session.messages
      .filter((m) => m.role !== 'system' && (m.content || m.toolCalls))
      .slice(-n);
  }

  /**
   * Get full session including pinned messages.
   */
  async getSession(workspaceSlug: string): Promise<ChatSession | undefined> {
    const sessions = await this.listSessions(workspaceSlug);
    const activeId = this.context.globalState.get<string | undefined>(this.activeKey(workspaceSlug));
    return sessions.find((s) => s.id === activeId);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Export
  // ─────────────────────────────────────────────────────────────────────────────

  async exportToMarkdown(workspaceSlug: string): Promise<string> {
    const session = await this.getSession(workspaceSlug);
    if (!session) return '_(no session)_';

    const lines: string[] = [];
    lines.push(`# AnythingLLM Chat Export`);
    lines.push('');
    lines.push(`**Workspace:** ${workspaceSlug}  `);
    lines.push(`**Session:** ${session.title}  `);
    lines.push(`**Created:** ${new Date(session.createdAt).toLocaleString('id-ID')}  `);
    lines.push(`**Messages:** ${session.messages.length}  `);
    lines.push('');
    lines.push('---');
    lines.push('');

    for (const msg of session.messages) {
      const time = new Date(msg.timestamp).toLocaleString('id-ID');
      const role = msg.role === 'user' ? '🧑 User' : msg.role === 'assistant' ? '⚡ AnythingLLM' : msg.role;
      const pin = msg.pinned ? ' 📌' : '';
      const cmd = msg.command ? `  /${msg.command}` : '';
      lines.push(`## ${role}${cmd}${pin}`);
      lines.push(`_${time}_`);
      lines.push('');
      if (msg.reasoning) {
        lines.push('<details><summary>💭 Reasoning</summary>');
        lines.push('');
        lines.push('```');
        lines.push(msg.reasoning);
        lines.push('```');
        lines.push('');
        lines.push('</details>');
        lines.push('');
      }
      lines.push(msg.content);
      if (msg.sources && msg.sources.length > 0) {
        lines.push('');
        lines.push('**📚 Sources:**');
        for (const s of msg.sources) {
          lines.push(`- ${s.title ?? s.source}`);
        }
      }
      lines.push('');
      lines.push('---');
      lines.push('');
    }

    return lines.join('\n');
  }

  async exportToJson(workspaceSlug: string): Promise<string> {
    const session = await this.getSession(workspaceSlug);
    return JSON.stringify(session ?? {}, null, 2);
  }

  /**
   * Save export to file in workspace.
   */
  async exportToFile(workspaceSlug: string, format: 'md' | 'json'): Promise<vscode.Uri | undefined> {
    const content = format === 'md'
      ? await this.exportToMarkdown(workspaceSlug)
      : await this.exportToJson(workspaceSlug);

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `anythingllm-chat-${workspaceSlug}-${ts}.${format}`;
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(filename),
      filters: { [format === 'md' ? 'Markdown' : 'JSON']: [format] },
    });
    if (!uri) return undefined;

    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
    Logger.info(`Chat exported to ${uri.fsPath}`);
    return uri;
  }

  private generateId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

/**
 * Generate a new unique message ID.
 */
export function newMessageId(): string {
  return `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
