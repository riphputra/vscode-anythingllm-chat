import { Logger } from './logger';
import { Telemetry } from './telemetry';
import { Config } from './config';
import type {
  AnythingLLMWorkspace,
  AnythingLLMThread,
  ChatStreamChunk,
  VectorSearchResult,
  UploadResult,
  UploadMetadata,
  ChatRequestOptions,
  WorkspaceDocument,
  WorkspaceStats,
  NativeToolDefinition,
} from './types';

export class AnythingLLMError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly endpoint?: string
  ) {
    super(message);
    this.name = 'AnythingLLMError';
  }

  isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }

  isNotFound(): boolean {
    return this.status === 404;
  }

  isRateLimited(): boolean {
    return this.status === 429;
  }

  isServerError(): boolean {
    return this.status >= 500;
  }
}

/**
 * HTTP client for the AnythingLLM API.
 * - Auth via Bearer token
 * - Auto retry with exponential backoff + jitter for 5xx / network errors
 * - Timeout via AbortController
 * - Automatic telemetry logging
 */
export class AnythingLLMClient {
  constructor(private apiKeyProvider: () => Promise<string>) {}

  private get baseUrl(): string {
    return Config.baseUrl;
  }

  private get timeoutMs(): number {
    return Config.requestTimeoutMs;
  }

  private get maxRetries(): number {
    return Config.maxRetries;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Core HTTP dengan retry & timeout
  // ─────────────────────────────────────────────────────────────────────────────

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE' | 'PUT',
    path: string,
    options: {
      body?: unknown;
      headers?: Record<string, string>;
      signal?: AbortSignal;
      parseJson?: boolean;
    } = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const apiKey = await this.apiKeyProvider();
    const parseJson = options.parseJson ?? true;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
      ...(options.headers ?? {}),
    };

    if (options.body !== undefined && !(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }

    let lastError: unknown;
    const start = Date.now();

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const isLast = attempt === this.maxRetries;
      try {
        const controller = new AbortController();
        const timeoutHandle = setTimeout(
          () => controller.abort(),
          this.timeoutMs
        );

        // Merge external signal with our timeout signal
        if (options.signal) {
          options.signal.addEventListener('abort', () => controller.abort(), { once: true });
        }

        const fetchOptions: RequestInit = {
          method,
          headers,
          signal: controller.signal,
        };

        if (options.body !== undefined) {
          fetchOptions.body =
            options.body instanceof FormData
              ? options.body
              : JSON.stringify(options.body);
        }

        Logger.info(`${method} ${url} (attempt ${attempt + 1}/${this.maxRetries + 1})`);

        const response = await fetch(url, fetchOptions);
        clearTimeout(timeoutHandle);

        // Retry on 5xx and 429
        if ((response.status >= 500 || response.status === 429) && !isLast) {
          const retryAfter = response.headers.get('Retry-After');
          const delay = this.calculateBackoff(attempt, retryAfter);
          Logger.warn(`HTTP ${response.status} on ${path}, retrying in ${delay}ms`);
          await this.sleep(delay);
          continue;
        }

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          let msg = `HTTP ${response.status}`;
          try {
            const j = JSON.parse(text);
            msg = j.message || j.error || msg;
          } catch {
            if (text) msg = text.slice(0, 200);
          }
          Telemetry.log({
            type: 'error',
            endpoint: path,
            durationMs: Date.now() - start,
            errorMessage: msg,
          });
          throw new AnythingLLMError(msg, response.status, path);
        }

        if (!parseJson) {
          Telemetry.log({
            type: 'success',
            endpoint: path,
            durationMs: Date.now() - start,
          });
          return response as unknown as T;
        }

        const json = (await response.json()) as T;
        Telemetry.log({
          type: 'success',
          endpoint: path,
          durationMs: Date.now() - start,
        });
        return json;
      } catch (err) {
        lastError = err;
        if (err instanceof AnythingLLMError) {
          // Don't retry on non-5xx client errors
          if (!err.isServerError() && !err.isRateLimited()) {
            throw err;
          }
          if (isLast) throw err;
        }
        // AbortError / TypeError (network) → retry
        if (isLast) {
          Telemetry.log({
            type: 'error',
            endpoint: path,
            durationMs: Date.now() - start,
            errorMessage: err instanceof Error ? err.message : String(err),
          });
          if (err instanceof Error && err.name === 'AbortError') {
            throw new AnythingLLMError(
              `Request timeout after ${this.timeoutMs}ms`,
              408,
              path
            );
          }
          throw err;
        }
        const delay = this.calculateBackoff(attempt);
        Logger.warn(
          `Network error on ${path}: ${err instanceof Error ? err.message : err}. Retry in ${delay}ms`
        );
        await this.sleep(delay);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error('Unknown error');
  }

