import * as vscode from 'vscode';

/**
 * Mendapatkan HTML content untuk webview chat
 * Semua backtick di dalam JS/HTML sudah di-escape (\`) agar tidak bentrok dengan TypeScript template literal
 */
export function getWebviewContent(workspaceSlug: string, serverUrl: string): string {
    return `<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AnythingLLM Chat</title>
    <style>
        :root {
            --chat-bg-1: #0f1115;
            --chat-bg-2: #161a22;
            --panel-bg: #1a1f29;
            --panel-border: #2a3140;
            --accent: #6c8cff;
            --accent-2: #8b6cff;
            --accent-soft: rgba(108, 140, 255, 0.16);
            --text-main: #eef1f7;
            --text-dim: #9aa4b8;
            --user-bubble-1: #5d6cf9;
            --user-bubble-2: #7b5cf0;
            --ai-bubble: #232a38;
            --ai-bubble-border: #313a4d;
            --code-bg: #1e2535;
            --code-border: #2d3a50;
            --success: #3ddc97;
            --danger: #ff6b6b;
            --warn: #f59e0b;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        html, body { height: 100%; }
        body {
            font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
            color: var(--text-main);
            background: linear-gradient(160deg, var(--chat-bg-1) 0%, var(--chat-bg-2) 100%);
            height: 100vh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        .header {
            padding: 12px 16px;
            background: linear-gradient(135deg, rgba(108,140,255,0.18), rgba(139,108,255,0.10));
            border-bottom: 1px solid var(--panel-border);
            display: flex;
            align-items: center;
            gap: 12px;
            backdrop-filter: blur(6px);
            flex-shrink: 0;
        }
        .header-icon {
            font-size: 20px;
            width: 36px; height: 36px;
            display: flex; align-items: center; justify-content: center;
            border-radius: 10px;
            background: linear-gradient(135deg, var(--accent), var(--accent-2));
            box-shadow: 0 2px 10px rgba(108,140,255,0.35);
            flex-shrink: 0;
        }
        .header-info { flex: 1; min-width: 0; }
        .header-title { font-weight: 700; font-size: 13px; color: var(--text-main); letter-spacing: 0.2px; }
        .header-subtitle { font-size: 11px; color: var(--text-dim); margin-top: 1px; }
        .connection-badge {
            display: flex; align-items: center; gap: 6px;
            padding: 4px 10px; border-radius: 20px;
            background: rgba(255,107,107,0.12);
            border: 1px solid rgba(255,107,107,0.30);
            font-size: 10.5px; font-weight: 500; color: var(--danger);
            transition: all 0.3s ease; cursor: default; white-space: nowrap; flex-shrink: 0;
        }
        .connection-badge.connected {
            background: rgba(61,220,151,0.12);
            border-color: rgba(61,220,151,0.30);
            color: var(--success);
        }
        .connection-badge .dot {
            width: 7px; height: 7px; border-radius: 50%;
            background: currentColor; flex-shrink: 0;
        }
        .connection-badge.connected .dot { animation: pulse-dot 2s infinite; }
        @keyframes pulse-dot { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
        .toolbar {
            padding: 8px 12px; background: var(--panel-bg);
            border-bottom: 1px solid var(--panel-border);
            display: flex; gap: 6px; flex-wrap: wrap; align-items: center; flex-shrink: 0;
        }
        .toolbar button {
            padding: 5px 10px; font-size: 11px; font-weight: 500;
            background: rgba(255,255,255,0.04); color: var(--text-main);
            border: 1px solid var(--panel-border); border-radius: 6px; cursor: pointer;
            display: flex; align-items: center; gap: 4px; transition: all 0.15s ease;
        }
        .toolbar button:hover { background: var(--accent-soft); border-color: var(--accent); color: #ffffff; transform: translateY(-1px); }
        .toolbar button:disabled { opacity: 0.4; cursor: not-allowed; transform: none; }
        .toolbar .separator { width: 1px; height: 20px; background: var(--panel-border); margin: 0 2px; }
        .kbd-badge {
            font-size: 9px; padding: 1px 4px;
            background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15);
            border-radius: 3px; color: var(--text-dim); font-family: monospace; margin-left: 2px;
        }
        .more-actions-wrap { position: relative; margin-left: auto; }
        #moreActionsBtn {
            padding: 5px 10px; background: rgba(255,255,255,0.04);
            border: 1px solid var(--panel-border); border-radius: 6px; cursor: pointer;
            font-size: 11px; color: var(--text-dim); display: flex; align-items: center; gap: 4px; transition: all 0.15s;
        }
        #moreActionsBtn:hover { background: var(--accent-soft); border-color: var(--accent); color: #fff; }
        .more-dropdown {
            display: none; position: absolute; right: 0; top: calc(100% + 6px);
            background: #1e2535; border: 1px solid var(--panel-border); border-radius: 8px;
            min-width: 160px; box-shadow: 0 8px 24px rgba(0,0,0,0.4); z-index: 100; overflow: hidden;
        }
        .more-dropdown.open { display: block; }
        .more-dropdown button {
            width: 100%; padding: 8px 14px; text-align: left;
            background: transparent; border: none; border-radius: 0;
            color: var(--text-main); font-size: 12px; cursor: pointer;
            display: flex; align-items: center; gap: 8px; transition: background 0.12s;
        }
        .more-dropdown button:hover { background: var(--accent-soft); }
        .project-stats {
            padding: 8px 14px;
            background: linear-gradient(135deg, rgba(61,220,151,0.10), rgba(108,140,255,0.06));
            border: 1px solid rgba(61,220,151,0.25);
            border-radius: 8px; font-size: 11px; margin: 8px 12px 0; color: var(--text-main); flex-shrink: 0;
        }
        #chat-container {
            flex: 1; overflow-y: auto; padding: 16px;
            display: flex; flex-direction: column; gap: 12px;
            background: radial-gradient(circle at 15% 10%, rgba(108,140,255,0.05), transparent 40%),
                        radial-gradient(circle at 85% 90%, rgba(139,108,255,0.05), transparent 40%);
            position: relative;
        }
        .welcome-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 8px; }
        .welcome-card {
            background: rgba(255,255,255,0.03); border: 1px solid var(--panel-border);
            border-radius: 10px; padding: 12px; cursor: pointer; transition: all 0.18s ease;
            display: flex; flex-direction: column; gap: 6px;
        }
        .welcome-card:hover { background: var(--accent-soft); border-color: var(--accent); transform: translateY(-2px); box-shadow: 0 4px 16px rgba(108,140,255,0.18); }
        .welcome-card-icon { font-size: 20px; }
        .welcome-card-title { font-size: 12px; font-weight: 600; color: var(--text-main); }
        .welcome-card-desc { font-size: 10.5px; color: var(--text-dim); line-height: 1.4; }
        .welcome-header { text-align: center; padding: 8px 0 4px; }
        .welcome-header h2 { font-size: 14px; font-weight: 700; color: var(--text-main); }
        .welcome-header p { font-size: 11.5px; color: var(--text-dim); margin-top: 4px; }
        .message-wrap { display: flex; align-items: flex-end; gap: 8px; animation: fadeIn 0.22s ease; }
        .message-wrap.user { flex-direction: row-reverse; }
        .message-wrap.ai { flex-direction: row; }
        .message-wrap.system { justify-content: center; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
        .msg-avatar {
            width: 28px; height: 28px; border-radius: 50%;
            display: flex; align-items: center; justify-content: center;
            font-size: 14px; flex-shrink: 0; margin-bottom: 18px;
        }
        .msg-avatar.user { background: linear-gradient(135deg, var(--user-bubble-1), var(--user-bubble-2)); box-shadow: 0 2px 8px rgba(93,108,249,0.35); }
        .msg-avatar.ai { background: linear-gradient(135deg, var(--accent), var(--accent-2)); box-shadow: 0 2px 8px rgba(108,140,255,0.3); }
        .msg-body { display: flex; flex-direction: column; gap: 3px; max-width: calc(100% - 80px); }
        .msg-body.user { align-items: flex-end; }
        .msg-body.ai { align-items: flex-start; }
        .message {
            padding: 10px 14px; border-radius: 14px; line-height: 1.65; font-size: 13px; word-wrap: break-word;
            box-shadow: 0 2px 8px rgba(0,0,0,0.25); position: relative;
        }
        .message.user { background: linear-gradient(135deg, var(--user-bubble-1), var(--user-bubble-2)); color: #ffffff; border-bottom-right-radius: 4px; }
        .message.ai { background: var(--ai-bubble); border: 1px solid var(--ai-bubble-border); color: var(--text-main); border-bottom-left-radius: 4px; }
        .message.system { background: transparent; color: var(--text-dim); font-size: 11px; font-style: italic; padding: 4px 10px; box-shadow: none; border: none; }
        .msg-timestamp { font-size: 10px; color: var(--text-dim); opacity: 0.7; padding: 0 4px; }
        .msg-actions { display: flex; gap: 6px; margin-top: 4px; opacity: 0; transition: opacity 0.15s; }
        .message-wrap:hover .msg-actions { opacity: 1; }
        .msg-action-btn {
            padding: 3px 8px; font-size: 10.5px; background: rgba(255,255,255,0.06);
            border: 1px solid var(--panel-border); border-radius: 5px; cursor: pointer;
            color: var(--text-dim); transition: all 0.12s; display: flex; align-items: center; gap: 4px;
        }
        .msg-action-btn:hover { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
        .message strong { color: inherit; font-weight: 700; opacity: 0.95; }
        .message.ai strong { color: #c8d8ff; }
        .message em { opacity: 0.85; font-style: italic; }
        .message code {
            background: var(--code-bg) !important; color: #a8d8ff !important;
            border: 1px solid var(--code-border); padding: 1px 6px; border-radius: 4px;
            font-family: 'Cascadia Code', 'Consolas', monospace; font-size: 12px;
        }
        .message.user code { background: rgba(255,255,255,0.18) !important; color: #ffffff !important; border-color: rgba(255,255,255,0.25); }
        .code-block-wrap { margin: 8px 0; border-radius: 8px; overflow: hidden; border: 1px solid var(--code-border); background: #141922; }
        .code-block-header {
            display: flex; align-items: center; justify-content: space-between;
            padding: 5px 12px; background: #1a2233; border-bottom: 1px solid var(--code-border); font-size: 10.5px;
        }
        .code-lang-badge { color: var(--accent); font-weight: 600; font-family: monospace; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; }
        .copy-code-btn {
            padding: 2px 8px; font-size: 10px; background: rgba(108,140,255,0.10);
            border: 1px solid rgba(108,140,255,0.25); border-radius: 4px; cursor: pointer;
            color: var(--accent); transition: all 0.12s; font-weight: 500;
        }
        .copy-code-btn:hover { background: rgba(108,140,255,0.22); }
        .copy-code-btn.copied { color: var(--success); border-color: rgba(61,220,151,0.3); }
        .code-block-wrap pre { margin: 0; padding: 12px 14px; overflow-x: auto; font-size: 12px; font-family: 'Cascadia Code', 'Consolas', monospace; line-height: 1.6; color: #c9d1d9; }
        .code-block-wrap pre code { background: transparent !important; border: none !important; padding: 0 !important; color: inherit !important; font-size: inherit !important; }
        .message ul, .message ol { padding-left: 20px; margin: 6px 0; }
        .message li { margin: 3px 0; line-height: 1.5; }
        .message p { margin: 4px 0; }
        .message hr { border: none; border-top: 1px solid var(--panel-border); margin: 10px 0; }
        .skeleton-wrap { display: flex; gap: 8px; align-items: flex-end; }
        .skeleton-avatar {
            width: 28px; height: 28px; border-radius: 50%;
            background: linear-gradient(90deg, #232a38 25%, #2d3848 50%, #232a38 75%);
            background-size: 200% 100%; animation: shimmer 1.4s infinite; flex-shrink: 0;
        }
        .skeleton-bubble {
            display: flex; flex-direction: column; gap: 6px; padding: 12px 16px;
            background: var(--ai-bubble); border: 1px solid var(--ai-bubble-border);
            border-radius: 14px; border-bottom-left-radius: 4px; min-width: 120px;
        }
        .skeleton-line {
            height: 10px; border-radius: 5px;
            background: linear-gradient(90deg, #2a3348 25%, #3a4560 50%, #2a3348 75%);
            background-size: 200% 100%; animation: shimmer 1.4s infinite;
        }
        .skeleton-line:nth-child(1) { width: 80%; }
        .skeleton-line:nth-child(2) { width: 55%; animation-delay: 0.1s; }
        .skeleton-line:nth-child(3) { width: 70%; animation-delay: 0.2s; }
        @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
        .stop-btn-wrap { display: flex; justify-content: center; padding: 4px 0 8px; }
        #stopBtn {
            padding: 6px 18px; font-size: 11.5px; background: rgba(255,107,107,0.10);
            border: 1px solid rgba(255,107,107,0.30); border-radius: 20px; cursor: pointer;
            color: var(--danger); font-weight: 500; display: flex; align-items: center; gap: 6px; transition: all 0.15s;
        }
        #stopBtn:hover { background: rgba(255,107,107,0.20); }
        #stopBtn .stop-icon { width: 8px; height: 8px; background: var(--danger); border-radius: 2px; }
        #newMsgBtn {
            position: absolute; bottom: 12px; left: 50%; transform: translateX(-50%);
            padding: 6px 16px; font-size: 11.5px; background: var(--accent);
            border: none; border-radius: 20px; cursor: pointer; color: #fff; font-weight: 600;
            display: none; align-items: center; gap: 6px; box-shadow: 0 4px 14px rgba(108,140,255,0.45);
            z-index: 10; transition: all 0.18s;
        }
        #newMsgBtn:hover { transform: translateX(-50%) translateY(-2px); }
        #newMsgBtn.visible { display: flex; }
        .input-area { padding: 12px; background: var(--panel-bg); border-top: 1px solid var(--panel-border); display: flex; gap: 8px; flex-shrink: 0; }
        #userInput {
            flex: 1; padding: 10px 13px; background: #11151d; color: var(--text-main);
            border: 1px solid var(--panel-border); border-radius: 8px; font-size: 13px; font-family: inherit;
            resize: none; min-height: 40px; max-height: 120px; transition: border-color 0.15s ease, box-shadow 0.15s ease;
        }
        #userInput::placeholder { color: var(--text-dim); }
        #userInput:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
        #sendBtn {
            padding: 10px 20px; background: linear-gradient(135deg, var(--user-bubble-1), var(--user-bubble-2));
            color: #ffffff; border: none; border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 600;
            box-shadow: 0 2px 10px rgba(108,140,255,0.35); transition: transform 0.12s ease, box-shadow 0.12s ease;
            display: flex; align-items: center; gap: 6px;
        }
        #sendBtn:hover { transform: translateY(-1px); box-shadow: 0 4px 14px rgba(108,140,255,0.45); }
        #sendBtn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; box-shadow: none; }
        .agent-input { padding: 10px 12px; background: var(--panel-bg); border-top: 1px solid var(--panel-border); display: none; gap: 8px; flex-shrink: 0; }
        .agent-input.active { display: flex; }
        #agentInput {
            flex: 1; padding: 10px 13px; background: #11151d; color: var(--text-main);
            border: 1px solid var(--panel-border); border-radius: 8px; font-size: 13px; transition: border-color 0.15s ease, box-shadow 0.15s ease;
        }
        #agentInput::placeholder { color: var(--text-dim); }
        #agentInput:focus { outline: none; border-color: var(--accent-2); box-shadow: 0 0 0 3px rgba(139,108,255,0.18); }
        #agentSendBtn {
            padding: 10px 18px; background: linear-gradient(135deg, #a855f7, var(--accent-2));
            color: white; border: none; border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 600;
            box-shadow: 0 2px 10px rgba(139,108,255,0.35); transition: transform 0.12s ease; display: flex; align-items: center; gap: 5px;
        }
        #agentSendBtn:hover { transform: translateY(-1px); }
        #agentCancelBtn {
            padding: 10px 16px; background: rgba(255,255,255,0.05); color: var(--text-main);
            border: 1px solid var(--panel-border); border-radius: 8px; cursor: pointer; font-size: 13px; transition: background 0.15s ease;
        }
        #agentCancelBtn:hover { background: rgba(255,255,255,0.1); }
        #toast-container { position: fixed; bottom: 80px; right: 14px; display: flex; flex-direction: column; gap: 6px; z-index: 999; }
        .toast {
            padding: 8px 14px; font-size: 12px; font-weight: 500; border-radius: 8px;
            display: flex; align-items: center; gap: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.35);
            animation: toast-in 0.25s ease; max-width: 240px;
        }
        .toast.success { background: rgba(61,220,151,0.15); border: 1px solid rgba(61,220,151,0.30); color: var(--success); }
        .toast.info { background: rgba(108,140,255,0.15); border: 1px solid rgba(108,140,255,0.30); color: var(--accent); }
        .toast.error { background: rgba(255,107,107,0.15); border: 1px solid rgba(255,107,107,0.30); color: var(--danger); }
        @keyframes toast-in { from { opacity: 0; transform: translateX(20px); } to { opacity: 1; transform: translateX(0); } }
        @keyframes toast-out { from { opacity: 1; } to { opacity: 0; transform: translateX(20px); } }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: var(--panel-border); border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: var(--accent); }
    </style>
</head>
<body>
    <div class="header">
        <span class="header-icon">🤖</span>
        <div class="header-info">
            <div class="header-title">AnythingLLM Assistant</div>
            <div class="header-subtitle" id="headerSubtitle">Workspace: ${workspaceSlug}</div>
        </div>
        <div class="connection-badge" id="connectionBadge">
            <div class="dot"></div>
            <span id="connectionLabel">Disconnected</span>
        </div>
    </div>

    <div class="toolbar">
        <button id="syncBtn" title="Upload project ke AnythingLLM"><span>📤</span> Sync</button>
        <button id="scanBtn" title="Scan project lokal"><span>🔍</span> Scan</button>
        <button id="agentBtn" title="AI Agent Mode (Ctrl+Enter)"><span>🤖</span> Agent <span class="kbd-badge">Ctrl+↵</span></button>
        <button id="tagBtn" title="Tag file aktif"><span>🏷️</span> Tag</button>
        <button id="testBtn" title="Test koneksi"><span></span> Test</button>
        <div class="separator"></div>
        <button id="clearBtn" title="Hapus history chat"><span>🧹</span> Clear</button>
        <div class="more-actions-wrap">
            <button id="moreActionsBtn">⋯ More</button>
            <div class="more-dropdown" id="moreDropdown">
                <button id="forceSyncBtn"><span>🔄</span> Force Sync</button>
                <button id="clearCacheBtn"><span>🗑️</span> Clear Cache</button>
            </div>
        </div>
    </div>

    <div id="projectStats" class="project-stats" style="display:none;"></div>

    <div id="chat-container">
        <button id="newMsgBtn">↓ New message</button>
    </div>

    <div class="stop-btn-wrap" id="stopBtnWrap" style="display:none;">
        <button id="stopBtn"><span class="stop-icon"></span> Stop generating</button>
    </div>

    <div class="agent-input" id="agentInputArea">
        <input type="text" id="agentInput" placeholder="Deskripsikan task untuk AI Agent..." />
        <button id="agentSendBtn">⚡ Execute <span class="kbd-badge">↵</span></button>
        <button id="agentCancelBtn">Cancel</button>
    </div>

    <div class="input-area" id="normalInputArea">
        <textarea id="userInput" placeholder="Tanya tentang project Anda... (Enter kirim, Shift+Enter baris baru)" rows="1"></textarea>
        <button id="sendBtn">Send <span class="kbd-badge">↵</span></button>
    </div>

    <div id="toast-container"></div>

    <script>
        (function() {
            const vscode = acquireVsCodeApi();
            const chatContainer = document.getElementById('chat-container');
            const userInput = document.getElementById('userInput');
            const sendBtn = document.getElementById('sendBtn');
            const scanBtn = document.getElementById('scanBtn');
            const testBtn = document.getElementById('testBtn');
            const clearBtn = document.getElementById('clearBtn');
            const syncBtn = document.getElementById('syncBtn');
            const agentBtn = document.getElementById('agentBtn');
            const tagBtn = document.getElementById('tagBtn');
            const connectionBadge = document.getElementById('connectionBadge');
            const connectionLabel = document.getElementById('connectionLabel');
            const projectStats = document.getElementById('projectStats');
            const agentInputArea = document.getElementById('agentInputArea');
            const normalInputArea = document.getElementById('normalInputArea');
            const agentInput = document.getElementById('agentInput');
            const agentSendBtn = document.getElementById('agentSendBtn');
            const agentCancelBtn = document.getElementById('agentCancelBtn');
            const stopBtn = document.getElementById('stopBtn');
            const stopBtnWrap = document.getElementById('stopBtnWrap');
            const newMsgBtn = document.getElementById('newMsgBtn');
            const moreActionsBtn = document.getElementById('moreActionsBtn');
            const moreDropdown = document.getElementById('moreDropdown');
            const forceSyncBtn = document.getElementById('forceSyncBtn');
            const clearCacheBtn = document.getElementById('clearCacheBtn');

            let isLoading = false;
            let userScrolledUp = false;
            let lastAiMessageEl = null;
            let lastUserText = '';

            // ===== Welcome screen =====
            function showWelcome() {
                const wrap = document.createElement('div');
                wrap.id = 'welcomeWrap';
                // Menggunakan tanda kutip biasa ('') untuk menghindari konflik backtick
                wrap.innerHTML = '<div class="welcome-header"><h2>👋 AnythingLLM Assistant</h2><p>Terhubung ke workspace AI Anda. Pilih aksi atau mulai bertanya.</p></div>' +
                    '<div class="welcome-grid">' +
                    '<div class="welcome-card" data-action="scan"><div class="welcome-card-icon"></div><div class="welcome-card-title">Scan Project</div><div class="welcome-card-desc">Baca seluruh struktur kode lokal Anda</div></div>' +
                    '<div class="welcome-card" data-action="sync"><div class="welcome-card-icon">📤</div><div class="welcome-card-title">Sync Project</div><div class="welcome-card-desc">Upload file ke AnythingLLM untuk di-embed AI</div></div>' +
                    '<div class="welcome-card" data-action="agent"><div class="welcome-card-icon"></div><div class="welcome-card-title">Agent Mode</div><div class="welcome-card-desc">Jalankan multi-step task secara otomatis</div></div>' +
                    '<div class="welcome-card" data-action="tag"><div class="welcome-card-icon">️</div><div class="welcome-card-title">Tag File</div><div class="welcome-card-desc">Beri label pada file aktif di editor</div></div>' +
                    '</div>';
                wrap.querySelectorAll('.welcome-card').forEach(card => {
                    card.addEventListener('click', () => {
                        const action = card.dataset.action;
                        if (action === 'scan') vscode.postMessage({ command: 'scanWorkspace' });
                        else if (action === 'sync') vscode.postMessage({ command: 'syncProject' });
                        else if (action === 'agent') agentBtn.click();
                        else if (action === 'tag') vscode.postMessage({ command: 'tagCurrentFile' });
                        removeWelcome();
                    });
                });
                chatContainer.insertBefore(wrap, newMsgBtn);
            }
            function removeWelcome() {
                const w = document.getElementById('welcomeWrap');
                if (w) w.remove();
            }
            showWelcome();

            // ===== Scroll tracking =====
            chatContainer.addEventListener('scroll', () => {
                const threshold = 80;
                const atBottom = chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight < threshold;
                userScrolledUp = !atBottom;
                if (atBottom) newMsgBtn.classList.remove('visible');
            });
            newMsgBtn.addEventListener('click', () => {
                scrollToBottom(true);
                newMsgBtn.classList.remove('visible');
                userScrolledUp = false;
            });
            function scrollToBottom(force = false) {
                if (!userScrolledUp || force) chatContainer.scrollTop = chatContainer.scrollHeight;
            }

            // ===== Helpers =====
            function getTimestamp() {
                const now = new Date();
                return now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
            }
            function escapeHtml(text) {
                if (!text) return '';
                const div = document.createElement('div');
                div.textContent = text;
                return div.innerHTML;
            }

            // ===== Markdown parser =====
            function parseMarkdown(rawText) {
                const lines = rawText.split('\\n');
                let html = '';
                let i = 0;
                let inUl = false, inOl = false;

                function closeList() {
                    if (inUl) { html += '</ul>'; inUl = false; }
                    if (inOl) { html += '</ol>'; inOl = false; }
                }

                while (i < lines.length) {
                    const line = lines[i];
                    
                    const fenceMatch = line.match(/^\\\`\\\`\\\`(\\w*)?/);
                    if (fenceMatch) {
                        closeList();
                        const lang = fenceMatch[1] || '';
                        let code = '';
                        i++;
                        while (i < lines.length && !lines[i].startsWith('\\\`\\\`\\\`')) {
                            code += lines[i] + '\\n';
                            i++;
                        }
                        i++;
                        const escapedCode = escapeHtml(code.trimEnd());
                        const langLabel = escapeHtml(lang) || 'code';
                        html += '<div class="code-block-wrap"><div class="code-block-header"><span class="code-lang-badge">' + langLabel + '</span>' +
                            '<button class="copy-code-btn" onclick="copyCode(this)">⎘ Copy</button></div>' +
                            '<pre><code>' + escapedCode + '</code></pre></div>';
                        continue;
                    }

                    const ulMatch = line.match(/^(\\s*)[-*] (.+)/);
                    if (ulMatch) {
                        if (!inUl) { if (inOl) { html += '</ol>'; inOl = false; } html += '<ul>'; inUl = true; }
                        html += '<li>' + inlineMarkdown(ulMatch[2]) + '</li>';
                        i++; continue;
                    }

                    const olMatch = line.match(/^\\d+\\.\\s+(.+)/);
                    if (olMatch) {
                        if (!inOl) { if (inUl) { html += '</ul>'; inUl = false; } html += '<ol>'; inOl = true; }
                        html += '<li>' + inlineMarkdown(olMatch[1]) + '</li>';
                        i++; continue;
                    }

                    closeList();
                    if (line.match(/^---+$/)) { html += '<hr>'; i++; continue; }
                    const hMatch = line.match(/^(#{1,3})\\s+(.+)/);
                    if (hMatch) {
                        html += '<p><strong>' + inlineMarkdown(hMatch[2]) + '</strong></p>';
                        i++; continue;
                    }
                    if (line.trim() === '') { i++; continue; }
                    html += '<p>' + inlineMarkdown(line) + '</p>';
                    i++;
                }
                closeList();
                return html;
            }

            function inlineMarkdown(text) {
                return escapeHtml(text)
                    .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
                    .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
                    .replace(/\\*(.+?)\\*/g, '<em>$1</em>');
            }

            // ===== Global functions for onclick =====
            window.copyCode = function(btn) {
                const pre = btn.closest('.code-block-wrap').querySelector('pre');
                navigator.clipboard.writeText(pre.innerText).then(() => {
                    btn.textContent = '✓ Copied';
                    btn.classList.add('copied');
                    setTimeout(() => { btn.textContent = '⎘ Copy'; btn.classList.remove('copied'); }, 2000);
                });
            };

            window.copyMessage = function(btn) {
                const msgEl = btn.closest('.message-wrap').querySelector('.message');
                navigator.clipboard.writeText(msgEl.innerText).then(() => {
                    const orig = btn.innerHTML;
                    btn.innerHTML = '✓ Copied';
                    setTimeout(() => { btn.innerHTML = orig; }, 2000);
                });
            };

            window.regenerateResponse = function() {
                if (!lastUserText) return;
                if (lastAiMessageEl) lastAiMessageEl.closest('.message-wrap').remove();
                vscode.postMessage({ command: 'sendMessage', text: lastUserText });
            };

            // ===== Add message =====
            function addMessage(role, text) {
                removeWelcome();
                const wrap = document.createElement('div');
                wrap.className = 'message-wrap ' + role;

                if (role === 'system') {
                    const msgEl = document.createElement('div');
                    msgEl.className = 'message system';
                    msgEl.textContent = text;
                    wrap.appendChild(msgEl);
                    chatContainer.insertBefore(wrap, newMsgBtn);
                    scrollToBottom();
                    return;
                }

                const avatar = document.createElement('div');
                avatar.className = 'msg-avatar ' + role;
                avatar.textContent = role === 'user' ? '👤' : '🤖';

                const body = document.createElement('div');
                body.className = 'msg-body ' + role;

                const bubble = document.createElement('div');
                bubble.className = 'message ' + role;

                if (role === 'user') {
                    bubble.textContent = text;
                    lastUserText = text;
                } else {
                    const parsedHtml = parseMarkdown(text);
                    bubble.innerHTML = parsedHtml;
                    lastAiMessageEl = bubble;
                }

                const ts = document.createElement('div');
                ts.className = 'msg-timestamp';
                ts.textContent = getTimestamp();

                const actions = document.createElement('div');
                actions.className = 'msg-actions';
                if (role === 'ai') {
                    // Menggunakan tanda kutip biasa
                    actions.innerHTML = '<button class="msg-action-btn" onclick="copyMessage(this)">⎘ Copy</button>' +
                        '<button class="msg-action-btn" onclick="regenerateResponse()">↺ Regenerate</button>';
                }

                body.appendChild(bubble);
                body.appendChild(ts);
                if (role === 'ai') body.appendChild(actions);

                if (role === 'user') { wrap.appendChild(body); wrap.appendChild(avatar); }
                else { wrap.appendChild(avatar); wrap.appendChild(body); }

                chatContainer.insertBefore(wrap, newMsgBtn);
                if (userScrolledUp) newMsgBtn.classList.add('visible');
                else scrollToBottom();
            }

            // ===== Loading =====
            function showLoading(show) {
                let existing = document.getElementById('loadingIndicator');
                if (show) {
                    isLoading = true;
                    stopBtnWrap.style.display = 'flex';
                    if (!existing) {
                        const skWrap = document.createElement('div');
                        skWrap.id = 'loadingIndicator';
                        skWrap.className = 'skeleton-wrap';
                        skWrap.innerHTML = '<div class="skeleton-avatar"></div>' +
                            '<div class="skeleton-bubble"><div class="skeleton-line"></div>' +
                            '<div class="skeleton-line"></div><div class="skeleton-line"></div></div>';
                        chatContainer.insertBefore(skWrap, newMsgBtn);
                        scrollToBottom();
                    }
                } else {
                    isLoading = false;
                    stopBtnWrap.style.display = 'none';
                    if (existing) existing.remove();
                }
                sendBtn.disabled = show;
                agentSendBtn.disabled = show;
            }

            // ===== Toast =====
            function showToast(text, type = 'info') {
                const container = document.getElementById('toast-container');
                const toast = document.createElement('div');
                toast.className = 'toast ' + type;
                toast.textContent = text;
                container.appendChild(toast);
                setTimeout(() => {
                    toast.style.animation = 'toast-out 0.25s ease forwards';
                    setTimeout(() => toast.remove(), 260);
                }, 3000);
            }

            // ===== Connection badge =====
            function setConnectionStatus(connected, workspace, serverUrl) {
                if (connected) {
                    connectionBadge.classList.add('connected');
                    connectionLabel.textContent = 'Connected to ' + (workspace || 'workspace');
                    connectionBadge.title = serverUrl || '';
                } else {
                    connectionBadge.classList.remove('connected');
                    connectionLabel.textContent = 'Disconnected';
                    connectionBadge.title = '';
                }
            }

            // ===== Event Listeners =====
            stopBtn.addEventListener('click', () => {
                showLoading(false);
                addMessage('system', 'Generation stopped by user.');
            });

            moreActionsBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                moreDropdown.classList.toggle('open');
            });
            document.addEventListener('click', () => moreDropdown.classList.remove('open'));

            sendBtn.addEventListener('click', sendMessage);
            scanBtn.addEventListener('click', () => vscode.postMessage({ command: 'scanWorkspace' }));
            testBtn.addEventListener('click', () => vscode.postMessage({ command: 'testConnection' }));
            syncBtn.addEventListener('click', () => vscode.postMessage({ command: 'syncProject' }));
            tagBtn.addEventListener('click', () => vscode.postMessage({ command: 'tagCurrentFile' }));
            forceSyncBtn.addEventListener('click', () => { vscode.postMessage({ command: 'forceSync' }); moreDropdown.classList.remove('open'); });
            clearCacheBtn.addEventListener('click', () => { vscode.postMessage({ command: 'clearCache' }); moreDropdown.classList.remove('open'); });

            clearBtn.addEventListener('click', () => {
                chatContainer.querySelectorAll('.message-wrap').forEach(el => el.remove());
                removeWelcome();
                showWelcome();
                vscode.postMessage({ command: 'clearHistory' });
                showToast('🧹 Chat history cleared', 'info');
            });

            agentBtn.addEventListener('click', () => {
                const isActive = agentInputArea.classList.toggle('active');
                if (isActive) { normalInputArea.style.display = 'none'; agentInput.focus(); }
                else { normalInputArea.style.display = 'flex'; }
            });

            agentSendBtn.addEventListener('click', () => {
                const text = agentInput.value.trim();
                if (!text) return;
                addMessage('user', ' ' + text);
                vscode.postMessage({ command: 'agentMode', text: text });
                agentInput.value = '';
                agentInputArea.classList.remove('active');
                normalInputArea.style.display = 'flex';
            });

            agentInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); agentSendBtn.click(); }
            });

            agentCancelBtn.addEventListener('click', () => {
                agentInputArea.classList.remove('active');
                normalInputArea.style.display = 'flex';
            });

            userInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); agentBtn.click(); return; }
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
            });

            userInput.addEventListener('input', () => {
                userInput.style.height = 'auto';
                userInput.style.height = Math.min(userInput.scrollHeight, 120) + 'px';
            });

            function sendMessage() {
                const text = userInput.value.trim();
                if (!text || isLoading) return;
                removeWelcome();
                addMessage('user', text);
                vscode.postMessage({ command: 'sendMessage', text: text });
                userInput.value = '';
                userInput.style.height = 'auto';
            }

            // ===== Incoming messages =====
            window.addEventListener('message', event => {
                const msg = event.data;
                console.log('[Webview] Received message:', msg);

                try {
                    switch (msg.command) {
                        case 'addMessage':
                            if (msg.text) addMessage(msg.role, msg.text);
                            else console.error('[Webview] Message text is null/undefined!');
                            break;
                        case 'setLoading':
                            showLoading(msg.value);
                            break;
                        case 'setScanning':
                            scanBtn.disabled = msg.value;
                            scanBtn.innerHTML = msg.value ? '<span>⏳</span> Scanning...' : '<span>🔍</span> Scan';
                            break;
                        case 'projectScanned':
                            // Escape backtick untuk variabel TS di dalam string JS
                            setConnectionStatus(true, '${workspaceSlug}', '${serverUrl}');
                            projectStats.style.display = 'block';
                            projectStats.innerHTML = '📊 ' + msg.stats.totalFiles + ' files | ' + Object.keys(msg.stats.languages).length + ' languages';
                            showToast('✅ Project scanned — ' + msg.stats.totalFiles + ' files', 'success');
                            break;
                        case 'historyCleared':
                            projectStats.style.display = 'none';
                            break;
                        case 'connectionStatus':
                            setConnectionStatus(msg.connected, msg.workspace, msg.serverUrl);
                            break;
                        case 'showToast':
                            showToast(msg.text, msg.type || 'info');
                            break;
                        default:
                            console.warn('[Webview] Unknown command:', msg.command);
                    }
                } catch (error) {
                    console.error('[Webview] Error handling message:', error);
                }
            });
        })();
    </script>
</body>
</html>`;
}