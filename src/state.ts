import * as vscode from 'vscode';
import { Config } from './config';
import type { AnythingLLMWorkspace } from './types';

/**
 * Global extension state: active workspace + cached workspace list.
 */
export class StateManager {
  private static _instance: StateManager;
  private _activeWorkspace: string = '';
  private _workspacesCache: AnythingLLMWorkspace[] = [];
  private _onDidChangeWorkspace = new vscode.EventEmitter<string>();
  private _onDidChangeWorkspaces = new vscode.EventEmitter<AnythingLLMWorkspace[]>();

  readonly onDidChangeWorkspace = this._onDidChangeWorkspace.event;
  readonly onDidChangeWorkspaces = this._onDidChangeWorkspaces.event;

  private constructor() {
    this._activeWorkspace = Config.defaultWorkspace;
  }

  static get instance(): StateManager {
    if (!this._instance) this._instance = new StateManager();
    return this._instance;
  }

  get activeWorkspaceSlug(): string {
    return this._activeWorkspace;
  }

  setActiveWorkspace(slug: string): void {
    if (this._activeWorkspace === slug) return;
    this._activeWorkspace = slug;
    Config.setDefaultWorkspace(slug);
    this._onDidChangeWorkspace.fire(slug);
  }

  get workspaces(): AnythingLLMWorkspace[] {
    return this._workspacesCache;
  }

  setWorkspaces(workspaces: AnythingLLMWorkspace[]): void {
    this._workspacesCache = workspaces;
    this._onDidChangeWorkspaces.fire(workspaces);
  }

  get activeWorkspace(): AnythingLLMWorkspace | undefined {
    return this._workspacesCache.find((w) => w.slug === this._activeWorkspace);
  }
}