  private calculateBackoff(attempt: number, retryAfter?: string | null): number {
    if (retryAfter) {
      const s = parseInt(retryAfter, 10);
      if (!isNaN(s)) return s * 1000;
    }
    // Exponential backoff + jitter: 500ms, 1s, 2s, 4s + jitter 0-300ms
    const base = Math.min(500 * Math.pow(2, attempt), 8000);
    const jitter = Math.random() * 300;
    return base + jitter;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // API Endpoints
  // ─────────────────────────────────────────────────────────────────────────────

  /** Verify API key (GET /v1/auth) */
  async verifyAuth(): Promise<boolean> {
    try {
      const res = await this.request<{ authenticated: boolean }>('GET', '/v1/auth');
      return res.authenticated === true;
    } catch (err) {
      if (err instanceof AnythingLLMError && err.isAuthError()) return false;
      throw err;
    }
  }

  /** List workspaces (GET /v1/workspaces) */
  async listWorkspaces(): Promise<AnythingLLMWorkspace[]> {
    const res = await this.request<{ workspaces: AnythingLLMWorkspace[] }>(
      'GET',
      '/v1/workspaces'
    );
    return res.workspaces ?? [];
  }

  /** Get workspace by slug (GET /v1/workspace/{slug}) */
  async getWorkspace(slug: string): Promise<AnythingLLMWorkspace> {
    const res = await this.request<{ workspace: AnythingLLMWorkspace }>(
      'GET',
      `/v1/workspace/${encodeURIComponent(slug)}`
    );
    return res.workspace;
  }

  /** List threads in a workspace (GET /v1/workspace/{slug}/threads — falls back to chat history) */
  async listThreads(slug: string): Promise<AnythingLLMThread[]> {
    // AnythingLLM does not have a stable list-thread endpoint across versions.
    // We use chat history as a proxy.
    try {
      const res = await this.request<{
        history: Array<{ threadSlug?: string; createdAt: string; prompt: string }>;
      }>('GET', `/v1/workspace/${encodeURIComponent(slug)}/chats`);
      const threads = new Map<string, AnythingLLMThread>();
      for (const h of res.history ?? []) {
        if (h.threadSlug && !threads.has(h.threadSlug)) {
          threads.set(h.threadSlug, {
            slug: h.threadSlug,
            name: h.prompt.slice(0, 60),
            createdAt: h.createdAt,
          });
        }
      }
      return Array.from(threads.values());
    } catch {
      return [];
    }
  }

  /** Create a new thread (POST /v1/workspace/{slug}/thread/new) */
  async createThread(slug: string, name?: string): Promise<AnythingLLMThread> {
    const res = await this.request<{ thread: AnythingLLMThread }>(
      'POST',
      `/v1/workspace/${encodeURIComponent(slug)}/thread/new`,
      { body: { name: name ?? 'New Thread' } }
    );
    return res.thread;
  }

  /**
   * Stream chat to workspace (POST /v1/workspace/{slug}/stream-chat)
   * AnythingLLM returns Server-Sent Events (SSE).
   * The callback is invoked for each chunk.
   */
  async streamChat(
    workspaceSlug: string,
    options: ChatRequestOptions,
    onChunk: (chunk: ChatStreamChunk) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const url = `${this.baseUrl}/v1/workspace/${encodeURIComponent(workspaceSlug)}/stream-chat`;
    const apiKey = await this.apiKeyProvider();

    const body: Record<string, unknown> = {
      message: options.message,
      mode: options.mode ?? Config.chatMode,
    };
    if (options.threadSlug) body.threadSlug = options.threadSlug;
    if (options.sessionId) body.sessionId = options.sessionId;
    if (options.attachments) body.attachments = options.attachments;
    if (options.history && options.history.length > 0) {
      body.history = options.history.map((m) => ({
        role: m.role,
        content: m.content,
      }));
    }
    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools;
    }
    if (options.images && options.images.length > 0) {
      body.images = options.images;
    }

    const start = Date.now();
    let attempt = 0;
    let lastError: unknown;

    while (attempt <= this.maxRetries) {
      try {
        const controller = new AbortController();
        const timeoutHandle = setTimeout(
          () => controller.abort(),
          this.timeoutMs
        );
        if (signal) {
          signal.addEventListener('abort', () => controller.abort(), { once: true });
        }

        Logger.info(`POST ${url} (stream-chat, attempt ${attempt + 1})`);

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        clearTimeout(timeoutHandle);

        if (response.status >= 500 || response.status === 429) {
          if (attempt === this.maxRetries) {
            const txt = await response.text().catch(() => '');
            throw new AnythingLLMError(
              txt || `HTTP ${response.status}`,
              response.status,
              '/stream-chat'
            );
          }
          const delay = this.calculateBackoff(attempt, response.headers.get('Retry-After'));
          Logger.warn(`HTTP ${response.status}, retrying in ${delay}ms`);
          await this.sleep(delay);
          attempt++;
          continue;
        }

        if (!response.ok) {
          const txt = await response.text().catch(() => '');
          let msg = `HTTP ${response.status}`;
          try {
            const j = JSON.parse(txt);
            msg = j.message || j.error || msg;
          } catch {
            if (txt) msg = txt.slice(0, 200);
          }
          throw new AnythingLLMError(msg, response.status, '/stream-chat');
        }

        await this.parseSSEStream(response, onChunk);

        Telemetry.log({
          type: 'success',
          endpoint: '/stream-chat',
          durationMs: Date.now() - start,
        });
        return;
      } catch (err) {
        lastError = err;
        if (err instanceof AnythingLLMError) {
          if (!err.isServerError() && !err.isRateLimited()) {
            Telemetry.log({
              type: 'error',
              endpoint: '/stream-chat',
              durationMs: Date.now() - start,
              errorMessage: err.message,
            });
            throw err;
          }
          if (attempt === this.maxRetries) {
            Telemetry.log({
              type: 'error',
              endpoint: '/stream-chat',
              durationMs: Date.now() - start,
              errorMessage: err.message,
            });
            throw err;
          }
        } else if (err instanceof Error && err.name === 'AbortError') {
          // Cancelled by the user — do not throw
          Logger.info('stream-chat aborted by user');
          return;
        }
        const delay = this.calculateBackoff(attempt);
        Logger.warn(`Stream error, retrying in ${delay}ms: ${err}`);
        await this.sleep(delay);
        attempt++;
      }
    }
    // Fallback — should not be reached
    if (lastError instanceof Error) throw lastError;
    throw new AnythingLLMError('Stream failed after retries', 500, '/stream-chat');
  }

