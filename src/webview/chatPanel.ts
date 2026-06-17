import * as vscode from 'vscode';
import { AnythingLLMClient } from '../anythingllm';
import { WorkspaceReader } from '../workspaceReader';
import { TagManager } from '../agent/TagManager';
import { TaskPlanner } from '../agent/TaskPlanner';
import { CacheManager } from '../cacheManager';
import { getWebviewContent } from './webviewContent';

export class ChatPanel {
    public static currentPanel: ChatPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private readonly client: AnythingLLMClient;
    private readonly reader: WorkspaceReader;
    private readonly tagManager: TagManager;
    private readonly taskPlanner: TaskPlanner;
    private readonly cacheManager: CacheManager;
    private disposables: vscode.Disposable[] = [];
    private projectContext: string = '';
    private isScanning: boolean = false;

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        outputChannel: vscode.OutputChannel,
        tagManager: TagManager,
        taskPlanner: TaskPlanner,
        cacheManager: CacheManager
    ) {
        this.panel = panel;
        this.client = new AnythingLLMClient(outputChannel, cacheManager);
        this.reader = new WorkspaceReader();
        this.tagManager = tagManager;
        this.taskPlanner = taskPlanner;
        this.cacheManager = cacheManager;

        const config = vscode.workspace.getConfiguration('anythingllm');
        const workspaceSlug = config.get<string>('workspaceSlug', 'default');
        const serverUrl = config.get<string>('serverUrl', 'http://localhost:3001');

        this.panel.webview.html = getWebviewContent(workspaceSlug, serverUrl);

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
                    case 'agentMode':
                        await this.handleAgentMode(message.text);
                        break;
                    case 'tagCurrentFile':
                        await this.handleTagCurrentFile();
                        break;
                    case 'getTags':
                        await this.handleGetTags();
                        break;
                    case 'clearCache':
                        await this.handleClearCache();
                        break;
                    case 'forceSync':
                        await this.handleForceSync();
                        break;
                }
            },
            null,
            this.disposables
        );

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    }

    public static createOrShow(
        extensionUri: vscode.Uri,
        outputChannel: vscode.OutputChannel,
        tagManager: TagManager,
        taskPlanner: TaskPlanner,
        cacheManager: CacheManager
    ) {
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

        ChatPanel.currentPanel = new ChatPanel(
            panel,
            extensionUri,
            outputChannel,
            tagManager,
            taskPlanner,
            cacheManager
        );
    }

    // ============ HANDLER METHODS ============

    private async handleUserMessage(text: string) {
        this.panel.webview.postMessage({ command: 'setLoading', value: true });

        try {
            let fullMessage = text;
            if (!this.projectContext && !this.isScanning) {
                this.panel.webview.postMessage({
                    command: 'addMessage',
                    role: 'ai',
                    text: '⚠️ *Project belum di-scan. Klik tombol "Scan Project" atau "Sync Project" agar AI bisa melihat seluruh kode Anda.*'
                });
            }

            if (this.projectContext) {
                fullMessage = `[PROJECT CONTEXT]\n${this.projectContext}\n\n[USER QUESTION]\n${text}`;
            }

            const response = await this.client.chat(fullMessage, 'chat');

            if (response.success && response.data) {
                let aiText = response.data.response;

                aiText = aiText.replace(/<think>[\s\S]*?<\/think>/gi, '_*(Proses berpikir AI disembunyikan)*_').trim();
                
                if (response.data.sources && response.data.sources.length > 0) {
                    aiText += '\n\n---\n**📚 Sources:**\n';
                    response.data.sources.forEach((source: any, i: number) => {
                        const docName = (source.document || source.title || 'Unknown');
                        aiText += `${i + 1}. ${docName}\n`;
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
                text: '🔍 *Scanning project... Mohon tunggu.*'
            });

            this.projectContext = await this.reader.buildProjectContext();
            const stats = (await this.reader.scanWorkspace()).stats;

            this.panel.webview.postMessage({
                command: 'addMessage',
                role: 'ai',
                text: `✅ **Project berhasil di-scan!**\n\n📊 **Statistik:**\n-  Total Files: ${stats.totalFiles}\n- 💾 Total Size: ${this.formatSize(stats.totalSize)}\n- 🗣️ Languages: ${Object.entries(stats.languages).map(([l, c]) => `${l} (${c})`).join(', ')}\n\nSekarang Anda bisa bertanya tentang project Anda.`
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
                : `❌ **Gagal terhubung ke AnythingLLM!**\n\nPeriksa:\n1. URL server sudah benar\n2. API Key sudah diisi\n3. Workspace slug sudah benar\n4. Server AnythingLLM bisa diakses`
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

            const { files, stats } = await this.reader.scanWorkspace();

            if (files.length === 0) {
                throw new Error('Tidak ada file yang bisa di-scan.');
            }

            this.panel.webview.postMessage({
                command: 'addMessage',
                role: 'ai',
                text: ` Memulai sync ${files.length} file ke AnythingLLM...\n\n*Periksa panel Output untuk detail progress*`
            });

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Syncing Project to AnythingLLM',
                cancellable: false
            }, async (progress) => {
                const uploadedFiles: string[] = [];
                const skippedFiles: string[] = [];
                let failedCount = 0;
                let failedFiles: string[] = [];

                for (let i = 0; i < files.length; i++) {
                    const file = files[i];
                    const currentHash = this.cacheManager.getFileHash(file.content);

                    if (!this.cacheManager.hasFileChanged(file.relativePath, currentHash)) {
                        skippedFiles.push(file.relativePath);
                        progress.report({
                            message: `Skipping ${file.relativePath} (${i + 1}/${files.length})`,
                            increment: (1 / files.length) * 100
                        });
                        continue;
                    }

                    progress.report({
                        message: `Uploading ${file.relativePath} (${i + 1}/${files.length})`,
                        increment: (1 / files.length) * 100
                    });

                    const success = await this.client.uploadRawDocument(file.relativePath, file.content);

                    if (success) {
                        uploadedFiles.push(file.relativePath);
                        this.cacheManager.updateFileHash(file.relativePath, currentHash);
                    } else {
                        failedCount++;
                        failedFiles.push(file.relativePath);
                    }

                    await new Promise(resolve => setTimeout(resolve, 300));
                }

                if (uploadedFiles.length > 0) {
                    progress.report({ message: 'Triggering AI Embedding...', increment: 100 });
                    await this.client.triggerWorkspaceSync(uploadedFiles);
                }

                let resultMsg = `✅ **Sync Selesai!**\n\n`;
                resultMsg += `📤 **Berhasil:** ${uploadedFiles.length} file\n`;
                resultMsg += `⏭️ **Di-skip (tidak berubah):** ${skippedFiles.length} file\n`;
                resultMsg += `❌ **Gagal:** ${failedCount} file\n`;

                if (failedFiles.length > 0 && failedFiles.length <= 5) {
                    resultMsg += `\n**File yang gagal:**\n${failedFiles.map(f => `- ${f}`).join('\n')}`;
                } else if (failedFiles.length > 5) {
                    resultMsg += `\n**5 file pertama yang gagal:**\n${failedFiles.slice(0, 5).map(f => `- ${f}`).join('\n')}\n...dan ${failedFiles.length - 5} lainnya`;
                }

                resultMsg += `\n\n*Periksa panel **Output > AnythingLLM Assistant** untuk detail error*`;

                this.panel.webview.postMessage({
                    command: 'addMessage',
                    role: 'ai',
                    text: resultMsg
                });

                this.panel.webview.postMessage({
                    command: 'showToast',
                    text: `✅ Sync complete — ${uploadedFiles.length} file berhasil`,
                    type: 'success'
                });
            });

        } catch (error: any) {
            this.panel.webview.postMessage({
                command: 'addMessage',
                role: 'ai',
                text: `❌ **Sync Gagal:** ${error.message}\n\n*Periksa panel Output untuk detail*`
            });
        } finally {
            this.panel.webview.postMessage({ command: 'setLoading', value: false });
        }
    }

    private async handleAgentMode(request: string) {
        this.panel.webview.postMessage({ command: 'setLoading', value: true });

        try {
            const task = await this.taskPlanner.createTaskFromRequest(request);

            if (task) {
                const stepsText = task.steps.map((s: any, i: number) => `${i + 1}. **${s.action}**: ${s.description}`).join('\n');

                this.panel.webview.postMessage({
                    command: 'addMessage',
                    role: 'ai',
                    text: ` **Task Plan Dibuat!**\n\n${task.description}\n\n**Steps (${task.steps.length}):\n${stepsText}\n\n✅ Task siap dieksekusi.`
                });
            } else {
                this.panel.webview.postMessage({
                    command: 'addMessage',
                    role: 'ai',
                    text: '❌ Gagal membuat task plan. Coba deskripsikan dengan lebih detail.'
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

    private async handleTagCurrentFile() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            this.panel.webview.postMessage({
                command: 'addMessage',
                role: 'ai',
                text: '⚠️ Tidak ada file yang aktif di editor.'
            });
            return;
        }

        await this.tagManager.showTagPicker(editor.document.fileName);

        const tags = this.tagManager.getTagsForFile(editor.document.fileName);
        this.panel.webview.postMessage({
            command: 'addMessage',
            role: 'ai',
            text: `🏷️ **Tags untuk \`${editor.document.fileName.split(/[\\/]/).pop()}\`:\n${tags.length > 0 ? tags.map((t: string) => `- ${t}`).join('\n') : '*Belum ada tag*'}`
        });
    }

    private async handleGetTags() {
        const tags = this.tagManager.getAllTags();
        const tagsData = tags.map((t: any) => ({ name: t.name, color: t.color }));
        this.panel.webview.postMessage({ command: 'tagsList', tags: tagsData });
    }

    // ============ HELPER METHODS ============

    private formatSize(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    private async handleClearCache() {
        const confirm = await vscode.window.showWarningMessage(
            'Hapus semua cache? File akan di-upload ulang saat sync berikutnya.',
            'Ya', 'Tidak'
        );

        if (confirm === 'Ya') {
            await vscode.commands.executeCommand('anythingllm.clearCache');
            this.panel.webview.postMessage({
                command: 'showToast',
                text: '🗑️ Cache cleared',
                type: 'info'
            });
        }
    }

    private async handleForceSync() {
        this.panel.webview.postMessage({ command: 'setLoading', value: true });

        try {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders) {
                throw new Error('Tidak ada workspace yang terbuka.');
            }

            const { files, stats } = await this.reader.scanWorkspace();

            if (files.length === 0) {
                throw new Error('Tidak ada file yang bisa di-scan.');
            }

            this.panel.webview.postMessage({
                command: 'addMessage',
                role: 'ai',
                text: `🔄 **Force Sync Dimulai!**\n\nMeng-upload ulang ${files.length} file (bypass cache)...`
            });

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Force Syncing Project',
                cancellable: false
            }, async (progress) => {
                const uploadedFiles: string[] = [];
                let failedCount = 0;

                for (let i = 0; i < files.length; i++) {
                    const file = files[i];
                    const currentHash = this.cacheManager.getFileHash(file.content);

                    progress.report({
                        message: `Uploading ${file.relativePath} (${i + 1}/${files.length})`,
                        increment: (1 / files.length) * 100
                    });

                    const success = await this.client.uploadRawDocument(file.relativePath, file.content);

                    if (success) {
                        uploadedFiles.push(file.relativePath);
                        this.cacheManager.updateFileHash(file.relativePath, currentHash);
                    } else {
                        failedCount++;
                    }

                    await new Promise(resolve => setTimeout(resolve, 300));
                }

                if (uploadedFiles.length > 0) {
                    progress.report({ message: 'Triggering AI Embedding...', increment: 100 });
                    await this.client.triggerWorkspaceSync(uploadedFiles);
                }

                this.panel.webview.postMessage({
                    command: 'addMessage',
                    role: 'ai',
                    text: `✅ **Force Sync Selesai!**\n\n📤 **Berhasil:** ${uploadedFiles.length} file\n❌ **Gagal:** ${failedCount} file\n\nCache telah diupdate. Sync berikutnya akan lebih cepat.`
                });

                this.panel.webview.postMessage({
                    command: 'showToast',
                    text: `🔄 Force sync complete — ${uploadedFiles.length} file`,
                    type: 'success'
                });
            });

        } catch (error: any) {
            this.panel.webview.postMessage({
                command: 'addMessage',
                role: 'ai',
                text: `❌ **Force Sync Gagal:** ${error.message}`
            });
        } finally {
            this.panel.webview.postMessage({ command: 'setLoading', value: false });
        }
    }

    // ✅ Method dispose yang hilang - ini yang menyebabkan error
    public dispose(): void {
        ChatPanel.currentPanel = undefined;
        this.panel.dispose();
        while (this.disposables.length) {
            const disposable = this.disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
}