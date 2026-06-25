# CHANGELOG

## [1.1.3] - 2026-06-25

### Fixed — Upload flow graceful handling
- **Resolved confusion when upload succeeds but embedding fails**. Previously, when `/v1/document/upload` returned 200 but `/v1/workspace/{slug}/update-embeddings` returned HTTP 500 (a server-side issue), the entire upload was reported as a failure even though the file was actually saved in AnythingLLM's document storage.
- Now the upload + embed steps are decoupled:
  - **Upload success → embed success**: full success message.
  - **Upload success → embed failure**: warning message that clearly states the file IS in `/documents`, plus the embedding error reason and likely server-side causes (embedding engine not configured, vector DB connection issue, workspace slug mismatch, file too large).
  - **Upload failure**: clean error message with the upload API's error.
- This applies to all 3 upload entry points: `anythingllm.uploadActiveFile` command, Chat Panel `/upload` button, and image upload via drag & drop / paste.

### Added — `anythingllm.embedDocument` command (interactive)
- New command: **AnythingLLM: Embed Existing Document into Workspace**.
- Use case: when a file was uploaded successfully but embedding failed (e.g. server wasn't ready), you no longer need to re-upload. Just run this command, pick the document(s) from a QuickPick of all uploaded files, and it will retry the `update-embeddings` call against the active workspace.
- Added to Command Palette under category "AnythingLLM".

## [1.1.2] - 2026-06-25

### Fixed — Chat Panel UI crash
- **Critical**: Resolved `Uncaught TypeError: Cannot read properties of null (reading 'addEventListener')` and `Cannot set properties of null (setting 'disabled')` errors that prevented the Chat Panel from sending messages or responding to button clicks.
- **Root cause**: A version drift between `media/chat-ui.js` (which queries element IDs like `#btn-agent`, `#btn-new-thread`, `#btn-upload`, `#btn-search`) and the compiled `dist/extension.js` (which renders the HTML) caused `document.getElementById(...)` to return `null`, throwing inside the IIFE init and breaking all subsequent event bindings.
- **Fix**: Hardened every DOM binding in `chat-ui.js`:
  - Added `onId(id, ev, fn)` helper — looks up element by ID, silently skips if missing.
  - Converted all init-time `document.getElementById('xxx').addEventListener(...)` calls to `onId(...)`.
  - Converted `els.input.addEventListener(...)` to `on(els.input, ...)`.
  - Added null-guard in `showSlashAutocomplete()` and `hideSlashAutocomplete()`.
  - Existing `on()` and `setDisabled()` helpers already had null-guards.
- **Result**: Even if a single element is missing, the rest of the UI continues to work. No more cascading failures.
- Also added the missing `media/icon.png` (128×128 purple "A" badge) required by `vsce package`.

### Fixed — TypeScript configuration
- `tsconfig.json` now includes `"lib": ["ES2022", "DOM"]` and `"types": ["node"]` so DOM globals (`fetch`, `AbortController`, `FormData`, `Blob`, `Response`, `TextDecoder`, `URL`, `RequestInit`, `setTimeout`, `clearTimeout`, `setInterval`) and Node globals (`Buffer`, `child_process`, `process`) resolve correctly.
- `@types/node` is in `devDependencies` (already was — verified).

## [1.1.1] - 2026-06-25

### Fixed
- `media/chat-ui.js` top directive changed from `// @ts-check` → `// @ts-nocheck` to suppress 154 spurious TypeScript errors in the webview JS file (which uses `acquireVsCodeApi()` — a runtime global injected by VS Code's webview harness, not in any TS lib).

## [1.0.2] - 2026-06-25

### Added — 18 New Features (Agentic + UX + Nice-to-have)

#### P1 — Agentic
- **LLM-based JSON planner** — ask the LLM to produce a structured JSON plan instead of relying on heuristic intent detection. Selected via `anythingllm.agentPlanner: "llm"`.
- **ReAct loop executor** — full Reason → Act → Observe loop with up to `agentMaxIterations` iterations before final synthesis. Default planner is now `react`.
- **11 new agent tools** added to the registry:
  - `file_read` — read a workspace file
  - `file_write` — create / overwrite a file (permission-gated)
  - `grep_search` — ripgrep regex search
  - `find_references` — VS Code symbol references
  - `terminal_exec` — run a shell command (permission-gated)
  - `web_fetch` — fetch a URL and return text
  - `run_diagnostics` — pull VS Code diagnostics
  - `git_status` — working tree status
  - `git_diff` — unstaged / staged diff
  - `open_file` — open a file in the editor
  - `list_directory` — list directory entries
  - `mcp_call` — invoke an MCP server tool
- **Tool permission gate** — destructive tools (`file_write`, `terminal_exec`) require explicit user confirmation (Allow once / Always allow this session / Deny). Approvals are tracked per session and can be reset via `AnythingLLM: Reset Agent Tool Permissions`.
- **Native function-calling API integration** — `anythingllm.agentPlanner: "native"` routes tool selection through the model's native function-calling endpoint.

#### P2 — UX
- **Chat history persistence** — per-workspace history saved to `globalState`. Survives panel close / window reload. Browse via the 📜 button.
- **Multi-turn context** — when `anythingllm.multiTurnContext` is enabled, the last 10 messages are sent with each stream-chat request.
- **Code block enhancement** — every code block now has **Copy**, **Insert at Cursor**, and **Apply as Diff** buttons with basic syntax highlighting.
- **Workspace document management UI** — list, delete, and re-embed documents in the active workspace via the 🗂️ button.
- **Slash command autocomplete** — typing `/` in the chat input opens a popup with available commands and descriptions.

#### P3 — Nice-to-have
- **MCP (Model Context Protocol) client** — auto-start enabled MCP servers, browse available tools, and invoke them from agent runs via `mcp_call`. Configured via `anythingllm.mcpServers`.
- **Export chat** — 💾 button exports the current conversation to Markdown or JSON.
- **Pin / bookmark messages** — 📌 on any message keeps it across Clear Chat.
- **Status bar item** — shows active workspace, agent mode state, and today's token count. Toggle with `anythingllm.showStatusBar`.
- **Welcome walkthrough** — 4-step onboarding (Configure → Open Chat → Agent Mode → Explore Features).
- **Image attachment** — drag & drop or paste images into the chat input. Multimodal-capable models receive the image inline.
- **Token / cost tracking** — `TokenTracker` estimates tokens and cost per session, with a configurable daily budget warning (`anythingllm.costBudgetUsd`).
- **Agent run history on disk** — every agent run (goal, plan, tool calls, observations, final answer, timing) is saved to `globalStorage` as JSON. Browse via Settings → Agent & MCP tab.

### Added — Collapsible `<think>` Blocks
- AI reasoning traces (`<think>...</think>` or any chain-of-thought output) are rendered as **collapsible sections** in the Chat Panel.
- Collapsed by default; click the **💭 Thinking process** header to expand.
- Captured live during streaming, so users can expand mid-response and watch reasoning accumulate.
- Configurable via `anythingllm.thinkBlocksCollapsed` (default: `true`).

### Added — Settings Modal expansion
- New **Agent & MCP** tab — planner strategy, max iterations, tool permissions, agent run history, MCP server management.
- New **Usage** tab — token / cost stats, daily budget, reset.
- Advanced tab gains: multi-turn context toggle, `<think>` collapse toggle, status bar toggle.

### Added — Commands & Keybindings
- `anythingllm.exportChat` — Export Chat
- `anythingllm.showHistory` — Show Chat History
- `anythingllm.workspaceDocuments` — Manage Workspace Documents
- `anythingllm.showAgentRuns` — Show Agent Run History
- `anythingllm.resetPermissions` — Reset Agent Tool Permissions

### Added — Configuration
- `anythingllm.agentPlanner` (`react` / `heuristic` / `llm` / `native`, default `react`)
- `anythingllm.agentMaxIterations` (1–10, default `5`)
- `anythingllm.multiTurnContext` (boolean, default `true`)
- `anythingllm.thinkBlocksCollapsed` (boolean, default `true`)
- `anythingllm.showStatusBar` (boolean, default `true`)
- `anythingllm.costBudgetUsd` (number, default `1.0`)
- `anythingllm.autoStartMcp` (boolean, default `true`)
- `anythingllm.mcpServers` (array of MCP server configs)

### Changed
- **Default planner** is now `react` (was `heuristic` in 0.2.0).
- **Localization**: all user-facing strings (UI labels, command descriptions, settings descriptions, walkthroughs, info messages) are now in **English** for global use. Code comments still mostly in English; remaining Indonesian comments translated.
- **Settings modal**: reorganized into 6 tabs (was 4) — General, API, Theme, Agent & MCP, Usage, Advanced.
- **Welcome message** on first activation now offers "Set API Key" or "Take Tour" buttons in English.

### Fixed
- All previously known npm audit vulnerabilities remain resolved (serialize-javascript, mocha, diff overrides + esbuild / vscode-test-cli upgrades).
- Improved error messages across all chat paths (panel + participant) — no more cryptic Indonesian-only errors.


---

## [1.0.1] - 2026-06-24

### Added — Tier 3 Agentic + UI v2
- **🤖 Tier 3 Agentic Mode** — AI agent with planning loop + tool registry
  - Heuristic planner: detect intent from user goal, auto-build a plan
  - Tool calls: `read_editor`, `vector_search`, `upload_current`, `chat`
  - Stream visualization: timeline cards (pending → running → done → failed)
  - Slash command `@anythingllm /agent <goal>` in VS Code Chat
  - Toggle via UI button, `Ctrl/Cmd+Shift+G`, or settings
- **🎨 Chat Panel UI v2** — WhatsApp-style layout
  - User messages: RIGHT-aligned bubble (accent color)
  - AI messages: LEFT-aligned bubble (subtle)
  - System / error: full-width banner
- **⚙️ Comprehensive Settings modal** — 4 tabs
  - General: default workspace, chat mode, citations toggle, agent mode toggle
  - API: base URL, API key, test connection, timeout, retries
  - Theme: auto / dark / light + 5 accent colors (blue / purple / green / orange / pink) with live preview
  - Advanced: telemetry, usage stats, reset stats, output log, danger zone
- **New slash command**: `/agent` in the chat participant
- **New commands**: `anythingllm.runAgent`, `anythingllm.toggleAgentMode`
- **New configuration**: `agentMode`, `uiTheme`, `uiAccent`
- **Keybinding**: `Ctrl/Cmd+Shift+G` to toggle agent mode

---

## [1.0.0] - 2026-06-24

### Added
- Initial release
- Chat participant `@anythingllm` with slash commands: `/ask`, `/summarize`, `/explain`, `/search`, `/upload`
- Streaming responses via SSE
- Secure API key storage via VS Code SecretStorage
- Sidebar with Workspaces & Threads tree views
- Auto-retry with exponential backoff for 5xx and rate-limit errors
- Timeout & cancellation support
- Editor context awareness (active file + selection)
- Follow-up suggestions
- Telemetry logging (local, no third-party)
- Configurable base URL, default workspace, chat mode, timeout, retries
