# AnythingLLM for VS Code

A production-ready Visual Studio Code extension for AI Chat & AI Agent, tightly integrated with your own [AnythingLLM](https://github.com/Mintplex-Labs/anything-llm) instance. Run RAG (Retrieval-Augmented Generation) over your private documents, upload files straight from the editor, and chat with AnythingLLM workspaces — all without leaving VS Code.

## ✨ Features

### 💬 Chat Panel v2 (Webview UI)
A custom webview-based chat with a **WhatsApp-style** layout — user messages on the right, AI on the left:
- **Bubble layout**: user messages on the right (accent bubble), AI answers on the left (subtle bubble)
- Workspace selector dropdown
- Slash command palette: Ask / Summarize / Explain / Search / Upload / **Agent**
- Streaming responses with a typing cursor animation
- Collapsible citations with source documents
- Per-code-block actions: **Copy**, **Insert at Cursor**, **Apply as Diff**
- Follow-up suggestion buttons
- Progress indicator while a request is in-flight
- Cancel button to abort streaming
- Full Markdown rendering (headings, tables, code, blockquotes, lists, links)

### 💭 Collapsible `<think>` Blocks
When the underlying model emits a reasoning trace (e.g. `<think>...</think>` tags or any chain-of-thought output), the panel renders it as a **collapsible section**:
- Collapsed by default (configurable via `anythingllm.thinkBlocksCollapsed`)
- Click the **💭 Thinking process** header to expand and inspect the model's reasoning
- The reasoning stream is captured live, so you can expand mid-response and watch it grow

### ⚙️ Comprehensive Settings Modal
Click the ⚙️ button in the panel header to open settings with **6 tabs**:
- **General** — default workspace, chat mode (chat/query), show citations, agent mode
- **API** — base URL, API key (SecretStorage), test connection, timeout, retries
- **Theme** — auto / dark / light + accent color (blue / purple / green / orange / pink) with live preview
- **Agent & MCP** — planner strategy, max iterations, tool permissions, agent run history, MCP server management
- **Usage** — token & cost stats, budget warning, reset
- **Advanced** — telemetry toggle, multi-turn context, `<think>` collapse, status bar, danger zone (clear API key)

### 🤖 Tier 3 — Agentic Mode
An autonomous AI Agent for complex goals. Instead of chatting directly, the agent will:
1. **Build a plan** based on the configured planner strategy
2. **Execute tool calls** in a ReAct (Reason → Act → Observe) loop
3. **Synthesize a final answer** when the goal is satisfied or the iteration budget is reached

**Planner strategies** (configurable via `anythingllm.agentPlanner`):
- `react` — ReAct loop, the most flexible (default)
- `heuristic` — fast pattern-match intent detection
- `llm` — ask the LLM to produce a JSON plan
- `native` — use the model's native function-calling API

**Built-in tools (13)**:
| Tool | Description |
|---|---|
| `vector_search` | Semantic search over AnythingLLM workspace documents |
| `file_read` | Read a file from the VS Code workspace |
| `file_write` | Create or overwrite a file (with permission gate) |
| `grep_search` | Regex search using ripgrep |
| `find_references` | Find symbol references in the active project |
| `terminal_exec` | Run a shell command (with permission gate) |
| `web_fetch` | Fetch a URL and return text content |
| `run_diagnostics` | Pull VS Code diagnostics (errors / warnings) |
| `git_status` | Show working tree status |
| `git_diff` | Show unstaged or staged diff |
| `open_file` | Open a file in the editor |
| `list_directory` | List entries in a directory |
| `mcp_call` | Invoke a tool from an external MCP server |

**Tool permission gate**: destructive tools (`file_write`, `terminal_exec`) require explicit user confirmation. Users can **Allow once**, **Always allow this session**, or **Deny**. Run `AnythingLLM: Reset Agent Tool Permissions` to clear approvals.

**Usage**:
- Toggle the 🤖 button in the Chat Panel header, or
- Pick "Agent" from the slash command palette, or
- `Ctrl/Cmd+Shift+G` for a global toggle, or
- `@anythingllm /agent <goal>` in the VS Code Chat view

**Example agent goals**:
- "Find documents about the leave policy and summarize the key points"
- "Upload the active file to the workspace and explain its contents"
- "Based on the code in the editor, find related docs and explain how to use them"

### 🧠 Chat Participant (`@anythingllm`)
Invoke in the VS Code Chat view (`Ctrl/Cmd+L`):
- **`@anythingllm`** or **`@anythingllm /ask`** — default chat with RAG over the active workspace
- **`@anythingllm /summarize`** — summarize the active file or selection
- **`@anythingllm /explain`** — explain the active code/text for developers
- **`@anythingllm /search`** — vector search documents (no LLM)
- **`@anythingllm /upload`** — upload the active file to a workspace
- **`@anythingllm /agent <goal>`** — Tier 3 Agent mode

### 🗂️ Sidebar
- **Workspaces** — browse and select AnythingLLM workspaces
- **Threads** — view conversation threads in the active workspace

### 📎 Editor Integration
- Upload the active file to AnythingLLM via the editor context menu (Right-click → AnythingLLM)
- Auto-embed documents into the active workspace after upload

### 🌟 v0.3.0 Feature Set (18 additions)
**Agentic (P1)**
1. LLM-based JSON planner
2. ReAct (Reason → Act → Observe) loop executor
3. 11+ new agent tools (`file_read`, `file_write`, `grep_search`, `find_references`, `terminal_exec`, `web_fetch`, `run_diagnostics`, `git_status`, `git_diff`, `open_file`, `list_directory`, `mcp_call`)
4. Tool permission / confirmation gate
5. Native function-calling API integration

**UX (P2)**
6. Chat history persistence (per-workspace, via `globalState`)
7. Multi-turn context (sends last N messages with each request)
8. Code block enhancement — syntax highlighting + copy + insert + apply diff
9. Workspace document management UI (list / delete / re-embed)
10. Slash command autocomplete popup

**Nice-to-have (P3)**
11. MCP (Model Context Protocol) client — auto-start, tool invocation
12. Export chat to Markdown or JSON
13. Pin / bookmark messages (persists across Clear)
14. Status bar item (active workspace, agent mode, today's token count)
15. Welcome walkthrough
16. Image attachment (drag & drop or paste for multimodal models)
17. Token / cost tracking with daily budget warning
18. Agent run history persisted to disk (audit trail)

### 🔒 Production-Ready
- ✅ **Streaming responses** via SSE (Server-Sent Events)
- ✅ **Secure API key storage** via VS Code SecretStorage (never written to `settings.json`)
- ✅ **Auto-retry with exponential backoff** for 5xx & rate-limit responses
- ✅ **Timeout & cancellation** support
- ✅ **Granular error handling** (auth, not-found, rate-limit, network)
- ✅ **Local telemetry** (request count, latency, error rate, token usage) — no third-party calls
- ✅ **Editor context awareness** (active file + selection)
- ✅ **Citations** for source traceability
- ✅ **Follow-up suggestions** for smoother UX
- ✅ **Theme customization** (auto / dark / light + 5 accent colors)

### 💜 Support / Donate (non-intrusive)
This extension is free and open source. If it saves you time, consider supporting it. Donations are **voluntary** — every feature works without paying a cent.

Donate buttons are placed in **3 non-intrusive locations**:
1. **Chat Panel header** — small 💜 heart icon next to the ⚙️ Settings button
2. **Settings modal → About tab** — Saweria & PayPal buttons
3. **Sidebar Workspaces view** — a 💜 "Support this project" row at the bottom, plus a heart icon in the view title bar

All three trigger the same `AnythingLLM: Support / Donate` command, which opens a QuickPick to choose between Saweria (IDR) and PayPal (USD).

## 📦 Prerequisites

- VS Code 1.90.0 or newer
- A reachable AnythingLLM instance (self-hosted or cloud)
- An AnythingLLM API key (generate at AnythingLLM → Settings → API Keys)

## 🚀 Quick Start

### 1. Build & Run in development mode

```bash
# Clone or navigate to the extension folder
cd anythingllm-vscode

# Install dependencies
npm install

# Compile (TypeScript check + lint + esbuild bundle)
npm run compile
```

To test in VS Code:
1. Open the extension folder in VS Code
2. Press **F5** (pick the "Run Extension" launch config)
3. VS Code opens a new Extension Development Host window with the extension active

### 2. Configure

#### Set Base URL (if not the default)
```
Command Palette (Ctrl/Cmd+Shift+P) → "AnythingLLM: Set Base URL"
```
Default: `http://localhost:3001/api` — change this if your instance lives elsewhere.

#### Set API Key
```
Command Palette → "AnythingLLM: Set API Key"
```
The API key is stored securely in VS Code SecretStorage (OS keychain), never in plain config.

#### Pick a Workspace
Open the AnythingLLM sidebar in the Activity Bar, click any workspace → "Set as Active".
Or via Command Palette:
```
"AnythingLLM: Select Workspace"
```

### 3. Start Chatting

Open the VS Code Chat view (`Ctrl/Cmd+L`) and type:

```
@anythingllm what's in the documents I just uploaded?
@anythingllm /summarize
@anythingllm /explain the main responsibility of this class
@anythingllm /search leave policy
@anythingllm /upload
```

Or open the dedicated Chat Panel with `Ctrl/Cmd+Shift+A` for the full UI experience (workspace selector, slash command bar, agent toggle, settings, export, history, document manager).

## ⚙️ Settings

Access via `File → Preferences → Settings` → search "AnythingLLM":

| Setting | Default | Description |
|---|---|---|
| `anythingllm.baseUrl` | `http://localhost:3001/api` | Base URL of your AnythingLLM API instance (no trailing slash) |
| `anythingllm.defaultWorkspace` | `""` | Default workspace slug used when the user hasn't picked one |
| `anythingllm.chatMode` | `chat` | `chat` (LLM + RAG) or `query` (retrieval only, no LLM) |
| `anythingllm.requestTimeoutMs` | `120000` | Request timeout in milliseconds |
| `anythingllm.maxRetries` | `3` | Max retries for 5xx / network errors |
| `anythingllm.showCitations` | `true` | Show source document citations under chat responses |
| `anythingllm.enableTelemetry` | `true` | Log local telemetry (request count, errors, latency). No third-party calls |
| `anythingllm.agentMode` | `false` | Enable Tier 3 Agent mode by default |
| `anythingllm.uiTheme` | `auto` | Chat Panel theme: `auto` (follow VS Code), `dark`, or `light` |
| `anythingllm.uiAccent` | `blue` | Accent color for buttons, badges, citations, agent plan: `blue` / `purple` / `green` / `orange` / `pink` |
| `anythingllm.agentPlanner` | `react` | Planner strategy: `react` / `heuristic` / `llm` / `native` |
| `anythingllm.agentMaxIterations` | `5` | Max ReAct iterations before the agent must synthesize a final answer (1–10) |
| `anythingllm.multiTurnContext` | `true` | Send the last 10 messages as context to the LLM (multi-turn conversation) |
| `anythingllm.thinkBlocksCollapsed` | `true` | Auto-collapse AI reasoning (`<think>` / chain-of-thought). Click to expand |
| `anythingllm.showStatusBar` | `true` | Show a status bar item (active workspace + agent mode + token count) |
| `anythingllm.costBudgetUsd` | `1.0` | Daily cost budget in USD. A warning appears when the estimate exceeds this |
| `anythingllm.autoStartMcp` | `true` | Auto-start all enabled MCP servers when the extension activates |
| `anythingllm.mcpServers` | `[]` | MCP server configurations (id, name, command, args, env, enabled) |

## 🏗️ Architecture

```
anythingllm-vscode/
├── src/
│   ├── extension.ts            # Entry point & activation
│   ├── chatParticipant.ts      # @anythingllm handler + slash commands
│   ├── chatPanel.ts            # Webview Chat Panel provider
│   ├── anythingllmClient.ts    # HTTP client with retry, timeout, SSE parser
│   ├── agent.ts                # Tier 3 Agent orchestrator (ReAct / planner)
│   ├── agentTools.ts           # 13 built-in agent tools
│   ├── agentPermissions.ts     # Tool permission / confirmation gate
│   ├── agentRunHistory.ts      # Agent run audit log on disk
│   ├── mcpClient.ts            # MCP (Model Context Protocol) client
│   ├── historyStore.ts         # Per-workspace chat history (globalState)
│   ├── tokenTracker.ts         # Token & cost estimation
│   ├── statusBar.ts            # Status bar item
│   ├── config.ts               # Settings.json wrapper
│   ├── secretStore.ts          # API key storage via SecretStorage
│   ├── state.ts                # State manager (active workspace, cache)
│   ├── treeViews.ts            # Sidebar Workspaces & Threads
│   ├── commands.ts             # All command registrations
│   ├── logger.ts               # OutputChannel logger
│   ├── telemetry.ts            # Local telemetry
│   └── types.ts                # Type definitions
├── media/                      # Icons, SVG assets, chat-ui.js, chat-ui.css
├── .vscode/                    # launch.json & tasks.json for debugging
├── package.json                # Extension manifest (participants, views, commands, config, walkthroughs)
├── tsconfig.json
├── esbuild.js                  # Bundler config
└── README.md
```

## 🔌 AnythingLLM API Endpoints Used

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/auth` | GET | Verify API key |
| `/v1/workspaces` | GET | List workspaces |
| `/v1/workspace/{slug}` | GET | Workspace details |
| `/v1/workspace/{slug}/stream-chat` | POST | Stream chat (SSE) |
| `/v1/workspace/{slug}/vector-search` | POST | Vector search |
| `/v1/workspace/{slug}/update-embeddings` | POST | Embed documents into a workspace |
| `/v1/workspace/{slug}/thread/new` | POST | Create a new thread |
| `/v1/workspace/{slug}/chats` | GET | Chat history (proxy for thread list) |
| `/v1/document/upload` | POST | Upload a document |

## 🛠️ Development

### Watch mode (auto-rebuild on save)
```bash
npm run watch
```

### Type check only
```bash
npm run check-types
```

### Lint
```bash
npm run lint
```

### Production build (minified)
```bash
npm run package
```

### Package as .vsix (for distribution)
```bash
npm install -g @vscode/vsce
vsce package
# Output: anythingllm-vscode-0.3.0.vsix
```

Install the .vsix:
```bash
code --install-extension anythingllm-vscode-0.3.0.vsix
```

## 🐛 Debugging

### View logs
```
Command Palette → "AnythingLLM: Show Output Log"
```
Or open the **Output** panel (`Ctrl/Cmd+Shift+U`) → select the "AnythingLLM" channel.

### View telemetry
After "Show Output Log", the tail of the log shows a summary:
```
Stats: X requests, Y errors, avg Zms, N tokens
```

### Verify API key & connectivity
```
Command Palette → "AnythingLLM: Refresh Workspaces"
```

If it fails, check:
1. The API key is valid (AnythingLLM → Settings → API Keys)
2. The Base URL is correct and reachable
3. Network / firewall isn't blocking the request

## 📝 Usage Tips

- Slash commands are more accurate than free-form prompts for specific tasks
- For large documents, use `/upload` first and then ask via `/ask` — don't paste huge content into the chat box
- `/search` is great for quick exploration without spending LLM tokens
- Set `"anythingllm.chatMode": "query"` when you only need retrieval (saves tokens)
- Toggle `🤖` Agent mode for multi-step research or code-modification tasks
- Pin important answers with 📌 so they survive "Clear Chat"
- Export the conversation with 💾 before clearing if you want to keep a transcript

## 🗺️ Roadmap

Ideas for future releases:

- [ ] Long-term cross-session memory (persistent user preferences)
- [ ] Auto-summarization when context window grows too large
- [ ] Self-correction loop driven by VS Code diagnostics
- [ ] Inline diff preview before applying agent-proposed edits
- [ ] Multi-model routing (pick a model per task type)
- [ ] Workspace-aware chat threads in the panel UI

## 📄 License

MIT

## 🔗 Links

- [AnythingLLM Assistant](https://github.com/riphputra/vscode-anythingllm-chat)
- [AnythingLLM](https://github.com/Mintplex-Labs/anything-llm)
- [VS Code Chat Participant API](https://code.visualstudio.com/api/extension-guides/chat)
- [AnythingLLM API Docs](https://docs.anythingllm.com/)
- [Model Context Protocol](https://modelcontextprotocol.io/)

<div align="center">

## ☕ Support Development

This project is open source and free. If you find it useful, buy me a coffee to keep me motivated to keep coding! 😄

<a href="https://saweria.co/r6zerodev">
  <img src="https://img.shields.io/badge/Saweria-Donasi_🇮🇩-FF8000?style=for-the-badge" height="40">
</a>
&nbsp;
<a href="https://paypal.me/r6zerodev">
  <img src="https://img.shields.io/badge/PayPal-Donate-00457C?style=for-the-badge&logo=paypal" height="40">
</a>

**⭐ Don't forget to star the repository if you like this project!**

</div>