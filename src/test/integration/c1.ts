/**
 * C1 end-to-end check (development-plan Checkpoint C1).
 *
 * Opens the REAL working fcpp project (out/c1-fcpp) in the extension host and
 * exercises the full Phase-1 loop through host commands:
 *   detect → dashboard → `conan create` + GTest parse (het.test) → asserts.
 * Run with:  npm run test:c1
 */
import * as assert from 'node:assert';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';

import { EXTENSION_ID } from '../hostExtension';

export async function run(): Promise<void> {
  console.log('[c1] starting');

  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(ext, 'extension must be discovered');
  await ext.activate();

  await vscode.commands.executeCommand('het.refresh');
  const name = await vscode.commands.executeCommand<string | null>('het.getCurrentProject');
  assert.strictEqual(name, 'fcpp', 'expected the real fcpp project, got: ' + name);

  // Dashboard webview opens without throwing.
  await vscode.commands.executeCommand('het.dashboard');
  await new Promise((r) => setTimeout(r, 400));

  console.log('[c1] running het.test (real conan create)…');
  await vscode.commands.executeCommand('het.test');

  const buildOk = await vscode.commands.executeCommand<boolean | null>('het.getBuildOk');
  if (buildOk !== true) {
    const tail = (await vscode.commands.executeCommand<string>('het.getLastConanOutput')) ?? '';
    console.log('[c1] conan output tail:\n' + tail);
  }
  assert.strictEqual(buildOk, true, 'conan create should succeed');

  const summary = (await vscode.commands.executeCommand('het.getTestSummary')) as {
    passed: number;
    failed: number;
    skipped: number;
  } | null;
  assert.ok(summary, 'gtest summary must be present');
  assert.ok(summary.passed > 0, 'at least one gtest case should pass');
  assert.strictEqual(summary.failed, 0, 'no gtest failures expected');

  const evidence = `buildOk=${buildOk} passed=${summary.passed} failed=${summary.failed} skipped=${summary.skipped}\n`;
  writeFileSync(join(__dirname, '..', 'c1-evidence.txt'), evidence, 'utf8');
  console.log('[c1] PASS ' + evidence.trim());
  console.log('[c1] OK - real fcpp build + tests verified through the extension host');

  // Optional "watch me" mode: keep the extension-host window open so a human
  // can observe the dashboard / test-results panels before auto-exit.
  const holdMs = Number(process.env.HET_C1_HOLD_MS ?? 0);
  if (holdMs > 0) {
    console.log(`[c1] holding ${Math.round(holdMs / 1000)}s so you can watch the window…`);
    await new Promise((resolve) => setTimeout(resolve, holdMs));
    console.log('[c1] auto-exit now');
  }
}
