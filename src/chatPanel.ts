import * as vscode from 'vscode';
import { AnythingLLMClient, AnythingLLMError } from './anythingllmClient';
import { Agent, type AgentRunOptions } from './agent';
import { Config } from './config';
import { Logger } from './logger';
import { SecretStore } from './secretStore';
import { StateManager } from './state';
import { Telemetry } from './telemetry';
import { HistoryStore, newMessageId } from './historyStore';
import { TokenTracker } from './tokenTracker';
import { McpClient } from './mcpClient';
import { AgentRunHistory } from './agentRunHistory';
import { resetPermissions } from './agentPermissions';
import { toNativeToolDefinitions } from './agentTools';
import type { ChatStreamChunk, VectorSearchResult, ChatMessage, AgentRunRecord } from './types';

/**
 * Message protocol antara webview dan extension host.
 */
type InboundMessage =
  | { type: 'sendMessage'; payload: { message: string; command: string; workspaceSlug: string; agentMode: boolean; images?: Array<{ name: string; mediaType: string; data: string }> } }
  | { type: 'cancelRequest' }
  | { type: 'getWorkspaces' }
  | { type: 'selectWorkspace'; payload: { slug: string } }
  | { type: 'uploadActiveFile'; payload: { workspaceSlug: string } }
  | { type: 'vectorSearch'; payload: { query: string; workspaceSlug: string } }
  | { type: 'newThread'; payload: { name: string; workspaceSlug: string } }
  | { type: 'getThreads'; payload: { workspaceSlug: string } }
  | { type: 'verifyAuth' }
  | { type: 'setApiKey' }
  | { type: 'setBaseUrl' }
  | { type: 'clearChat' }
  | { type: 'getActiveEditorContext' }
  | { type: 'getStats' }
  | { type: 'getSettings' }
  | { type: 'saveSettings'; payload: Partial<ExtensionSettings> }
  | { type: 'verifyApiConnection'; payload: { baseUrl: string } }
  | { type: 'resetTelemetry' }
  | { type: 'clearApiKey' }
  // v0.3.0 new messages
  | { type: 'getHistory' }
  | { type: 'exportChat'; payload: { format: 'md' | 'json' } }
  | { type: 'togglePinMessage'; payload: { messageId: string } }
  | { type: 'loadHistory' }
  | { type: 'getWorkspaceDocuments'; payload: { workspaceSlug: string } }
  | { type: 'deleteDocument'; payload: { workspaceSlug: string; docName: string } }
  | { type: 'getMcpTools' }
  | { type: 'getAgentRuns' }
  | { type: 'clearAgentRuns' }
  | { type: 'openAgentRunsFolder' }
  | { type: 'resetPermissions' }
  | { type: 'imageUpload'; payload: { fileName: string; base64: string; mediaType: string } }
  | { type: 'openWalkthrough' }
  | { type: 'openDonate' };

interface ExtensionSettings {
  baseUrl: string;
  chatMode: 'chat' | 'query';
  defaultWorkspace: string;
  showCitations: boolean;
  enableTelemetry: boolean;
  requestTimeoutMs: number;
  maxRetries: number;
  theme: 'auto' | 'dark' | 'light';
  accent: 'blue' | 'purple' | 'green' | 'orange' | 'pink';
  agentMode: boolean;
  hasApiKey: boolean;
  // v0.3.0
  agentPlanner: 'heuristic' | 'llm' | 'react' | 'native';
  agentMaxIterations: number;
  multiTurnContext: boolean;
  mcpServers: Array<{ id: string; name: string; command: string; args?: string[]; enabled: boolean }>;
  costBudgetUsd: number;
  showStatusBar: boolean;
  autoStartMcp: boolean;
  thinkBlocksCollapsed: boolean;
}

interface OutboundMessage {
  type: string;
  payload?: unknown;
}

/**
 * Manager untuk Chat Panel berbasis Webview.
 */
export class ChatPanelProvider {
  public static readonly viewType = 'anythingllmChatPanel';
  private static instance: ChatPanelProvider | undefined;
  private panel: vscode.WebviewPanel | undefined;
  private disposables: vscode.Disposable[] = [];
  private abortController: AbortController | undefined;
  private agent: Agent;
  private historyStore: HistoryStore;
  private tokenTracker: TokenTracker;
  private mcpClient: McpClient;
  private agentRunHistory: AgentRunHistory;
  private currentMessageId: string | null = null;
  private currentReasoning: string = '';

  constructor(
    private context: vscode.ExtensionContext,
    private client: AnythingLLMClient,
    private secrets: SecretStore
  ) {
    this.agent = new Agent(client);
    this.historyStore = new HistoryStore(context);
    this.tokenTracker = new TokenTracker();
    this.mcpClient = new McpClient();
    this.agentRunHistory = new AgentRunHistory(context);
  }

  static getInstance(
    context: vscode.ExtensionContext,
    client: AnythingLLMClient,
    secrets: SecretStore
  ): ChatPanelProvider {
    if (!this.instance) {
      this.instance = new ChatPanelProvider(context, client, secrets);
    }
    return this.instance;
  }

