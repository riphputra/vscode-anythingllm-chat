import axios, { AxiosInstance } from 'axios';
import * as vscode from 'vscode';

export interface ChatResponse {
    success: boolean;
    data?: {
        response: string;
        sources?: Array<any>;
    };
    error?: string;
}

export class AnythingLLMClient {
    private client: AxiosInstance;
    private workspaceSlug: string;
    private sessionId: string;
    private outputChannel: vscode.OutputChannel;

    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
        const config = vscode.workspace.getConfiguration('anythingllm');
        
        // Pastikan URL tidak ada slash di belakang
        let serverUrl = config.get<string>('serverUrl', 'http://localhost:3001');
        if (serverUrl.endsWith('/')) serverUrl = serverUrl.slice(0, -1);
        
        const apiKey = config.get<string>('apiKey', '');
        this.workspaceSlug = config.get<string>('workspaceSlug', 'default');
        
        this.sessionId = `vscode-${Date.now()}`;

        this.outputChannel.appendLine(`[INIT] Server: ${serverUrl}`);
        this.outputChannel.appendLine(`[INIT] Workspace Slug: ${this.workspaceSlug}`);
        this.outputChannel.appendLine(`[INIT] API Key: ${apiKey ? '***' + apiKey.slice(-4) : 'NOT SET (Kosong!)'}`);

        this.client = axios.create({
            baseURL: `${serverUrl}/api/v1`,
            timeout: 3600000, // Dikurangi menjadi 60 detik agar tidak menunggu terlalu lama
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            }
        });
    }

    async chat(message: string, mode: 'chat' | 'query' = 'chat'): Promise<ChatResponse> {
        try {
            this.outputChannel.appendLine(`[CHAT] Mengirim pesan ke /workspace/${this.workspaceSlug}/chat...`);
            
            const response = await this.client.post(
                `/workspace/${this.workspaceSlug}/chat`,
                {
                    message: message,
                    mode: mode,
                    sessionId: this.sessionId
                }
            );

            this.outputChannel.appendLine(`[CHAT] Sukses! Status: ${response.status}`);
            
            // Parse response asli AnythingLLM (bisa berupa textResponse atau response)
            const data = response.data;
            const aiText = data.textResponse || data.response || JSON.stringify(data);
            
            return {
                success: true,
                data: {
                    response: aiText,
                    sources: data.sources || []
                }
            };
        } catch (error: any) {
            this.outputChannel.appendLine(`[ERROR] ${error.message}`);
            
            if (error.response) {
                this.outputChannel.appendLine(`[ERROR] HTTP Status: ${error.response.status}`);
                this.outputChannel.appendLine(`[ERROR] Detail: ${JSON.stringify(error.response.data)}`);
                return {
                    success: false,
                    error: error.response.data?.error || `HTTP ${error.response.status}: ${error.message}`
                };
            } else if (error.code === 'ECONNABORTED') {
                return { success: false, error: 'Timeout: Server terlalu lama merespons (>60 detik).' };
            } else {
                return { success: false, error: error.message || 'Network error / Server tidak bisa dihubungi.' };
            }
        }
    }

    async testConnection(): Promise<boolean> {
        try {
            this.outputChannel.appendLine(`[TEST] Mencoba koneksi ke /workspace/${this.workspaceSlug}...`);
            await this.client.get(`/workspace/${this.workspaceSlug}`);
            this.outputChannel.appendLine(`[TEST] Koneksi berhasil!`);
            return true;
        } catch (error: any) {
            this.outputChannel.appendLine(`[TEST] Koneksi gagal: ${error.message}`);
            if (error.response) {
                this.outputChannel.appendLine(`[TEST] HTTP Status: ${error.response.status}`);
                this.outputChannel.appendLine(`[TEST] Detail: ${JSON.stringify(error.response.data)}`);
            }
            return false;
        }
    }
    /**
   * Upload raw text document ke AnythingLLM
   */
    async uploadRawDocument(filename: string, content: string): Promise<boolean> {
        try {
        this.outputChannel.appendLine(`[UPLOAD] Mengupload: ${filename} (${(content.length / 1024).toFixed(1)} KB)`);
        await this.client.post('/document/raw', {
            name: filename,
            content: content,
            mode: 'embed' // Mode embed agar langsung diproses untuk RAG
        });
        return true;
        } catch (error: any) {
        this.outputChannel.appendLine(`[UPLOAD] Gagal upload ${filename}: ${error.message}`);
        return false;
        }
    }

    /**
     * Trigger update embeddings di workspace
     */
    async triggerWorkspaceSync(fileNames: string[]): Promise<boolean> {
        try {
        this.outputChannel.appendLine(`[SYNC] Meminta AnythingLLM memproses ${fileNames.length} file baru...`);
        await this.client.post(`/workspace/${this.workspaceSlug}/update-embeddings`, {
            adds: fileNames,
            deletes: []
        });
        return true;
        } catch (error: any) {
        this.outputChannel.appendLine(`[SYNC] Gagal trigger sync: ${error.message}`);
        return false;
        }
    }
    getSlug(): string { return this.workspaceSlug; }
}