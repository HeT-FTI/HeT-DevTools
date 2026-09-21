/**
 * C5 cockpit check (gui-rework-plan Checkpoint C5).
 *
 * Two phases, fully offline:
 *   Phase "empty" — an empty workspace folder → `het.cockpit` opens and the
 *                   five-step new-project wizard must auto-open at step 1.
 *   Phase "proj"  — the mini-fcpp fixture workspace → cockpit opens with a
 *                   project name, no wizard, and a clean template badge.
 *
 * Run with:  npm run test:c5
 */
import * as assert from 'node:assert';
import * as vscode from 'vscode';

import { EXTENSION_ID } from '../hostExtension';
const phase = process.env.HET_C5_PHASE ?? 'empty';

interface CockpitStateShape {
  page: string;
  wizard: { step: number } | null;
  top: { projectName: string; templateBehind: number };
}

export async function run(): Promise<void> {
  console.log(`[c5] phase=${phase} starting`);
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(ext, 'extension must be discovered');
  await ext.activate();

  await vscode.commands.executeCommand('het.cockpit');
  await new Promise((r) => setTimeout(r, 600));

  const state = (await vscode.commands.executeCommand('het.getCockpitState')) as CockpitStateShape;
  assert.ok(state && typeof state.page === 'string', 'cockpit state must be queryable');

  if (phase === 'empty') {
    assert.strictEqual(state.top.projectName, '', 'empty workspace must report no project');
    assert.ok(state.wizard !== null && state.wizard.step === 1, 'wizard must auto-open at step 1 on an empty workspace');
    console.log('[c5] empty-phase OK — cockpit open, wizard auto-opened at step 1');
  } else {
    assert.strictEqual(state.top.projectName, 'mini-fcpp', 'workspace must be mini-fcpp');
    assert.strictEqual(state.wizard, null, 'wizard must not pop when a project exists');
    assert.strictEqual(state.top.templateBehind, 0, 'template badge must be clean without a marker');
    console.log('[c5] project-phase OK — cockpit open, no wizard, template badge 0');
  }
  console.log('[c5] OK');
}
