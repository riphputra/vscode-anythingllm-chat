import * as vscode from 'vscode';
import { Logger } from './logger';

/**
 * Permission gate for destructive agent tools.
 *
 * Tools that require permission: file_write, terminal_exec, open_file (mutating),
 * mcp_call (configurable), and any tool flagged with requiresPermission.
 *
 * The user can: Allow once / Always allow in this session / Deny.
 */

export type PermissionDecision = 'allow' | 'always_allow' | 'deny';

export interface PermissionRequest {
  tool: string;
  summary: string;
  detail?: string;
  risk: 'low' | 'medium' | 'high';
  /** Diff preview if the tool makes changes */
  diffPreview?: string;
}

export interface PermissionResult {
  decision: PermissionDecision;
  tool: string;
}

const ALWAYS_ALLOW = new Set<string>();

/**
 * Check whether a tool has already been permanently allowed for this session.
 */
export function isAlwaysAllowed(tool: string): boolean {
  return ALWAYS_ALLOW.has(tool);
}

/**
 * Reset the permission cache (e.g. when the user clicks "Reset permissions" in settings).
 */
export function resetPermissions(): void {
  ALWAYS_ALLOW.clear();
  Logger.info('Agent permissions reset.');
}

/**
 * Ask the user for permission via a VS Code QuickPick.
 * Called from the extension host (not the webview).
 */
export async function requestPermission(
  req: PermissionRequest
): Promise<PermissionResult> {
  // Fast path: already allowed
  if (isAlwaysAllowed(req.tool)) {
    return { decision: 'allow', tool: req.tool };
  }

  const riskIcon = req.risk === 'high' ? '🔴' : req.risk === 'medium' ? '🟡' : '🟢';
  const items: Array<vscode.QuickPickItem & { decision: PermissionDecision }> = [
    {
      label: `${riskIcon} Allow once`,
      description: 'Run only this one time',
      decision: 'allow',
    },
    {
      label: `✓ Always allow ${req.tool} this session`,
      description: 'Do not ask again for this session',
      decision: 'always_allow',
    },
    {
      label: `✗ Deny`,
      description: 'Cancel this tool execution',
      decision: 'deny',
    },
  ];

  // Show diff preview if available
  if (req.diffPreview) {
    // Trim diff to reasonable length for QuickPick description
    const diffTrimmed = req.diffPreview.slice(0, 200);
    items[0].detail = diffTrimmed;
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: `🤖 Agent Permission: ${req.tool}`,
    placeHolder: req.summary,
    ignoreFocusOut: true,
  });

  const decision = picked?.decision ?? 'deny';

  if (decision === 'always_allow') {
    ALWAYS_ALLOW.add(req.tool);
    Logger.info(`Permission: ${req.tool} set to always-allow for session.`);
  }

  return { decision, tool: req.tool };
}
