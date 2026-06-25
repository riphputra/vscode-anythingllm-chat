import * as vscode from 'vscode';
import { AnythingLLMClient } from './anythingllmClient';
import { Logger } from './logger';
import { StateManager } from './state';
import type { AnythingLLMWorkspace } from './types';

/**
 * Special tree item that triggers a command on click.
 * Used for non-workspace rows like "Support this project".
 */
export class ActionTreeItem extends vscode.TreeItem {
  constructor(
    public readonly actionId: string,
    label: string,
    tooltip: string,
    icon: string,
    commandId?: string
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.id = `action-${actionId}`;
    this.tooltip = tooltip;
    this.contextValue = `action-${actionId}`;
    this.iconPath = new vscode.ThemeIcon(icon);
    if (commandId) {
      this.command = { command: commandId, title: label, tooltip };
    }
  }
}

export class WorkspaceTreeItem extends vscode.TreeItem {
  constructor(public readonly workspace: AnythingLLMWorkspace) {
    super(workspace.name, vscode.TreeItemCollapsibleState.None);
    this.id = `workspace-${workspace.slug}`;
    this.description = `${workspace.documents ?? 0} docs`;
    this.tooltip = `Workspace: ${workspace.name}\nSlug: ${workspace.slug}\nDokumen: ${workspace.documents ?? '?'}`;
    this.contextValue = 'workspace';
    this.iconPath = new vscode.ThemeIcon('folder-library');

    if (workspace.slug === StateManager.instance.activeWorkspaceSlug) {
      this.iconPath = new vscode.ThemeIcon('folder-active');
      this.description = '✓ ' + (this.description ?? '');
    }
  }
}

export class WorkspaceTreeDataProvider
  implements vscode.TreeDataProvider<WorkspaceTreeItem | ActionTreeItem>
{
  private _onDidChange = new vscode.EventEmitter<
    WorkspaceTreeItem | ActionTreeItem | undefined
  >();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private client: AnythingLLMClient) {}

  refresh(): void {
    this._onDidChange.fire(undefined);
  }

  getTreeItem(element: WorkspaceTreeItem | ActionTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: WorkspaceTreeItem | ActionTreeItem): Promise<Array<WorkspaceTreeItem | ActionTreeItem>> {
    if (element) return [];

    const items: Array<WorkspaceTreeItem | ActionTreeItem> = [];

    // 1. Real workspaces
    try {
      const workspaces = await this.client.listWorkspaces();
      StateManager.instance.setWorkspaces(workspaces);
      for (const w of workspaces) {
        items.push(new WorkspaceTreeItem(w));
      }
    } catch (err) {
      Logger.error('Failed to load workspaces', err);
    }

    // 2. Non-intrusive "Support this project" row at the bottom
    items.push(
      new ActionTreeItem(
        'donate',
        '💜 Support this project',
        'Open the donate page (Saweria / PayPal). Donations are voluntary and never required.',
        'heart',
        'anythingllm.openDonate'
      )
    );

    return items;
  }
}

export class ThreadTreeItem extends vscode.TreeItem {
  constructor(
    public readonly slug: string,
    public readonly name: string,
    public readonly workspaceSlug: string
  ) {
    super(name, vscode.TreeItemCollapsibleState.None);
    this.id = `thread-${slug}`;
    this.description = slug.slice(0, 8);
    this.tooltip = `Thread: ${name}\nSlug: ${slug}`;
    this.contextValue = 'thread';
    this.iconPath = new vscode.ThemeIcon('comment-discussion');
  }
}

export class ThreadTreeDataProvider
  implements vscode.TreeDataProvider<ThreadTreeItem>
{
  private _onDidChange = new vscode.EventEmitter<ThreadTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private client: AnythingLLMClient) {}

  refresh(): void {
    this._onDidChange.fire(undefined);
  }

  getTreeItem(element: ThreadTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ThreadTreeItem): Promise<ThreadTreeItem[]> {
    if (element) return [];
    const slug = StateManager.instance.activeWorkspaceSlug;
    if (!slug) return [];

    try {
      const threads = await this.client.listThreads(slug);
      return threads.map((t) => new ThreadTreeItem(t.slug, t.name, slug));
    } catch (err) {
      Logger.error('Failed to load threads', err);
      return [];
    }
  }
}
