import * as vscode from 'vscode';
import { ChatPanel } from './webview/chatPanel';

let outputChannel: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {
    // Buat Output Channel baru
    outputChannel = vscode.window.createOutputChannel('AnythingLLM Assistant');
    outputChannel.appendLine('🤖 AnythingLLM Assistant is now active!');
    outputChannel.appendLine('Untuk melihat log debugging, buka menu View > Output, lalu pilih "AnythingLLM Assistant" di dropdown.');

    const openChatCmd = vscode.commands.registerCommand('anythingllm.openChat', () => {
        ChatPanel.createOrShow(context.extensionUri, outputChannel); // <--- oper outputChannel
    });

    const scanWorkspaceCmd = vscode.commands.registerCommand('anythingllm.scanWorkspace', () => {
        ChatPanel.createOrShow(context.extensionUri, outputChannel);
    });

    const clearHistoryCmd = vscode.commands.registerCommand('anythingllm.clearHistory', () => {
        vscode.window.showInformationMessage('Chat history cleared!');
    });

    context.subscriptions.push(openChatCmd, scanWorkspaceCmd, clearHistoryCmd, outputChannel);

    const config = vscode.workspace.getConfiguration('anythingllm');
    const apiKey = config.get<string>('apiKey', '');
    
    if (!apiKey) {
        vscode.window.showWarningMessage(
            '⚠️ AnythingLLM API Key belum diset! Buka Settings > Extensions > AnythingLLM Assistant.',
            'Open Settings'
        ).then(selection => {
            if (selection === 'Open Settings') {
                vscode.commands.executeCommand('workbench.action.openSettings', 'anythingllm');
            }
        });
    }
}

export function deactivate() {}