/* ============================================================
   AnythingLLM Chat Panel — Frontend Logic (v2)
   - User messages RIGHT, AI messages LEFT
   - Comprehensive Settings modal (General / API / Theme / Advanced)
   - Tier 3 Agent mode with planning timeline + tool call cards
   - Theme & accent switching with persistence
   ============================================================ */

// @ts-nocheck
// This file runs in the VS Code webview (browser) context, NOT the
// extension host or Node.js. `acquireVsCodeApi()` is a runtime global
// injected by the webview harness and is not present in any TypeScript
// lib — so we disable type-checking here. The extension's own tsc
// project (see tsconfig.json) only covers src/**/*.ts anyway.

(function () {
  'use strict';

  // ──────────────────────────────────────────────────────────────────────────
  // State
  // ──────────────────────────────────────────────────────────────────────────
  const state = {
    activeCommand: 'ask',
    activeWorkspaceSlug: '',
    workspaces: [],
    threads: [],
    isStreaming: false,
    agentMode: false,
    currentAssistantMessageEl: null,
    currentAssistantText: '',
    currentAgentPlanEl: null,
    agentSteps: new Map(), // stepId -> DOM element
    authOk: false,
    config: {
      chatMode: 'chat',
      showCitations: true,
      theme: 'auto',
      accent: 'blue',
    },
    settings: null,
  };

  // Persisted UI state via VS Code webview state API
  const persisted = (typeof acquireVsCodeApi === 'function') ? acquireVsCodeApi() : null;
  const savedState = persisted?.getState() ?? {};
  if (savedState.theme) state.config.theme = savedState.theme;
  if (savedState.accent) state.config.accent = savedState.accent;
  if (typeof savedState.agentMode === 'boolean') state.agentMode = savedState.agentMode;

  const vscode = persisted || acquireVsCodeApi();

  const $ = (sel) => document.querySelector(sel);
  // Safe event binder — silently skips if element is missing so one bad ref
  // cannot kill the entire IIFE (defensive against HTML/JS drift).
  const on = (el, ev, fn, opts) => { if (el) el.addEventListener(ev, fn, opts); };
  const onId = (id, ev, fn, opts) => { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn, opts); return el; };
  const setDisabled = (el, val) => { if (el) el.disabled = val; };
  const cls = (el, ...args) => { if (el) el.classList(...args); };
  const els = {
    body: document.body,
    workspaceSelect: $('#workspace-select'),
    btnAgent: $('#btn-agent'),
    btnNewThread: $('#btn-new-thread'),
    btnUpload: $('#btn-upload'),
    btnSearch: $('#btn-search'),
    btnClear: $('#btn-clear'),
    btnSettings: $('#btn-settings'),
    authBanner: $('#auth-banner'),
    authBaseUrl: $('#auth-base-url'),
    btnSetApiKey: $('#btn-set-api-key'),
    commandBar: $('.command-bar'),
    cmdBtns: document.querySelectorAll('.cmd-btn'),
    messages: $('#messages'),
    progress: $('#progress'),
    progressText: $('#progress-text'),
    input: $('#input'),
    inputWrapper: $('#input-wrapper'),
    btnSend: $('#btn-send'),
    btnStop: $('#btn-stop'),
    activeCommand: $('#active-command'),
    chatMode: $('#chat-mode'),
    citationsStatus: $('#citations-status'),
    editorCtxHint: $('#editor-ctx-hint'),
    agentStatusHint: $('#agent-status-hint'),
    settingsModal: $('#settings-modal'),
  };

  // ──────────────────────────────────────────────────────────────────────────
  // Markdown renderer (minimal, safe-ish)
  // ──────────────────────────────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function renderMarkdown(text) {
    if (!text) return '';

    const codeBlocks = [];
    let processed = text.replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) => {
      const idx = codeBlocks.length;
      codeBlocks.push({ lang: lang || 'plain', code });
      return `\u0000CODEBLOCK_${idx}\u0000`;
    });

    processed = escapeHtml(processed);

    processed = processed.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
    processed = processed.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
    processed = processed.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');

    processed = processed.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    processed = processed.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');

    processed = processed.replace(/`([^`]+)`/g, '<code>$1</code>');

    processed = processed.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>'
    );

    processed = processed.replace(/^&gt;\s+(.+)$/gm, '<blockquote>$1</blockquote>');

    processed = processed.replace(/^(\s*)[-*]\s+(.+)$/gm, '$1<li>$2</li>');
    processed = processed.replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, '<ul>$1</ul>');

    processed = processed.replace(/^\d+\.\s+(.+)$/gm, '<oli>$1</oli>');
    processed = processed.replace(/(<oli>[\s\S]*?<\/oli>)(?!\s*<oli>)/g, '<ol>$1</ol>');
    processed = processed.replace(/<oli>/g, '<li>').replace(/<\/oli>/g, '</li>');

    processed = processed.replace(
      /^\|(.+)\|\n\|([-:\s|]+)\|\n((?:\|.*\|\n?)+)/gm,
      (_, header, _sep, body) => {
        const hCells = header.split('|').map((c) => c.trim()).filter(Boolean);
        const rows = body.trim().split('\n').map((r) =>
          r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
        );
        return '<table><thead><tr>' +
          hCells.map((c) => `<th>${c}</th>`).join('') +
          '</tr></thead><tbody>' +
          rows.map((r) => '<tr>' + r.map((c) => `<td>${c}</td>`).join('') + '</tr>').join('') +
          '</tbody></table>';
      }
    );

    const blocks = processed.split(/\n\n+/);
    processed = blocks.map((block) => {
      if (/^\s*<(h[1-6]|ul|ol|blockquote|table|pre|div)/.test(block)) return block;
      if (block.includes('\u0000CODEBLOCK_')) return block;
      return '<p>' + block.replace(/\n/g, '<br>') + '</p>';
    }).join('\n');

    processed = processed.replace(/\u0000CODEBLOCK_(\d+)\u0000/g, (_, idx) => {
      const { lang, code } = codeBlocks[parseInt(idx, 10)];
      const id = 'code-' + Date.now() + '-' + idx;
      const langLabel = escapeHtml(lang);
      const isEditable = ['javascript', 'js', 'typescript', 'ts', 'python', 'py', 'go', 'rust', 'java', 'c', 'cpp', 'csharp', 'css', 'html', 'json', 'yaml', 'bash', 'sh', 'sql', 'php', 'ruby'].includes(lang.toLowerCase());
      return `<pre><div class="code-block-header"><span class="code-lang">${langLabel}</span>` +
        `<div class="code-block-actions">` +
          `<button class="code-copy-btn" onclick="copyCode('${id}')">📋 Copy</button>` +
          (isEditable ? `<button class="code-insert-btn" onclick="insertCode('${id}')">📥 Insert</button>` : '') +
        `</div></div>` +
        `<code id="${id}">${escapeHtml(code)}</code></pre>`;
    });

    return processed;
  }

  // @ts-ignore
  window.copyCode = function (id) {
    const el = document.getElementById(id);
    if (el) {
      navigator.clipboard.writeText(el.textContent || '');
      const btn = el.parentElement.querySelector('.code-copy-btn');
      if (btn) {
        const original = btn.textContent;
        btn.textContent = '✓ Copied';
        setTimeout(() => { btn.textContent = original; }, 1500);
      }
    }
  };

  // ──────────────────────────────────────────────────────────────────────────
  // Theme & accent application
  // ──────────────────────────────────────────────────────────────────────────
  function applyTheme() {
    els.body.className = '';
    els.body.classList.add(`theme-${state.config.theme}`);
    els.body.classList.add(`accent-${state.config.accent}`);
  }

  function persistUiState() {
    vscode.setState({
      theme: state.config.theme,
      accent: state.config.accent,
      agentMode: state.agentMode,
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Message rendering
  // ──────────────────────────────────────────────────────────────────────────
  function now() {
    return new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  }

  function createMessageEl(role, content, command) {
    const msg = document.createElement('div');
    msg.className = `message role-${role}`;

    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    const avatarIcon = role === 'user' ? '🧑' : role === 'assistant' ? '⚡' : role === 'error' ? '⚠' : 'ℹ';
    avatar.textContent = avatarIcon;

    const contentEl = document.createElement('div');
    contentEl.className = 'message-content';

    const header = document.createElement('div');
    header.className = 'message-header';
    const roleLabel = role === 'user' ? 'Anda' : role === 'assistant' ? 'AnythingLLM' : role === 'error' ? 'Error' : 'System';
    header.innerHTML = `<span class="message-role">${roleLabel}</span>` +
      (command ? `<span class="message-command-tag">/${command}</span>` : '') +
      `<span class="message-time">${now()}</span>`;

    const body = document.createElement('div');
    body.className = 'message-body';
    if (role === 'user') {
      body.textContent = content;
    } else {
      body.innerHTML = renderMarkdown(content);
    }

    contentEl.appendChild(header);
    contentEl.appendChild(body);
    msg.appendChild(avatar);
    msg.appendChild(contentEl);
    return msg;
  }

  function appendMessage(role, content, command) {
    const welcome = els.messages.querySelector('.welcome');
    if (welcome) welcome.remove();

    const msgEl = createMessageEl(role, content, command);
    els.messages.appendChild(msgEl);
    scrollToBottom();
    return msgEl;
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      els.messages.scrollTop = els.messages.scrollHeight;
    });
  }

  function showProgress(text) {
    els.progressText.textContent = text;
    els.progress.classList.remove('hidden');
  }

  function hideProgress() {
    els.progress.classList.add('hidden');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Agent mode UI
  // ──────────────────────────────────────────────────────────────────────────
  function setAgentMode(enabled) {
    state.agentMode = enabled;
    persistUiState();

    // Toggle UI
    els.btnAgent.classList.toggle('active', enabled);
    els.inputWrapper.classList.toggle('agent-active', enabled);
    els.agentStatusHint.innerHTML = enabled
      ? '🤖 <strong style="color: var(--llm-accent, #8b5cf6);">Agent ON</strong>'
      : '';

    // Update active command display
    if (enabled) {
      setActiveCommand('agent', /* skipFocus = */ true);
      els.input.placeholder = '🤖 Agent: type a high-level goal, e.g. "Find documents about the leave policy and summarize the key points"';
    } else {
      setActiveCommand('ask', true);
    }
  }

  function renderAgentPlan(plan) {
    // Plan attached to current assistant message — if none, create
    if (!state.currentAssistantMessageEl) {
      state.currentAssistantMessageEl = appendMessage('assistant', '', 'agent');
      state.currentAssistantMessageEl.querySelector('.message-body').classList.add('streaming-cursor');
    }

    const contentEl = state.currentAssistantMessageEl.querySelector('.message-content');
    // Remove existing plan
    const existingPlan = contentEl.querySelector('.agent-plan');
    if (existingPlan) existingPlan.remove();

    const planEl = document.createElement('div');
    planEl.className = 'agent-plan';
    planEl.innerHTML =
      `<div class="agent-plan-header">🤖 Agent Plan — ${escapeHtml(plan.goal.slice(0, 80))}${plan.goal.length > 80 ? '...' : ''}</div>` +
      `<div class="agent-plan-steps">` +
      plan.steps.map((s) =>
        `<div class="agent-step pending" data-step-id="${escapeHtml(s.id)}">` +
        `<div class="agent-step-icon">○</div>` +
        `<div class="agent-step-content">` +
        `<div class="agent-step-title">${escapeHtml(s.title)}</div>` +
        (s.detail ? `<div class="agent-step-detail">${escapeHtml(s.detail)}</div>` : '') +
        `</div></div>`
      ).join('') +
      `</div>`;
    contentEl.appendChild(planEl);

    // Index steps for quick access
    state.agentSteps.clear();
    planEl.querySelectorAll('.agent-step').forEach((el) => {
      state.agentSteps.set(el.dataset.stepId, el);
    });
    state.currentAgentPlanEl = planEl;

    scrollToBottom();
  }

  function updateAgentStep(stepId, status, result) {
    const stepEl = state.agentSteps.get(stepId);
    if (!stepEl) return;
    stepEl.classList.remove('pending', 'running', 'done', 'failed');
    stepEl.classList.add(status);
    const iconEl = stepEl.querySelector('.agent-step-icon');
    const iconMap = { pending: '○', running: '◐', done: '✓', failed: '✗' };
    if (iconEl) iconEl.textContent = iconMap[status] || '○';

    if (result) {
      let resultEl = stepEl.querySelector('.agent-tool-result');
      if (!resultEl) {
        resultEl = document.createElement('div');
        resultEl.className = 'agent-tool-result';
        stepEl.querySelector('.agent-step-content').appendChild(resultEl);
      }
      resultEl.textContent = result;
    }
    scrollToBottom();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Chat flow
  // ──────────────────────────────────────────────────────────────────────────
  function setStreaming(isStreaming) {
    state.isStreaming = isStreaming;
    els.btnSend.classList.toggle('hidden', isStreaming);
    els.btnStop.classList.toggle('hidden', !isStreaming);
    els.input.disabled = false;
  }

  function sendMessage() {
    const text = els.input.value.trim();
    if (!text || state.isStreaming) return;

    if (!state.activeWorkspaceSlug) {
      appendMessage('error', '⚠️ Please select a workspace before sending a chat.');
      return;
    }

    if (!state.authOk) {
      appendMessage('error', '⚠️ API key not configured. Click the Set API Key button in the banner above.');
      return;
    }

    // Show user message (RIGHT aligned via CSS class .role-user)
    const cmd = state.agentMode ? 'agent' : state.activeCommand;
    appendMessage('user', text, cmd);

    // Clear input
    els.input.value = '';
    autoResize();

    // Send to extension
    vscode.postMessage({
      type: 'sendMessage',
      payload: {
        message: text,
        command: state.activeCommand,
        workspaceSlug: state.activeWorkspaceSlug,
        agentMode: state.agentMode,
        images: state.pendingImages && state.pendingImages.length > 0 ? state.pendingImages : undefined,
      },
    });

    // Clear pending images after send
    state.pendingImages = [];
    renderImagePreviews();

    if (state.agentMode) {
      showProgress('🤖 Agent merencanakan langkah...');
    } else if (state.activeCommand === 'upload') {
      showProgress('Mengupload file...');
    } else if (state.activeCommand === 'search') {
      showProgress('Searching documents...');
    } else {
      showProgress('Menunggu response...');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Inbound messages (from extension)
  // ──────────────────────────────────────────────────────────────────────────
  window.addEventListener('message', (event) => {
    const msg = event.data;
    handleInbound(msg);
  });

  function handleInbound(msg) {
    switch (msg.type) {
      case 'authStatus':
        state.authOk = !!msg.payload.ok;
        if (state.authOk) {
          els.authBanner.classList.add('hidden');
        } else {
          els.authBanner.classList.remove('hidden');
          els.authBaseUrl.textContent = msg.payload.baseUrl
            ? `Base URL: ${msg.payload.baseUrl}`
            : '';
        }
        break;

      case 'workspacesList':
        renderWorkspaces(msg.payload.workspaces, msg.payload.activeSlug);
        break;

      case 'activeWorkspace':
        state.activeWorkspaceSlug = msg.payload.slug;
        els.workspaceSelect.value = msg.payload.slug;
        updateActionButtons();
        break;

      case 'threadsList':
        state.threads = msg.payload.threads;
        break;

      case 'agentStart':
        // Will be followed by agentPlan
        break;

      case 'agentPlan':
        hideProgress();
        setStreaming(true);
        renderAgentPlan(msg.payload);
        break;

      case 'agentStepStart':
        updateAgentStep(msg.payload.stepId, msg.payload.status);
        break;

      case 'agentStepProgress':
        // Update step detail inline (optional)
        {
          const stepEl = state.agentSteps.get(msg.payload.stepId);
          if (stepEl) {
            let progressEl = stepEl.querySelector('.agent-step-detail');
            if (progressEl && msg.payload.message) {
              progressEl.textContent = msg.payload.message;
            }
          }
        }
        break;

      case 'agentStepDone':
        updateAgentStep(msg.payload.stepId, msg.payload.status, msg.payload.result);
        // When chat step starts, prepare streaming body
        if (msg.payload.tool === 'chat' && msg.payload.status === 'done') {
          // chat step completed — finalize streaming
        }
        break;

      case 'chatStart':
        hideProgress();
        setStreaming(true);
        if (state.activeCommand !== 'search' && state.activeCommand !== 'upload' && !state.agentMode) {
          state.currentAssistantText = '';
          state.currentAssistantMessageEl = appendMessage('assistant', '', msg.payload.command);
          state.currentAssistantMessageEl.querySelector('.message-body').classList.add('streaming-cursor');
        }
        break;

      case 'chatChunk':
        if (!state.currentAssistantMessageEl) {
          // For agent mode, lazy-create on first token
          state.currentAssistantMessageEl = appendMessage('assistant', '', state.agentMode ? 'agent' : state.activeCommand);
          state.currentAssistantMessageEl.querySelector('.message-body').classList.add('streaming-cursor');
          state.currentAssistantText = '';
        }
        state.currentAssistantText += msg.payload.text;
        const body = state.currentAssistantMessageEl.querySelector('.message-body');
        body.innerHTML = renderMarkdown(state.currentAssistantText);
        scrollToBottom();
        break;

      case 'chatSources':
        if (state.currentAssistantMessageEl && state.config.showCitations) {
          const contentEl = state.currentAssistantMessageEl.querySelector('.message-content');
          const existing = contentEl.querySelector('.citations');
          if (existing) existing.remove();
          const citations = document.createElement('div');
          citations.className = 'citations';
          const sources = msg.payload.sources;
          citations.innerHTML =
            `<div class="citations-header">📚 ${sources.length} document sources — click to view</div>` +
            `<div class="citations-list">${sources.map((s, i) =>
              `<div class="citation-item">` +
              `<div class="citation-title">${i + 1}. ${escapeHtml(s.title || 'Untitled')}</div>` +
              (s.text ? `<div class="citation-text">${escapeHtml(s.text)}...</div>` : '') +
              `<div class="citation-source">📄 ${escapeHtml(s.source)}</div>` +
              `</div>`
            ).join('')}</div>`;
          citations.querySelector('.citations-header').addEventListener('click', () => {
            citations.classList.toggle('expanded');
          });
          contentEl.appendChild(citations);
          scrollToBottom();
        }
        break;

      case 'chatDone':
        setStreaming(false);
        hideProgress();
        if (state.currentAssistantMessageEl) {
          state.currentAssistantMessageEl.querySelector('.message-body').classList.remove('streaming-cursor');
          addFollowups(state.currentAssistantMessageEl);
          state.currentAssistantMessageEl = null;
          state.currentAssistantText = '';
          state.currentAgentPlanEl = null;
          state.agentSteps.clear();
        }
        break;

      case 'chatCancelled':
        setStreaming(false);
        hideProgress();
        if (state.currentAssistantMessageEl) {
          state.currentAssistantMessageEl.querySelector('.message-body').classList.remove('streaming-cursor');
          state.currentAssistantMessageEl = null;
          state.currentAssistantText = '';
        }
        appendMessage('system', '⏹ Request cancelled.');
        break;

      case 'chatError':
        setStreaming(false);
        hideProgress();
        if (state.currentAssistantMessageEl) {
          // Keep partial output, just remove cursor
          state.currentAssistantMessageEl.querySelector('.message-body').classList.remove('streaming-cursor');
          state.currentAssistantMessageEl = null;
          state.currentAssistantText = '';
        }
        appendMessage('error', `❌ ${msg.payload.message}`);
        if (msg.payload.isAuthError) {
          els.authBanner.classList.remove('hidden');
        }
        break;

      case 'searchResults':
        setStreaming(false);
        hideProgress();
        renderSearchResults(msg.payload.results);
        break;

      case 'uploadResult':
        hideProgress();
        renderUploadResult(msg.payload);
        break;

      case 'progress':
        showProgress(msg.payload.message);
        break;

      case 'threadCreated':
        appendMessage('system', `🧵 Thread baru dibuat: ${msg.payload.name}`);
        break;

      case 'editorContext':
        if (msg.payload) {
          els.editorCtxHint.textContent = `📄 ${msg.payload.label} (${msg.payload.language})`;
        } else {
          els.editorCtxHint.textContent = '';
        }
        break;

      case 'stats':
        // Could show stats in settings Advanced tab
        state.lastStats = msg.payload;
        const statsEl = document.getElementById('stats-display');
        if (statsEl) {
          statsEl.innerHTML =
            `<div>Requests: <strong>${msg.payload.totalRequests}</strong></div>` +
            `<div>Errors: <strong>${msg.payload.totalErrors}</strong></div>` +
            `<div>Avg Latency: <strong>${msg.payload.avgLatencyMs}ms</strong></div>` +
            `<div>Tokens: <strong>${msg.payload.totalTokens}</strong></div>`;
        }
        break;

      case 'settings':
        state.settings = msg.payload;
        state.config.theme = msg.payload.theme || 'auto';
        state.config.accent = msg.payload.accent || 'blue';
        state.config.chatMode = msg.payload.chatMode || 'chat';
        state.config.showCitations = msg.payload.showCitations !== false;
        applyTheme();
        els.chatMode.textContent = state.config.chatMode;
        els.citationsStatus.textContent = state.config.showCitations ? 'on' : 'off';
        // Reflect agentMode from settings if user hasn't toggled yet
        if (typeof msg.payload.agentMode === 'boolean' && !persisted?.getState()?.agentMode) {
          // Only auto-apply if not user-persisted
        }
        // If settings modal open, refresh it
        if (!els.settingsModal.classList.contains('hidden')) {
          populateSettingsForm(msg.payload);
        }
        break;

      case 'settingsSaved':
        showSettingStatus(msg.payload.ok ? 'ok' : 'error', msg.payload.message);
        if (msg.payload.ok) {
          // Refresh settings
          vscode.postMessage({ type: 'getSettings' });
        }
        break;

      case 'apiConnectionResult':
        {
          const el = document.getElementById('api-conn-status');
          if (el) {
            el.className = 'setting-status ' + (msg.payload.ok ? 'ok' : 'error');
            el.textContent = msg.payload.ok
              ? `✓ ${msg.payload.message} (HTTP ${msg.payload.status})`
              : `✗ ${msg.payload.message}`;
          }
        }
        break;

      case 'chatCleared':
        els.messages.innerHTML = '';
        els.messages.innerHTML = `
          <div class="welcome">
            <div class="welcome-icon">⚡</div>
            <h2>Chat Dibersihkan</h2>
            <p>Mulai percakapan baru dengan AnythingLLM.</p>
          </div>`;
        state.currentAssistantMessageEl = null;
        state.agentSteps.clear();
        break;

      // ── v0.3.0 new inbound messages ─────────────────────────────────────────
      case 'thinking':
        // Append reasoning to current think block (collapsible)
        handleThinkingChunk(msg.payload.text);
        break;

      case 'historyLoaded':
        handleHistoryLoaded(msg.payload.session);
        break;

      case 'messagePinned':
        {
          const msgEl = document.querySelector(`[data-message-id="${msg.payload.messageId}"]`);
          if (msgEl) {
            msgEl.classList.toggle('pinned', msg.payload.pinned);
            const pinBtn = msgEl.querySelector('.pin-btn');
            if (pinBtn) {
              pinBtn.classList.toggle('pinned', msg.payload.pinned);
              pinBtn.textContent = msg.payload.pinned ? '📌' : '📍';
            }
          }
        }
        break;

      case 'workspaceDocuments':
        renderDocsModal(msg.payload.documents, msg.payload.workspaceSlug);
        break;

      case 'documentDeleted':
        // Just refresh — already re-fetched
        break;

      case 'exportResult':
        appendMessage('system', `💾 Chat diekspor ke: ${msg.payload.path}`);
        break;

      case 'mcpTools':
        renderMcpToolsInSettings(msg.payload.tools);
        break;

      case 'agentRuns':
        renderAgentRunsList(msg.payload.runs);
        break;

      case 'toolCall':
        renderToolCallCard(msg.payload);
        break;

      case 'toolResult':
        renderToolResultCard(msg.payload);
        break;

      case 'iteration':
        renderIterationMarker(msg.payload.iteration, msg.payload.maxIterations);
        break;
    }
  }

  function renderWorkspaces(workspaces, activeSlug) {
    state.workspaces = workspaces;
    els.workspaceSelect.innerHTML =
      '<option value="">— Select Workspace —</option>' +
      workspaces.map((w) =>
        `<option value="${w.slug}"${w.slug === activeSlug ? ' selected' : ''}>${escapeHtml(w.name)} (${w.documents} docs)</option>`
      ).join('');
    if (activeSlug) {
      state.activeWorkspaceSlug = activeSlug;
    } else if (workspaces.length > 0 && !state.activeWorkspaceSlug) {
      state.activeWorkspaceSlug = workspaces[0].slug;
      els.workspaceSelect.value = workspaces[0].slug;
    }
    updateActionButtons();
  }

  function updateActionButtons() {
    const enabled = !!state.activeWorkspaceSlug && state.authOk;
    setDisabled(els.btnNewThread, !enabled);
    setDisabled(els.btnUpload, !enabled);
    setDisabled(els.btnSearch, !enabled);
  }

  function renderSearchResults(results) {
    if (!results || results.length === 0) {
      appendMessage('system', '🔍 No relevant documents found.');
      return;
    }
    const msgEl = appendMessage('assistant', `Found **${results.length}** relevant documents:`, 'search');
    const body = msgEl.querySelector('.message-body');

    const list = document.createElement('div');
    list.className = 'search-results';
    results.forEach((r, i) => {
      const item = document.createElement('div');
      item.className = 'search-result-item';
      item.innerHTML =
        `<div class="search-result-title">` +
        `<span class="search-result-name">${i + 1}. ${escapeHtml(r.document.name)}</span>` +
        `<span class="search-result-score">${(r.score * 100).toFixed(1)}%</span>` +
        `</div>` +
        `<div class="search-result-meta">Type: ${escapeHtml(r.document.type)}</div>` +
        `<div class="search-result-text">${escapeHtml(r.text.slice(0, 400))}${r.text.length > 400 ? '...' : ''}</div>`;
      list.appendChild(item);
    });
    body.appendChild(list);
    scrollToBottom();
  }

  function renderUploadResult(payload) {
    if (payload.success) {
      const msgEl = appendMessage('assistant', `✅ ${payload.message}`, 'upload');
      if (payload.documents && payload.documents.length > 0) {
        const body = msgEl.querySelector('.message-body');
        const docsDiv = document.createElement('div');
        docsDiv.className = 'upload-result';
        payload.documents.forEach((d) => {
          const doc = document.createElement('div');
          doc.className = 'upload-doc';
          doc.innerHTML = `📄 <strong>${escapeHtml(d.name)}</strong> • ID: ${escapeHtml(d.id)} • Type: ${escapeHtml(d.type)}`;
          docsDiv.appendChild(doc);
        });
        body.appendChild(docsDiv);
      }
    } else {
      appendMessage('error', `❌ Upload failed: ${payload.message}`);
    }
    scrollToBottom();
  }

  function addFollowups(msgEl) {
    const cmd = state.activeCommand;
    const followups = {
      ask: [
        { label: 'More detail', prompt: 'Explain the answer above in more detail' },
        { label: 'Code example', prompt: 'Give me a code example' },
        { label: 'Search related documents', prompt: '/search related documents' },
      ],
      summarize: [
        { label: 'Bullet points', prompt: 'Summarize as bullet points' },
      ],
      explain: [
        { label: 'How to use', prompt: 'How do I use this code?' },
        { label: 'Potential bugs', prompt: 'What are the potential bugs?' },
      ],
      search: [
        { label: 'Ask about doc #1', prompt: 'Ask about the first document' },
      ],
      agent: [
        { label: 'Continue', prompt: 'Continue from the previous result' },
        { label: 'Summarize', prompt: 'Summarize the agent findings above' },
      ],
    };

    const list = followups[cmd];
    if (!list || list.length === 0) return;

    const followupsEl = document.createElement('div');
    followupsEl.className = 'followups';
    list.forEach((f) => {
      const btn = document.createElement('button');
      btn.className = 'followup-btn';
      btn.textContent = f.label;
      btn.addEventListener('click', () => {
        const text = f.prompt.startsWith('/search')
          ? f.prompt.replace(/^\/search\s*/, '')
          : f.prompt;
        if (f.prompt.startsWith('/search')) {
          setActiveCommand('search');
        } else {
          setActiveCommand('ask');
        }
        els.input.value = text;
        sendMessage();
      });
      followupsEl.appendChild(btn);
    });

    msgEl.querySelector('.message-content').appendChild(followupsEl);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Settings modal
  // ──────────────────────────────────────────────────────────────────────────
  function openSettings() {
    vscode.postMessage({ type: 'getSettings' });
    vscode.postMessage({ type: 'getStats' });
    renderSettingsModal();
    els.settingsModal.classList.remove('hidden');
  }

  function closeSettings() {
    els.settingsModal.classList.add('hidden');
  }

  function renderSettingsModal() {
    els.settingsModal.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <div class="modal-title">⚙️ AnythingLLM Settings</div>
          <button class="modal-close" id="modal-close" title="Close">✕</button>
        </div>
        <div class="modal-tabs">
          <button class="modal-tab active" data-tab="general">General</button>
          <button class="modal-tab" data-tab="api">API</button>
          <button class="modal-tab" data-tab="theme">Theme</button>
          <button class="modal-tab agent-tab" data-tab="agent">Agent & MCP</button>
          <button class="modal-tab token-tab" data-tab="token">Tokens</button>
          <button class="modal-tab" data-tab="advanced">Advanced</button>
          <button class="modal-tab about-tab" data-tab="about">About</button>
        </div>
        <div class="modal-body">
          <div class="settings-panel active" data-panel="general"></div>
          <div class="settings-panel" data-panel="api"></div>
          <div class="settings-panel" data-panel="theme"></div>
          <div class="settings-panel" data-panel="agent"></div>
          <div class="settings-panel" data-panel="token"></div>
          <div class="settings-panel" data-panel="advanced"></div>
          <div class="settings-panel" data-panel="about"></div>
        </div>
        <div class="modal-footer">
          <span class="setting-status" id="setting-status">&nbsp;</span>
          <div>
            <button class="btn-secondary" id="btn-cancel-settings">Cancel</button>
            <button class="btn-primary" id="btn-save-settings">Save Changes</button>
          </div>
        </div>
      </div>
    `;

    populateGeneral();
    populateApi();
    populateTheme();
    populateAgent();
    populateToken();
    populateAdvanced();
    populateAbout();
    bindSettingsEvents();
    populateSettingsForm(state.settings);
  }

  function populateAgent() {
    const panel = els.settingsModal.querySelector('[data-panel="agent"]');
    panel.innerHTML = `
      <div class="setting-row">
        <label class="setting-label">Agent Planner Strategy</label>
        <span class="setting-desc">How the agent builds its plan.<br>
          • <strong>react</strong> — Reason→Act→Observe loop (default, most flexible)<br>
          • <strong>heuristic</strong> — Pattern-match intent (fast, deterministic)<br>
          • <strong>llm</strong> — Ask the LLM to produce a JSON plan<br>
          • <strong>native</strong> — Use the model's function-calling API (if supported)
        </span>
        <div class="setting-control">
          <select class="setting-select" id="set-agent-planner">
            <option value="react">react — ReAct loop</option>
            <option value="heuristic">heuristic — Pattern matching</option>
            <option value="llm">llm — LLM-based planner</option>
            <option value="native">native — Function calling API</option>
          </select>
        </div>
      </div>

      <div class="setting-row">
        <label class="setting-label">Max Iterations</label>
        <span class="setting-desc">Maksimum iterasi ReAct loop (1-10). Default 5.</span>
        <div class="setting-control">
          <input type="number" class="setting-input" id="set-agent-max-iter" min="1" max="10" />
        </div>
      </div>

      <div class="setting-row">
        <label class="setting-label">Multi-turn Context</label>
        <span class="setting-desc">Send the last 10 messages as context to the LLM (more contextual answers).</span>
        <div class="setting-control">
          <label class="setting-toggle">
            <input type="checkbox" id="set-multi-turn" />
            <span class="toggle-switch"></span>
            <span id="multi-turn-toggle-label">On</span>
          </label>
        </div>
      </div>

      <div class="setting-row">
        <label class="setting-label">Collapse Think Blocks</label>
        <span class="setting-desc">Auto-collapse AI reasoning (&lt;think&gt; / chain-of-thought). Click to expand.</span>
        <div class="setting-control">
          <label class="setting-toggle">
            <input type="checkbox" id="set-think-collapsed" />
            <span class="toggle-switch"></span>
            <span id="think-collapsed-toggle-label">On</span>
          </label>
        </div>
      </div>

      <div class="setting-row">
        <label class="setting-label">Reset Tool Permissions</label>
        <span class="setting-desc">Reset "always allow" permission untuk tool destruktif (file_write, terminal_exec).</span>
        <div class="setting-control">
          <button class="btn-secondary" id="btn-reset-perms">Reset Permissions</button>
        </div>
      </div>

      <div class="setting-row">
        <label class="setting-label">Agent Run History</label>
        <span class="setting-desc">Agent execution history is saved automatically for audit.</span>
        <div class="setting-control">
          <button class="btn-secondary" id="btn-refresh-runs">Refresh</button>
          <button class="btn-secondary" id="btn-open-runs-folder">Open Folder</button>
          <button class="btn-danger" id="btn-clear-runs">Clear All</button>
        </div>
        <div class="setting-control" style="margin-top:8px;">
          <div class="agent-runs-list" style="max-height:200px; overflow-y:auto;"></div>
        </div>
      </div>

      <div class="setting-row">
        <label class="setting-label">MCP Servers (Model Context Protocol)</label>
        <span class="setting-desc">Konfigurasi server MCP eksternal. Edit di settings.json (anythingllm.mcpServers).</span>
        <div class="setting-control">
          <label class="setting-toggle">
            <input type="checkbox" id="set-auto-start-mcp" />
            <span class="toggle-switch"></span>
            <span id="mcp-toggle-label">On</span>
          </label>
          <span style="margin-left:8px; font-size:11px; color:var(--vscode-descriptionForeground);">Auto-start MCP servers when the extension activates</span>
        </div>
        <div class="setting-control" style="margin-top:8px;">
          <button class="btn-secondary" id="btn-refresh-mcp">Refresh MCP Tools</button>
        </div>
        <div class="setting-control" style="margin-top:8px;">
          <div class="mcp-tools-list" style="max-height:200px; overflow-y:auto;"></div>
        </div>
      </div>
    `;
  }

  function populateToken() {
    const panel = els.settingsModal.querySelector('[data-panel="token"]');
    panel.innerHTML = `
      <div class="setting-row">
        <label class="setting-label">Daily Cost Budget (USD)</label>
        <span class="setting-desc">A warning appears when the estimated daily cost exceeds the budget.</span>
        <div class="setting-control">
          <input type="number" class="setting-input" id="set-cost-budget" min="0" step="0.1" />
        </div>
      </div>

      <div class="setting-row">
        <label class="setting-label">Today's Usage</label>
        <span class="setting-desc">Estimated tokens & cost for today.</span>
        <div class="setting-control" id="token-stats-display" style="font-size:12px; display:grid; grid-template-columns: 1fr 1fr; gap:4px 12px;"></div>
      </div>

      <div class="setting-row">
        <label class="setting-label">All-time Usage</label>
        <span class="setting-desc">Cumulative total since the extension activated.</span>
        <div class="setting-control" id="token-total-display" style="font-size:12px; display:grid; grid-template-columns: 1fr 1fr; gap:4px 12px;"></div>
      </div>

      <div class="setting-row">
        <label class="setting-label">Note on Cost Estimates</label>
        <span class="setting-desc">Estimates use the heuristic ~4 chars/token (English) / ~2 chars/token (CJK). Per-1K-token rates are hard-coded in TokenTracker for common models. For self-hosted AnythingLLM instances, the actual cost is $0 (local).</span>
      </div>
    `;
  }

  function populateGeneral() {
    const panel = els.settingsModal.querySelector('[data-panel="general"]');
    panel.innerHTML = `
      <div class="setting-row">
        <label class="setting-label">Default Workspace</label>
        <span class="setting-desc">Workspace slug auto-selected when the extension activates.</span>
        <div class="setting-control">
          <input type="text" class="setting-input" id="set-default-workspace" placeholder="e.g. my-workspace" />
        </div>
      </div>

      <div class="setting-row">
        <label class="setting-label">Chat Mode</label>
        <span class="setting-desc">Chat = LLM + RAG; Query = document retrieval without an LLM (saves tokens).</span>
        <div class="setting-control">
          <select class="setting-select" id="set-chat-mode">
            <option value="chat">chat — LLM + RAG</option>
            <option value="query">query — retrieval only</option>
          </select>
        </div>
      </div>

      <div class="setting-row">
        <label class="setting-label">Show Citations</label>
        <span class="setting-desc">Show source documents under chat responses.</span>
        <div class="setting-control">
          <label class="setting-toggle">
            <input type="checkbox" id="set-show-citations" />
            <span class="toggle-switch"></span>
            <span id="citations-toggle-label">On</span>
          </label>
        </div>
      </div>

      <div class="setting-row">
        <label class="setting-label">Agent Mode (Tier 3)</label>
        <span class="setting-desc">Enable agentic mode — the agent will build a plan and call tools autonomously for complex goals.</span>
        <div class="setting-control">
          <label class="setting-toggle">
            <input type="checkbox" id="set-agent-mode" />
            <span class="toggle-switch"></span>
            <span id="agent-toggle-label">Off</span>
          </label>
        </div>
      </div>
    `;
  }

  function populateApi() {
    const panel = els.settingsModal.querySelector('[data-panel="api"]');
    panel.innerHTML = `
      <div class="setting-row">
        <label class="setting-label">Base URL</label>
        <span class="setting-desc">URL root instance AnythingLLM Anda (tanpa trailing slash).</span>
        <div class="setting-control">
          <input type="text" class="setting-input" id="set-base-url" placeholder="https://ai.example.com/api" />
        </div>
      </div>

      <div class="setting-row">
        <label class="setting-label">API Key</label>
        <span class="setting-desc">Stored securely in VS Code SecretStorage (not in plain text in settings.json).</span>
        <div class="setting-control" style="display:flex; gap:8px; align-items:center;">
          <input type="password" class="setting-input" id="set-api-key" placeholder="••••••••••••••••" style="flex:1;" />
          <button class="btn-primary" id="btn-update-api-key">Update Key</button>
        </div>
        <div class="setting-control" style="margin-top:8px;">
          <span class="setting-status" id="api-key-status">&nbsp;</span>
        </div>
      </div>

      <div class="setting-row">
        <label class="setting-label">Test Connection</label>
        <span class="setting-desc">Verify the connection to your AnythingLLM instance with the current configuration.</span>
        <div class="setting-control">
          <button class="btn-secondary" id="btn-test-conn">Test Connection</button>
          <span class="setting-status" id="api-conn-status" style="margin-left:10px;">&nbsp;</span>
        </div>
      </div>

      <div class="setting-row">
        <label class="setting-label">Request Timeout (ms)</label>
        <span class="setting-desc">Timeout request ke API. Default 120000 (2 menit).</span>
        <div class="setting-control">
          <input type="number" class="setting-input" id="set-timeout" min="5000" max="600000" step="1000" />
        </div>
      </div>

      <div class="setting-row">
        <label class="setting-label">Max Retries</label>
        <span class="setting-desc">Retry maksimum untuk error 5xx / 429 / network. Default 3.</span>
        <div class="setting-control">
          <input type="number" class="setting-input" id="set-retries" min="0" max="10" />
        </div>
      </div>
    `;
  }

  function populateTheme() {
    const panel = els.settingsModal.querySelector('[data-panel="theme"]');
    panel.innerHTML = `
      <div class="setting-row">
        <label class="setting-label">Theme</label>
        <span class="setting-desc">Chat panel theme. Auto = follow VS Code's theme.</span>
        <div class="setting-control">
          <div class="theme-swatch-group">
            <div class="theme-swatch swatch-auto" data-theme="auto">Auto</div>
            <div class="theme-swatch swatch-dark" data-theme="dark">Dark</div>
            <div class="theme-swatch swatch-light" data-theme="light">Light</div>
          </div>
        </div>
      </div>

      <div class="setting-row">
        <label class="setting-label">Accent Color</label>
        <span class="setting-desc">Accent color for buttons, badges, citations, and the agent plan.</span>
        <div class="setting-control">
          <div class="accent-swatch-group">
            <div class="accent-swatch accent-blue" data-accent="blue" title="Blue"></div>
            <div class="accent-swatch accent-purple" data-accent="purple" title="Purple"></div>
            <div class="accent-swatch accent-green" data-accent="green" title="Green"></div>
            <div class="accent-swatch accent-orange" data-accent="orange" title="Orange"></div>
            <div class="accent-swatch accent-pink" data-accent="pink" title="Pink"></div>
          </div>
        </div>
      </div>

      <div class="setting-row">
        <label class="setting-label">Preview</label>
        <span class="setting-desc">Preview of how messages look with the current theme.</span>
        <div class="setting-control">
          <div style="display:flex; flex-direction:column; gap:10px; padding:10px; background:var(--llm-bg); border-radius:6px; border:1px solid var(--vscode-panel-border);">
            <div class="message role-user" style="max-width:80%;">
              <div class="message-avatar">🧑</div>
              <div class="message-content">
                <div class="message-header"><span class="message-role">You</span><span class="message-time">now</span></div>
                <div class="message-body">Hi, this is a sample user message on the right side.</div>
              </div>
            </div>
            <div class="message role-assistant" style="max-width:80%;">
              <div class="message-avatar">⚡</div>
              <div class="message-content">
                <div class="message-header"><span class="message-role">AnythingLLM</span><span class="message-time">now</span></div>
                <div class="message-body">Hi! This is a sample AI response on the left side.</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function populateAdvanced() {
    const panel = els.settingsModal.querySelector('[data-panel="advanced"]');
    panel.innerHTML = `
      <div class="setting-row">
        <label class="setting-label">Telemetry</label>
        <span class="setting-desc">Local log: request count, error count, latency. Does not send data to any third party.</span>
        <div class="setting-control">
          <label class="setting-toggle">
            <input type="checkbox" id="set-telemetry" />
            <span class="toggle-switch"></span>
            <span id="telemetry-toggle-label">On</span>
          </label>
        </div>
      </div>

      <div class="setting-row">
        <label class="setting-label">Usage Statistics</label>
        <span class="setting-desc">Statistics for this session (since the extension activated).</span>
        <div class="setting-control" id="stats-display" style="font-size:12px; display:grid; grid-template-columns: 1fr 1fr; gap:4px 12px;"></div>
        <div class="setting-control" style="margin-top:8px;">
          <button class="btn-secondary" id="btn-reset-stats">Reset Stats</button>
        </div>
      </div>

      <div class="setting-row">
        <label class="setting-label">Output Log</label>
        <span class="setting-desc">Open the VS Code Output panel to view extension logs.</span>
        <div class="setting-control">
          <button class="btn-secondary" id="btn-show-output">Show Output Log</button>
        </div>
      </div>

      <div class="setting-row">
        <label class="setting-label">Danger Zone</label>
        <span class="setting-desc">Remove the API key from SecretStorage. You'll need to set it again to use the extension.</span>
        <div class="setting-control" style="margin-top:8px;">
          <button class="btn-danger" id="btn-clear-api-key">Clear API Key</button>
        </div>
      </div>
    `;
  }

  function populateAbout() {
    const panel = els.settingsModal.querySelector('[data-panel="about"]');
    panel.innerHTML = `
      <div class="setting-row about-hero">
        <div class="about-logo">⚡</div>
        <div>
          <div class="about-title">AnythingLLM for VS Code</div>
          <div class="about-version">v0.3.5 · MIT License</div>
          <div class="about-tagline">AI Chat & AI Agent extension for VS Code, powered by your own AnythingLLM instance.</div>
        </div>
      </div>

      <div class="setting-row">
        <label class="setting-label">💜 Support this project</label>
        <span class="setting-desc">
          This extension is free and open source. If it saves you time, consider buying me a coffee.
          Donations are <strong>voluntary</strong> — every feature works without paying a cent.
        </span>
        <div class="setting-control donate-buttons">
          <button class="btn-donate btn-saweria" id="btn-donate-saweria">
            <span class="donate-icon">🟠</span>
            <span class="donate-label">Saweria</span>
            <span class="donate-sub">IDR</span>
          </button>
          <button class="btn-donate btn-paypal" id="btn-donate-paypal">
            <span class="donate-icon">🔵</span>
            <span class="donate-label">PayPal</span>
            <span class="donate-sub">USD</span>
          </button>
        </div>
      </div>

      <div class="setting-row">
        <label class="setting-label">Useful links</label>
        <div class="setting-control" style="display:grid; gap:6px; font-size:12px;">
          <a href="https://github.com/riphputra/vscode-anythingllm-chat" target="_blank" rel="noopener">📦 Source code &amp; issues</a>
          <a href="https://docs.anythingllm.com/" target="_blank" rel="noopener">📚 AnythingLLM docs</a>
          <a href="https://github.com/Mintplex-Labs/anything-llm" target="_blank" rel="noopener">🚀 AnythingLLM project</a>
        </div>
      </div>
    `;
  }

  function populateSettingsForm(s) {
    if (!s) return;
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
    const check = (id, val) => { const el = document.getElementById(id); if (el) el.checked = val; };

    set('set-default-workspace', s.defaultWorkspace || '');
    set('set-chat-mode', s.chatMode || 'chat');
    check('set-show-citations', s.showCitations !== false);
    check('set-agent-mode', !!s.agentMode || state.agentMode);
    updateToggleLabel('set-show-citations', 'citations-toggle-label');
    updateToggleLabel('set-agent-mode', 'agent-toggle-label');

    set('set-base-url', s.baseUrl || '');
    set('set-timeout', s.requestTimeoutMs || 120000);
    set('set-retries', s.maxRetries ?? 3);
    check('set-telemetry', s.enableTelemetry !== false);
    updateToggleLabel('set-telemetry', 'telemetry-toggle-label');

    // v0.3.0 new fields
    set('set-agent-planner', s.agentPlanner || 'react');
    set('set-agent-max-iter', s.agentMaxIterations ?? 5);
    check('set-multi-turn', s.multiTurnContext !== false);
    updateToggleLabel('set-multi-turn', 'multi-turn-toggle-label');
    check('set-think-collapsed', s.thinkBlocksCollapsed !== false);
    updateToggleLabel('set-think-collapsed', 'think-collapsed-toggle-label');
    check('set-auto-start-mcp', s.autoStartMcp !== false);
    updateToggleLabel('set-auto-start-mcp', 'mcp-toggle-label');
    set('set-cost-budget', s.costBudgetUsd ?? 1.0);

    // API key status
    const apiStatus = document.getElementById('api-key-status');
    if (apiStatus) {
      apiStatus.className = 'setting-status ' + (s.hasApiKey ? 'ok' : 'error');
      apiStatus.textContent = s.hasApiKey ? '✓ API key saved' : '✗ No API key yet';
    }

    // Theme & accent
    document.querySelectorAll('.theme-swatch').forEach((el) => {
      el.classList.toggle('selected', el.dataset.theme === (s.theme || 'auto'));
    });
    document.querySelectorAll('.accent-swatch').forEach((el) => {
      el.classList.toggle('selected', el.dataset.accent === (s.accent || 'blue'));
    });

    // Token stats
    const tokenStats = document.getElementById('token-stats-display');
    if (tokenStats && state.lastStats) {
      tokenStats.innerHTML =
        `<div>Today tokens: <strong>${(state.lastStats.todayTokens || 0).toLocaleString()}</strong></div>` +
        `<div>Est. cost today: <strong>$${((state.lastStats.estimatedCostUsd || 0)).toFixed(4)}</strong></div>` +
        `<div>Budget: <strong>$${(state.lastStats.costBudgetUsd || 0).toFixed(2)}</strong></div>`;
    }
    const tokenTotal = document.getElementById('token-total-display');
    if (tokenTotal && state.lastStats) {
      tokenTotal.innerHTML =
        `<div>Total requests: <strong>${state.lastStats.totalRequests || 0}</strong></div>` +
        `<div>Total tokens: <strong>${(state.lastStats.totalTokens || 0).toLocaleString()}</strong></div>` +
        `<div>Tokens in: <strong>${(state.lastStats.tokensIn || 0).toLocaleString()}</strong></div>` +
        `<div>Tokens out: <strong>${(state.lastStats.tokensOut || 0).toLocaleString()}</strong></div>` +
        `<div>Total cost: <strong>$${((state.lastStats.estimatedCostUsd || 0)).toFixed(4)}</strong></div>`;
    }
  }

  function updateToggleLabel(checkboxId, labelId) {
    const cb = document.getElementById(checkboxId);
    const lbl = document.getElementById(labelId);
    if (cb && lbl) lbl.textContent = cb.checked ? 'On' : 'Off';
  }

  function showSettingStatus(kind, message) {
    const el = document.getElementById('setting-status');
    if (!el) return;
    el.className = 'setting-status ' + (kind === 'ok' ? 'ok' : 'error');
    el.textContent = message || '';
    setTimeout(() => {
      if (el) el.textContent = '\u00A0';
    }, 3000);
  }

  function bindSettingsEvents() {
    // Tab switching
    els.settingsModal.querySelectorAll('.modal-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        els.settingsModal.querySelectorAll('.modal-tab').forEach((t) => t.classList.remove('active'));
        els.settingsModal.querySelectorAll('.settings-panel').forEach((p) => p.classList.remove('active'));
        tab.classList.add('active');
        els.settingsModal.querySelector(`[data-panel="${tab.dataset.tab}"]`).classList.add('active');
        if (tab.dataset.tab === 'advanced' || tab.dataset.tab === 'token') {
          vscode.postMessage({ type: 'getStats' });
        }
        if (tab.dataset.tab === 'agent') {
          vscode.postMessage({ type: 'getAgentRuns' });
          vscode.postMessage({ type: 'getMcpTools' });
        }
      });
    });

    // Close handlers
    onId('modal-close', 'click', closeSettings);
    onId('btn-cancel-settings', 'click', closeSettings);
    on(els.settingsModal, 'click', (e) => {
      if (e.target === els.settingsModal) closeSettings();
    });

    // Toggle labels
    ['set-show-citations', 'set-agent-mode', 'set-telemetry', 'set-multi-turn', 'set-think-collapsed', 'set-auto-start-mcp'].forEach((id) => {
      const cb = document.getElementById(id);
      if (cb) {
        cb.addEventListener('change', () => {
          const labelMap = {
            'set-show-citations': 'citations-toggle-label',
            'set-agent-mode': 'agent-toggle-label',
            'set-telemetry': 'telemetry-toggle-label',
            'set-multi-turn': 'multi-turn-toggle-label',
            'set-think-collapsed': 'think-collapsed-toggle-label',
            'set-auto-start-mcp': 'mcp-toggle-label',
          };
          updateToggleLabel(id, labelMap[id]);
        });
      }
    });

    // Theme swatches
    els.settingsModal.querySelectorAll('.theme-swatch').forEach((sw) => {
      sw.addEventListener('click', () => {
        els.settingsModal.querySelectorAll('.theme-swatch').forEach((s) => s.classList.remove('selected'));
        sw.classList.add('selected');
        state.config.theme = sw.dataset.theme;
        applyTheme();
      });
    });

    // Accent swatches
    els.settingsModal.querySelectorAll('.accent-swatch').forEach((sw) => {
      sw.addEventListener('click', () => {
        els.settingsModal.querySelectorAll('.accent-swatch').forEach((s) => s.classList.remove('selected'));
        sw.classList.add('selected');
        state.config.accent = sw.dataset.accent;
        applyTheme();
      });
    });

    // Save
    onId('btn-save-settings', 'click', () => {
      const payload = {
        baseUrl: document.getElementById('set-base-url')?.value,
        chatMode: document.getElementById('set-chat-mode')?.value,
        defaultWorkspace: document.getElementById('set-default-workspace')?.value,
        showCitations: document.getElementById('set-show-citations')?.checked,
        enableTelemetry: document.getElementById('set-telemetry')?.checked,
        requestTimeoutMs: parseInt(document.getElementById('set-timeout')?.value, 10),
        maxRetries: parseInt(document.getElementById('set-retries')?.value, 10),
        theme: state.config.theme,
        accent: state.config.accent,
        agentMode: document.getElementById('set-agent-mode')?.checked,
        // v0.3.0
        agentPlanner: document.getElementById('set-agent-planner')?.value,
        agentMaxIterations: parseInt(document.getElementById('set-agent-max-iter')?.value, 10),
        multiTurnContext: document.getElementById('set-multi-turn')?.checked,
        thinkBlocksCollapsed: document.getElementById('set-think-collapsed')?.checked,
        autoStartMcp: document.getElementById('set-auto-start-mcp')?.checked,
        costBudgetUsd: parseFloat(document.getElementById('set-cost-budget')?.value || '1.0'),
      };
      // Apply agent mode immediately
      setAgentMode(!!payload.agentMode);
      // Update multi-turn hint
      const mt = document.getElementById('multi-turn-hint');
      if (mt) {
        mt.textContent = payload.multiTurnContext ? '🔗 Multi-turn: ON' : '🔗 Multi-turn: OFF';
        mt.classList.toggle('disabled', !payload.multiTurnContext);
      }
      persistUiState();
      vscode.postMessage({ type: 'saveSettings', payload });
    });

    // Reset permissions
    const btnResetPerms = document.getElementById('btn-reset-perms');
    if (btnResetPerms) {
      btnResetPerms.addEventListener('click', () => {
        vscode.postMessage({ type: 'resetPermissions' });
      });
    }

    // Agent runs
    const btnRefreshRuns = document.getElementById('btn-refresh-runs');
    if (btnRefreshRuns) {
      btnRefreshRuns.addEventListener('click', () => {
        vscode.postMessage({ type: 'getAgentRuns' });
      });
    }
    const btnOpenRuns = document.getElementById('btn-open-runs-folder');
    if (btnOpenRuns) {
      btnOpenRuns.addEventListener('click', () => {
        vscode.postMessage({ type: 'openAgentRunsFolder' });
      });
    }
    const btnClearRuns = document.getElementById('btn-clear-runs');
    if (btnClearRuns) {
      btnClearRuns.addEventListener('click', () => {
        if (confirm('Delete all agent run history?')) {
          vscode.postMessage({ type: 'clearAgentRuns' });
        }
      });
    }

    // MCP
    const btnRefreshMcp = document.getElementById('btn-refresh-mcp');
    if (btnRefreshMcp) {
      btnRefreshMcp.addEventListener('click', () => {
        vscode.postMessage({ type: 'getMcpTools' });
      });
    }

    // Update API key — delegates to native VS Code input
    onId('btn-update-api-key', 'click', () => {
      vscode.postMessage({ type: 'setApiKey' });
    });

    // Test connection
    onId('btn-test-conn', 'click', () => {
      const baseUrl = document.getElementById('set-base-url')?.value;
      const status = document.getElementById('api-conn-status');
      if (status) {
        status.className = 'setting-status';
        status.textContent = '⏳ Menguji koneksi...';
      }
      vscode.postMessage({ type: 'verifyApiConnection', payload: { baseUrl } });
    });

    // Reset stats
    onId('btn-reset-stats', 'click', () => {
      vscode.postMessage({ type: 'resetTelemetry' });
    });

    // Show output log
    onId('btn-show-output', 'click', () => {
      // Trigger via settings — we'll send a message that opens output channel
      // Implemented via command URI: not possible directly from webview for output channel
      // Instead, we just inform user — they can use Command Palette
      const status = document.getElementById('setting-status');
      if (status) {
        status.className = 'setting-status ok';
        status.textContent = 'Open the Command Palette → "AnythingLLM: Show Output Log"';
        setTimeout(() => { status.textContent = '\u00A0'; }, 3000);
      }
    });

    // Clear API key
    onId('btn-clear-api-key', 'click', () => {
      if (confirm('Are you sure you want to delete the API key? You will need to set it again to use the extension.')) {
        vscode.postMessage({ type: 'clearApiKey' });
      }
    });

    // Donate buttons (About tab)
    const btnSaweria = document.getElementById('btn-donate-saweria');
    if (btnSaweria) {
      btnSaweria.addEventListener('click', () => {
        vscode.postMessage({ type: 'openDonate' });
      });
    }
    const btnPaypal = document.getElementById('btn-donate-paypal');
    if (btnPaypal) {
      btnPaypal.addEventListener('click', () => {
        vscode.postMessage({ type: 'openDonate' });
      });
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Event listeners
  // ──────────────────────────────────────────────────────────────────────────
  function setActiveCommand(cmd, skipFocus) {
    state.activeCommand = cmd;
    els.activeCommand.textContent = cmd;
    els.cmdBtns.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.command === cmd);
    });

    const placeholders = {
      ask: 'Type a question for the AnythingLLM workspace...',
      summarize: 'Type a summarization focus (or leave blank to summarize the active file)...',
      explain: 'Type an additional question (or leave blank to explain the active file)...',
      search: 'Type a document search query...',
      upload: 'Click the send button to upload the active file...',
      agent: '🤖 Type a high-level goal — the agent will plan + execute tools...',
    };
    els.input.placeholder = placeholders[cmd] || placeholders.ask;

    if (['summarize', 'explain'].includes(cmd)) {
      vscode.postMessage({ type: 'getActiveEditorContext' });
    }
    if (!skipFocus) els.input.focus();
  }

  function autoResize() {
    els.input.style.height = 'auto';
    els.input.style.height = Math.min(els.input.scrollHeight, 200) + 'px';
  }

  // Workspace select
  on(els.workspaceSelect, 'change', (e) => {
    const slug = e.target.value;
    if (slug) {
      vscode.postMessage({ type: 'selectWorkspace', payload: { slug } });
    }
  });

  // Command buttons
  els.cmdBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const cmd = btn.dataset.command;
      if (cmd === 'agent') {
        setAgentMode(!state.agentMode);
      } else {
        // If was in agent mode, turn it off
        if (state.agentMode) setAgentMode(false);
        setActiveCommand(cmd);
      }
    });
  });

  // Header actions
  on(els.btnAgent, 'click', () => {
    setAgentMode(!state.agentMode);
    if (els.input) els.input.focus();
  });

  on(els.btnNewThread, 'click', () => {
    const name = prompt('Nama thread baru:', 'New Thread');
    if (name !== null) {
      vscode.postMessage({
        type: 'newThread',
        payload: { name, workspaceSlug: state.activeWorkspaceSlug },
      });
    }
  });

  on(els.btnUpload, 'click', () => {
    setActiveCommand('upload');
    vscode.postMessage({
      type: 'uploadActiveFile',
      payload: { workspaceSlug: state.activeWorkspaceSlug },
    });
    showProgress('Mengupload file aktif...');
  });

  on(els.btnSearch, 'click', () => {
    setActiveCommand('search');
    if (els.input) els.input.focus();
  });

  on(els.btnClear, 'click', () => {
    if (confirm('Bersihkan semua pesan chat?')) {
      vscode.postMessage({ type: 'clearChat' });
    }
  });

  on(els.btnSettings, 'click', openSettings);

  on(els.btnSetApiKey, 'click', () => {
    vscode.postMessage({ type: 'setApiKey' });
  });

  // Input
  on(els.input, 'input', autoResize);
  on(els.input, 'keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  on(els.btnSend, 'click', sendMessage);
  on(els.btnStop, 'click', () => {
    vscode.postMessage({ type: 'cancelRequest' });
  });

  // Track active editor changes (debounced)
  let editorCheckTimer;
  document.addEventListener('click', () => {
    clearTimeout(editorCheckTimer);
    editorCheckTimer = setTimeout(() => {
      if (['summarize', 'explain'].includes(state.activeCommand)) {
        vscode.postMessage({ type: 'getActiveEditorContext' });
      }
    }, 200);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // v0.3.0 — Think blocks (collapsible reasoning)
  // ──────────────────────────────────────────────────────────────────────────
  function handleThinkingChunk(text) {
    if (!state.currentAssistantMessageEl) {
      state.currentAssistantMessageEl = appendMessage('assistant', '', state.agentMode ? 'agent' : state.activeCommand);
    }
    const contentEl = state.currentAssistantMessageEl.querySelector('.message-content');
    let thinkBlock = contentEl.querySelector('.think-block');
    if (!thinkBlock) {
      thinkBlock = document.createElement('div');
      thinkBlock.className = 'think-block collapsed';
      thinkBlock.innerHTML =
        `<div class="think-block-header">` +
          `<span class="think-toggle">▶</span>` +
          `<span class="think-icon">💭</span>` +
          `<span class="think-label">AI Thinking</span>` +
          `<span class="think-stats"></span>` +
        `</div>` +
        `<div class="think-block-body"></div>`;
      contentEl.insertBefore(thinkBlock, contentEl.querySelector('.message-body'));
      // Insert before the body
      const body = contentEl.querySelector('.message-body');
      contentEl.insertBefore(thinkBlock, body);

      thinkBlock.querySelector('.think-block-header').addEventListener('click', () => {
        thinkBlock.classList.toggle('collapsed');
        thinkBlock.classList.toggle('expanded');
        const toggle = thinkBlock.querySelector('.think-toggle');
        toggle.textContent = thinkBlock.classList.contains('expanded') ? '▼' : '▶';
      });
    }
    const body = thinkBlock.querySelector('.think-block-body');
    body.textContent += text;
    const stats = thinkBlock.querySelector('.think-stats');
    stats.textContent = `${body.textContent.length} chars`;
    scrollToBottom();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // v0.3.0 — History loading
  // ──────────────────────────────────────────────────────────────────────────
  function handleHistoryLoaded(session) {
    if (!session || !session.messages || session.messages.length === 0) {
      // Show welcome
      return;
    }
    // Clear welcome
    const welcome = els.messages.querySelector('.welcome');
    if (welcome) welcome.remove();

    els.messages.innerHTML = '';
    for (const m of session.messages) {
      const msgEl = appendMessage(m.role, m.content || '', m.command);
      msgEl.setAttribute('data-message-id', m.id);
      if (m.pinned) {
        msgEl.classList.add('pinned');
      }
      // Render reasoning as collapsible block
      if (m.reasoning) {
        const contentEl = msgEl.querySelector('.message-content');
        const body = msgEl.querySelector('.message-body');
        const thinkBlock = document.createElement('div');
        thinkBlock.className = 'think-block collapsed';
        thinkBlock.innerHTML =
          `<div class="think-block-header">` +
            `<span class="think-toggle">▶</span>` +
            `<span class="think-icon">💭</span>` +
            `<span class="think-label">AI Thinking</span>` +
            `<span class="think-stats">${m.reasoning.length} chars</span>` +
          `</div>` +
          `<div class="think-block-body"></div>`;
        thinkBlock.querySelector('.think-block-body').textContent = m.reasoning;
        thinkBlock.querySelector('.think-block-header').addEventListener('click', () => {
          thinkBlock.classList.toggle('collapsed');
          thinkBlock.classList.toggle('expanded');
          const t = thinkBlock.querySelector('.think-toggle');
          t.textContent = thinkBlock.classList.contains('expanded') ? '▼' : '▶';
        });
        contentEl.insertBefore(thinkBlock, body);
      }
      // Render images if any
      if (m.imagePreviews && m.imagePreviews.length > 0) {
        const body = msgEl.querySelector('.message-body');
        for (const src of m.imagePreviews) {
          const img = document.createElement('img');
          img.src = src;
          img.style.maxWidth = '200px';
          body.appendChild(img);
        }
      }
      // Add pin button to message actions
      addMessageActions(msgEl, m.id, m.pinned);
    }
    scrollToBottom();
  }

  function addMessageActions(msgEl, messageId, pinned) {
    const contentEl = msgEl.querySelector('.message-content');
    let actionsEl = contentEl.querySelector('.message-actions');
    if (!actionsEl) {
      actionsEl = document.createElement('div');
      actionsEl.className = 'message-actions';
      contentEl.appendChild(actionsEl);
    }
    const pinBtn = document.createElement('button');
    pinBtn.className = 'pin-btn msg-action-btn' + (pinned ? ' pinned' : '');
    pinBtn.textContent = pinned ? '📌 Pinned' : '📍 Pin';
    pinBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'togglePinMessage', payload: { messageId } });
    });
    actionsEl.appendChild(pinBtn);

    // Add copy button for assistant messages
    if (msgEl.classList.contains('role-assistant')) {
      const copyBtn = document.createElement('button');
      copyBtn.className = 'msg-action-btn';
      copyBtn.textContent = '📋 Copy';
      copyBtn.addEventListener('click', () => {
        const text = msgEl.querySelector('.message-body').innerText;
        navigator.clipboard.writeText(text);
        copyBtn.textContent = '✓ Copied';
        setTimeout(() => { copyBtn.textContent = '📋 Copy'; }, 1500);
      });
      actionsEl.appendChild(copyBtn);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // v0.3.0 — Tool call & result cards (ReAct loop visualization)
  // ──────────────────────────────────────────────────────────────────────────
  function renderToolCallCard(payload) {
    if (!state.currentAssistantMessageEl) {
      state.currentAssistantMessageEl = appendMessage('assistant', '', 'agent');
    }
    const contentEl = state.currentAssistantMessageEl.querySelector('.message-content');
    const body = state.currentAssistantMessageEl.querySelector('.message-body');
    const card = document.createElement('div');
    card.className = 'tool-call-card';
    card.setAttribute('data-tool-call-id', payload.stepId);
    card.innerHTML =
      `<div class="tool-call-header">` +
        `<span>🔧 ${escapeHtml(payload.tool)}</span>` +
        `<span class="iteration-badge">iter ${payload.iteration || 1}</span>` +
      `</div>` +
      `<div class="tool-call-args">${escapeHtml(JSON.stringify(payload.args, null, 2))}</div>`;
    contentEl.insertBefore(card, body);
    scrollToBottom();
  }

  function renderToolResultCard(payload) {
    if (!state.currentAssistantMessageEl) return;
    const contentEl = state.currentAssistantMessageEl.querySelector('.message-content');
    const body = state.currentAssistantMessageEl.querySelector('.message-body');
    const card = document.createElement('div');
    card.className = 'tool-result-card' + (payload.ok ? '' : ' error');
    card.innerHTML =
      `<div class="tool-result-header">` +
        `<span>${payload.ok ? '✓' : '✗'} ${escapeHtml(payload.tool)}</span>` +
      `</div>` +
      `<div class="tool-result-output">${escapeHtml(payload.output.slice(0, 1500))}${payload.output.length > 1500 ? '\n...' : ''}</div>`;
    contentEl.insertBefore(card, body);
    scrollToBottom();
  }

  function renderIterationMarker(iteration, maxIterations) {
    if (!state.currentAssistantMessageEl) {
      state.currentAssistantMessageEl = appendMessage('assistant', '', 'agent');
    }
    const contentEl = state.currentAssistantMessageEl.querySelector('.message-content');
    const body = state.currentAssistantMessageEl.querySelector('.message-body');
    const marker = document.createElement('div');
    marker.className = 'iteration-marker';
    marker.innerHTML =
      `<span class="iter-number">Iterasi ${iteration}/${maxIterations}</span>` +
      `<span>ReAct loop — Reason → Act → Observe</span>`;
    contentEl.insertBefore(marker, body);
    scrollToBottom();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // v0.3.0 — Slash command autocomplete
  // ──────────────────────────────────────────────────────────────────────────
  const SLASH_COMMANDS = [
    { name: '/ask', desc: 'Chat with RAG over the workspace', icon: '💬' },
    { name: '/summarize', desc: 'Summarize the active file / selection', icon: '📝' },
    { name: '/explain', desc: 'Explain the code currently open in the editor', icon: '📖' },
    { name: '/search', desc: 'Search documents without an LLM (saves tokens)', icon: '🔎' },
    { name: '/upload', desc: 'Upload the active file to the workspace', icon: '📤' },
    { name: '/agent', desc: 'Agentic mode — plan + tool calls', icon: '🤖' },
  ];

  function showSlashAutocomplete(query) {
    const dropdown = document.getElementById('slash-autocomplete');
    if (!dropdown) return;
    const matches = SLASH_COMMANDS.filter((c) => c.name.startsWith(query));
    if (matches.length === 0) {
      dropdown.classList.add('hidden');
      return;
    }
    dropdown.innerHTML = matches.map((c, i) =>
      `<div class="slash-item${i === 0 ? ' selected' : ''}" data-cmd="${c.name}">` +
        `<span class="slash-item-icon">${c.icon}</span>` +
        `<span class="slash-item-name">${c.name}</span>` +
        `<span class="slash-item-desc">${escapeHtml(c.desc)}</span>` +
      `</div>`
    ).join('');
    dropdown.classList.remove('hidden');

    dropdown.querySelectorAll('.slash-item').forEach((item) => {
      item.addEventListener('click', () => {
        const cmd = item.dataset.cmd.slice(1);
        setActiveCommand(cmd);
        els.input.value = '';
        dropdown.classList.add('hidden');
        els.input.focus();
      });
    });
  }

  function hideSlashAutocomplete() {
    const el = document.getElementById('slash-autocomplete');
    if (el) el.classList.add('hidden');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // v0.3.0 — Image attachment (paste / drag-drop / file picker)
  // ──────────────────────────────────────────────────────────────────────────
  const imagePreviewsEl = document.getElementById('image-previews');
  state.pendingImages = [];

  function addImageAttachment(name, base64, mediaType) {
    state.pendingImages.push({ name, data: base64, mediaType });
    renderImagePreviews();
  }

  function renderImagePreviews() {
    if (state.pendingImages.length === 0) {
      imagePreviewsEl.classList.add('hidden');
      imagePreviewsEl.innerHTML = '';
      return;
    }
    imagePreviewsEl.classList.remove('hidden');
    imagePreviewsEl.innerHTML = '';
    state.pendingImages.forEach((img, i) => {
      const preview = document.createElement('div');
      preview.className = 'image-preview';
      preview.innerHTML =
        `<img src="data:${img.mediaType};base64,${img.data}" alt="${escapeHtml(img.name)}" />` +
        `<button class="image-remove" data-idx="${i}" title="Remove">✕</button>`;
      preview.querySelector('.image-remove').addEventListener('click', () => {
        state.pendingImages.splice(i, 1);
        renderImagePreviews();
      });
      imagePreviewsEl.appendChild(preview);
    });
  }

  // File picker for image upload
  onId('btn-image', 'click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = reader.result.split(',')[1];
        addImageAttachment(file.name, base64, file.type);
      };
      reader.readAsDataURL(file);
    };
    input.click();
  });

  // Drag & drop images
  on(els.inputWrapper, 'dragover', (e) => {
    e.preventDefault();
    els.inputWrapper.classList.add('drag-over');
  });
  on(els.inputWrapper, 'dragleave', () => {
    els.inputWrapper.classList.remove('drag-over');
  });
  on(els.inputWrapper, 'drop', (e) => {
    e.preventDefault();
    els.inputWrapper.classList.remove('drag-over');
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
    for (const file of files) {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = reader.result.split(',')[1];
        addImageAttachment(file.name, base64, file.type);
      };
      reader.readAsDataURL(file);
    }
  });

  // Paste image
  on(els.input, 'paste', (e) => {
    const items = e.clipboardData?.items || [];
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (!file) continue;
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = reader.result.split(',')[1];
          addImageAttachment(`pasted-${Date.now()}.png`, base64, file.type);
        };
        reader.readAsDataURL(file);
      }
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // v0.3.0 — Workspace Documents modal
  // ──────────────────────────────────────────────────────────────────────────
  const docsModal = document.getElementById('docs-modal');

  function openDocsModal() {
    if (!state.activeWorkspaceSlug) {
      appendMessage('error', '⚠️ Please select a workspace first.');
      return;
    }
    docsModal.classList.remove('hidden');
    docsModal.innerHTML =
      `<div class="modal">` +
        `<div class="modal-header">` +
          `<div class="modal-title">🗂️ Workspace Documents</div>` +
          `<button class="modal-close" id="docs-close">✕</button>` +
        `</div>` +
        `<div class="modal-body"><div class="docs-list">Loading...</div></div>` +
      `</div>`;
    document.getElementById('docs-close').addEventListener('click', () => docsModal.classList.add('hidden'));
    docsModal.addEventListener('click', (e) => { if (e.target === docsModal) docsModal.classList.add('hidden'); });
    vscode.postMessage({ type: 'getWorkspaceDocuments', payload: { workspaceSlug: state.activeWorkspaceSlug } });
  }

  function renderDocsModal(documents, workspaceSlug) {
    const list = docsModal.querySelector('.docs-list');
    if (!list) return;
    if (!documents || documents.length === 0) {
      list.innerHTML = '<p style="text-align:center; color:var(--vscode-descriptionForeground); padding:20px;">No documents in this workspace.</p>';
      return;
    }
    list.innerHTML = '';
    for (const d of documents) {
      const item = document.createElement('div');
      item.className = 'doc-item';
      const sizeStr = d.size ? `${(d.size / 1024).toFixed(1)} KB` : '';
      item.innerHTML =
        `<span class="doc-icon">📄</span>` +
        `<div class="doc-name">${escapeHtml(d.name)}</div>` +
        `<span class="doc-meta">${escapeHtml(d.type)} • ${sizeStr}</span>` +
        `<button class="doc-delete" data-name="${escapeHtml(d.name)}">Delete</button>`;
      item.querySelector('.doc-delete').addEventListener('click', () => {
        if (confirm(`Delete document "${d.name}" from the workspace?`)) {
          vscode.postMessage({
            type: 'deleteDocument',
            payload: { workspaceSlug, docName: d.name },
          });
        }
      });
      list.appendChild(item);
    }
  }

  onId('btn-docs', 'click', openDocsModal);

  // ──────────────────────────────────────────────────────────────────────────
  // v0.3.0 — Export chat
  // ──────────────────────────────────────────────────────────────────────────
  onId('btn-export', 'click', () => {
    const choice = confirm('Export as Markdown (OK) or JSON (Cancel)?');
    vscode.postMessage({ type: 'exportChat', payload: { format: choice ? 'md' : 'json' } });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // v0.3.0 — History modal
  // ──────────────────────────────────────────────────────────────────────────
  const historyModal = document.getElementById('history-modal');
  onId('btn-history', 'click', () => {
    historyModal.classList.remove('hidden');
    historyModal.innerHTML =
      `<div class="modal">` +
        `<div class="modal-header">` +
          `<div class="modal-title">📜 Chat History</div>` +
          `<button class="modal-close" id="history-close">✕</button>` +
        `</div>` +
        `<div class="modal-body">` +
          `<p style="color:var(--vscode-descriptionForeground); font-size:12px; margin-bottom:10px;">` +
            `History is saved automatically per workspace. Pinned messages survive Clear Chat.` +
          `</p>` +
          `<button class="btn-secondary" id="btn-load-history">Reload</button>` +
        `</div>` +
      `</div>`;
    document.getElementById('history-close').addEventListener('click', () => historyModal.classList.add('hidden'));
    document.getElementById('btn-load-history').addEventListener('click', () => {
      vscode.postMessage({ type: 'loadHistory' });
    });
    historyModal.addEventListener('click', (e) => { if (e.target === historyModal) historyModal.classList.add('hidden'); });
    vscode.postMessage({ type: 'loadHistory' });
  });

  onId('btn-pin', 'click', () => {
    appendMessage('system', '📌 Pinned messages survive Clear Chat. Click the 📍 button on any message to pin / unpin.');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // v0.3.0 — Donate (header button)
  // ──────────────────────────────────────────────────────────────────────────
  const btnDonate = document.getElementById('btn-donate');
  if (btnDonate) {
    btnDonate.addEventListener('click', () => {
      vscode.postMessage({ type: 'openDonate' });
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // v0.3.0 — Slash autocomplete input handler
  // ──────────────────────────────────────────────────────────────────────────
  on(els.input, 'input', (e) => {
    autoResize();
    const value = e.target.value;
    if (value.startsWith('/') && !value.includes(' ')) {
      showSlashAutocomplete(value);
    } else {
      hideSlashAutocomplete();
    }
  });

  // Escape to close autocomplete
  on(els.input, 'keydown', (e) => {
    const dropdown = document.getElementById('slash-autocomplete');
    if (dropdown && !dropdown.classList.contains('hidden')) {
      if (e.key === 'Escape') {
        hideSlashAutocomplete();
        e.preventDefault();
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        const selected = dropdown.querySelector('.slash-item.selected');
        if (selected) {
          e.preventDefault();
          selected.click();
          return;
        }
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const items = dropdown.querySelectorAll('.slash-item');
        const curIdx = Array.from(items).findIndex((i) => i.classList.contains('selected'));
        items.forEach((i) => i.classList.remove('selected'));
        const newIdx = e.key === 'ArrowDown'
          ? (curIdx + 1) % items.length
          : (curIdx - 1 + items.length) % items.length;
        items[newIdx]?.classList.add('selected');
        return;
      }
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // v0.3.0 — Walkthrough callout
  // ──────────────────────────────────────────────────────────────────────────
  if (!persisted?.getState()?.walkthroughDismissed) {
    const callout = document.createElement('div');
    callout.className = 'walkthrough-callout';
    callout.innerHTML =
      `<span>👋 Welcome to AnythingLLM v0.3.0! Check out the new features.</span>` +
      `<button id="btn-walkthrough">Take Tour</button>`;
    els.messages.insertBefore(callout, els.messages.firstChild);
    onId('btn-walkthrough', 'click', () => {
      vscode.postMessage({ type: 'openWalkthrough' });
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // v0.3.0 — Insert code to editor (via clipboard fallback)
  // ──────────────────────────────────────────────────────────────────────────
  // @ts-ignore
  window.insertCode = function (id) {
    const el = document.getElementById(id);
    if (el) {
      const text = el.textContent || '';
      navigator.clipboard.writeText(text).then(() => {
        const btn = el.parentElement.querySelector('.code-insert-btn');
        if (btn) {
          const orig = btn.textContent;
          btn.textContent = '✓ Copied! Paste di editor';
          setTimeout(() => { btn.textContent = orig; }, 2000);
        }
      });
    }
  };

  // ──────────────────────────────────────────────────────────────────────────
  // v0.3.0 — Render MCP tools in settings
  // ──────────────────────────────────────────────────────────────────────────
  function renderMcpToolsInSettings(tools) {
    const panel = els.settingsModal.querySelector('[data-panel="mcp"]');
    if (!panel) return;
    const list = panel.querySelector('.mcp-tools-list');
    if (!list) return;
    if (tools.length === 0) {
      list.innerHTML = '<p style="color:var(--vscode-descriptionForeground); font-size:11px;">No MCP tools available. Add an MCP server in the Agent & MCP tab.</p>';
      return;
    }
    list.innerHTML = tools.map((t) =>
      `<div class="doc-item">` +
        `<span class="doc-icon">🔌</span>` +
        `<div class="doc-name">${escapeHtml(t.serverName)}/${escapeHtml(t.name)}</div>` +
        `<span class="doc-meta">${escapeHtml(t.description || '')}</span>` +
      `</div>`
    ).join('');
  }

  function renderAgentRunsList(runs) {
    const panel = els.settingsModal.querySelector('[data-panel="agent"]');
    if (!panel) return;
    const list = panel.querySelector('.agent-runs-list');
    if (!list) return;
    if (runs.length === 0) {
      list.innerHTML = '<p style="color:var(--vscode-descriptionForeground); font-size:11px;">No agent runs saved yet.</p>';
      return;
    }
    list.innerHTML = runs.slice(0, 20).map((r) =>
      `<div class="history-item">` +
        `<div>` +
          `<div class="history-item-title">${escapeHtml(r.goal.slice(0, 80))}</div>` +
          `<div class="history-item-meta">${new Date(r.startedAt).toLocaleString('id-ID')} • ${r.status} • ${r.iterations} iters • ${r.tokensIn + r.tokensOut} tok</div>` +
        `</div>` +
      `</div>`
    ).join('');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Init
  // ──────────────────────────────────────────────────────────────────────────
  applyTheme();
  if (state.agentMode) setAgentMode(true);
  setActiveCommand('ask', true);
  autoResize();
  els.input.focus();

  // Request initial state
  vscode.postMessage({ type: 'verifyAuth' });
  vscode.postMessage({ type: 'getSettings' });
  vscode.postMessage({ type: 'loadHistory' });
})();
