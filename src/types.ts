/**
 * Type definitions for the AnythingLLM VS Code Extension.
 */

export interface AnythingLLMWorkspace {
  id: number;
  name: string;
  slug: string;
  createdAt?: string;
  lastUpdatedAt?: string;
  documents?: number;
  threads?: number;
}

export interface AnythingLLMThread {
  slug: string;
  name: string;
  createdAt: string;
  lastUpdatedAt?: string;
  workspaceId?: number;
}

export interface AnythingLLMDocument {
  id: string;
  name: string;
  type: string;
  extension?: string;
  size?: number;
  url?: string;
  createdAt?: string;
  lastUpdatedAt?: string;
  cached?: boolean;
  pinned?: boolean;
}

export interface ChatStreamChunk {
  id: string;
  type: string;
  textResponse: string;
  sources?: Array<{
    id?: string;
    title?: string;
    source: string;
    chunkSource?: string;
    text?: string;
    score?: number;
    documentId?: string;
    workspaceId?: number;
  }>;
  close: boolean;
  error?: string;
  /** Reasoning / chain-of-thought tokens (DeepSeek-R1, o1-style models) */
  reasoningResponse?: string;
  /** Native function/tool calls emitted by the model */
  toolCalls?: Array<NativeToolCall>;
}

export interface ChatResponse {
  id: string;
  textResponse: string;
  sources?: Array<{
    title?: string;
    source: string;
    text?: string;
    score?: number;
  }>;
  error?: string;
}

export interface VectorSearchResult {
  id: string;
  score: number;
  document: {
    id: string;
    name: string;
    type: string;
  };
  chunkSource?: string;
  text: string;
}

export interface UploadResult {
  success: boolean;
  message: string;
  documents: AnythingLLMDocument[];
  error?: string;
  /** True if the server auto-embedded the documents into the workspace
   *  via the `addToWorkspaces` form parameter (AnythingLLM >= 1.6.0).
   *  When true, callers can SKIP the second /update-embeddings call. */
  embedded?: boolean;
}

/** Optional metadata that AnythingLLM stores alongside the uploaded document. */
export interface UploadMetadata {
  title?: string;
  docAuthor?: string;
  description?: string;
  docSource?: string;
}

export interface ChatRequestOptions {
  message: string;
  mode?: 'chat' | 'query';
  threadSlug?: string;
  sessionId?: string;
  attachments?: Array<{ name: string; content: string }>;
  /** Multi-turn conversation history (newest last) */
  history?: ChatMessage[];
  /** Native function/tool definitions for models that support them */
  tools?: NativeToolDefinition[];
  /** Image attachments (base64 data URLs) for multimodal models */
  images?: Array<{ name: string; mediaType: string; data: string }>;
}

export interface TelemetryEvent {
  type: 'request' | 'error' | 'success' | 'cache_hit';
  endpoint: string;
  durationMs?: number;
  tokensUsed?: number;
  errorMessage?: string;
  timestamp: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier 3 — Agent types
// ─────────────────────────────────────────────────────────────────────────────

export type AgentToolName =
  | 'plan'
  | 'vector_search'
  | 'upload_current'
  | 'read_editor'
  | 'chat'
  | 'finalize'
  // New v0.3.0 tools
  | 'file_read'
  | 'file_write'
  | 'grep_search'
  | 'find_references'
  | 'terminal_exec'
  | 'web_fetch'
  | 'run_diagnostics'
  | 'git_status'
  | 'git_diff'
  | 'open_file'
  | 'list_directory'
  | 'mcp_call';

export type AgentStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface AgentStep {
  id: string;
  tool: AgentToolName;
  title: string;
  detail?: string;
  status: AgentStepStatus;
  result?: string;
  startedAt?: number;
  endedAt?: number;
  /** Iteration number this step belongs to (ReAct loop) */
  iteration?: number;
  /** Reasoning behind this step (when LLM-planner is used) */
  reasoning?: string;
}

export interface AgentPlan {
  goal: string;
  steps: AgentStep[];
  /** Strategy used to build this plan */
  strategy: 'heuristic' | 'llm' | 'native' | 'react';
}

export interface AgentEvent {
  type:
    | 'plan_created'
    | 'plan_updated'
    | 'step_start'
    | 'step_progress'
    | 'step_done'
    | 'step_failed'
    | 'token'
    | 'thinking'
    | 'sources'
    | 'tool_call'
    | 'tool_result'
    | 'permission_request'
    | 'permission_response'
    | 'iteration'
    | 'done'
    | 'error';
  payload?: unknown;
}

export type AgentEventHandler = (event: AgentEvent) => void;

// ─────────────────────────────────────────────────────────────────────────────
// Native function calling (OpenAI-style)
// ─────────────────────────────────────────────────────────────────────────────

export interface NativeToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface NativeToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON-encoded
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Chat history persistence
// ─────────────────────────────────────────────────────────────────────────────

export type ChatRole = 'user' | 'assistant' | 'system' | 'tool';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  /** Reasoning content (collapsible <think>) — emitted by some models */
  reasoning?: string;
  command?: string;
  timestamp: number;
  sources?: Array<{ title?: string; source: string; text?: string }>;
  /** Pinned by user */
  pinned?: boolean;
  /** Agent steps (if message is from agent run) */
  agentSteps?: AgentStep[];
  /** Image attachments as data URLs (preview only — not persisted in globalState) */
  imagePreviews?: string[];
  /** Tool calls emitted by this message */
  toolCalls?: NativeToolCall[];
  /** Token usage estimate */
  tokensIn?: number;
  tokensOut?: number;
}

export interface ChatSession {
  id: string;
  workspaceSlug: string;
  createdAt: number;
  updatedAt: number;
  title: string;
  messages: ChatMessage[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent run history (audit log)
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentRunRecord {
  id: string;
  goal: string;
  workspaceSlug: string;
  startedAt: number;
  endedAt?: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  iterations: number;
  steps: AgentStep[];
  finalResponse?: string;
  sourcesCount: number;
  tokensIn: number;
  tokensOut: number;
  errorMessage?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Token / cost tracking
// ─────────────────────────────────────────────────────────────────────────────

export interface TokenUsageRecord {
  timestamp: number;
  endpoint: string;
  tokensIn: number;
  tokensOut: number;
  model?: string;
  estimatedCostUsd: number;
}

export interface TokenStats {
  totalRequests: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalEstimatedCostUsd: number;
  todayTokens: number;
  budgetUsd: number;
  budgetWarningEmitted: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP (Model Context Protocol) types
// ─────────────────────────────────────────────────────────────────────────────

export interface McpServerConfig {
  id: string;
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled: boolean;
}

export interface McpTool {
  serverId: string;
  serverName: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolCallResult {
  content: Array<{ type: 'text' | 'image' | 'resource'; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Workspace document management
// ─────────────────────────────────────────────────────────────────────────────

export interface WorkspaceDocument {
  id: string;
  name: string;
  type: string;
  extension?: string;
  size?: number;
  createdAt?: string;
  lastUpdatedAt?: string;
  cached?: boolean;
  pinned?: boolean;
}

export interface WorkspaceStats {
  slug: string;
  name: string;
  documentCount: number;
  vectorCount: number;
  totalSizeBytes: number;
}
