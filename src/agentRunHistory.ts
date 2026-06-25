import * as vscode from 'vscode';
import { Logger } from './logger';
import type { AgentRunRecord } from './types';

/**
 * Audit log for agent runs.
 *
 * Every agent execution is saved to a JSON file under:
 *   globalStorageUri/agent-runs/<timestamp>-<goal-slug>.json
 *
 * Supports:
 *   - listRuns() — view all runs
 *   - getRun(id) — view run details
 *   - resumeRun(id) — replan with the same goal
 *   - clearRuns() — wipe the log
 */

export class AgentRunHistory {
  private runsDir: vscode.Uri;

  constructor(_context: vscode.ExtensionContext) {
    this.runsDir = vscode.Uri.joinPath(_context.globalStorageUri, 'agent-runs');
    this.ensureDir();
  }

  private async ensureDir(): Promise<void> {
    try {
      await vscode.workspace.fs.createDirectory(this.runsDir);
    } catch {
      // best-effort
    }
  }

  async saveRun(record: AgentRunRecord): Promise<vscode.Uri> {
    await this.ensureDir();
    const safeGoal = record.goal
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'untitled';
    const ts = new Date(record.startedAt).toISOString().replace(/[:.]/g, '-');
    const filename = `${ts}-${safeGoal}.json`;
    const uri = vscode.Uri.joinPath(this.runsDir, filename);

    const data = JSON.stringify(record, null, 2);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(data, 'utf-8'));
    Logger.info(`Agent run saved to ${uri.fsPath}`);
    return uri;
  }

  async listRuns(): Promise<AgentRunRecord[]> {
    await this.ensureDir();
    try {
      const entries = await vscode.workspace.fs.readDirectory(this.runsDir);
      const records: AgentRunRecord[] = [];
      for (const [name] of entries) {
        if (!name.endsWith('.json')) continue;
        try {
          const uri = vscode.Uri.joinPath(this.runsDir, name);
          const buf = await vscode.workspace.fs.readFile(uri);
          records.push(JSON.parse(Buffer.from(buf).toString('utf-8')));
        } catch (err) {
          Logger.warn(`Failed to parse agent run ${name}`, err);
        }
      }
      return records.sort((a, b) => b.startedAt - a.startedAt);
    } catch {
      return [];
    }
  }

  async getRun(id: string): Promise<AgentRunRecord | undefined> {
    const runs = await this.listRuns();
    return runs.find((r) => r.id === id);
  }

  async clearRuns(): Promise<void> {
    await this.ensureDir();
    try {
      const entries = await vscode.workspace.fs.readDirectory(this.runsDir);
      for (const [name] of entries) {
        const uri = vscode.Uri.joinPath(this.runsDir, name);
        await vscode.workspace.fs.delete(uri);
      }
      Logger.info('All agent run history cleared.');
    } catch (err) {
      Logger.error('Failed to clear agent runs', err);
    }
  }

  /**
   * Open the agent runs directory in the file explorer.
   */
  async revealInExplorer(): Promise<void> {
    await this.ensureDir();
    await vscode.commands.executeCommand('revealFileInOS', this.runsDir);
  }

  /**
   * Show a QuickPick of past runs and let user pick one to view/resume.
   */
  async pickRun(): Promise<AgentRunRecord | undefined> {
    const runs = await this.listRuns();
    if (runs.length === 0) {
      vscode.window.showInformationMessage('No agent runs saved yet.');
      return undefined;
    }

    const items = runs.slice(0, 50).map((r) => ({
      label: r.goal.slice(0, 80),
      description: new Date(r.startedAt).toLocaleString('en-US'),
      detail: `${r.status} • ${r.iterations} iters • ${r.steps.length} steps${r.errorMessage ? ' • ' + r.errorMessage : ''}`,
      run: r,
    }));

    const picked = await vscode.window.showQuickPick(items, {
      title: '🤖 Agent Run History',
      placeHolder: 'Pick a run to view its details',
      matchOnDescription: true,
      matchOnDetail: true,
    });

    return picked?.run;
  }
}
