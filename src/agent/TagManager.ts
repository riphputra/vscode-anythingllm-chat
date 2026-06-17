import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os'

export interface FileTag {
    name: string;
    color: string;
    description?: string;
}

export interface TaggedFile {
    filePath: string;
    tags: string[];
    metadata?: {
        lastModified: string;
        addedBy: string;
    };
}

export class TagManager {
    private tagsFilePath: string;
    private tags: Map<string, FileTag>;
    private taggedFiles: Map<string, TaggedFile>;
    private outputChannel: vscode.OutputChannel;

    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
        
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders) {
            const workspacePath = workspaceFolders[0].uri.fsPath;
            this.tagsFilePath = path.join(workspacePath, '.vscode', 'ai-tags.json');
        } else {
            this.tagsFilePath = path.join(vscode.env.appRoot, 'ai-tags.json');
        }
        
        this.tags = new Map();
        this.taggedFiles = new Map();
        this.loadTags();
    }

    /**
     * Add tag to file
     */
    async addTagToFile(filePath: string, tagName: string): Promise<boolean> {
        try {
            this.outputChannel.appendLine(`[TAG] Adding tag "${tagName}" to ${filePath}`);

            if (!this.tags.has(tagName)) {
                // Auto-create tag dengan warna random
                const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD'];
                const randomColor = colors[Math.floor(Math.random() * colors.length)];
                this.tags.set(tagName, { name: tagName, color: randomColor });
            }

            let taggedFile = this.taggedFiles.get(filePath);
            if (!taggedFile) {
                taggedFile = {
                    filePath,
                    tags: [],
                    metadata: {
                        lastModified: new Date().toISOString(),
                        addedBy: os.userInfo().username
                    }
                };
            }

            if (!taggedFile.tags.includes(tagName)) {
                taggedFile.tags.push(tagName);
                taggedFile.metadata!.lastModified = new Date().toISOString();
                this.taggedFiles.set(filePath, taggedFile);
                
                await this.saveTags();
                this.outputChannel.appendLine(`[TAG] ✅ Tag added successfully`);
                return true;
            }

            return false; // Tag sudah ada
        } catch (error: any) {
            this.outputChannel.appendLine(`[TAG] ❌ Error: ${error.message}`);
            return false;
        }
    }

    /**
     * Remove tag from file
     */
    async removeTagFromFile(filePath: string, tagName: string): Promise<boolean> {
        const taggedFile = this.taggedFiles.get(filePath);
        if (!taggedFile) return false;

        const index = taggedFile.tags.indexOf(tagName);
        if (index > -1) {
            taggedFile.tags.splice(index, 1);
            this.taggedFiles.set(filePath, taggedFile);
            await this.saveTags();
            return true;
        }

        return false;
    }

    /**
     * Get files by tag
     */
    getFilesByTag(tagName: string): TaggedFile[] {
        return Array.from(this.taggedFiles.values()).filter(file => 
            file.tags.includes(tagName)
        );
    }

    /**
     * Get tags for file
     */
    getTagsForFile(filePath: string): string[] {
        return this.taggedFiles.get(filePath)?.tags || [];
    }

    /**
     * Get all tags
     */
    getAllTags(): FileTag[] {
        return Array.from(this.tags.values());
    }

    /**
     * Create new tag
     */
    async createTag(name: string, color: string, description?: string): Promise<boolean> {
        if (this.tags.has(name)) {
            return false;
        }

        this.tags.set(name, { name, color, description });
        await this.saveTags();
        return true;
    }

    /**
     * Show tag picker UI
     */
    async showTagPicker(filePath: string): Promise<void> {
        const tags = Array.from(this.tags.keys());
        const currentTags = this.getTagsForFile(filePath);
        
        // Tambahkan opsi untuk membuat tag baru secara instan
        const quickPickItems = [
            { label: '$(add) Buat Tag Baru...', description: 'Ketik nama tag baru', tag: '__NEW__' },
            ...tags.map(tag => ({
                label: tag,
                description: currentTags.includes(tag) ? '✓ Sudah ditag' : 'Klik untuk tag',
                picked: currentTags.includes(tag),
                tag
            }))
        ];

        const selected = await vscode.window.showQuickPick(quickPickItems, {
            canPickMany: true,
            placeHolder: 'Pilih tag atau ketik nama baru...'
        });

        if (selected) {
            for (const item of selected) {
                if (item.tag === '__NEW__') {
                    const newTagName = await vscode.window.showInputBox({ prompt: 'Nama tag baru:' });
                    if (newTagName) await this.addTagToFile(filePath, newTagName);
                } else {
                    await this.addTagToFile(filePath, item.tag);
                }
            }
        }
    }

    private async createTagFromInput(): Promise<void> {
        const name = await vscode.window.showInputBox({
            prompt: 'Nama tag',
            placeHolder: 'contoh: important, todo, review'
        });

        if (!name) return;

        const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7'];
        const color = await vscode.window.showQuickPick(colors, {
            placeHolder: 'Pilih warna tag'
        });

        if (color) {
            await this.createTag(name, color);
            vscode.window.showInformationMessage(`Tag "${name}" berhasil dibuat!`);
        }
    }

    private async loadTags(): Promise<void> {
        try {
            if (fs.existsSync(this.tagsFilePath)) {
                const data = JSON.parse(await fs.promises.readFile(this.tagsFilePath, 'utf-8'));
                
                if (data.tags) {
                    Object.entries(data.tags).forEach(([name, tag]: [string, any]) => {
                        this.tags.set(name, tag);
                    });
                }
                
                if (data.files) {
                    Object.entries(data.files).forEach(([path, file]: [string, any]) => {
                        this.taggedFiles.set(path, file);
                    });
                }
                
                this.outputChannel.appendLine(`[TAG] Loaded ${this.tags.size} tags and ${this.taggedFiles.size} tagged files`);
            }
        } catch (error: any) {
            this.outputChannel.appendLine(`[TAG] Error loading tags: ${error.message}`);
        }
    }

    private async saveTags(): Promise<void> {
        try {
            const dir = path.dirname(this.tagsFilePath);
            if (!fs.existsSync(dir)) {
                await fs.promises.mkdir(dir, { recursive: true });
            }

            const data = {
                tags: Object.fromEntries(this.tags),
                files: Object.fromEntries(this.taggedFiles),
                version: '1.0'
            };

            await fs.promises.writeFile(this.tagsFilePath, JSON.stringify(data, null, 2), 'utf-8');
            this.outputChannel.appendLine(`[TAG] Tags saved to ${this.tagsFilePath}`);
        } catch (error: any) {
            this.outputChannel.appendLine(`[TAG] Error saving tags: ${error.message}`);
        }
    }
}