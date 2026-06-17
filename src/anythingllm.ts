import axios, { AxiosInstance } from 'axios';
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { CacheManager } from './cacheManager';

export interface ChatResponse {
    success: boolean;
    data?: {
        response: string;
        sources?: Array<any>;
    };
    error?: string;
}

export class AnythingLLMClient {
    private cacheManager: CacheManager;
    private client: AxiosInstance;
    private workspaceSlug: string;
    private sessionId: string;
    private outputChannel: vscode.OutputChannel;

    constructor(outputChannel: vscode.OutputChannel, cacheManager: CacheManager) {
        this.outputChannel = outputChannel;
        this.cacheManager = cacheManager;
        
        const config = vscode.workspace.getConfiguration('anythingllm');
        let serverUrl = config.get<string>('serverUrl', 'http://localhost:3001');
        if (serverUrl.endsWith('/')) serverUrl = serverUrl.slice(0, -1);
        
        const apiKey = config.get<string>('apiKey', '');
        this.workspaceSlug = config.get<string>('workspaceSlug', 'default');
        this.sessionId = `vscode-${Date.now()}`;

        this.outputChannel.appendLine(`[INIT] Server: ${serverUrl}`);
        this.outputChannel.appendLine(`[INIT] Workspace: ${this.workspaceSlug}`);
        this.outputChannel.appendLine(`[INIT] API Key: ${apiKey ? '***' + apiKey.slice(-4) : 'NOT SET'}`);

        this.client = axios.create({
            baseURL: `${serverUrl}/api/v1`,
            timeout: 60000,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            }
        });
    }

    /**
     * Upload file sebagai text document ke AnythingLLM
     * Menggunakan JSON payload (LEBIH SIMPLE & RELIABLE)
     */
    async uploadRawDocument(filename: string, content: string): Promise<boolean> {
        try {
            this.outputChannel.appendLine(`[UPLOAD] Mengupload: ${filename} (${(content.length / 1024).toFixed(1)} KB)`);
            
            // Buat filename yang aman (ganti slash dengan underscore)
            const safeFilename = filename.replace(/[/\\]/g, '_');
            
            // Kirim sebagai JSON langsung (tanpa FormData)
            const response = await this.client.post('/document/upload-file', {
                name: safeFilename,
                content: content
            });

            this.outputChannel.appendLine(`[UPLOAD] ✅ Status: ${response.status}`);
            this.outputChannel.appendLine(`[UPLOAD] ✅ Response: ${JSON.stringify(response.data).substring(0, 200)}`);
            
            // Cek apakah upload berhasil
            if (response.data?.success || response.data?.document || response.status === 200) {
                return true;
            }
            
            return false;
        } catch (error: any) {
            this.outputChannel.appendLine(`[UPLOAD] ❌ Error: ${error.message}`);
            
            if (error.response) {
                this.outputChannel.appendLine(`[UPLOAD] Status: ${error.response.status}`);
                this.outputChannel.appendLine(`[UPLOAD] Detail: ${JSON.stringify(error.response.data).substring(0, 300)}`);
                
                // Jika endpoint /document/upload-file tidak ada, coba endpoint alternatif
                if (error.response.status === 404) {
                    this.outputChannel.appendLine(`[UPLOAD] Mencoba endpoint alternatif...`);
                    return await this.uploadRawDocumentAlternative(filename, content);
                }
            }
            
            return false;
        }
    }

    /**
     * Fallback: Upload via endpoint alternatif
     */
    private async uploadRawDocumentAlternative(filename: string, content: string): Promise<boolean> {
        try {
            const safeFilename = filename.replace(/[/\\]/g, '_');
            
            // Coba endpoint langsung ke workspace
            const response = await this.client.post(`/workspace/${this.workspaceSlug}/update-embeddings`, {
                adds: [{
                    name: safeFilename,
                    content: content
                }],
                deletes: []
            });

            this.outputChannel.appendLine(`[UPLOAD-ALT] ✅ Response: ${JSON.stringify(response.data).substring(0, 200)}`);
            return response.data?.success || response.status === 200;
        } catch (error: any) {
            this.outputChannel.appendLine(`[UPLOAD-ALT] ❌ Error: ${error.message}`);
            if (error.response) {
                this.outputChannel.appendLine(`[UPLOAD-ALT] Detail: ${JSON.stringify(error.response.data).substring(0, 300)}`);
            }
            return false;
        }
    }

    /**
     * Trigger workspace sync untuk memproses file yang sudah di-upload
     */
    async triggerWorkspaceSync(fileNames: string[]): Promise<boolean> {
        try {
            this.outputChannel.appendLine(`[SYNC] Memproses ${fileNames.length} file di workspace...`);
            
            const processedNames = fileNames.map(f => f.replace(/[/\\]/g, '_'));
            
            const response = await this.client.post(`/workspace/${this.workspaceSlug}/update-embeddings`, {
                adds: processedNames,
                deletes: []
            });

            this.outputChannel.appendLine(`[SYNC] ✅ Response: ${JSON.stringify(response.data).substring(0, 200)}`);
            return response.data?.success || response.status === 200;
        } catch (error: any) {
            this.outputChannel.appendLine(`[SYNC] ❌ Error: ${error.message}`);
            if (error.response) {
                this.outputChannel.appendLine(`[SYNC] Detail: ${JSON.stringify(error.response.data).substring(0, 300)}`);
            }
            return false;
        }
    }

    async chat(message: string, mode: 'chat' | 'query' = 'chat'): Promise<ChatResponse> {
        try {
            const promptHash = crypto.createHash('md5').update(message).digest('hex');
            const cachedResponse = this.cacheManager.getCachedResponse(promptHash);
            
            if (cachedResponse) {
                this.outputChannel.appendLine(`[CACHE] ✅ Menggunakan response dari cache`);
                return { success: true, data: { response: cachedResponse } };
            }

            this.outputChannel.appendLine(`[CHAT] Memanggil API...`);
            const response = await this.client.post(
                `/workspace/${this.workspaceSlug}/chat`,
                { message: message, mode: mode, sessionId: this.sessionId }
            );

            const aiText = response.data.textResponse || response.data.response || JSON.stringify(response.data);
            this.cacheManager.saveResponse(promptHash, aiText);

            return { 
                success: true, 
                data: { 
                    response: aiText, 
                    sources: response.data.sources || [] 
                } 
            };
        } catch (error: any) {
            this.outputChannel.appendLine(`[CHAT] ❌ Error: ${error.message}`);
            if (error.response) {
                this.outputChannel.appendLine(`[CHAT] Detail: ${JSON.stringify(error.response.data).substring(0, 300)}`);
            }
            return { 
                success: false, 
                error: error.response?.data?.error || error.message 
            };
        }
    }

    async testConnection(): Promise<boolean> {
        try {
            this.outputChannel.appendLine(`[TEST] Testing connection to ${this.workspaceSlug}...`);
            const response = await this.client.get(`/workspace/${this.workspaceSlug}`);
            this.outputChannel.appendLine(`[TEST] ✅ Connected! Status: ${response.status}`);
            this.outputChannel.appendLine(`[TEST] Response: ${JSON.stringify(response.data).substring(0, 200)}`);
            return true;
        } catch (error: any) {
            this.outputChannel.appendLine(`[TEST] ❌ Failed: ${error.message}`);
            if (error.response) {
                this.outputChannel.appendLine(`[TEST] Status: ${error.response.status}`);
                this.outputChannel.appendLine(`[TEST] Detail: ${JSON.stringify(error.response.data).substring(0, 300)}`);
            }
            return false;
        }
    }

    getSlug(): string { return this.workspaceSlug; }
}