  show(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active, false);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      ChatPanelProvider.viewType,
      'AnythingLLM Chat',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, 'media'),
        ],
        enableCommandUris: true,
      }
    );

    this.panel.iconPath = new vscode.ThemeIcon('comment-discussion');
    this.panel.webview.html = this.getHtml(this.panel.webview);

    this.panel.webview.onDidReceiveMessage(
      (msg: InboundMessage) => this.handleMessage(msg),
      null,
      this.disposables
    );

    this.panel.onDidDispose(
      () => this.dispose(),
      null,
      this.disposables
    );

    this.pushInitialState();
  }

  private async pushInitialState(): Promise<void> {
    const hasKey = await this.secrets.hasApiKey();
    this.send({ type: 'authStatus', payload: { ok: hasKey, baseUrl: Config.baseUrl } });

    if (hasKey) {
      await this.refreshWorkspaces();
    }
    const slug = StateManager.instance.activeWorkspaceSlug;
    if (slug) {
      this.send({ type: 'activeWorkspace', payload: { slug } });
    }
    await this.sendSettings();
    await this.pushHistory();
  }

  private async pushHistory(): Promise<void> {
    const slug = StateManager.instance.activeWorkspaceSlug;
    if (!slug) {
      this.send({ type: 'historyLoaded', payload: { messages: [] } });
      return;
    }
    const session = await this.historyStore.getSession(slug);
    this.send({
      type: 'historyLoaded',
      payload: {
        session: session ? {
          id: session.id,
          title: session.title,
          createdAt: session.createdAt,
          messages: session.messages.map((m) => this.sanitizeMessage(m)),
        } : null,
      },
    });
  }

  /** Strip large fields before sending to webview to keep payload small */
  private sanitizeMessage(m: ChatMessage) {
    return {
      id: m.id,
      role: m.role,
      content: m.content,
      reasoning: m.reasoning,
      command: m.command,
      timestamp: m.timestamp,
      pinned: m.pinned,
      sources: m.sources,
      toolCalls: m.toolCalls,
      imagePreviews: m.imagePreviews,
      tokensIn: m.tokensIn,
      tokensOut: m.tokensOut,
    };
  }

  private async handleMessage(msg: InboundMessage): Promise<void> {
    Logger.info(`ChatPanel message: ${msg.type}`);
    try {
      switch (msg.type) {
        case 'sendMessage':
          await this.handleSendMessage(msg.payload);
          break;
        case 'cancelRequest':
          this.handleCancel();
          break;
        case 'getWorkspaces':
          await this.refreshWorkspaces();
          break;
        case 'selectWorkspace':
          StateManager.instance.setActiveWorkspace(msg.payload.slug);
          this.send({ type: 'activeWorkspace', payload: { slug: msg.payload.slug } });
          await this.refreshThreads(msg.payload.slug);
          await this.pushHistory();
          break;
        case 'uploadActiveFile':
          await this.handleUploadFile(msg.payload.workspaceSlug);
          break;
        case 'vectorSearch':
          await this.handleVectorSearch(msg.payload.query, msg.payload.workspaceSlug);
          break;
        case 'newThread':
          await this.handleNewThread(msg.payload.name, msg.payload.workspaceSlug);
          break;
        case 'getThreads':
          await this.refreshThreads(msg.payload.workspaceSlug);
          break;
        case 'verifyAuth':
          await this.handleVerifyAuth();
          break;
        case 'setApiKey':
          await vscode.commands.executeCommand('anythingllm.setApiKey');
          await this.pushInitialState();
          break;
        case 'setBaseUrl':
          await vscode.commands.executeCommand('anythingllm.setBaseUrl');
          this.send({ type: 'authStatus', payload: { ok: await this.secrets.hasApiKey(), baseUrl: Config.baseUrl } });
          await this.sendSettings();
          break;
        case 'clearChat':
          this.abortController?.abort();
          {
            const slug = StateManager.instance.activeWorkspaceSlug;
            if (slug) await this.historyStore.clearSession(slug);
          }
          this.send({ type: 'chatCleared' });
          await this.pushHistory();
          break;
        case 'getActiveEditorContext':
          this.sendActiveEditorContext();
          break;
        case 'getStats':
          this.send({ type: 'stats', payload: this.getStats() });
          break;
        case 'getSettings':
          await this.sendSettings();
          break;
        case 'saveSettings':
          await this.handleSaveSettings(msg.payload);
          break;
        case 'verifyApiConnection':
          await this.handleVerifyApiConnection(msg.payload.baseUrl);
          break;
        case 'resetTelemetry':
          Telemetry.reset();
          this.tokenTracker.reset();
          this.send({ type: 'stats', payload: this.getStats() });
          this.send({ type: 'settingsSaved', payload: { ok: true, message: 'Telemetry & token tracker direset.' } });
          break;
        case 'clearApiKey':
          await this.secrets.deleteApiKey();
          this.send({ type: 'authStatus', payload: { ok: false, baseUrl: Config.baseUrl } });
          this.send({ type: 'settingsSaved', payload: { ok: true, message: 'API Key dihapus.' } });
          break;
        // v0.3.0 new handlers
        case 'getHistory':
          await this.pushHistory();
          break;
        case 'exportChat':
          await this.handleExportChat(msg.payload.format);
          break;
        case 'togglePinMessage':
          await this.handleTogglePin(msg.payload.messageId);
          break;
        case 'loadHistory':
          await this.pushHistory();
          break;
        case 'getWorkspaceDocuments':
          await this.handleGetWorkspaceDocuments(msg.payload.workspaceSlug);
          break;
        case 'deleteDocument':
          await this.handleDeleteDocument(msg.payload.workspaceSlug, msg.payload.docName);
          break;
        case 'getMcpTools':
          this.send({ type: 'mcpTools', payload: { tools: this.mcpClient.getAllTools() } });
          break;
        case 'getAgentRuns':
          this.send({ type: 'agentRuns', payload: { runs: await this.agentRunHistory.listRuns() } });
          break;
        case 'clearAgentRuns':
          await this.agentRunHistory.clearRuns();
          this.send({ type: 'agentRuns', payload: { runs: [] } });
          this.send({ type: 'settingsSaved', payload: { ok: true, message: 'Agent run history cleared.' } });
          break;
        case 'openAgentRunsFolder':
          await this.agentRunHistory.revealInExplorer();
          break;
        case 'resetPermissions':
          resetPermissions();
          this.send({ type: 'settingsSaved', payload: { ok: true, message: 'Agent permissions reset.' } });
          break;
        case 'imageUpload':
          await this.handleImageUpload(msg.payload);
          break;
        case 'openWalkthrough':
          vscode.commands.executeCommand('workbench.action.openWalkthrough', 'riphputra.anythingllm-vscode#anythingllm.welcome');
          break;
        case 'openDonate':
          vscode.commands.executeCommand('anythingllm.openDonate');
          break;
      }
    } catch (err) {
      Logger.error(`ChatPanel handler error: ${msg.type}`, err);
      const errMsg = err instanceof Error ? err.message : String(err);
      this.send({ type: 'chatError', payload: { message: errMsg } });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Send message handler (with history persistence)
  // ─────────────────────────────────────────────────────────────────────────────

  private async handleSendMessage(payload: {
    message: string;
    command: string;
    workspaceSlug: string;
    agentMode: boolean;
    images?: Array<{ name: string; mediaType: string; data: string }>;
  }): Promise<void> {
    if (!payload.workspaceSlug) {
      this.send({ type: 'chatError', payload: { message: 'Please select a workspace first.' } });
      return;
    }
    if (!payload.message.trim()) {
      this.send({ type: 'chatError', payload: { message: 'Message cannot be empty.' } });
      return;
    }

    // Persist user message
    const userMsg: ChatMessage = {
      id: newMessageId(),
      role: 'user',
      content: payload.message,
      command: payload.command,
      timestamp: Date.now(),
      imagePreviews: payload.images?.map((i) => `data:${i.mediaType};base64,${i.data}`),
      tokensIn: TokenTracker.estimateTokens(payload.message),
    };
    await this.historyStore.addMessage(payload.workspaceSlug, userMsg);

    // AGENT MODE — Tier 3
    if (payload.agentMode) {
      await this.runAgent(payload.message, payload.workspaceSlug);
      return;
    }

    // Inject editor context
    let finalMessage = payload.message;
    const editorCtx = this.getActiveEditorContext();
    if (editorCtx && ['ask', 'summarize', 'explain'].includes(payload.command)) {
      if (payload.command === 'summarize') {
        finalMessage = `Summarize the following code/text in full, explain its purpose and key points:\n\n\`\`\`${editorCtx.language}\n${editorCtx.content}\n\`\`\``;
      } else if (payload.command === 'explain') {
        finalMessage = `Explain the following code/text in detail for a junior developer. Include: purpose, how it works, and a usage example:\n\n\`\`\`${editorCtx.language}\n${editorCtx.content}\n\`\`\``;
      } else {
        finalMessage = `${payload.message}\n\n--- Context from editor (${editorCtx.label}) ---\n\`\`\`${editorCtx.language}\n${editorCtx.content.slice(0, 8000)}\n\`\`\``;
      }
    }

    // Multi-turn context
    const multiTurnEnabled = Config.section.get<boolean>('multiTurnContext', true);
    const history = multiTurnEnabled
      ? await this.historyStore.getMultiTurnContext(payload.workspaceSlug, 10)
      : undefined;

    this.send({ type: 'chatStart', payload: { command: payload.command } });

    this.abortController = new AbortController();
    this.currentMessageId = newMessageId();
    this.currentReasoning = '';
    let sourcesCount = 0;
    let assistantText = '';

    try {
      await this.client.streamChat(
        payload.workspaceSlug,
        {
          message: finalMessage,
          mode: Config.chatMode,
          history,
          images: payload.images,
        },
        (chunk: ChatStreamChunk) => {
          if (this.abortController?.signal.aborted) return;
          if (chunk.textResponse) {
            assistantText += chunk.textResponse;
            this.send({ type: 'chatChunk', payload: { text: chunk.textResponse } });
          }
          if (chunk.reasoningResponse) {
            this.currentReasoning += chunk.reasoningResponse;
            this.send({ type: 'thinking', payload: { text: chunk.reasoningResponse } });
          }
          if (chunk.sources && chunk.sources.length > 0) {
            sourcesCount = chunk.sources.length;
            this.send({
              type: 'chatSources',
              payload: {
                sources: chunk.sources.map((s) => ({
                  title: s.title ?? s.source,
                  source: s.source,
                  text: s.text?.slice(0, 300),
                })),
              },
            });
          }
          if (chunk.error) {
            this.send({ type: 'chatError', payload: { message: chunk.error } });
          }
        },
        this.abortController.signal
      );

      // Track tokens
      const tokensIn = TokenTracker.estimateTokens(finalMessage);
      const tokensOut = TokenTracker.estimateTokens(assistantText);
      this.tokenTracker.record({
        timestamp: Date.now(),
        endpoint: '/stream-chat',
        tokensIn,
        tokensOut,
      });

      // Persist assistant message
      const assistantMsg: ChatMessage = {
        id: this.currentMessageId,
        role: 'assistant',
        content: assistantText,
        reasoning: this.currentReasoning || undefined,
        command: payload.command,
        timestamp: Date.now(),
        sources: undefined, // sources come via chatSources event, already shown in UI
        tokensIn,
        tokensOut,
      };
      await this.historyStore.addMessage(payload.workspaceSlug, assistantMsg);

      this.send({
        type: 'chatDone',
        payload: {
          sourcesCount,
          messageId: this.currentMessageId,
          tokensIn,
          tokensOut,
        },
      });
      this.send({ type: 'stats', payload: this.getStats() });
    } catch (err) {
      if (err instanceof AnythingLLMError) {
        this.send({
          type: 'chatError',
          payload: {
            message: `[${err.status}] ${err.message}`,
            isAuthError: err.isAuthError(),
            isNotFound: err.isNotFound(),
            isRateLimited: err.isRateLimited(),
          },
        });
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        this.send({ type: 'chatError', payload: { message: msg } });
      }
    } finally {
      this.abortController = undefined;
      this.currentMessageId = null;
      this.currentReasoning = '';
    }
  }

  /**
   * Run Tier 3 Agent loop with v0.3.0 enhancements.
   */
  private async runAgent(goal: string, workspaceSlug: string): Promise<void> {
    this.abortController = new AbortController();

    this.send({ type: 'agentStart', payload: { goal } });

    const strategy = Config.section.get<'heuristic' | 'llm' | 'react' | 'native'>('agentPlanner', 'react');
    const maxIterations = Config.section.get<number>('agentMaxIterations', 5);

    const options: AgentRunOptions = {
      strategy,
      maxIterations,
      mcpCall: async (serverId, toolName, args) => {
        return this.mcpClient.callTool(serverId, toolName, args);
      },
    };

    const startedAt = Date.now();
    const record: AgentRunRecord = {
      id: newMessageId(),
      goal,
      workspaceSlug,
      startedAt,
      status: 'running',
      iterations: 0,
      steps: [],
      sourcesCount: 0,
      tokensIn: 0,
      tokensOut: 0,
    };

    let assistantText = '';
    let reasoning = '';

    try {
      await this.agent.run(
        workspaceSlug,
        goal,
        (event) => {
          if (this.abortController?.signal.aborted) return;
          switch (event.type) {
            case 'plan_created':
              this.send({ type: 'agentPlan', payload: event.payload });
              break;
            case 'plan_updated':
              this.send({ type: 'agentPlan', payload: event.payload });
              break;
            case 'step_start': {
              const p = event.payload as { stepId: string; tool: string; iteration?: number };
              this.send({ type: 'agentStepStart', payload: { ...p, status: 'running' } });
              record.steps.push({ id: p.stepId, tool: p.tool as AgentRunRecord['steps'][number]['tool'], title: p.tool, status: 'running', iteration: p.iteration });
              break;
            }
            case 'step_progress':
              this.send({ type: 'agentStepProgress', payload: event.payload });
              break;
            case 'step_done': {
              const p = event.payload as { stepId: string; tool: string; result?: string; durationMs?: number; iteration?: number };
              this.send({ type: 'agentStepDone', payload: { ...p, status: 'done' } });
              const step = record.steps.find((s) => s.id === p.stepId);
              if (step) { step.status = 'done'; step.result = p.result; }
              if (p.iteration) record.iterations = Math.max(record.iterations, p.iteration);
              break;
            }
            case 'step_failed': {
              const p = event.payload as { stepId: string; tool: string; error: string };
              this.send({ type: 'agentStepDone', payload: { ...p, status: 'failed' } });
              const step = record.steps.find((s) => s.id === p.stepId);
              if (step) { step.status = 'failed'; step.result = `FAILED: ${p.error}`; }
              break;
            }
            case 'token': {
              const p = event.payload as { text: string };
              assistantText += p.text;
              this.send({ type: 'chatChunk', payload: { text: p.text } });
              break;
            }
            case 'thinking': {
              const p = event.payload as { text: string };
              reasoning += p.text;
              this.send({ type: 'thinking', payload: { text: p.text } });
              break;
            }
            case 'sources':
              this.send({ type: 'chatSources', payload: event.payload });
              record.sourcesCount = (event.payload as { sources: unknown[] }).sources.length;
              break;
            case 'tool_call':
              this.send({ type: 'toolCall', payload: event.payload });
              break;
            case 'tool_result':
              this.send({ type: 'toolResult', payload: event.payload });
              break;
            case 'iteration':
              this.send({ type: 'iteration', payload: event.payload });
              break;
            case 'done': {
              const p = event.payload as { sourcesCount?: number; iterations?: number };
              record.iterations = p.iterations ?? record.iterations;
              record.status = 'completed';
              record.endedAt = Date.now();
              record.finalResponse = assistantText;
              record.tokensIn = TokenTracker.estimateTokens(goal);
              record.tokensOut = TokenTracker.estimateTokens(assistantText);

              this.tokenTracker.record({
                timestamp: Date.now(),
                endpoint: 'agent',
                tokensIn: record.tokensIn,
                tokensOut: record.tokensOut,
              });

              // Save agent run to disk
              this.agentRunHistory.saveRun(record).catch((e) => Logger.warn('Failed to save agent run', e));

              // Persist assistant message
              const assistantMsg: ChatMessage = {
                id: newMessageId(),
                role: 'assistant',
                content: assistantText,
                reasoning: reasoning || undefined,
                command: 'agent',
                timestamp: Date.now(),
                agentSteps: record.steps,
                tokensIn: record.tokensIn,
                tokensOut: record.tokensOut,
              };
              this.historyStore.addMessage(workspaceSlug, assistantMsg).catch((e) => Logger.warn('Failed to save agent msg', e));

              this.send({ type: 'chatDone', payload: { sourcesCount: p.sourcesCount ?? 0, messageId: assistantMsg.id, tokensIn: record.tokensIn, tokensOut: record.tokensOut } });
              this.send({ type: 'stats', payload: this.getStats() });
              break;
            }
            case 'error':
              this.send({ type: 'chatError', payload: event.payload });
              record.status = 'failed';
              record.endedAt = Date.now();
              record.errorMessage = (event.payload as { message: string }).message;
              this.agentRunHistory.saveRun(record).catch(() => {});
              break;
          }
        },
        this.abortController.signal,
        options
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.send({ type: 'chatError', payload: { message: `Agent error: ${msg}` } });
      record.status = 'failed';
      record.endedAt = Date.now();
      record.errorMessage = msg;
      this.agentRunHistory.saveRun(record).catch(() => {});
    } finally {
      this.abortController = undefined;
    }
  }

  private handleCancel(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = undefined;
      Logger.info('Chat request cancelled by user');
      this.send({ type: 'chatCancelled' });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // v0.3.0 specific handlers
  // ─────────────────────────────────────────────────────────────────────────────

  private async handleExportChat(format: 'md' | 'json'): Promise<void> {
    const slug = StateManager.instance.activeWorkspaceSlug;
    if (!slug) {
      this.send({ type: 'chatError', payload: { message: 'Please select a workspace first.' } });
      return;
    }
    const uri = await this.historyStore.exportToFile(slug, format);
    if (uri) {
      this.send({ type: 'exportResult', payload: { ok: true, path: uri.fsPath, format } });
      vscode.window.showInformationMessage(`Chat exported to ${uri.fsPath}`, 'Open File').then((a) => {
        if (a === 'Open File') vscode.env.openExternal(uri);
      });
    }
  }

  private async handleTogglePin(messageId: string): Promise<void> {
    const slug = StateManager.instance.activeWorkspaceSlug;
    if (!slug) return;
    const pinned = await this.historyStore.togglePin(slug, messageId);
    this.send({ type: 'messagePinned', payload: { messageId, pinned } });
  }

  private async handleGetWorkspaceDocuments(workspaceSlug: string): Promise<void> {
    try {
      const docs = await this.client.listWorkspaceDocuments(workspaceSlug);
      this.send({ type: 'workspaceDocuments', payload: { workspaceSlug, documents: docs } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.send({ type: 'chatError', payload: { message: `Failed to list documents: ${msg}` } });
    }
  }

  private async handleDeleteDocument(workspaceSlug: string, docName: string): Promise<void> {
    try {
      await this.client.removeDocumentFromWorkspace(workspaceSlug, docName);
      this.send({ type: 'documentDeleted', payload: { workspaceSlug, docName } });
      // Refresh
      await this.handleGetWorkspaceDocuments(workspaceSlug);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.send({ type: 'chatError', payload: { message: `Failed to delete: ${msg}` } });
    }
  }

  private async handleImageUpload(payload: { fileName: string; base64: string; mediaType: string }): Promise<void> {
    const slug = StateManager.instance.activeWorkspaceSlug;
    if (!slug) {
      this.send({ type: 'chatError', payload: { message: 'Please select a workspace first.' } });
      return;
    }
    try {
      const buf = Buffer.from(payload.base64, 'base64');
      // Single-call upload + auto-embed via `addToWorkspaces`.
      const result = await this.client.uploadImage(
        new Uint8Array(buf),
        payload.fileName,
        payload.mediaType,
        { addToWorkspaces: [slug] }
      );
      if (!result.success || result.documents.length === 0) {
        this.send({ type: 'uploadResult', payload: { success: false, message: result.error ?? 'Upload failed' } });
        return;
      }
      if (result.embedded) {
        this.send({
          type: 'uploadResult',
          payload: {
            success: true,
            message: `Image ${payload.fileName} uploaded & embedded into workspace "${slug}".`,
            documents: result.documents.map((d) => ({ id: d.id, name: d.name, type: d.type })),
          },
        });
        return;
      }
      // Fallback for older servers: explicit update-embeddings call.
      const docNames = result.documents.map((d) => d.name);
      try {
        await this.client.updateEmbeddings(slug, docNames);
        this.send({
          type: 'uploadResult',
          payload: {
            success: true,
            message: `Image ${payload.fileName} uploaded & embedded into workspace "${slug}".`,
            documents: result.documents.map((d) => ({ id: d.id, name: d.name, type: d.type })),
          },
        });
      } catch (embedErr) {
        Logger.error('handleImageUpload: embed failed (upload OK)', embedErr);
        const msg = embedErr instanceof Error ? embedErr.message : String(embedErr);
        this.send({
          type: 'uploadResult',
          payload: {
            success: true,
            message: `⚠️ Image uploaded to /documents, but embedding failed: ${msg}. Check embedding engine config on the AnythingLLM server (Admin → Embedder Preference) and vector DB connection.`,
            documents: result.documents.map((d) => ({ id: d.id, name: d.name, type: d.type })),
          },
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.send({ type: 'uploadResult', payload: { success: false, message: msg } });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Existing handlers
  // ─────────────────────────────────────────────────────────────────────────────

  private async refreshWorkspaces(): Promise<void> {
    try {
      const workspaces = await this.client.listWorkspaces();
      StateManager.instance.setWorkspaces(workspaces);
      this.send({
        type: 'workspacesList',
        payload: {
          workspaces: workspaces.map((w) => ({
            slug: w.slug,
            name: w.name,
            documents: w.documents ?? 0,
          })),
          activeSlug: StateManager.instance.activeWorkspaceSlug,
        },
      });
    } catch (err) {
      Logger.error('refreshWorkspaces failed', err);
      if (err instanceof AnythingLLMError && err.isAuthError()) {
        this.send({ type: 'authStatus', payload: { ok: false, baseUrl: Config.baseUrl } });
      }
    }
  }

  private async refreshThreads(workspaceSlug: string): Promise<void> {
    try {
      const threads = await this.client.listThreads(workspaceSlug);
      this.send({
        type: 'threadsList',
        payload: { threads: threads.map((t) => ({ slug: t.slug, name: t.name })) },
      });
    } catch {
      // silent
    }
  }

  private async handleUploadFile(workspaceSlug: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this.send({ type: 'uploadResult', payload: { success: false, message: 'No active file in the editor.' } });
      return;
    }
    const fileName = editor.document.uri.fsPath.split('/').pop() ?? 'document.txt';
    const content = new Uint8Array(Buffer.from(editor.document.getText(), 'utf-8'));
    this.send({ type: 'progress', payload: { message: `Mengupload ${fileName}...` } });
    try {
      // Single-call upload + auto-embed via `addToWorkspaces` (AnythingLLM >= 1.6.0).
      const result = await this.client.uploadFile(content, fileName, 'text/plain', {
        addToWorkspaces: [workspaceSlug],
      });
      if (!result.success || result.documents.length === 0) {
        this.send({ type: 'uploadResult', payload: { success: false, message: result.error ?? 'Upload failed.' } });
        return;
      }
      if (result.embedded) {
        this.send({
          type: 'uploadResult',
          payload: {
            success: true,
            message: `${fileName} uploaded & embedded into workspace "${workspaceSlug}".`,
            documents: result.documents.map((d) => ({ id: d.id, name: d.name, type: d.type })),
          },
        });
        return;
      }
      // Fallback for older servers: explicit update-embeddings call.
      const docNames = result.documents.map((d) => d.name);
      try {
        await this.client.updateEmbeddings(workspaceSlug, docNames);
        this.send({
          type: 'uploadResult',
          payload: {
            success: true,
            message: `${fileName} uploaded & embedded into workspace "${workspaceSlug}".`,
            documents: result.documents.map((d) => ({ id: d.id, name: d.name, type: d.type })),
          },
        });
      } catch (embedErr) {
        Logger.error('handleUploadFile: embed failed (upload OK)', embedErr);
        const msg = embedErr instanceof Error ? embedErr.message : String(embedErr);
        this.send({
          type: 'uploadResult',
          payload: {
            success: true,
            message: `⚠️ ${fileName} uploaded to AnythingLLM documents, but embedding into workspace failed: ${msg}. Likely cause: embedding engine not configured (Admin → Embedder Preference), or vector DB connection issue on the server. Your file is safe in /documents.`,
            documents: result.documents.map((d) => ({ id: d.id, name: d.name, type: d.type })),
          },
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.send({ type: 'uploadResult', payload: { success: false, message: msg } });
    }
  }

  private async handleVectorSearch(query: string, workspaceSlug: string): Promise<void> {
    this.send({ type: 'chatStart', payload: { command: 'search' } });
    try {
      const results: VectorSearchResult[] = await this.client.vectorSearch(workspaceSlug, query, 6);
      this.send({ type: 'searchResults', payload: { results } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.send({ type: 'chatError', payload: { message: msg } });
    }
  }

  private async handleNewThread(name: string, workspaceSlug: string): Promise<void> {
    try {
      const thread = await this.client.createThread(workspaceSlug, name || 'New Thread');
      this.send({ type: 'threadCreated', payload: { slug: thread.slug, name: thread.name } });
      await this.refreshThreads(workspaceSlug);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.send({ type: 'chatError', payload: { message: `Failed to create thread: ${msg}` } });
    }
  }

  private async handleVerifyAuth(): Promise<void> {
    const ok = await this.client.verifyAuth();
    this.send({ type: 'authStatus', payload: { ok, baseUrl: Config.baseUrl } });
    if (ok) await this.refreshWorkspaces();
  }

  private async handleVerifyApiConnection(baseUrl: string): Promise<void> {
    try {
      const url = `${baseUrl.replace(/\/+$/, '')}/v1/auth`;
      const apiKey = await this.secrets.getApiKey();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(url, {
        method: 'GET',
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.ok) {
        this.send({ type: 'apiConnectionResult', payload: { ok: true, status: res.status, message: 'Koneksi berhasil.' } });
      } else {
        this.send({ type: 'apiConnectionResult', payload: { ok: false, status: res.status, message: `HTTP ${res.status}` } });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.send({ type: 'apiConnectionResult', payload: { ok: false, status: 0, message: msg } });
    }
  }

  private async handleSaveSettings(payload: Partial<ExtensionSettings>): Promise<void> {
    try {
      const section = vscode.workspace.getConfiguration('anythingllm');
      const targets = vscode.ConfigurationTarget.Global;

      if (payload.baseUrl !== undefined && payload.baseUrl.trim()) {
        await Config.setBaseUrl(payload.baseUrl.trim());
      }
      if (payload.chatMode !== undefined) await section.update('chatMode', payload.chatMode, targets);
      if (payload.defaultWorkspace !== undefined) await Config.setDefaultWorkspace(payload.defaultWorkspace);
      if (payload.showCitations !== undefined) await section.update('showCitations', payload.showCitations, targets);
      if (payload.enableTelemetry !== undefined) await section.update('enableTelemetry', payload.enableTelemetry, targets);
      if (payload.requestTimeoutMs !== undefined) await section.update('requestTimeoutMs', payload.requestTimeoutMs, targets);
      if (payload.maxRetries !== undefined) await section.update('maxRetries', payload.maxRetries, targets);
      if (payload.theme !== undefined) await section.update('uiTheme', payload.theme, targets);
      if (payload.accent !== undefined) await section.update('uiAccent', payload.accent, targets);
      if (payload.agentMode !== undefined) await section.update('agentMode', payload.agentMode, targets);
      // v0.3.0
      if (payload.agentPlanner !== undefined) await section.update('agentPlanner', payload.agentPlanner, targets);
      if (payload.agentMaxIterations !== undefined) await section.update('agentMaxIterations', payload.agentMaxIterations, targets);
      if (payload.multiTurnContext !== undefined) await section.update('multiTurnContext', payload.multiTurnContext, targets);
      if (payload.mcpServers !== undefined) await section.update('mcpServers', payload.mcpServers, targets);
      if (payload.costBudgetUsd !== undefined) {
        await section.update('costBudgetUsd', payload.costBudgetUsd, targets);
        this.tokenTracker.setBudget(payload.costBudgetUsd);
      }
      if (payload.showStatusBar !== undefined) await section.update('showStatusBar', payload.showStatusBar, targets);
      if (payload.autoStartMcp !== undefined) await section.update('autoStartMcp', payload.autoStartMcp, targets);
      if (payload.thinkBlocksCollapsed !== undefined) await section.update('thinkBlocksCollapsed', payload.thinkBlocksCollapsed, targets);

      // Restart MCP servers if config changed
      if (payload.mcpServers !== undefined) {
        await this.mcpClient.stopAll();
        if (payload.autoStartMcp !== false) {
          await this.mcpClient.startAll();
        }
      }

      this.send({ type: 'settingsSaved', payload: { ok: true, message: 'Settings saved.' } });
      await this.sendSettings();
      this.send({ type: 'authStatus', payload: { ok: await this.secrets.hasApiKey(), baseUrl: Config.baseUrl } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.send({ type: 'settingsSaved', payload: { ok: false, message: msg } });
    }
  }

  private async sendSettings(): Promise<void> {
    const section = vscode.workspace.getConfiguration('anythingllm');
    const settings: ExtensionSettings = {
      baseUrl: Config.baseUrl,
      chatMode: Config.chatMode,
      defaultWorkspace: Config.defaultWorkspace,
      showCitations: Config.showCitations,
      enableTelemetry: section.get<boolean>('enableTelemetry', true),
      requestTimeoutMs: Config.requestTimeoutMs,
      maxRetries: Config.maxRetries,
      theme: section.get<'auto' | 'dark' | 'light'>('uiTheme', 'auto'),
      accent: section.get<'blue' | 'purple' | 'green' | 'orange' | 'pink'>('uiAccent', 'blue'),
      agentMode: section.get<boolean>('agentMode', false),
      hasApiKey: await this.secrets.hasApiKey(),
      // v0.3.0
      agentPlanner: section.get<'heuristic' | 'llm' | 'react' | 'native'>('agentPlanner', 'react'),
      agentMaxIterations: section.get<number>('agentMaxIterations', 5),
      multiTurnContext: section.get<boolean>('multiTurnContext', true),
      mcpServers: section.get<Array<{ id: string; name: string; command: string; args?: string[]; enabled: boolean }>>('mcpServers', []),
      costBudgetUsd: section.get<number>('costBudgetUsd', 1.0),
      showStatusBar: section.get<boolean>('showStatusBar', true),
      autoStartMcp: section.get<boolean>('autoStartMcp', true),
      thinkBlocksCollapsed: section.get<boolean>('thinkBlocksCollapsed', true),
    };
    this.send({ type: 'settings', payload: settings });
  }

  private getActiveEditorContext(): { label: string; content: string; language: string } | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return undefined;
    const selection = editor.selection;
    const doc = editor.document;
    const fileName = doc.uri.fsPath.split('/').pop() ?? 'untitled';
    const content = selection && !selection.isEmpty ? doc.getText(selection) : doc.getText();
    if (!content.trim()) return undefined;
    const label = selection && !selection.isEmpty ? `selection di ${fileName}` : fileName;
    return { label, content, language: doc.languageId };
  }

  private sendActiveEditorContext(): void {
    this.send({ type: 'editorContext', payload: this.getActiveEditorContext() });
  }

  private getStats() {
    const s = Telemetry.getStats();
    const tk = this.tokenTracker.getStats();
    return {
      totalRequests: s.totalRequests,
      totalErrors: s.totalErrors,
      avgLatencyMs: s.avgLatencyMs,
      totalTokens: tk.totalTokensIn + tk.totalTokensOut,
      tokensIn: tk.totalTokensIn,
      tokensOut: tk.totalTokensOut,
      todayTokens: tk.todayTokens,
      estimatedCostUsd: tk.totalEstimatedCostUsd,
      costBudgetUsd: tk.budgetUsd,
    };
  }

  private send(msg: OutboundMessage): void {
    this.panel?.webview.postMessage(msg);
  }

  /**
   * Get list of native tool definitions (for sending to LLM when using native function calling).
   */
  getNativeToolDefinitions() {
    return toNativeToolDefinitions();
  }

  /**
   * Get reference to MCP client (for extension.ts startup).
   */
  getMcpClient(): McpClient {
    return this.mcpClient;
  }

  /**
   * Get reference to token tracker (for status bar updates).
   */
  getTokenTracker(): TokenTracker {
    return this.tokenTracker;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // HTML generator
  // ─────────────────────────────────────────────────────────────────────────────

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat-ui.css')
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat-ui.js')
    );

    return /* html */ `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
                 style-src ${webview.cspSource} 'unsafe-inline';
                 script-src 'nonce-${nonce}';
                 img-src ${webview.cspSource} https: data:;
                 font-src ${webview.cspSource};" />
  <title>AnythingLLM Chat</title>
  <link rel="stylesheet" href="${styleUri}" />
</head>
<body class="theme-auto accent-blue">
  <div id="app">
    <header class="header">
      <div class="header-left">
        <div class="logo">
          <span class="logo-icon">⚡</span>
          <span class="logo-text">AnythingLLM</span>
        </div>
        <select id="workspace-select" class="workspace-select" title="Select workspace">
          <option value="">— Select Workspace —</option>
        </select>
      </div>
      <div class="header-actions">
        <button id="btn-history" class="icon-btn" title="History">📜</button>
        <button id="btn-pin" class="icon-btn" title="Pinned Messages">📌</button>
        <button id="btn-export" class="icon-btn" title="Export Chat">💾</button>
        <button id="btn-docs" class="icon-btn" title="Workspace Documents">🗂️</button>
        <button id="btn-agent" class="icon-btn" title="Agent Mode (Tier 3)">🤖</button>
        <button id="btn-new-thread" class="icon-btn" title="New Thread" disabled>🧵</button>
        <button id="btn-upload" class="icon-btn" title="Upload File" disabled>📤</button>
        <button id="btn-search" class="icon-btn" title="Vector Search" disabled>🔍</button>
        <button id="btn-image" class="icon-btn" title="Upload Image" disabled>🖼️</button>
        <button id="btn-clear" class="icon-btn" title="Clear Chat">🗑️</button>
        <button id="btn-donate" class="icon-btn icon-btn-donate" title="Support this project 💜">💜</button>
        <button id="btn-settings" class="icon-btn" title="Settings">⚙️</button>
      </div>
    </header>

    <div id="auth-banner" class="auth-banner hidden">
      <div class="auth-banner-content">
        <span class="auth-icon">🔐</span>
        <div class="auth-text">
          <strong>API Key not configured</strong>
          <small id="auth-base-url"></small>
        </div>
      </div>
      <button id="btn-set-api-key" class="btn-primary">Set API Key</button>
    </div>

    <div class="command-bar">
      <button class="cmd-btn active" data-command="ask"><span class="cmd-icon">💬</span><span>Ask</span></button>
      <button class="cmd-btn" data-command="summarize"><span class="cmd-icon">📝</span><span>Summarize</span></button>
      <button class="cmd-btn" data-command="explain"><span class="cmd-icon">📖</span><span>Explain</span></button>
      <button class="cmd-btn" data-command="search"><span class="cmd-icon">🔎</span><span>Search</span></button>
      <button class="cmd-btn" data-command="upload"><span class="cmd-icon">📤</span><span>Upload</span></button>
      <button class="cmd-btn cmd-agent" data-command="agent"><span class="cmd-icon">🤖</span><span>Agent</span></button>
    </div>

    <main id="messages" class="messages">
      <div class="welcome">
        <div class="welcome-icon">⚡</div>
        <h2>AnythingLLM Chat v0.3.0</h2>
        <p>Chat with your AnythingLLM documents & workspaces, with Agent, MCP, multi-turn context, and much more.</p>
        <div class="welcome-tips">
          <div class="tip"><strong>💡 /ask</strong><span>Chat with RAG over the workspace</span></div>
          <div class="tip"><strong>📝 /summarize</strong><span>Summarize the active file / selection</span></div>
          <div class="tip"><strong>📖 /explain</strong><span>Explain the code currently open in the editor</span></div>
          <div class="tip"><strong>🤖 Agent</strong><span>Agentic mode — ReAct loop with 13 tools</span></div>
          <div class="tip"><strong>🖼️ Image</strong><span>Upload images for multimodal models</span></div>
          <div class="tip"><strong>💾 Export</strong><span>Export chat to Markdown / JSON</span></div>
        </div>
      </div>
    </main>

    <div id="progress" class="progress hidden">
      <div class="spinner"></div>
      <span id="progress-text">Processing...</span>
    </div>

    <footer class="input-area">
      <div id="image-previews" class="image-previews hidden"></div>
      <div class="input-wrapper" id="input-wrapper">
        <textarea
          id="input"
          class="input"
          placeholder="Type a message to AnythingLLM... (Enter to send, Shift+Enter for a new line, '/' for slash commands)"
          rows="1"
        ></textarea>
        <div class="input-actions">
          <span id="active-command" class="active-command">ask</span>
          <span id="token-meter" class="token-meter hidden"></span>
          <button id="btn-stop" class="btn-stop hidden">⏹ Stop</button>
          <button id="btn-send" class="btn-send" title="Kirim (Enter)">➤</button>
        </div>
      </div>
      <div class="input-hints">
        <span class="hint">Mode: <strong id="chat-mode">chat</strong></span>
        <span class="hint">Citations: <strong id="citations-status">on</strong></span>
        <span class="hint" id="editor-ctx-hint"></span>
        <span class="hint" id="agent-status-hint"></span>
        <span class="hint" id="multi-turn-hint"></span>
      </div>
    </footer>
  </div>

  <div id="slash-autocomplete" class="slash-autocomplete hidden"></div>
  <div id="settings-modal" class="modal-overlay hidden"></div>
  <div id="docs-modal" class="modal-overlay hidden"></div>
  <div id="history-modal" class="modal-overlay hidden"></div>
  <div id="permission-modal" class="modal-overlay hidden"></div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.abortController?.abort();
    this.panel?.dispose();
    this.panel = undefined;
    ChatPanelProvider.instance = undefined;
    while (this.disposables.length) {
      const d = this.disposables.pop();
      d?.dispose();
    }
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
