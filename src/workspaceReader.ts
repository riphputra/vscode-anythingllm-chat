import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export interface ProjectFile {
    path: string;
    relativePath: string;
    content: string;
    language: string;
    size: number;
}

export class WorkspaceReader {
    private excludePatterns: string[];
    private maxFileSize: number;

    constructor() {
        const config = vscode.workspace.getConfiguration('anythingllm');
        this.excludePatterns = config.get<string[]>('excludePatterns', [
            '**/node_modules/**',
            '**/.git/**',
            '**/dist/**',
            '**/build/**',
            '**/.vscode/**',
            '**/out/**',
            '**/.next/**',
            '**/__pycache__/**',
            '**/*.pyc',
            '**/venv/**',
            '**/.env'
        ]);
        this.maxFileSize = config.get<number>('maxFileSize', 100000);
    }

    /**
     * Scan seluruh workspace dan kembalikan struktur folder
     */
    async scanWorkspace(): Promise<{
        structure: string;
        files: ProjectFile[];
        stats: { totalFiles: number; totalSize: number; languages: Record<string, number> };
    }> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            throw new Error('Tidak ada workspace yang terbuka');
        }

        const rootPath = workspaceFolders[0].uri.fsPath;
        const files: ProjectFile[] = [];
        const structure: string[] = [];
        const languages: Record<string, number> = {};

        await this.scanDirectory(rootPath, rootPath, files, structure, languages, 0);

        const totalSize = files.reduce((sum, f) => sum + f.size, 0);

        return {
            structure: structure.join('\n'),
            files,
            stats: {
                totalFiles: files.length,
                totalSize,
                languages
            }
        };
    }

    private async scanDirectory(
        dirPath: string,
        rootPath: string,
        files: ProjectFile[],
        structure: string[],
        languages: Record<string, number>,
        depth: number
    ): Promise<void> {
        if (depth > 10) return; // Batasi kedalaman folder

        const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
        const indent = '  '.repeat(depth);

        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            const relativePath = path.relative(rootPath, fullPath);

            // Cek apakah harus di-exclude
            if (this.shouldExclude(relativePath)) {
                continue;
            }

            if (entry.isDirectory()) {
                structure.push(`${indent}📁 ${entry.name}/`);
                await this.scanDirectory(fullPath, rootPath, files, structure, languages, depth + 1);
            } else if (entry.isFile()) {
                const stats = await fs.promises.stat(fullPath);
                
                // Skip file yang terlalu besar
                if (stats.size > this.maxFileSize) {
                    structure.push(`${indent}📄 ${entry.name} (${this.formatSize(stats.size)}) [SKIPPED - too large]`);
                    continue;
                }

                // Skip binary files
                if (this.isBinaryFile(entry.name)) {
                    structure.push(`${indent}📄 ${entry.name} (${this.formatSize(stats.size)}) [BINARY]`);
                    continue;
                }

                try {
                    const content = await fs.promises.readFile(fullPath, 'utf-8');
                    const language = this.getLanguageFromExtension(entry.name);
                    
                    files.push({
                        path: fullPath,
                        relativePath,
                        content,
                        language,
                        size: stats.size
                    });

                    structure.push(`${indent}📄 ${entry.name} (${this.formatSize(stats.size)})`);
                    
                    languages[language] = (languages[language] || 0) + 1;
                } catch (err) {
                    structure.push(`${indent}📄 ${entry.name} [ERROR READING]`);
                }
            }
        }
    }

    private shouldExclude(relativePath: string): boolean {
        const normalizedPath = relativePath.replace(/\\/g, '/');
        return this.excludePatterns.some(pattern => {
            const regex = this.globToRegex(pattern);
            return regex.test(normalizedPath);
        });
    }

    private globToRegex(glob: string): RegExp {
        const regexStr = glob
            .replace(/\*\*/g, '.*')
            .replace(/\*/g, '[^/]*')
            .replace(/\?/g, '.')
            .replace(/\//g, '\\/');
        return new RegExp(`^${regexStr}$|${regexStr}`);
    }

    private isBinaryFile(filename: string): boolean {
        const binaryExtensions = [
            '.png', '.jpg', '.jpeg', '.gif', '.ico', '.bmp', '.webp',
            '.pdf', '.doc', '.docx', '.xls', '.xlsx',
            '.zip', '.rar', '.tar', '.gz', '.7z',
            '.exe', '.dll', '.so', '.dylib',
            '.mp3', '.mp4', '.avi', '.mov', '.wav',
            '.woff', '.woff2', '.ttf', '.eot',
            '.pyc', '.class', '.o', '.obj'
        ];
        const ext = path.extname(filename).toLowerCase();
        return binaryExtensions.includes(ext);
    }

    private getLanguageFromExtension(filename: string): string {
        const ext = path.extname(filename).toLowerCase();
        const languageMap: Record<string, string> = {
            '.js': 'javascript',
            '.ts': 'typescript',
            '.jsx': 'javascript-react',
            '.tsx': 'typescript-react',
            '.py': 'python',
            '.java': 'java',
            '.cpp': 'cpp',
            '.c': 'c',
            '.cs': 'csharp',
            '.go': 'go',
            '.rs': 'rust',
            '.php': 'php',
            '.rb': 'ruby',
            '.swift': 'swift',
            '.kt': 'kotlin',
            '.html': 'html',
            '.css': 'css',
            '.scss': 'scss',
            '.json': 'json',
            '.xml': 'xml',
            '.yaml': 'yaml',
            '.yml': 'yaml',
            '.md': 'markdown',
            '.sql': 'sql',
            '.sh': 'shell',
            '.bash': 'shell',
            '.vue': 'vue',
            '.svelte': 'svelte'
        };
        return languageMap[ext] || 'text';
    }

    private formatSize(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    /**
     * Buat context string dari seluruh project untuk dikirim ke AI
     */
    async buildProjectContext(): Promise<string> {
        const { structure, files, stats } = await this.scanWorkspace();
        
        let context = `## 📊 Project Statistics\n`;
        context += `- Total Files: ${stats.totalFiles}\n`;
        context += `- Total Size: ${this.formatSize(stats.totalSize)}\n`;
        context += `- Languages: ${Object.entries(stats.languages).map(([lang, count]) => `${lang} (${count})`).join(', ')}\n\n`;
        
        context += `## 📁 Project Structure\n\`\`\`\n${structure}\n\`\`\`\n\n`;
        
        // Tambahkan isi file-file penting (package.json, README, dll)
        const importantFiles = files.filter(f => 
            f.relativePath === 'package.json' ||
            f.relativePath === 'README.md' ||
            f.relativePath === 'tsconfig.json' ||
            f.relativePath === 'requirements.txt' ||
            f.relativePath.endsWith('.env.example')
        );

        if (importantFiles.length > 0) {
            context += `## 📄 Important Files Content\n`;
            for (const file of importantFiles.slice(0, 5)) {
                context += `\n### ${file.relativePath}\n\`\`\`${file.language}\n${file.content.substring(0, 5000)}\n\`\`\`\n`;
            }
        }

        return context;
    }
}