  /**
   * Parse the SSE stream from AnythingLLM.
   * Format: `data: {json}\n\n` lines
   */
  private async parseSSEStream(
    response: Response,
    onChunk: (chunk: ChatStreamChunk) => void
  ): Promise<void> {
    if (!response.body) {
      throw new AnythingLLMError('Empty response body', 500, '/stream-chat');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Split per event (double newline)
        let separatorIdx: number;
        while ((separatorIdx = buffer.indexOf('\n\n')) >= 0) {
          const rawEvent = buffer.slice(0, separatorIdx);
          buffer = buffer.slice(separatorIdx + 2);

          // Parse baris `data:`
          for (const line of rawEvent.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
              const chunk = JSON.parse(payload) as ChatStreamChunk;
              onChunk(chunk);
              if (chunk.close) return;
            } catch (err) {
              Logger.warn(`Failed to parse SSE chunk: ${payload.slice(0, 100)}`, err);
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /** Vector search (POST /v1/workspace/{slug}/vector-search) */
  async vectorSearch(
    workspaceSlug: string,
    query: string,
    topN = 4
  ): Promise<VectorSearchResult[]> {
    const res = await this.request<{
      results?: VectorSearchResult[];
    }>('POST', `/v1/workspace/${encodeURIComponent(workspaceSlug)}/vector-search`, {
      body: { query, topN },
    });
    return res.results ?? [];
  }

  /**
   * Upload a file to AnythingLLM via POST /v1/document/upload.
   *
   * Supported AnythingLLM versions accept the following multipart fields:
   *   - `file` (required)         — the file blob
   *   - `addToWorkspaces` (opt.)   — comma-separated workspace slugs that should
   *                                  auto-embed the document in the same request
   *                                  (AnythingLLM >= 1.6.0). When provided,
   *                                  callers can SKIP the second /update-embeddings call.
   *   - `metadata` (opt., JSON)    — { title, docAuthor, description, docSource }
   *
   * The response is normalized so callers always receive:
   *   - `documents[].name`        — derived from `name` || `title` || `location`
   *   - `embedded`                — true if `addToWorkspaces` was provided AND the
   *                                  server returned success. False otherwise (older
   *                                  servers that ignore the field, or upload failure).
   */
  async uploadFile(
    fileBuffer: Uint8Array,
    fileName: string,
    mimeType: string,
    options?: {
      addToWorkspaces?: string[];
      metadata?: UploadMetadata;
    }
  ): Promise<UploadResult> {
    const formData = new FormData();
    // Cast through BlobPart — DOM lib's Blob constructor is strict about
    // SharedArrayBuffer vs ArrayBuffer; in practice fileBuffer is always a
    // plain Uint8Array backed by a normal ArrayBuffer.
    const blob = new Blob([fileBuffer as unknown as BlobPart], { type: mimeType });
    formData.append('file', blob, fileName);

    if (options?.addToWorkspaces && options.addToWorkspaces.length > 0) {
      // AnythingLLM expects comma-separated slugs.
      formData.append('addToWorkspaces', options.addToWorkspaces.join(','));
    }
    if (options?.metadata) {
      formData.append('metadata', JSON.stringify(options.metadata));
    }

    type RawUploadResponse = {
      success?: boolean;
      error?: string | null;
      documents?: Array<Record<string, unknown>>;
    };

    const raw = await this.request<RawUploadResponse>('POST', '/v1/document/upload', {
      body: formData,
    });

    const docs = (raw.documents ?? []).map((d) => ({
      id: String(d.id ?? d.docId ?? ''),
      name: String(d.name ?? d.title ?? d.location ?? ''),
      type: String(d.type ?? 'file'),
      extension: d.extension ? String(d.extension) : undefined,
      size: typeof d.size === 'number' ? d.size : undefined,
      createdAt: d.createdAt ? String(d.createdAt) : undefined,
      lastUpdatedAt: d.lastUpdatedAt ? String(d.lastUpdatedAt) : undefined,
      cached: Boolean(d.cached),
      pinned: Boolean(d.pinned),
    }));

    const usedAutoEmbed = !!(options?.addToWorkspaces && options.addToWorkspaces.length > 0);
    return {
      success: raw.success !== false,
      message: raw.success === false ? (raw.error ?? 'Upload failed') : 'Upload OK',
      documents: docs,
      error: raw.error ?? undefined,
      // Server confirmed success + we requested auto-embed → treat as embedded.
      // (Server silently ignores addToWorkspaces on old versions; in that case
      // the caller can detect by checking `result.embedded` and falling back
      // to updateEmbeddings().)
      embedded: usedAutoEmbed && raw.success !== false,
    };
  }

  /** Embed document ke workspace (POST /v1/workspace/{slug}/update-embeddings) */
  async updateEmbeddings(
    workspaceSlug: string,
    adds: string[],
    deletes: string[] = []
  ): Promise<void> {
    await this.request(
      'POST',
      `/v1/workspace/${encodeURIComponent(workspaceSlug)}/update-embeddings`,
      { body: { adds, deletes } }
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Workspace document management (v0.3.0)
  // ─────────────────────────────────────────────────────────────────────────────

  /** List documents in a workspace (GET /v1/workspace/{slug}/documents) */
  async listWorkspaceDocuments(workspaceSlug: string): Promise<WorkspaceDocument[]> {
    try {
      const res = await this.request<{
        documents?: Array<Record<string, unknown>>;
        workspace?: { documents?: Array<Record<string, unknown>> };
      }>('GET', `/v1/workspace/${encodeURIComponent(workspaceSlug)}`);
      // AnythingLLM returns workspace.documents[] in some versions, top-level documents in others
      const docs = res.documents ?? res.workspace?.documents ?? [];
      return docs.map((d) => this.normalizeDoc(d));
    } catch (err) {
      Logger.warn('listWorkspaceDocuments failed', err);
      return [];
    }
  }

  /**
   * Get full document list from /v1/documents (system-wide, may not be available
   * in all versions). Filter by workspaceSlug via relationship if needed.
   */
  async listAllDocuments(): Promise<WorkspaceDocument[]> {
    try {
      const res = await this.request<{ localFiles?: Array<Record<string, unknown>>; documents?: Array<Record<string, unknown>> }>(
        'GET',
        '/v1/documents'
      );
      const docs = res.localFiles ?? res.documents ?? [];
      return docs.map((d) => this.normalizeDoc(d));
    } catch (err) {
      Logger.warn('listAllDocuments failed', err);
      return [];
    }
  }

  /** Delete a document from the system (DELETE /v1/document/{docName}) */
  async deleteDocument(docName: string): Promise<void> {
    await this.request('DELETE', `/v1/document/${encodeURIComponent(docName)}`);
  }

  /** Remove a document from a workspace's embeddings only (keeps doc in system) */
  async removeDocumentFromWorkspace(workspaceSlug: string, docName: string): Promise<void> {
    await this.updateEmbeddings(workspaceSlug, [], [docName]);
  }

  /** Upload an image (POST /v1/document/upload) — same endpoint as text files */
  async uploadImage(
    fileBuffer: Uint8Array,
    fileName: string,
    mimeType: string,
    options?: { addToWorkspaces?: string[]; metadata?: UploadMetadata }
  ): Promise<UploadResult> {
    return this.uploadFile(fileBuffer, fileName, mimeType, options);
  }

  /** Get workspace stats (document count, vector count) */
  async getWorkspaceStats(workspaceSlug: string): Promise<WorkspaceStats> {
    try {
      const ws = await this.getWorkspace(workspaceSlug);
      const docs = await this.listWorkspaceDocuments(workspaceSlug);
      return {
        slug: ws.slug,
        name: ws.name,
        documentCount: docs.length,
        vectorCount: ws.documents ?? docs.length,
        totalSizeBytes: docs.reduce((sum, d) => sum + (d.size ?? 0), 0),
      };
    } catch {
      return {
        slug: workspaceSlug,
        name: workspaceSlug,
        documentCount: 0,
        vectorCount: 0,
        totalSizeBytes: 0,
      };
    }
  }

  /**
   * Native function calling — POST /v1/workspace/{slug}/function-call
   * Available only in some AnythingLLM versions (newer than 1.2.0).
   * Falls back to stream-chat with tools if endpoint returns 404.
   */
  async nativeFunctionCall(
    workspaceSlug: string,
    message: string,
    tools: NativeToolDefinition[],
    signal?: AbortSignal
  ): Promise<{ text: string; toolCalls: Array<{ id: string; function: { name: string; arguments: string } }> }> {
    try {
      const res = await this.request<{
        textResponse?: string;
        toolCalls?: Array<{ id: string; function: { name: string; arguments: string } }>;
      }>('POST', `/v1/workspace/${encodeURIComponent(workspaceSlug)}/function-call`, {
        body: { message, tools },
        signal,
      });
      return {
        text: res.textResponse ?? '',
        toolCalls: res.toolCalls ?? [],
      };
    } catch (err) {
      if (err instanceof AnythingLLMError && err.isNotFound()) {
        // Endpoint not supported — return empty (caller should fall back to stream-chat)
        return { text: '', toolCalls: [] };
      }
      throw err;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────────

  private normalizeDoc(d: Record<string, unknown>): WorkspaceDocument {
    return {
      id: String(d.id ?? d.docId ?? ''),
      name: String(d.name ?? d.title ?? ''),
      type: String(d.type ?? 'file'),
      extension: d.extension ? String(d.extension) : undefined,
      size: typeof d.size === 'number' ? d.size : undefined,
      createdAt: d.createdAt ? String(d.createdAt) : undefined,
      lastUpdatedAt: d.lastUpdatedAt ? String(d.lastUpdatedAt) : undefined,
      cached: Boolean(d.cached),
      pinned: Boolean(d.pinned),
    };
  }
}
