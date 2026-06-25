import * as vscode from 'vscode';
import { Logger } from './logger';

const API_KEY_SECRET = 'anythingllm.apiKey';

/**
 * Wrapper aman untuk API key menggunakan VS Code SecretStorage.
 * API key TIDAK disimpan di settings.json (plain text).
 */
export class SecretStore {
  constructor(private context: vscode.ExtensionContext) {}

  async getApiKey(): Promise<string | undefined> {
    try {
      return await this.context.secrets.get(API_KEY_SECRET);
    } catch (err) {
      Logger.error('Failed to read API key from SecretStorage', err);
      return undefined;
    }
  }

  async setApiKey(key: string): Promise<void> {
    await this.context.secrets.store(API_KEY_SECRET, key);
    Logger.info('API key stored in SecretStorage');
  }

  async deleteApiKey(): Promise<void> {
    await this.context.secrets.delete(API_KEY_SECRET);
    Logger.info('API key deleted from SecretStorage');
  }

  async hasApiKey(): Promise<boolean> {
    const key = await this.getApiKey();
    return !!key && key.trim().length > 0;
  }

  /**
   * Returns API key or throws a user-friendly error with actionable guidance.
   */
  async requireApiKey(): Promise<string> {
    const key = await this.getApiKey();
    if (!key) {
      const action = await vscode.window.showErrorMessage(
        'AnythingLLM API key is not configured. Set it first to use this extension.',
        'Set API Key',
        'Cancel'
      );
      if (action === 'Set API Key') {
        await vscode.commands.executeCommand('anythingllm.setApiKey');
      }
      throw new Error('API key not configured');
    }
    return key;
  }
}
