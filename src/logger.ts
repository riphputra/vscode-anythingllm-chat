import * as vscode from 'vscode';

/**
 * Centralized logger using a VS Code OutputChannel.
 * Makes debugging and observability easier.
 */
export class Logger {
  private static channel: vscode.OutputChannel;

  static init(context: vscode.ExtensionContext): void {
    this.channel = vscode.window.createOutputChannel('AnythingLLM');
    context.subscriptions.push(this.channel);
  }

  static info(message: string): void {
    const line = `[INFO  ${new Date().toISOString()}] ${message}`;
    this.channel.appendLine(line);
  }

  static warn(message: string, error?: unknown): void {
    const errStr = error instanceof Error
      ? `: ${error.message}`
      : error !== undefined
        ? `: ${String(error)}`
        : '';
    const line = `[WARN  ${new Date().toISOString()}] ${message}${errStr}`;
    this.channel.appendLine(line);
  }

  static error(message: string, error?: unknown): void {
    const errStr = error instanceof Error
      ? `${error.message}\n${error.stack ?? ''}`
      : String(error);
    const line = `[ERROR ${new Date().toISOString()}] ${message}\n${errStr}`;
    this.channel.appendLine(line);
  }

  static show(): void {
    this.channel?.show();
  }
}
