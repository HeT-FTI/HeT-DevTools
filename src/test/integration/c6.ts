/**
 * C6 cockpit/dashboard check (gui-rework-plan-v3 Checkpoint C6).
 *
 * Two phases, fully offline:
 *   Phase "empty" — an empty workspace folder → the monitoring chip is HIDDEN
 *                   (V3-1: no project ⇒ invisible) and the Explorer init-here
 *                   command `het.newProjectHere` is registered.
 *   Phase "proj"  — the mini-fcpp fixture → chip (het.chipOverview, icon
 *                   tooltip, no new-project link); `het.dashboard?["deps"]`
 *                   focuses the deps section; deps commands are registered.
 *
 * Run with:  npm run test:c6
 */
import * as assert from 'node:assert';
import * as vscode from 'vscode';

import { EXTENSION_ID } from '../hostExtension';
const phase = process.env.HET_C6_PHASE ?? 'empty';

interface ChipShape {
  text: string;
  tooltip: string;
  command?: string;
}

export async function run(): Promise<void> {
  console.log(`[c6] phase=${phase} starting`);
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(ext, 'extension must be discovered');
  await ext.activate();
  await new Promise((r) => setTimeout(r, 400));

  const chip = (await vscode.commands.executeCommand('het.getChipState')) as ChipShape | null;

  if (phase === 'empty') {
    // V3-1: without a project the monitoring chip must be invisible — and the
    // empty-workspace on-boarding prompt must never have blocked activation.
    assert.strictEqual(chip, null, 'monitoring chip must be hidden when no fcpp project is open');
    const cmds = await vscode.commands.getCommands(true);
    assert.ok(cmds.includes('het.newProjectHere'), 'Explorer init-here command must be registered');
    assert.ok(cmds.includes('het.chipOverview'), 'chip overview command must be registered');
    console.log('[c6] empty-phase OK — chip hidden (monitoring only) + init-here registered');
  } else {
    assert.ok(chip, 'project chip should be present');
    assert.ok(chip.text.includes('HeT'), 'project chip should be present');
    assert.strictEqual(chip.command, 'het.chipOverview', 'project chip opens the monitor overview');
    assert.ok(chip.tooltip.includes('$('), 'tooltip must carry $(icon) tokens');
    assert.ok(!chip.tooltip.includes('het.newProject'), 'monitoring chip must not offer new project');
    // V5-2 hover console: 项目/状态 table + command links + health row.
    assert.ok(chip.tooltip.includes('| 项目 | 状态 |'), 'hover console is a 项目/状态 table');
    assert.ok(chip.tooltip.includes('工程健康'), 'health total row rendered last');
    assert.ok(chip.tooltip.includes('command:het.test'), 'build action link present');
    assert.ok(chip.tooltip.includes('command:het.envCheck'), 'env action link present');
    assert.ok(chip.tooltip.includes('command:het.healthCheck'), 'health rescore link present');

    // open dashboard at the deps section (anchor semantics)
    await vscode.commands.executeCommand('het.dashboard', ['deps']);
    await new Promise((r) => setTimeout(r, 1200));
    const state = (await vscode.commands.executeCommand('het.getCockpitState')) as { page: string; top: { projectName: string } };
    assert.ok(state, 'cockpit state must be queryable');
    assert.strictEqual(state.top.projectName, 'mini-fcpp');
    assert.strictEqual(state.page, 'deps', 'dashboard should focus the deps section');

    // deps commands are registered
    const cmds = await vscode.commands.getCommands(true);
    assert.ok(cmds.includes('het.refreshConanIndex'), 'het.refreshConanIndex must be registered');
    assert.ok(cmds.includes('het.addDependency'), 'het.addDependency must be registered');
    // V5-2 console commands are registered
    assert.ok(cmds.includes('het.envCheck'), 'het.envCheck must be registered');
    assert.ok(cmds.includes('het.openDocsArtifact'), 'het.openDocsArtifact must be registered');
    assert.ok(cmds.includes('het.openBuildOutput'), 'het.openBuildOutput must be registered');
    assert.ok(cmds.includes('het.healthReport'), 'het.healthReport must be registered');
    console.log('[c6] project-phase OK — chip hover console + dashboard deps focus + deps commands registered');
  }
  console.log('[c6] OK');
}
