import * as vscode from 'vscode';
import { AnythingLLMClient } from '../anythingllm';
import { FileEditor } from './FileEditor';

export interface Task {
    id: string;
    description: string;
    steps: TaskStep[];
    status: 'pending' | 'running' | 'completed' | 'failed';
    createdAt: Date;
    completedAt?: Date;
}

export interface TaskStep {
    id: string;
    action: 'read_file' | 'edit_file' | 'create_file' | 'delete_file' | 'run_command' | 'search_code';
    description: string;
    parameters: any;
    status: 'pending' | 'running' | 'completed' | 'failed'; // ✅ Sudah ditambahkan 'running'
    result?: any;
}

export class TaskPlanner {
    private client: AnythingLLMClient;
    private editor: FileEditor;
    private outputChannel: vscode.OutputChannel;
    private tasks: Map<string, Task>;

    constructor(
        client: AnythingLLMClient,
        editor: FileEditor,
        outputChannel: vscode.OutputChannel
    ) {
        this.client = client;
        this.editor = editor;
        this.outputChannel = outputChannel;
        this.tasks = new Map();
    }

    /**
     * Parse user request menjadi task plan menggunakan AI
     */
    async createTaskFromRequest(userRequest: string): Promise<Task | null> {
        try {
            this.outputChannel.appendLine(`[AGENT] Creating task from: ${userRequest}`);

            // Minta AI untuk membuat plan
            const planPrompt = `
Anda adalah AI Agent yang bertugas membuat rencana eksekusi untuk development tasks.

User request: "${userRequest}"

Buat rencana step-by-step yang detail dalam format JSON seperti ini:
{
    "description": "Ringkasan task",
    "steps": [
        {
            "action": "read_file|edit_file|create_file|delete_file|run_command|search_code",
            "description": "Penjelasan step",
            "parameters": {
                "filePath": "path/file.js",
                "searchText": "text to find",
                "replaceText": "text to replace",
                "command": "npm install"
            }
        }
    ]
}

Hanya return JSON, tanpa penjelasan lain.
            `;

            const response = await this.client.chat(planPrompt, 'query');
            
            if (!response.success || !response.data) {
                throw new Error('Gagal membuat task plan dari AI');
            }

            // Parse JSON response
            let planData;
            try {
                // Extract JSON dari response (kadang AI menambahkan text lain)
                const jsonMatch = response.data.response.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    planData = JSON.parse(jsonMatch[0]);
                } else {
                    planData = JSON.parse(response.data.response);
                }
            } catch (e) {
                throw new Error('Response AI bukan JSON yang valid');
            }

            // Convert ke Task object
            const task: Task = {
                id: `task-${Date.now()}`,
                description: planData.description || userRequest,
                steps: planData.steps.map((step: any, index: number) => ({
                    id: `step-${index}`,
                    action: step.action,
                    description: step.description,
                    parameters: step.parameters,
                    status: 'pending' as const
                })),
                status: 'pending',
                createdAt: new Date()
            };

            this.tasks.set(task.id, task);
            this.outputChannel.appendLine(`[AGENT] Task created: ${task.id} with ${task.steps.length} steps`);

            return task;
        } catch (error: any) {
            this.outputChannel.appendLine(`[AGENT] Error creating task: ${error.message}`);
            vscode.window.showErrorMessage(`Gagal membuat task plan: ${error.message}`);
            return null;
        }
    }

    /**
     * Execute task step by step
     */
    async executeTask(taskId: string): Promise<boolean> {
        const task = this.tasks.get(taskId);
        if (!task) {
            throw new Error('Task tidak ditemukan');
        }

        task.status = 'running';
        this.outputChannel.appendLine(`[AGENT] Starting task execution: ${task.description}`);

        for (let i = 0; i < task.steps.length; i++) {
            const step = task.steps[i];
            
            this.outputChannel.appendLine(`[AGENT] Executing step ${i + 1}/${task.steps.length}: ${step.description}`);
            
            try {
                step.status = 'running';
                
                switch (step.action) {
                    case 'read_file':
                        step.result = await this.executeReadFile(step.parameters);
                        break;
                    case 'edit_file':
                        step.result = await this.executeEditFile(step.parameters);
                        break;
                    case 'create_file':
                        step.result = await this.executeCreateFile(step.parameters);
                        break;
                    case 'delete_file':
                        step.result = await this.executeDeleteFile(step.parameters);
                        break;
                    case 'run_command':
                        step.result = await this.executeRunCommand(step.parameters);
                        break;
                    case 'search_code':
                        step.result = await this.executeSearchCode(step.parameters);
                        break;
                    default:
                        throw new Error(`Unknown action: ${step.action}`);
                }
                
                step.status = 'completed';
                this.outputChannel.appendLine(`[AGENT] ✅ Step completed`);
                
            } catch (error: any) {
                step.status = 'failed';
                step.result = { error: error.message };
                this.outputChannel.appendLine(`[AGENT] ❌ Step failed: ${error.message}`);
                
                // Tanya user apakah mau lanjut atau stop
                const continueTask = await vscode.window.showErrorMessage(
                    `Step "${step.description}" gagal: ${error.message}`,
                    'Lanjutkan', 'Stop Task'
                );
                
                if (continueTask !== 'Lanjutkan') {
                    task.status = 'failed';
                    return false;
                }
            }
        }

        task.status = 'completed';
        task.completedAt = new Date();
        this.outputChannel.appendLine(`[AGENT] ✅ Task completed successfully!`);
        
        vscode.window.showInformationMessage(`Task "${task.description}" selesai!`);
        return true;
    }

    private async executeReadFile(params: any): Promise<any> {
        const uri = vscode.Uri.file(params.filePath);
        const doc = await vscode.workspace.openTextDocument(uri);
        return { content: doc.getText() };
    }

    private async executeEditFile(params: any): Promise<any> {
        return await this.editor.editFile(
            params.filePath,
            params.searchText,
            params.replaceText,
            params.description || 'AI Edit'
        );
    }

    private async executeCreateFile(params: any): Promise<any> {
        return await this.editor.createFile(params.filePath, params.content);
    }

    private async executeDeleteFile(params: any): Promise<any> {
        return await this.editor.deleteFile(params.filePath);
    }

    private async executeRunCommand(params: any): Promise<any> {
        return await this.editor.executeCommand(params.command);
    }

    private async executeSearchCode(params: any): Promise<any> {
        // Implementasi search code di workspace
        return { message: 'Search not implemented yet' };
    }

    getTask(taskId: string): Task | undefined {
        return this.tasks.get(taskId);
    }

    getAllTasks(): Task[] {
        return Array.from(this.tasks.values());
    }
}