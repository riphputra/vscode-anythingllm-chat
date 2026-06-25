import * as vscode from 'vscode';
import { AnythingLLMClient, AnythingLLMError } from './anythingllmClient';
import { Agent } from './agent';
import { Config } from './config';
import { Logger } from './logger';
import { StateManager } from './state';
import type { ChatStreamChunk } from './types';

interface ChatResult {
  metadata: {
    command?: string;
    workspaceSlug: string;
    mode: string;
    sourcesCount: number;
  };
  errorDetails?: vscode.ChatErrorDetails;
}

/**
 * Chat Participant handler — invoked for every user prompt in the VS Code Chat view.
 *
 * Supported commands:
 *  - /ask       : chat with the active workspace (default)
 *  - /summarize : summarize the active file / selection
 *  - /explain   : explain the active selection / file
 *  - /search    : vector-search only (no LLM)
 *  - /upload    : upload the active file to a workspace
 */
export class ChatParticipantHandler {
  private agent: Agent;

  constructor(private client: AnythingLLMClient) {
    this.agent = new Agent(client);
  }

  getHandler(): vscode.ChatRequestHandler {
    return async (request, _context, stream, token): Promise<ChatResult> => {
      const start = Date.now();

      try {
        const workspaceSlug = StateManager.instance.activeWorkspaceSlug;
        if (!workspaceSlug) {
          stream.markdown('⚠️ **No workspace selected.**\n\n');
          stream.button({
            command: 'anythingllm.selectWorkspace',
            title: vscode.l10n.t('Select Workspace'),
          });
          return this.result('', request.command ?? 'ask', 0, 'no_workspace');
        }

        // Dispatch by command
        switch (request.command) {
          case 'summarize':
            return await this.handleSummarize(request, stream, token, workspaceSlug);
          case 'explain':
            return await this.handleExplain(request, stream, token, workspaceSlug);
          case 'search':
            return await this.handleSearch(request, stream, token, workspaceSlug);
          case 'upload':
            return await this.handleUpload(request, stream, token, workspaceSlug);
          case 'agent':
            return await this.handleAgent(request, stream, token, workspaceSlug);
          case 'ask':
          default:
            return await this.handleAsk(request, _context, stream, token, workspaceSlug);
        }
      } catch (err) {
        return this.handleError(err, stream, request.command ?? 'ask');
      } finally {
        Logger.info(`chat request completed in ${Date.now() - start}ms`);
      }
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Handlers per command
  // ─────────────────────────────────────────────────────────────────────────────

  /** /ask — default chat with RAG */
  private async handleAsk(
    request: vscode.ChatRequest,
    _context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    workspaceSlug: string
  ): Promise<ChatResult> {
    const prompt = request.prompt.trim();
    if (!prompt) {
      stream.markdown('Type your question after `@anythingllm /ask`.');
      return this.result(workspaceSlug, 'ask', 0);
    }

    stream.progress(`🔍 Connecting to workspace "${workspaceSlug}"...`);

    // Check for an active editor — if present, attach the selection as context
    const editorContext = this.getActiveEditorContext();
    const finalPrompt = editorContext
      ? this.injectEditorContext(prompt, editorContext)
      : prompt;

    let sourcesCount = 0;
    let firstToken = true;

    await this.client.streamChat(
      workspaceSlug,
      { message: finalPrompt, mode: Config.chatMode },
      (chunk: ChatStreamChunk) => {
        if (token.isCancellationRequested) return;

        if (firstToken && chunk.textResponse) {
          stream.progress('');
          firstToken = false;
        }

        if (chunk.textResponse) {
          stream.markdown(chunk.textResponse);
        }

        if (chunk.sources && chunk.sources.length > 0) {
          sourcesCount = chunk.sources.length;
        }

        if (chunk.error) {
          stream.markdown(`\n\n⚠️ **Error:** ${chunk.error}`);
        }
      },
      this.abortSignalFromToken(token)
    );

    // Citations
    if (sourcesCount > 0 && Config.showCitations) {
      stream.markdown('\n\n---\n\n**📚 Sources:**\n');
      // Note: detailed sources are surfaced as references by the follow-up handler
    }

    return this.result(workspaceSlug, 'ask', sourcesCount);
  }

  /** /summarize — summarize the active file / selection */
  private async handleSummarize(
    request: vscode.ChatRequest,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    workspaceSlug: string
  ): Promise<ChatResult> {
    const editorContext = this.getActiveEditorContext();
    if (!editorContext) {
      stream.markdown(
        '❌ No active file to summarize. Open a file in the editor and try again.'
      );
      return this.result(workspaceSlug, 'summarize', 0, 'no_editor');
    }

    const userPrompt = request.prompt.trim();
    const instruction = userPrompt
      ? `Summarize with the following focus: ${userPrompt}\n\n`
      : '';

    const finalPrompt = `${instruction}Please summarize the following code/text in full, explaining its purpose, main function, and key points:\n\n${editorContext.content}`;

    stream.progress(`📝 Summarizing ${editorContext.label}...`);

    let sourcesCount = 0;
    await this.client.streamChat(
      workspaceSlug,
      { message: finalPrompt, mode: 'chat' },
      (chunk) => {
        if (token.isCancellationRequested) return;
        if (chunk.textResponse) stream.markdown(chunk.textResponse);
        if (chunk.sources?.length) sourcesCount = chunk.sources.length;
        if (chunk.error) stream.markdown(`\n\n⚠️ **Error:** ${chunk.error}`);
      },
      this.abortSignalFromToken(token)
    );

    return this.result(workspaceSlug, 'summarize', sourcesCount);
  }

  /** /explain — explain the active code/text */
  private async handleExplain(
    request: vscode.ChatRequest,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    workspaceSlug: string
  ): Promise<ChatResult> {
    const editorContext = this.getActiveEditorContext();
    if (!editorContext) {
      stream.markdown('❌ No active file to explain.');
      return this.result(workspaceSlug, 'explain', 0, 'no_editor');
    }

    const userPrompt = request.prompt.trim();
    const instruction = userPrompt ? `\n\nAdditional question: ${userPrompt}` : '';

    const finalPrompt = `Explain the following code/text in detail for a junior developer. Include: purpose, how it works, and a usage example.${instruction}\n\n\`\`\`${editorContext.language}\n${editorContext.content}\n\`\`\``;

    stream.progress(`📖 Analyzing ${editorContext.label}...`);

    let sourcesCount = 0;
    await this.client.streamChat(
      workspaceSlug,
      { message: finalPrompt, mode: 'chat' },
      (chunk) => {
        if (token.isCancellationRequested) return;
        if (chunk.textResponse) stream.markdown(chunk.textResponse);
        if (chunk.sources?.length) sourcesCount = chunk.sources.length;
        if (chunk.error) stream.markdown(`\n\n⚠️ **Error:** ${chunk.error}`);
      },
      this.abortSignalFromToken(token)
    );

    return this.result(workspaceSlug, 'explain', sourcesCount);
  }

  /** /search — vector search without an LLM */
  private async handleSearch(
    request: vscode.ChatRequest,
    stream: vscode.ChatResponseStream,
    _token: vscode.CancellationToken,
    workspaceSlug: string
  ): Promise<ChatResult> {
    const query = request.prompt.trim();
    if (!query) {
      stream.markdown('Type a search query after `@anythingllm /search`.');
      return this.result(workspaceSlug, 'search', 0);
    }

    stream.progress(`🔎 Searching documents for: "${query}"...`);

    const results = await this.client.vectorSearch(workspaceSlug, query, 6);

    if (results.length === 0) {
      stream.markdown(`No relevant documents found for: _"${query}"_`);
      return this.result(workspaceSlug, 'search', 0);
    }

    stream.markdown(`Found **${results.length}** relevant documents:\n\n`);
    results.forEach((r, i) => {
      const score = (r.score * 100).toFixed(1);
      stream.markdown(
        `### ${i + 1}. ${r.document.name}\n` +
        `**Score:** ${score}% • **Type:** ${r.document.type}\n\n` +
        `> ${r.text.slice(0, 300)}${r.text.length > 300 ? '...' : ''}\n\n`
      );
    });

    return this.result(workspaceSlug, 'search', results.length);
  }

  /** /upload — upload the active file to a workspace */
  private async handleUpload(
    _request: vscode.ChatRequest,
    stream: vscode.ChatResponseStream,
    _token: vscode.CancellationToken,
    workspaceSlug: string
  ): Promise<ChatResult> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      stream.markdown('❌ No active file to upload.');
      return this.result(workspaceSlug, 'upload', 0, 'no_editor');
    }

    const filePath = editor.document.uri.fsPath;
    const fileName = filePath.split('/').pop() ?? 'document.txt';

    stream.progress(`📤 Uploading ${fileName}...`);

    const fileContent = new Uint8Array(
      Buffer.from(editor.document.getText(), 'utf-8')
    );

    const result = await this.client.uploadFile(
      fileContent,
      fileName,
      'text/plain'
    );

    if (!result.success) {
      stream.markdown(`❌ Upload failed: ${result.error ?? 'Unknown error'}`);
      return this.result(workspaceSlug, 'upload', 0, result.error ?? 'upload_failed');
    }

    stream.markdown(`✅ **${fileName}** uploaded to the workspace!\n\n`);
    stream.markdown(`**Document ID:** ${result.documents[0]?.id ?? 'N/A'}\n`);
    stream.markdown(`**Type:** ${result.documents[0]?.type ?? 'N/A'}\n`);

    // Offer to embed into the workspace
    if (result.documents.length > 0) {
      stream.markdown('\nTo make this document available for RAG, embed it into the workspace:');
      stream.button({
        command: 'anythingllm.embedDocument',
        title: vscode.l10n.t('Embed into Workspace'),
        arguments: [workspaceSlug, result.documents.map((d) => d.name)],
      });
    }

    return this.result(workspaceSlug, 'upload', 0);
  }

