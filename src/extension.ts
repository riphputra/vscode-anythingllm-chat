import * as vscode from 'vscode';
import { AnythingLLMClient } from './anythingllmClient';
import { ChatParticipantHandler } from './chatParticipant';
import { ChatPanelProvider } from './chatPanel';
import { Logger } from './logger';
import { registerCommands } from './commands';
import { SecretStore } from './secretStore';
import { StateManager } from './state';
import { StatusBar } from './statusBar';
import { resetPermissions } from './agentPermissions';
import {
  WorkspaceTreeDataProvider,
  ThreadTreeDataProvider,
} from './treeViews';
import { Config } from './config';

export function activate(context: vscode.ExtensionContext): void {
  Logger.init(context);
  Logger.info(`Activating AnythingLLM extension v${context.extension.packageJSON?.version}`);

  // ─── Init core services ────────────────────────────────────────────────
  const secrets = new SecretStore(context);
  const client = new AnythingLLMClient(async () => secrets.requireApiKey());

  // ─── Tree views ────────────────────────────────────────────────────────
  const workspaceTreeProvider = new WorkspaceTreeDataProvider(client);
  const threadTreeProvider = new ThreadTreeDataProvider(client);

  const workspaceView = vscode.window.createTreeView('anythingllm.workspaces', {
    treeDataProvider: workspaceTreeProvider,
    showCollapseAll: false,
  });
  context.subscriptions.push(workspaceView);

  const threadView = vscode.window.createTreeView('anythingllm.threads', {
    treeDataProvider: threadTreeProvider,
    showCollapseAll: false,
  });
  context.subscriptions.push(threadView);

  // ─── Chat participant ──────────────────────────────────────────────────
  const handler = new ChatParticipantHandler(client);
  const participant = vscode.chat.createChatParticipant(
    'anythingllm.chat',
    handler.getHandler()
  );
  participant.iconPath = new vscode.ThemeIcon('hubot');
  context.subscriptions.push(participant);

  // ─── Follow-up provider ────────────────────────────────────────────────
  participant.followupProvider = {
    provideFollowups(result, _context, _token) {
      const meta = (result as { metadata?: { command?: string; workspaceSlug?: string } })
        ?.metadata;
      if (!meta) return [];

      const followups: vscode.ChatFollowup[] = [];
      const ws = meta.workspaceSlug ? ` in workspace ${meta.workspaceSlug}` : '';

      switch (meta.command) {
        case 'ask':
          followups.push(
            { prompt: 'Explain the answer above in more detail', label: vscode.l10n.t('More detail') },
            { prompt: 'Give me a code example', label: vscode.l10n.t('Code example') },
            { prompt: `Search related documents${ws}`, label: vscode.l10n.t('Search documents') }
          );
          break;
        case 'summarize':
          followups.push(
            { prompt: 'Summarize as bullet points', label: vscode.l10n.t('Bullet points') },
            { prompt: 'Apply to another file', label: vscode.l10n.t('Summarize another file') }
          );
          break;
        case 'explain':
          followups.push(
            { prompt: 'How do I use this code?', label: vscode.l10n.t('How to use') },
            { prompt: 'What are the potential bugs?', label: vscode.l10n.t('Potential bugs') }
          );
          break;
        case 'search':
          followups.push(
            { prompt: 'Ask about the first document', label: vscode.l10n.t('Ask about doc #1') }
          );
          break;
        case 'agent':
          followups.push(
            { prompt: 'Continue the investigation', label: vscode.l10n.t('Continue') },
            { prompt: 'Summarize the agent findings above', label: vscode.l10n.t('Summarize findings') }
          );
          break;
      }
      return followups;
    },
  };

  // ─── Commands ──────────────────────────────────────────────────────────
  registerCommands(
    context,
    client,
    secrets,
    workspaceTreeProvider,
    threadTreeProvider
  );

  // ─── Chat Panel (Webview) ──────────────────────────────────────────────
  const chatPanel = ChatPanelProvider.getInstance(context, client, secrets);
  context.subscriptions.push(
    vscode.commands.registerCommand('anythingllm.openChatPanel', () => {
      chatPanel.show();
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('anythingllm.clearChat', () => {
      chatPanel.show();
    })
  );

  // ─── Tier 3 Agent commands ────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('anythingllm.runAgent', async () => {
      chatPanel.show();
      const goal = await vscode.window.showInputBox({
        prompt: 'Goal for the Agent',
        placeHolder: 'e.g. Find documents about the leave policy and summarize the key points',
        ignoreFocusOut: true,
      });
      if (!goal) return;
      vscode.window.showInformationMessage(
        `🤖 Agent: type the following goal in the Chat Panel and press Enter:\n"${goal}"`
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('anythingllm.toggleAgentMode', () => {
      const current = vscode.workspace
        .getConfiguration('anythingllm')
        .get<boolean>('agentMode', false);
      vscode.workspace
        .getConfiguration('anythingllm')
        .update('agentMode', !current, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(
        `🤖 Agent mode: ${!current ? 'ON' : 'OFF'}`
      );
      chatPanel.show();
    })
  );

  // ─── v0.3.0 new commands ───────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('anythingllm.exportChat', () => {
      chatPanel.show();
      // User uses the export button in chat panel
      vscode.window.showInformationMessage('Click the 💾 button in the Chat Panel header to export.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('anythingllm.showHistory', () => {
      chatPanel.show();
      vscode.window.showInformationMessage('Click the 📜 button in the Chat Panel header to view history.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('anythingllm.workspaceDocuments', () => {
      chatPanel.show();
      vscode.window.showInformationMessage('Click the 🗂️ button in the Chat Panel header to manage documents.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('anythingllm.showAgentRuns', async () => {
      // Use AgentRunHistory's picker directly via chatPanel (we don't have direct ref, so use command)
      // Actually we need to expose this — for now, just open chat panel and hint
      chatPanel.show();
      vscode.window.showInformationMessage('Open Settings → "Agent & MCP" tab to view agent run history.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('anythingllm.resetPermissions', () => {
      resetPermissions();
      vscode.window.showInformationMessage('🤖 Agent tool permissions have been reset.');
    })
  );

  // ─── Status bar ────────────────────────────────────────────────────────
  const showStatusBar = Config.section.get<boolean>('showStatusBar', true);
  if (showStatusBar) {
    const statusBar = new StatusBar();
    context.subscriptions.push(statusBar);

    // Wire up token tracker updates
    const tokenTracker = chatPanel.getTokenTracker();
    const updateStatusBar = () => {
      const stats = tokenTracker.getStats();
      statusBar.setTodayTokens(stats.todayTokens);
    };
    setInterval(updateStatusBar, 30_000); // refresh every 30s

    // Wire up agent mode + streaming state to status bar
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('anythingllm.agentMode')) {
          statusBar.setAgentMode(Config.section.get<boolean>('agentMode', false));
        }
      })
    );
    statusBar.setAgentMode(Config.section.get<boolean>('agentMode', false));
  }

  // ─── Auto-start MCP servers ───────────────────────────────────────────
  const autoStartMcp = Config.section.get<boolean>('autoStartMcp', true);
  if (autoStartMcp) {
    const mcpClient = chatPanel.getMcpClient();
    mcpClient.startAll().catch((err) => {
      Logger.warn('Failed to auto-start MCP servers', err);
    });
    context.subscriptions.push({ dispose: () => mcpClient.stopAll() });
  }

  // ─── Welcome message on first activation ───────────────────────────────
  context.subscriptions.push(
    StateManager.instance.onDidChangeWorkspace((slug) => {
      Logger.info(`Active workspace changed: ${slug}`);
      threadTreeProvider.refresh();
    })
  );

  // ─── Auto-load workspace list if API key already present ───────────────
  secrets.hasApiKey().then((has) => {
    if (has) {
      workspaceTreeProvider.refresh();
      Logger.info('API key detected, auto-loading workspaces');
    } else {
      Logger.info('No API key configured yet. User must set via command.');
      // Show walkthrough on first launch
      vscode.window
        .showInformationMessage(
          'AnythingLLM: Welcome! Set your API key to start using the extension.',
          'Set API Key',
          'Take Tour'
        )
        .then((a) => {
          if (a === 'Set API Key') {
            vscode.commands.executeCommand('anythingllm.setApiKey');
          } else if (a === 'Take Tour') {
            vscode.commands.executeCommand(
              'workbench.action.openWalkthrough',
              'riphputra.anythingllm-vscode#anythingllm.welcome'
            );
          }
        });
    }
  });

  Logger.info('AnythingLLM extension activated (v0.3.0)');
}

export function deactivate(): void {
  Logger.info('AnythingLLM extension deactivated');
}
