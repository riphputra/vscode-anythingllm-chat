import * as vscode from 'vscode';

/**
 * Wrapper for extension configuration (settings.json).
 */
export class Config {
  static get section(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('anythingllm');
  }

  static get baseUrl(): string {
    const url = this.section.get<string>('baseUrl', 'http://localhost:3001/api');
    // Strip trailing slash for consistent URL building
    return url.replace(/\/+$/, '');
  }

  static get defaultWorkspace(): string {
    return this.section.get<string>('defaultWorkspace', '');
  }

  static get chatMode(): 'chat' | 'query' {
    return this.section.get<'chat' | 'query'>('chatMode', 'chat');
  }

  static get requestTimeoutMs(): number {
    return this.section.get<number>('requestTimeoutMs', 120000);
  }

  static get maxRetries(): number {
    return this.section.get<number>('maxRetries', 3);
  }

  static get showCitations(): boolean {
    return this.section.get<boolean>('showCitations', true);
  }

  static async setBaseUrl(url: string): Promise<void> {
    await this.section.update('baseUrl', url, vscode.ConfigurationTarget.Global);
  }

  static async setDefaultWorkspace(slug: string): Promise<void> {
    await this.section.update('defaultWorkspace', slug, vscode.ConfigurationTarget.Global);
  }
}
