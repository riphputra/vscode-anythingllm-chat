import * as vscode from 'vscode';
import { AnythingLLMClient } from '../anythingllm';
import { WorkspaceReader } from '../workspaceReader';

export class ChatPanel {
    public static currentPanel: ChatPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private readonly client: AnythingLLMClient;
    private readonly reader: WorkspaceReader;
    private disposables: vscode.Disposable[] = [];
    private projectContext: string = '';
    private isScanning: boolean = false;

    // Constructor sudah menerima outputChannel
    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, outputChannel: vscode.OutputChannel) {
        this.panel = panel;
        this.client = new AnythingLLMClient(outputChannel); // Oper ke client
        this.reader = new WorkspaceReader();

        this.panel.webview.html = this.getHtmlContent();
        
        this.panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'sendMessage':
                        await this.handleUserMessage(message.text);
                        break;
                    case 'scanWorkspace':
                        await this.handleScanWorkspace();
                        break;
                    case 'testConnection':
                        await this.handleTestConnection();
                        break;
                    case 'syncProject':
                        await this.handleSyncProject();
                        break;
                    case 'clearHistory':
                        this.projectContext = '';
                        this.panel.webview.postMessage({ command: 'historyCleared' });
                        break;
                }
            },
            null,
            this.disposables
        );

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    }

    // createOrShow sudah menerima outputChannel
    public static createOrShow(extensionUri: vscode.Uri, outputChannel: vscode.OutputChannel) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (ChatPanel.currentPanel) {
            ChatPanel.currentPanel.panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'anythingllmChat',
            'AnythingLLM Assistant',
            column || vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        // Oper outputChannel ke constructor
        ChatPanel.currentPanel = new ChatPanel(panel, extensionUri, outputChannel);
    }

    private async handleUserMessage(text: string) {
        this.panel.webview.postMessage({ command: 'setLoading', value: true });

        try {
            let fullMessage = text;
            if (!this.projectContext && !this.isScanning) {
                this.panel.webview.postMessage({
                    command: 'addMessage',
                    role: 'ai',
                    text: '⚠️ *Project belum di-scan. Klik tombol "Scan Project" agar AI bisa melihat seluruh kode Anda, atau lanjutkan chat tanpa context project.*'
                });
            }

            if (this.projectContext) {
                fullMessage = `[PROJECT CONTEXT]\n${this.projectContext}\n\n[USER QUESTION]\n${text}`;
            }

            const response = await this.client.chat(fullMessage, 'chat');

            if (response.success && response.data) {
                let aiText = response.data.response;
                
                if (response.data.sources && response.data.sources.length > 0) {
                    aiText += '\n\n---\n**📚 Sources:**\n';
                    response.data.sources.forEach((source: any, i: number) => {
                        aiText += `${i + 1}. ${source.document || source.title || 'Unknown'}\n`;
                    });
                }

                this.panel.webview.postMessage({
                    command: 'addMessage',
                    role: 'ai',
                    text: aiText
                });
            } else {
                this.panel.webview.postMessage({
                    command: 'addMessage',
                    role: 'ai',
                    text: `❌ Error: ${response.error || 'Unknown error'}`
                });
            }
        } catch (error: any) {
            this.panel.webview.postMessage({
                command: 'addMessage',
                role: 'ai',
                text: `❌ Error: ${error.message}`
            });
        } finally {
            this.panel.webview.postMessage({ command: 'setLoading', value: false });
        }
    }

    private async handleScanWorkspace() {
        this.isScanning = true;
        this.panel.webview.postMessage({ command: 'setScanning', value: true });

        try {
            this.panel.webview.postMessage({
                command: 'addMessage',
                role: 'ai',
                text: '🔍 *Scanning project... Mohon tunggu, sedang membaca seluruh file...*'
            });

            this.projectContext = await this.reader.buildProjectContext();
            const stats = (await this.reader.scanWorkspace()).stats;
            
            this.panel.webview.postMessage({
                command: 'addMessage',
                role: 'ai',
                text: `✅ **Project berhasil di-scan!**\n\n` +
                      `📊 **Statistik:**\n` +
                      `- 📄 Total Files: ${stats.totalFiles}\n` +
                      `- 💾 Total Size: ${this.formatSize(stats.totalSize)}\n` +
                      `- 🗣️ Languages: ${Object.entries(stats.languages).map(([l, c]) => `${l} (${c})`).join(', ')}\n\n` +
                      `Sekarang Anda bisa bertanya tentang project Anda.`
            });

            this.panel.webview.postMessage({ command: 'projectScanned', stats });
        } catch (error: any) {
            this.panel.webview.postMessage({
                command: 'addMessage',
                role: 'ai',
                text: `❌ Error saat scan: ${error.message}`
            });
        } finally {
            this.isScanning = false;
            this.panel.webview.postMessage({ command: 'setScanning', value: false });
        }
    }

    private async handleTestConnection() {
        this.panel.webview.postMessage({ command: 'setLoading', value: true });
        
        const isConnected = await this.client.testConnection();
        const config = vscode.workspace.getConfiguration('anythingllm');
        const serverUrl = config.get<string>('serverUrl', 'http://localhost:3001');
        
        this.panel.webview.postMessage({
            command: 'addMessage',
            role: 'ai',
            text: isConnected 
                ? `✅ **Terhubung ke AnythingLLM!**\nWorkspace: \`${this.client.getSlug()}\`\nServer: ${serverUrl}`
                : `❌ **Gagal terhubung ke AnythingLLM!**\n\nPeriksa:\n1. URL server sudah benar\n2. API Key sudah diisi\n3. Workspace slug sudah benar\n4. Server AnythingLLM bisa diakses\n\n*(Cek panel Output > AnythingLLM Assistant untuk detail error)*`
        });
        
        this.panel.webview.postMessage({ command: 'setLoading', value: false });
    }
    private async handleSyncProject() {
        this.panel.webview.postMessage({ command: 'setLoading', value: true });
        
        try {
          const workspaceFolders = vscode.workspace.workspaceFolders;
          if (!workspaceFolders) {
            throw new Error('Tidak ada workspace yang terbuka.');
          }
    
          const reader = new WorkspaceReader();
          const { files, stats } = await reader.scanWorkspace();
    
          if (files.length === 0) {
            throw new Error('Tidak ada file yang bisa di-scan (mungkin semua di-exclude atau binary).');
          }
    
          this.panel.webview.postMessage({
            command: 'addMessage',
            role: 'ai',
            text: `📤 Memulai sync ${files.length} file ke AnythingLLM... Mohon tunggu.`
          });
    
          // Gunakan progress bar native VS Code
          await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Syncing Project to AnythingLLM',
            cancellable: false
          }, async (progress) => {
            const uploadedFiles: string[] = [];
            let failedCount = 0;
    
            for (let i = 0; i < files.length; i++) {
              progress.report({ message: `Uploading ${files[i].relativePath} (${i + 1}/${files.length})`, increment: (1 / files.length) * 100 });
              
              const success = await this.client.uploadRawDocument(files[i].relativePath, files[i].content);
              if (success) {
                uploadedFiles.push(files[i].relativePath);
              } else {
                failedCount++;
              }
              
              // Jeda 300ms untuk menghindari rate limit API
              await new Promise(resolve => setTimeout(resolve, 300));
            }
    
            if (uploadedFiles.length > 0) {
              progress.report({ message: 'Triggering AI Embedding Process...', increment: 100 });
              await this.client.triggerWorkspaceSync(uploadedFiles);
            }
    
            const successMsg = `✅ **Sync Selesai!**\n📤 Berhasil: ${uploadedFiles.length} file\n❌ Gagal/Skip: ${failedCount} file\n\nAI sekarang bisa membaca file-file tersebut saat Anda bertanya.`;
            
            this.panel.webview.postMessage({
              command: 'addMessage',
              role: 'ai',
              text: successMsg
            });
          });
    
        } catch (error: any) {
          this.panel.webview.postMessage({
            command: 'addMessage',
            role: 'ai',
            text: `❌ **Sync Gagal:** ${error.message}`
          });
        } finally {
          this.panel.webview.postMessage({ command: 'setLoading', value: false });
        }
    }
    private formatSize(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    private getHtmlContent(): string {
        const config = vscode.workspace.getConfiguration('anythingllm');
        const workspaceSlug = config.get<string>('workspaceSlug', 'default');

        return `<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AnythingLLM Chat</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            height: 100vh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        .header {
            padding: 12px 16px;
            background: var(--vscode-titleBar-activeBackground);
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .header-icon { font-size: 20px; }
        .header-info { flex: 1; }
        .header-title { font-weight: bold; font-size: 14px; }
        .header-subtitle { font-size: 11px; opacity: 0.7; }
        .status-dot { width: 8px; height: 8px; border-radius: 50%; background: #f44336; }
        .status-dot.connected { background: #4caf50; }
        .toolbar {
            padding: 8px 12px;
            background: var(--vscode-sideBar-background);
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex; gap: 6px; flex-wrap: wrap;
        }
        .toolbar button {
            padding: 4px 10px; font-size: 11px;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none; border-radius: 3px; cursor: pointer;
            display: flex; align-items: center; gap: 4px;
        }
        .toolbar button:hover { background: var(--vscode-button-secondaryHoverBackground); }
        .toolbar button:disabled { opacity: 0.5; cursor: not-allowed; }
        #chat-container {
            flex: 1; overflow-y: auto; padding: 16px;
            display: flex; flex-direction: column; gap: 12px;
        }
        .message {
            max-width: 90%; padding: 10px 14px; border-radius: 10px;
            line-height: 1.5; font-size: 13px; word-wrap: break-word; white-space: pre-wrap;
        }
        .message.user {
            align-self: flex-end;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border-bottom-right-radius: 2px;
        }
        .message.ai {
            align-self: flex-start;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            border-bottom-left-radius: 2px;
        }
        .message.system {
            align-self: center; background: transparent;
            color: var(--vscode-descriptionForeground); font-size: 11px; font-style: italic;
        }
        .loading { display: flex; gap: 4px; padding: 12px; align-self: flex-start; }
        .loading span {
            width: 6px; height: 6px; background: var(--vscode-foreground);
            border-radius: 50%; animation: bounce 1.4s infinite ease-in-out;
        }
        .loading span:nth-child(1) { animation-delay: -0.32s; }
        .loading span:nth-child(2) { animation-delay: -0.16s; }
        @keyframes bounce { 0%, 80%, 100% { transform: scale(0); } 40% { transform: scale(1); } }
        .input-area {
            padding: 12px; background: var(--vscode-sideBar-background);
            border-top: 1px solid var(--vscode-panel-border);
            display: flex; gap: 8px;
        }
        #userInput {
            flex: 1; padding: 10px 12px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 6px; font-size: 13px; font-family: inherit;
            resize: none; min-height: 38px; max-height: 120px;
        }
        #userInput:focus { outline: 1px solid var(--vscode-focusBorder); }
        #syncBtn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
        #syncBtn:hover { background: var(--vscode-button-hoverBackground); }
        #sendBtn {
            padding: 10px 18px; background: var(--vscode-button-background);
            color: var(--vscode-button-foreground); border: none;
            border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500;
        }
        
        #sendBtn:hover { background: var(--vscode-button-hoverBackground); }
        #sendBtn:disabled { opacity: 0.5; cursor: not-allowed; }
        ::-webkit-scrollbar { width: 8px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); border-radius: 4px; }
        .project-stats {
            padding: 8px 12px; background: var(--vscode-textBlockQuote-background);
            border-radius: 6px; font-size: 11px; margin: 0 12px;
        }
    </style>
</head>
<body>
    <div class="header">
        <span class="header-icon">🤖</span>
        <div class="header-info">
            <div class="header-title">AnythingLLM Assistant</div>
            <div class="header-subtitle">Workspace: ${workspaceSlug}</div>
        </div>
        <div class="status-dot" id="statusDot" title="Disconnected"></div>
    </div>

    <div class="toolbar">
        <button id="syncBtn" title="Upload project ke AnythingLLM"><span>📤</span> Sync Project</button>
        <button id="scanBtn" title="Scan project lokal"><span>🔍</span> Scan Project</button>
        <button id="testBtn" title="Test koneksi ke AnythingLLM"><span>🔌</span> Test Connection</button>
        <button id="clearBtn" title="Hapus history chat"><span>🗑️</span> Clear</button>
    </div>

    <div id="projectStats" class="project-stats" style="display:none;"></div>
    <div id="chat-container"></div>

    <div class="input-area">
        <textarea id="userInput" placeholder="Tanya tentang project Anda..." rows="1"></textarea>
        <button id="sendBtn">Send</button>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const chatContainer = document.getElementById('chat-container');
        const userInput = document.getElementById('userInput');
        const sendBtn = document.getElementById('sendBtn');
        const scanBtn = document.getElementById('scanBtn');
        const testBtn = document.getElementById('testBtn');
        const clearBtn = document.getElementById('clearBtn');
        const statusDot = document.getElementById('statusDot');
        const projectStats = document.getElementById('projectStats');
        const syncBtn = document.getElementById('syncBtn');
        

        addMessage('ai', '👋 Halo! Saya AI Assistant Anda yang terhubung ke AnythingLLM.\\n\\n**Langkah pertama:** Klik tombol **🔍 Scan Project** agar saya bisa melihat seluruh kode di project Anda.\\n\\nAtau klik **🔌 Test Connection** untuk memastikan server bisa dihubungi.');

        sendBtn.addEventListener('click', sendMessage);
        scanBtn.addEventListener('click', () => vscode.postMessage({ command: 'scanWorkspace' }));
        testBtn.addEventListener('click', () => vscode.postMessage({ command: 'testConnection' }));
        syncBtn.addEventListener('click', () => vscode.postMessage({ command: 'syncProject' }));
        clearBtn.addEventListener('click', () => {
            chatContainer.innerHTML = '';
            vscode.postMessage({ command: 'clearHistory' });
            addMessage('system', 'Chat history cleared');
        });

        userInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
        });

        userInput.addEventListener('input', () => {
            userInput.style.height = 'auto';
            userInput.style.height = Math.min(userInput.scrollHeight, 120) + 'px';
        });

        function sendMessage() {
            const text = userInput.value.trim();
            if (!text) return;
            addMessage('user', text);
            vscode.postMessage({ command: 'sendMessage', text: text });
            userInput.value = '';
            userInput.style.height = 'auto';
        }

        function addMessage(role, text) {
            const div = document.createElement('div');
            div.className = 'message ' + role;
            let formatted = text
                .replace(/\\*\\*(.*?)\\*\\*/g, '<strong>$1</strong>')
                .replace(/\\*(.*?)\\*/g, '<em>$1</em>')
                .replace(/\`([^\`]+)\`/g, '<code style="background:rgba(127,127,127,0.2);padding:2px 4px;border-radius:3px;">$1</code>')
                .replace(/\\n/g, '<br>');
            div.innerHTML = formatted;
            chatContainer.appendChild(div);
            chatContainer.scrollTop = chatContainer.scrollHeight;
        }

        function showLoading(show) {
            let loading = document.getElementById('loadingIndicator');
            if (show) {
                if (!loading) {
                    loading = document.createElement('div');
                    loading.id = 'loadingIndicator';
                    loading.className = 'loading';
                    loading.innerHTML = '<span></span><span></span><span></span>';
                    chatContainer.appendChild(loading);
                }
                chatContainer.scrollTop = chatContainer.scrollHeight;
            } else if (loading) { loading.remove(); }
            sendBtn.disabled = show;
        }

        window.addEventListener('message', event => {
            const msg = event.data;
            switch (msg.command) {
                case 'addMessage': addMessage(msg.role, msg.text); break;
                case 'setLoading': showLoading(msg.value); break;
                case 'setScanning':
                    scanBtn.disabled = msg.value;
                    scanBtn.innerHTML = msg.value ? '<span>⏳</span> Scanning...' : '<span>🔍</span> Scan Project';
                    break;
                case 'projectScanned':
                    statusDot.classList.add('connected');
                    statusDot.title = 'Project scanned';
                    projectStats.style.display = 'block';
                    projectStats.innerHTML = \`📊 \${msg.stats.totalFiles} files | \${Object.keys(msg.stats.languages).length} languages\`;
                    break;
                case 'historyCleared':
                    projectStats.style.display = 'none';
                    statusDot.classList.remove('connected');
                    break;
            }
        });
    </script>
</body>
</html>`;
    }

    public dispose() {
        ChatPanel.currentPanel = undefined;
        this.panel.dispose();
        while (this.disposables.length) {
            const disposable = this.disposables.pop();
            if (disposable) { disposable.dispose(); }
        }
    }
}