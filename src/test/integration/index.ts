/**
 * Extension-host integration smoke test (T-0.2 DoD proof).
 *
 * Loaded via @vscode/test-electron with the mini-fcpp fixture opened as the
 * workspace, so the "workspace contains metadata.json" activation event fires.
 * Asserts that the extension activates and its registered command executes.
 *
 * Run with:  npm run test:integration
 */
import * as assert from 'node:assert';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';

import { EXTENSION_ID, discoveredIds, hetExtension } from '../hostExtension';

export async function run(): Promise<void> {
  console.log('[integration-smoke] starting');

  const ext = hetExtension() ?? vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(ext, `extension must be discovered in the test host — expected "${EXTENSION_ID}"; discovered: ${discoveredIds()}`);

  await ext.activate();
  assert.strictEqual(ext.isActive, true, 'extension must be active after activate()');

  // The activation line written to the "HeT DevTools" output channel must exist.
  // Read via a registered command (deterministic; ext.exports can be flaky).
  const activationLine = (await vscode.commands.executeCommand<string>('het.getActivationLine')) ?? '';
  assert.ok(
    activationLine.includes(`activated \u2014 ${ext.id}`),
    `expected activation line with "${ext.id}", got: ` + activationLine,
  );
  // Durable evidence for the outer runner (host stdout forwarding is unreliable).
  writeFileSync(join(__dirname, '..', 'activation-evidence.txt'), activationLine + '\n', 'utf8');
  console.log('[integration-smoke] activation = ' + activationLine);

  await vscode.commands.executeCommand('het.hello');

  const folders = vscode.workspace.workspaceFolders ?? [];
  assert.ok(folders.length > 0, 'expected a workspace folder (mini-fcpp fixture)');

  // Phase 1: host-side project detection must be wired (T-1.1).
  await vscode.commands.executeCommand('het.refresh');
  const detectedName = await vscode.commands.executeCommand<string | null>('het.getCurrentProject');
  assert.strictEqual(detectedName, 'mini-fcpp', 'host should detect the mini-fcpp project');

  // Phase 1: dashboard webview opens without throwing (T-1.8 smoke).
  await vscode.commands.executeCommand('het.dashboard');
  await new Promise((r) => setTimeout(r, 500));

  // GUI-rework P-G1: integrated cockpit opens, navigates and returns its state.
  await vscode.commands.executeCommand('het.cockpit');
  await new Promise((r) => setTimeout(r, 400));
  await vscode.commands.executeCommand('het.getCockpitState');
  await new Promise((r) => setTimeout(r, 200));

  console.log('[integration-smoke] OK - extension active in ' + folders[0].uri.fsPath);
}