  /** /agent — Tier 3 agentic loop */
  private async handleAgent(
    request: vscode.ChatRequest,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    workspaceSlug: string
  ): Promise<ChatResult> {
    const goal = request.prompt.trim();
    if (!goal) {
      stream.markdown(
        '🤖 Type your goal after `@anythingllm /agent`. Example:\n\n' +
        '> @anythingllm /agent Find documents about the leave policy and summarize the key points'
      );
      return this.result(workspaceSlug, 'agent', 0);
    }

    stream.markdown(`🤖 **Agent mode active** — goal:\n> ${goal}\n\n`);
    stream.progress('🤖 Building a plan...');

    const abortController = new AbortController();
    token.onCancellationRequested(() => abortController.abort());

    let sourcesCount = 0;

    await this.agent.run(
      workspaceSlug,
      goal,
      (event) => {
        if (token.isCancellationRequested) return;
        switch (event.type) {
          case 'plan_created': {
            const p = event.payload as {
              goal: string;
              steps: Array<{ id: string; tool: string; title: string; detail?: string; status: string }>;
            };
            stream.markdown('📋 **Plan:**\n');
            p.steps.forEach((s, i) => {
              stream.markdown(`${i + 1}. ${s.title}${s.detail ? ` — _${s.detail}_` : ''}\n`);
            });
            stream.markdown('\n');
            break;
          }
          case 'step_start': {
            const p = event.payload as { tool: string };
            stream.progress(`▶ ${p.tool}...`);
            break;
          }
          case 'step_done': {
            const p = event.payload as { tool: string; result?: string; durationMs?: number };
            if (p.tool !== 'chat' && p.result) {
              stream.markdown(`✓ _${p.tool}_ (${p.durationMs ?? 0}ms): ${p.result.slice(0, 200)}\n`);
            }
            break;
          }
          case 'step_failed': {
            const p = event.payload as { tool: string; error: string };
            stream.markdown(`✗ _${p.tool}_ failed: ${p.error}\n`);
            break;
          }
          case 'token': {
            const p = event.payload as { text: string };
            stream.markdown(p.text);
            break;
          }
          case 'sources': {
            const p = event.payload as { sources: Array<{ title?: string; source: string }> };
            sourcesCount = p.sources.length;
            break;
          }
          case 'error': {
            const p = event.payload as { message: string };
            stream.markdown(`\n\n⚠️ **Error:** ${p.message}`);
            break;
          }
          case 'done': {
            stream.progress('');
            break;
          }
        }
      },
      abortController.signal
    );

    if (sourcesCount > 0 && Config.showCitations) {
      stream.markdown('\n\n---\n\n📚 Document sources were collected via agent tool calls.');
    }

    return this.result(workspaceSlug, 'agent', sourcesCount);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────────

  private getActiveEditorContext(): {
    label: string;
    content: string;
    language: string;
  } | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return undefined;

    const selection = editor.selection;
    const document = editor.document;
    const fileName = document.uri.fsPath.split('/').pop() ?? 'untitled';
    const language = document.languageId;

    const content = selection && !selection.isEmpty
      ? document.getText(selection)
      : document.getText();

    if (!content.trim()) return undefined;

    const label = selection && !selection.isEmpty
      ? `selection in ${fileName}`
      : fileName;

    return { label, content, language };
  }

