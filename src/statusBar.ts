import * as vscode from 'vscode';
import { Config } from './config';
import { StateManager } from './state';

/**
 * Status bar item showing active workspace + agent mode + cost.
 *
 * Position: Right side of status bar (priority 100).
 * Click: Open Chat Panel.
 */
export class StatusBar {
  private item: vscode.StatusBarItem;
  private agentMode: boolean = false;
  private streaming: boolean = false;
  private todayTokens: number = 0;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.item.command = 'anythingllm.openChatPanel';
    this.item.tooltip = 'AnythingLLM — Click to open Chat Panel';
    this.update();
    this.item.show();

    // React to config changes
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('anythingllm')) {
        this.update();
      }
    });

    StateManager.instance.onDidChangeWorkspace(() => this.update());
  }

  setAgentMode(enabled: boolean): void {
    this.agentMode = enabled;
    this.update();
  }

  setStreaming(streaming: boolean): void {
    this.streaming = streaming;
    this.update();
  }

  setTodayTokens(tokens: number): void {
    this.todayTokens = tokens;
    this.update();
  }

  update(): void {
    const ws = StateManager.instance.activeWorkspaceSlug;
    const wsLabel = ws ? `$(database) ${ws}` : '$(warning) no workspace';
    const agent = this.agentMode ? ' $(robot)' : '';
    const stream = this.streaming ? ' $(loading~spin)' : '';
    const tokens = this.todayTokens > 0 ? ` $(pulse) ${this.formatTokens(this.todayTokens)} tok` : '';

    this.item.text = `$(comment-discussion) ${wsLabel}${agent}${stream}${tokens}`;
    this.item.tooltip = this.buildTooltip();
  }

  private buildTooltip(): string {
    const lines = [
      'AnythingLLM for VS Code',
      `Workspace: ${StateManager.instance.activeWorkspaceSlug || '(none)'}`,
      `Base URL: ${Config.baseUrl}`,
      `Agent mode: ${this.agentMode ? 'ON' : 'OFF'}`,
      `Status: ${this.streaming ? 'streaming…' : 'idle'}`,
    ];
    if (this.todayTokens > 0) {
      lines.push(`Tokens today: ${this.todayTokens.toLocaleString()}`);
    }
    lines.push('', 'Click to open Chat Panel');
    return lines.join('\n');
  }

  private formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  }

  dispose(): void {
    this.item.dispose();
  }
}
