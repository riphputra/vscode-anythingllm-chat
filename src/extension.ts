import * as vscode from 'vscode';
import { ChatPanel } from './webview/chatPanel';
import { AnythingLLMClient } from './anythingllm';
import { FileEditor } from './agent/FileEditor';
import { TagManager } from './agent/TagManager';
import { TaskPlanner } from './agent/TaskPlanner';
import { CacheManager } from './cacheManager';
import * as fs from 'fs';
import * as path from 'path';

let outputChannel: vscode.OutputChannel;
let tagManager: TagManager;
let fileEditor: FileEditor;
let taskPlanner: TaskPlanner;
let cacheManager: CacheManager;

export function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('AnythingLLM Assistant');
    outputChannel.appendLine('🤖 AnythingLLM Assistant activated!');

    cacheManager = new CacheManager();

    const client = new AnythingLLMClient(outputChannel, cacheManager);
    fileEditor = new FileEditor(outputChannel);
    tagManager = new TagManager(outputChannel);
    taskPlanner = new TaskPlanner(client, fileEditor, outputChannel);

    // Command: Open Chat
    context.subscriptions.push(
        vscode.commands.registerCommand('anythingllm.openChat', () => {
            ChatPanel.createOrShow(context.extensionUri, outputChannel, tagManager, taskPlanner, cacheManager);
        })
    );

    // Command: Tag File
    context.subscriptions.push(
        vscode.commands.registerCommand('anythingllm.tagFile', async (uri?: vscode.Uri) => {
            const filePath = uri?.fsPath || vscode.window.activeTextEditor?.document.fileName;
            if (filePath) {
                await tagManager.showTagPicker(filePath);
            }
        })
    );

    // Command: Show Tagged Files
    context.subscriptions.push(
        vscode.commands.registerCommand('anythingllm.showTaggedFiles', async () => {
            const tags = tagManager.getAllTags();
            
            const quickPickItems = tags.map(tag => ({
                label: tag.name,
                description: tag.description || '',
                color: tag.color,
                tag
            }));

            const selected = await vscode.window.showQuickPick(quickPickItems, {
                placeHolder: 'Pilih tag untuk lihat file'
            });

            if (selected) {
                const files = tagManager.getFilesByTag(selected.tag.name);
                const fileUris = files.map(f => vscode.Uri.file(f.filePath));
                
                await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(files[0]?.filePath || ''), { forceNewWindow: false });
            }
        })
    );

    // Command: Agent Mode
    context.subscriptions.push(
        vscode.commands.registerCommand('anythingllm.agentMode', async () => {
            const request = await vscode.window.showInputBox({
                prompt: 'Apa yang ingin AI lakukan?',
                placeHolder: 'contoh: "Buat fungsi login dengan validasi email dan password"',
                ignoreFocusOut: true
            });

            if (request) {
                vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: 'AI Agent sedang membuat rencana...',
                    cancellable: false
                }, async (progress) => {
                    progress.report({ message: 'Menganalisis request...' });
                    
                    const task = await taskPlanner.createTaskFromRequest(request);
                    
                    if (task) {
                        progress.report({ message: `Task plan dibuat: ${task.steps.length} steps` });
                        
                        const confirmed = await vscode.window.showInformationMessage(
                            `AI akan menjalankan ${task.steps.length} step:\n\n${task.steps.map((s, i) => `${i+1}. ${s.description}`).join('\n')}`,
                            'Jalankan', 'Batal'
                        );

                        if (confirmed === 'Jalankan') {
                            progress.report({ message: 'Menjalankan task...' });
                            await taskPlanner.executeTask(task.id);
                        }
                    }
                });
            }
        })
    );

    // Welcome message
    const config = vscode.workspace.getConfiguration('anythingllm');
    if (!config.get<string>('apiKey')) {
        vscode.window.showWarningMessage(
            '⚠️ API Key belum diset!',
            'Open Settings'
        ).then(selection => {
            if (selection === 'Open Settings') {
                vscode.commands.executeCommand('workbench.action.openSettings', 'anythingllm');
            }
        });
    }
    // 1. Buat Status Bar Item untuk Tagging
    const tagStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    tagStatusBar.command = 'anythingllm.tagFile';
    context.subscriptions.push(tagStatusBar);

    // 2. Update Status Bar saat pindah file
    const updateTagStatus = () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const tags = tagManager.getTagsForFile(editor.document.fileName);
            if (tags.length > 0) {
                tagStatusBar.text = `️ ${tags.join(', ')}`;
                tagStatusBar.tooltip = 'Klik untuk mengubah tag file ini';
                tagStatusBar.show();
            } else {
                tagStatusBar.text = '🏷️ Tag File';
                tagStatusBar.tooltip = 'Klik untuk memberi tag pada file ini';
                tagStatusBar.show();
            }
        } else {
            tagStatusBar.hide();
        }
    };

    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(updateTagStatus));
    updateTagStatus(); // Panggil saat pertama kali load

    // Command: Clear Cache
    context.subscriptions.push(
        vscode.commands.registerCommand('anythingllm.clearCache', async () => {
            const confirm = await vscode.window.showWarningMessage(
                'Hapus semua cache (file hash & chat history)? Ini akan memaksa re-upload semua file saat sync berikutnya.',
                'Ya, Hapus Cache', 'Batal'
            );
            
            if (confirm === 'Ya, Hapus Cache') {
                // Hapus file cache
                const workspaceFolders = vscode.workspace.workspaceFolders;
                if (workspaceFolders) {
                    const cachePath = path.join(workspaceFolders[0].uri.fsPath, '.vscode', 'ai-cache.json');
                    try {
                        if (fs.existsSync(cachePath)) {
                            await fs.promises.unlink(cachePath);
                            vscode.window.showInformationMessage('✅ Cache berhasil dihapus! Silakan sync ulang project Anda.');
                            outputChannel.appendLine('[CACHE] ✅ Cache cleared');
                        }
                    } catch (error: any) {
                        vscode.window.showErrorMessage(`Gagal hapus cache: ${error.message}`);
                    }
                }
            }
        })
    );
}

export function deactivate() {}