  private injectEditorContext(
    prompt: string,
    editorContext: { label: string; content: string; language: string }
  ): string {
    return `${prompt}\n\n--- Context from editor (${editorContext.label}) ---\n\`\`\`${editorContext.language}\n${editorContext.content.slice(0, 8000)}\n\`\`\``;
  }

  private abortSignalFromToken(token: vscode.CancellationToken): AbortSignal | undefined {
    if (typeof AbortController === 'undefined') return undefined;
    const controller = new AbortController();
    token.onCancellationRequested(() => controller.abort());
    return controller.signal;
  }

  private result(
    workspaceSlug: string,
    command: string,
    sourcesCount: number,
    errorDetails?: string
  ): ChatResult {
    return {
      metadata: {
        command,
        workspaceSlug,
        mode: Config.chatMode,
        sourcesCount,
      },
      errorDetails: errorDetails
        ? { message: errorDetails }
        : undefined,
    };
  }

  private handleError(
    err: unknown,
    stream: vscode.ChatResponseStream,
    command: string
  ): ChatResult {
    Logger.error('Chat handler error', err);

    if (err instanceof AnythingLLMError) {
      if (err.isAuthError()) {
        stream.markdown('🚫 **API key is invalid or expired.**\n\n');
        stream.button({
          command: 'anythingllm.setApiKey',
          title: vscode.l10n.t('Update API Key'),
        });
        return this.result('', command, 0, 'auth_error');
      }
      if (err.isNotFound()) {
        stream.markdown(
          `🔍 **Workspace not found.** Check the workspace slug in your settings.`
        );
        stream.button({
          command: 'anythingllm.selectWorkspace',
          title: vscode.l10n.t('Select Workspace'),
        });
        return this.result('', command, 0, 'not_found');
      }
      if (err.isRateLimited()) {
        stream.markdown('⏱️ **Rate limit reached.** Please try again in a moment.');
        return this.result('', command, 0, 'rate_limited');
      }
      stream.markdown(`⚠️ **Error ${err.status}:** ${err.message}`);
      return this.result('', command, 0, `http_${err.status}`);
    }

    const msg = err instanceof Error ? err.message : String(err);
    stream.markdown(`⚠️ **Unexpected error:** ${msg}`);
    return this.result('', command, 0, 'unknown_error');
  }
}
