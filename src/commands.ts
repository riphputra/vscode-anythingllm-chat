import * as vscode from 'vscode';
import { AnythingLLMClient, AnythingLLMError } from './anythingllmClient';
import { Config } from './config';
import { Logger } from './logger';
import { SecretStore } from './secretStore';
import { StateManager } from './state';
import type { WorkspaceTreeDataProvider, ThreadTreeDataProvider } from './treeViews';
import { Telemetry } from './telemetry';
import { DONATE_LINKS } from './donateConfig';

/**
 * Registration of all extension commands.
 */
export function registerCommands(
  context: vscode.ExtensionContext,
  client: AnythingLLMClient,
  secrets: SecretStore,
  workspaceTree: WorkspaceTreeDataProvider,
  threadTree: ThreadTreeDataProvider
): void {
  // ─── anythingllm.setApiKey ───────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('anythingllm.setApiKey', async () => {
      const input = await vscode.window.showInputBox({
        prompt: 'AnythingLLM API Key',
        placeHolder: 'Enter the API key from your AnythingLLM instance',
        password: true,
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim().length < 8 ? 'API key is too short' : null),
      });
      if (!input) return;

      await secrets.setApiKey(input.trim());

      // Verify
      try {
        const ok = await client.verifyAuth();
        if (ok) {
          vscode.window.showInformationMessage(
            '✅ AnythingLLM API key saved and verified.'
          );
          workspaceTree.refresh();
        } else {
          vscode.window.showWarningMessage(
            '⚠️ API key saved, but verification failed. Please double-check the key and Base URL.'
          );
        }
      } catch (err) {
        Logger.error('verifyAuth failed', err);
        vscode.window.showWarningMessage(
          'API key saved, but could not verify. Check the Base URL and your network connection.'
        );
      }
    })
  );

  // ─── anythingllm.setBaseUrl ──────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('anythingllm.setBaseUrl', async () => {
      const current = Config.baseUrl;
      const input = await vscode.window.showInputBox({
        prompt: 'AnythingLLM API Base URL',
        placeHolder: 'https://your-instance.com/api',
        value: current,
        ignoreFocusOut: true,
        validateInput: (v) => {
          try {
            const u = new URL(v);
            if (!u.protocol.startsWith('http')) return 'URL must be http/https';
            return null;
          } catch {
            return 'Invalid URL';
          }
        },
      });
      if (!input) return;
      await Config.setBaseUrl(input.replace(/\/+$/, ''));
      vscode.window.showInformationMessage(`Base URL set to: ${Config.baseUrl}`);
      workspaceTree.refresh();
    })
  );

  // ─── anythingllm.selectWorkspace ─────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'anythingllm.selectWorkspace',
      async (item?: { workspace?: { slug: string; name: string } }) => {
        let slug: string | undefined;
        let name: string | undefined;

        if (item?.workspace?.slug) {
          slug = item.workspace.slug;
          name = item.workspace.name;
        } else {
          // Show QuickPick
          try {
            const workspaces = await client.listWorkspaces();
            if (workspaces.length === 0) {
              vscode.window.showWarningMessage('No workspaces found on this instance.');
              return;
            }
            const picked = await vscode.window.showQuickPick(
              workspaces.map((w) => ({
                label: w.name,
                description: w.slug,
                detail: `${w.documents ?? 0} documents`,
                slug: w.slug,
              })),
              { placeHolder: 'Select the active workspace' }
            );
            if (!picked) return;
            slug = picked.slug;
            name = picked.label;
          } catch (err) {
            handleApiError(err);
            return;
          }
        }

        StateManager.instance.setActiveWorkspace(slug);
        vscode.window.showInformationMessage(
          `✅ Active workspace: ${name ?? slug}`
        );
        workspaceTree.refresh();
        threadTree.refresh();
      }
    )
  );

  // ─── anythingllm.refreshWorkspaces ───────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('anythingllm.refreshWorkspaces', () => {
      workspaceTree.refresh();
      threadTree.refresh();
    })
  );

  // ─── anythingllm.uploadActiveFile ────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'anythingllm.uploadActiveFile',
      async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          vscode.window.showWarningMessage('Open a file in the editor first.');
          return;
        }

        let slug = StateManager.instance.activeWorkspaceSlug;
        if (!slug) {
          const picked = await pickWorkspace(client);
          if (!picked) return;
          slug = picked;
        }

        const filePath = editor.document.uri.fsPath;
        const fileName = filePath.split('/').pop() ?? 'document.txt';
        const content = new Uint8Array(
          Buffer.from(editor.document.getText(), 'utf-8')
        );

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Uploading ${fileName} to AnythingLLM...`,
            cancellable: false,
          },
          async () => {
            try {
              // Single-call upload + auto-embed (AnythingLLM >= 1.6.0).
              // The `addToWorkspaces` form field tells the server to embed
              // the document into the listed workspaces immediately — no
              // separate /update-embeddings call needed.
              const result = await client.uploadFile(
                content,
                fileName,
                'text/plain',
                { addToWorkspaces: [slug!] }
              );
              if (!result.success || result.documents.length === 0) {
                vscode.window.showErrorMessage(
                  `Upload failed: ${result.error ?? 'Unknown error'}`
                );
                return;
              }

              if (result.embedded) {
                // Server confirmed auto-embed — done.
                vscode.window.showInformationMessage(
                  `✅ ${fileName} uploaded & embedded into workspace "${slug}".`
                );
                workspaceTree.refresh();
                return;
              }

              // Fallback: server didn't auto-embed (old AnythingLLM version).
              // Try the explicit /update-embeddings call.
              const docNames = result.documents.map((d) => d.name);
              try {
                await client.updateEmbeddings(slug!, docNames);
                vscode.window.showInformationMessage(
                  `✅ ${fileName} uploaded & embedded into workspace "${slug}".`
                );
                workspaceTree.refresh();
              } catch (embedErr) {
                Logger.error('updateEmbeddings failed (upload step OK)', embedErr);
                const msg = embedErr instanceof Error ? embedErr.message : String(embedErr);
                const action = await vscode.window.showWarningMessage(
                  `⚠️ File "${fileName}" was uploaded to AnythingLLM documents, but embedding into workspace failed.`,
                  'Retry Embed',
                  'Show Diagnostics',
                  'Dismiss'
                );
                if (action === 'Retry Embed') {
                  try {
                    await client.updateEmbeddings(slug!, docNames);
                    vscode.window.showInformationMessage(
                      `✅ ${fileName} embedded into workspace on retry.`
                    );
                    workspaceTree.refresh();
                  } catch (retryErr) {
                    Logger.error('retry embed failed', retryErr);
                    vscode.window.showErrorMessage(
                      `Embedding still failing: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`
                    );
                  }
                } else if (action === 'Show Diagnostics') {
                  vscode.window.showInformationMessage(
                    `Embedding failed with: ${msg}\n\n` +
                    `Likely causes on the AnythingLLM server:\n` +
                    `• Embedding engine not configured (Admin → Embedder Preference)\n` +
                    `• Vector DB connection error (LanceDB / Chroma / Pinecone / Qdrant)\n` +
                    `• Workspace slug "${slug}" does not match an existing workspace\n` +
                    `• File too large or unsupported for embedding\n\n` +
                    `Your file is safely in /documents — fix the server, then run "Retry Embed".`
                  );
                }
              }
            } catch (err) {
              handleApiError(err);
            }
          }
        );
      }
    )
  );

  // ─── anythingllm.newThread ───────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('anythingllm.newThread', async () => {
      let slug = StateManager.instance.activeWorkspaceSlug;
      if (!slug) {
        const picked = await pickWorkspace(client);
        if (!picked) return;
        slug = picked;
      }
      const name = await vscode.window.showInputBox({
        prompt: 'Thread name',
        placeHolder: 'e.g. Login feature discussion',
      });
      try {
        const thread = await client.createThread(slug, name ?? 'New Thread');
        vscode.window.showInformationMessage(
          `✅ Thread created: ${thread.name} (slug: ${thread.slug.slice(0, 8)}...)`
        );
        threadTree.refresh();
      } catch (err) {
        handleApiError(err);
      }
    })
  );

  // ─── anythingllm.embedDocument ───────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'anythingllm.embedDocument',
      async (workspaceSlug?: string, documentNames?: string[]) => {
        // Interactive mode: pick workspace + document
        if (!workspaceSlug || !documentNames) {
          let slug = StateManager.instance.activeWorkspaceSlug;
          if (!slug) {
            const picked = await pickWorkspace(client);
            if (!picked) return;
            slug = picked;
          }
          try {
            const docs = await client.listAllDocuments();
            if (docs.length === 0) {
              vscode.window.showInformationMessage('No documents found in AnythingLLM.');
              return;
            }
            const picks = await vscode.window.showQuickPick(
              docs.map((d) => ({ label: d.name, description: d.type, picked: false })),
              { canPickMany: true, placeHolder: 'Select document(s) to embed into the workspace' }
            );
            if (!picks || picks.length === 0) return;
            workspaceSlug = slug;
            documentNames = picks.map((p) => p.label);
          } catch (err) {
            handleApiError(err);
            return;
          }
        }
        try {
          await client.updateEmbeddings(workspaceSlug!, documentNames!);
          vscode.window.showInformationMessage(
            `✅ ${documentNames!.length} document(s) embedded into workspace "${workspaceSlug}"`
          );
          workspaceTree.refresh();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(
            `Embedding failed: ${msg}\n\nLikely causes:\n• Embedding engine not configured on the AnythingLLM server (Admin → Embedder Preference)\n• Vector DB connection error\n• Workspace slug "${workspaceSlug}" is invalid`
          );
        }
      }
    )
  );

  // ─── anythingllm.openSettings ────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('anythingllm.openSettings', () => {
      vscode.commands.executeCommand(
        'workbench.action.openSettings',
        '@ext:riphputra.anythingllm-vscode'
      );
    })
  );

  // ─── anythingllm.showOutput ──────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('anythingllm.showOutput', () => {
      const stats = Telemetry.getStats();
      Logger.show();
      Logger.info(
        `Stats: ${stats.totalRequests} requests, ${stats.totalErrors} errors, avg ${stats.avgLatencyMs}ms, ${stats.totalTokens} tokens`
      );
    })
  );

  // ─── anythingllm.openDonate ──────────────────────────────────────────────
  // Shows a QuickPick with the configured donate platforms (Saweria / PayPal),
  // then opens the chosen URL externally. Non-intrusive: voluntary only.
  //
  // URLs are sourced from `src/donateConfig.ts` (compile-time constants),
  // NOT from VS Code settings — the extension author edits that file directly
  // to bake their own donate links into the distributed .vsix.
  context.subscriptions.push(
    vscode.commands.registerCommand('anythingllm.openDonate', async () => {
      if (DONATE_LINKS.length === 0) {
        vscode.window.showInformationMessage(
          'No donate URLs are configured. The extension author can add them in src/donateConfig.ts.'
        );
        return;
      }

      const picked = await vscode.window.showQuickPick(
        DONATE_LINKS.map((entry) => ({
          label: entry.label,
          description: entry.description,
          detail: entry.url,
          url: entry.url,
        })),
        {
          placeHolder: 'Choose a way to support AnythingLLM for VS Code',
          title: '💜 Support this project',
        }
      );

      if (!picked) return;

      try {
        await vscode.env.openExternal(vscode.Uri.parse(picked.url));
        Logger.info(`Donate link opened: ${picked.url}`);
      } catch (err) {
        Logger.error('Failed to open donate URL', err);
        vscode.window.showErrorMessage(
          `Could not open the donate link: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    })
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function pickWorkspace(
  client: AnythingLLMClient
): Promise<string | undefined> {
  try {
    const workspaces = await client.listWorkspaces();
    if (workspaces.length === 0) {
      vscode.window.showWarningMessage('No workspaces available.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      workspaces.map((w) => ({ label: w.name, slug: w.slug })),
      { placeHolder: 'Select a workspace' }
    );
    return picked?.slug;
  } catch (err) {
    handleApiError(err);
    return;
  }
}

function handleApiError(err: unknown): void {
  Logger.error('API error', err);
  if (err instanceof AnythingLLMError) {
    if (err.isAuthError()) {
      vscode.window
        .showErrorMessage(
          'API key is invalid or expired.',
          'Set API Key'
        )
        .then((a) => {
          if (a === 'Set API Key') {
            vscode.commands.executeCommand('anythingllm.setApiKey');
          }
        });
      return;
    }
    vscode.window.showErrorMessage(`AnythingLLM API Error (${err.status}): ${err.message}`);
    return;
  }
  vscode.window.showErrorMessage(
    `Error: ${err instanceof Error ? err.message : String(err)}`
  );
}
