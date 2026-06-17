import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export interface EditOperation {
    filePath: string;
    oldText: string;
    newText: string;
    description?: string;
}

export class FileEditor {
    private outputChannel: vscode.OutputChannel;

    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
    }

    /**
     * Edit file dengan search & replace
     * Dengan konfirmasi user dan diff preview
     */
    async editFile(
        filePath: string,
        oldText: string,
        newText: string,
        description: string = 'AI Edit'
    ): Promise<boolean> {
        try {
            this.outputChannel.appendLine(`[EDITOR] Memulai edit: ${filePath}`);
            this.outputChannel.appendLine(`[EDITOR] Description: ${description}`);

            // Validasi file
            if (!fs.existsSync(filePath)) {
                throw new Error(`File tidak ditemukan: ${filePath}`);
            }

            // Baca isi file saat ini
            const currentContent = await fs.promises.readFile(filePath, 'utf-8');

            // Cek apakah oldText ada di file
            if (!currentContent.includes(oldText)) {
                throw new Error('Teks yang akan diganti tidak ditemukan di file');
            }

            // Buat diff
            const diff = this.createDiff(currentContent, oldText, newText);
            
            // Tampilkan preview ke user
            const userConfirmed = await this.showEditPreview(filePath, diff, description);
            
            if (!userConfirmed) {
                this.outputChannel.appendLine('[EDITOR] User membatalkan edit');
                return false;
            }

            // Lakukan edit
            const workspaceEdit = new vscode.WorkspaceEdit();
            const uri = vscode.Uri.file(filePath);
            
            // Cari semua occurrence oldText
            const document = await vscode.workspace.openTextDocument(uri);
            const occurrences = this.findAllOccurrences(document, oldText);
            
            for (const range of occurrences) {
                workspaceEdit.replace(uri, range, newText);
            }

            // Apply edit
            const success = await vscode.workspace.applyEdit(workspaceEdit);
            
            if (success) {
                this.outputChannel.appendLine(`[EDITOR] ✅ Edit berhasil applied`);
                
                // Auto-save jika di-enable
                const config = vscode.workspace.getConfiguration('anythingllm');
                if (config.get<boolean>('autoSaveAfterEdit', true)) {
                    await document.save();
                    this.outputChannel.appendLine(`[EDITOR] 💾 File auto-saved`);
                }
                
                return true;
            } else {
                throw new Error('Gagal menerapkan edit ke workspace');
            }
        } catch (error: any) {
            this.outputChannel.appendLine(`[EDITOR] ❌ Error: ${error.message}`);
            vscode.window.showErrorMessage(`File edit failed: ${error.message}`);
            return false;
        }
    }

    /**
     * Create new file
     */
    async createFile(filePath: string, content: string): Promise<boolean> {
        try {
            this.outputChannel.appendLine(`[EDITOR] Creating file: ${filePath}`);

            // Cek apakah file sudah ada
            if (fs.existsSync(filePath)) {
                const overwrite = await vscode.window.showWarningMessage(
                    `File sudah ada: ${path.basename(filePath)}. Timpa?`,
                    { modal: true },
                    'Ya', 'Tidak'
                );
                
                if (overwrite !== 'Ya') {
                    return false;
                }
            }

            // Pastikan folder ada
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) {
                await fs.promises.mkdir(dir, { recursive: true });
            }

            // Tulis file
            await fs.promises.writeFile(filePath, content, 'utf-8');
            
            this.outputChannel.appendLine(`[EDITOR] ✅ File created: ${filePath}`);
            
            // Buka file di editor
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
            await vscode.window.showTextDocument(document);
            
            return true;
        } catch (error: any) {
            this.outputChannel.appendLine(`[EDITOR] ❌ Error creating file: ${error.message}`);
            vscode.window.showErrorMessage(`Failed to create file: ${error.message}`);
            return false;
        }
    }

    /**
     * Delete file dengan konfirmasi
     */
    async deleteFile(filePath: string): Promise<boolean> {
        try {
            this.outputChannel.appendLine(`[EDITOR] Deleting file: ${filePath}`);

            const confirmed = await vscode.window.showWarningMessage(
                `Hapus file "${path.basename(filePath)}"? Tindakan ini tidak bisa dibatalkan.`,
                { modal: true },
                'Hapus', 'Batal'
            );

            if (confirmed !== 'Hapus') {
                return false;
            }

            await fs.promises.unlink(filePath);
            this.outputChannel.appendLine(`[EDITOR] ✅ File deleted: ${filePath}`);
            
            return true;
        } catch (error: any) {
            this.outputChannel.appendLine(`[EDITOR] ❌ Error deleting file: ${error.message}`);
            vscode.window.showErrorMessage(`Failed to delete file: ${error.message}`);
            return false;
        }
    }

    /**
     * Execute terminal command (Agent feature)
     */
    async executeCommand(command: string): Promise<{ success: boolean; output: string }> {
        try {
            this.outputChannel.appendLine(`[AGENT] Executing command: ${command}`);

            // Safety check - block dangerous commands
            const dangerousCommands = ['rm -rf /', 'del /s', 'format', 'mkfs'];
            if (dangerousCommands.some(dc => command.includes(dc))) {
                throw new Error('Command berbahaya diblokir untuk keamanan');
            }

            // Konfirmasi user
            const confirmed = await vscode.window.showWarningMessage(
                `Jalankan command: "${command}"?`,
                { modal: true },
                'Ya', 'Tidak'
            );

            if (confirmed !== 'Ya') {
                return { success: false, output: 'Command dibatalkan user' };
            }

            // Execute di terminal
            const terminal = vscode.window.createTerminal('AI Agent');
            terminal.show();
            terminal.sendText(command);

            // Note: VS Code API tidak menyediakan cara mudah untuk capture output terminal
            // User perlu lihat output di terminal secara manual
            
            this.outputChannel.appendLine(`[AGENT] ✅ Command executed (lihat terminal untuk output)`);
            
            return { 
                success: true, 
                output: 'Command dijalankan. Lihat terminal untuk output.' 
            };
        } catch (error: any) {
            this.outputChannel.appendLine(`[AGENT] ❌ Error executing command: ${error.message}`);
            return { success: false, output: error.message };
        }
    }

    private findAllOccurrences(document: vscode.TextDocument, searchText: string): vscode.Range[] {
        const ranges: vscode.Range[] = [];
        const text = document.getText();
        let index = text.indexOf(searchText);
        
        while (index !== -1) {
            const position = document.positionAt(index);
            const endPosition = document.positionAt(index + searchText.length);
            ranges.push(new vscode.Range(position, endPosition));
            index = text.indexOf(searchText, index + 1);
        }
        
        return ranges;
    }

    private createDiff(original: string, oldText: string, newText: string): string {
        return `--- Original\n+++ Modified\n\n-${oldText.split('\n').slice(0, 5).join('\\n')}\n+${newText.split('\n').slice(0, 5).join('\\n')}\n...`;
    }

    private async showEditPreview(filePath: string, diff: string, description: string): Promise<boolean> {
        const result = await vscode.window.showInformationMessage(
            `AI ingin mengedit file:\n${path.basename(filePath)}\n\n${description}\n\n${diff.substring(0, 500)}...`,
            { modal: true, detail: 'Review perubahan di atas sebelum melanjutkan' },
            'Terapkan Perubahan', 'Batal'
        );
        
        return result === 'Terapkan Perubahan';
    }
}