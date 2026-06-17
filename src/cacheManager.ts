import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';

export class CacheManager {
    private cachePath: string;
    private cacheData: {
        fileHashes: Record<string, string>;
        chatResponses: Record<string, { response: string; timestamp: number }>;
    };

    constructor() {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        const rootPath = workspaceFolders ? workspaceFolders[0].uri.fsPath : vscode.env.appRoot;
        this.cachePath = path.join(rootPath, '.vscode', 'ai-cache.json');
        this.cacheData = { fileHashes: {}, chatResponses: {} };
        this.loadCache();
    }

    // --- File Hash Cache (Untuk Sync Project) ---
    public getFileHash(content: string): string {
        return crypto.createHash('md5').update(content).digest('hex');
    }

    public hasFileChanged(relativePath: string, currentHash: string): boolean {
        const cachedHash = this.cacheData.fileHashes[relativePath];
        return cachedHash !== currentHash;
    }

    public updateFileHash(relativePath: string, hash: string): void {
        this.cacheData.fileHashes[relativePath] = hash;
        this.saveCache();
    }

    // --- Chat Response Cache (Untuk Hemat API) ---
    public getCachedResponse(promptHash: string): string | null {
        const cached = this.cacheData.chatResponses[promptHash];
        if (cached) {
            // Cache expired setelah 1 jam (3600000 ms)
            if (Date.now() - cached.timestamp < 3600000) {
                return cached.response;
            } else {
                delete this.cacheData.chatResponses[promptHash];
                this.saveCache();
            }
        }
        return null;
    }

    public saveResponse(promptHash: string, response: string): void {
        this.cacheData.chatResponses[promptHash] = { response, timestamp: Date.now() };
        this.saveCache();
    }

    // --- Helper ---
    private loadCache(): void {
        try {
            if (fs.existsSync(this.cachePath)) {
                this.cacheData = JSON.parse(fs.readFileSync(this.cachePath, 'utf-8'));
            }
        } catch (e) {
            console.error('Failed to load cache', e);
        }
    }

    private saveCache(): void {
        try {
            const dir = path.dirname(this.cachePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(this.cachePath, JSON.stringify(this.cacheData, null, 2));
        } catch (e) {
            console.error('Failed to save cache', e);
        }
    }
}