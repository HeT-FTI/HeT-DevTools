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
import { assertHostIsTrustworthy, logProvenance, writeEvidence } from './support/hostProvenance';
const phase = process.env.HET_C6_PHASE ?? 'empty';

interface ChipShape {
  text: string;
  tooltip: string;
  command?: string;
}

/** 单页视图状态（`het.getCockpitView`）：深链定位到哪一段、哪些段已加载/已折叠。 */
interface CockpitViewShape {
  focus: string | null;
  folded: string[];
  opened: string[];
}

/**
 * 等深链落地。面板首帧是异步的（打开面板 → 解析段 → 展开 → 推送），
 * 所以轮询而不是"睡固定毫秒" —— 睡固定值在慢机器上就是随机红。
 */
async function waitForDeepLink(): Promise<CockpitViewShape> {
  const deadline = Date.now() + 15_000;
  let view = (await vscode.commands.executeCommand('het.getCockpitView')) as CockpitViewShape;
  while (!view.focus && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    view = (await vscode.commands.executeCommand('het.getCockpitView')) as CockpitViewShape;
  }
  return view;
}

export async function run(): Promise<void> {
  console.log(`[c6] phase=${phase} starting`);
  // 宿主自证（与 c8 同一套）：结论必须自带上下文 —— 远端宿主 / web 宿主 / 市场装置的那份
  // 扩展都会让结果失去意义。两个阶段的工作区不同：空目录 `out/c6-ws` 与夹具 `mini-fcpp`。
  const provenance = assertHostIsTrustworthy({ tag: `c6:${phase}`, workspaceContains: ['c6-ws', 'mini-fcpp'] });
  logProvenance(`c6:${phase}`, provenance);
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
    // E 块：悬停动作名按 §5.2 定稿（编译打包 = het.build；不再有"构建并测试"这个二义名）
    assert.ok(chip.tooltip.includes('command:het.build'), '编译打包 action link present');
    assert.ok(chip.tooltip.includes('command:het.envCheck'), 'env action link present');
    assert.ok(chip.tooltip.includes('command:het.cacheClean'), 'cache governance action link present');
    assert.ok(chip.tooltip.includes('command:het.healthCheck'), 'health rescore link present');
    assert.ok(!chip.tooltip.includes('构建并测试'), '§5.2：二义动作名不许再出现在任何可见文案里');
    // E 块：行名 == rail 定稿名（同一串字），且五段都在
    for (const lane of ['环境车道', '构建验证', '模块文档', '质量安全', '交付发布']) {
      assert.ok(chip.tooltip.includes(lane), `悬停行名用 rail 定稿名：${lane}`);
    }

    // 深链 `deps`（旧 tab id）现在要落在**单页里的某一段**上，而不是切“页”：新 UI 没有
    // “当前页”这个概念（旧 `state.page` 已归档）。用户能感知的验收点只有一个 ——
    // “点完这条链接，那一段真的展开在我眼前了吗”。
    await vscode.commands.executeCommand('het.dashboard', ['deps']);
    const view = await waitForDeepLink();
    const focus = view.focus ?? '';
    assert.ok(focus, '旧 tab id `deps` 必须还能解析成一个真实存在的段（否则就是“点了没反应”）');
    assert.ok(
      view.opened.includes(focus),
      `深链目标段必须被加载（否则定位到一个空段）：${JSON.stringify(view)}`,
    );
    assert.ok(
      !view.folded.includes(focus),
      `深链目标段必须是展开可见的（不能深链到一个折叠着的段）：${JSON.stringify(view)}`,
    );
    const state = (await vscode.commands.executeCommand('het.getCockpitState')) as { top: { projectName: string } };
    assert.ok(state, 'cockpit state must be queryable');
    assert.strictEqual(state.top.projectName, 'mini-fcpp', '驾驶舱 L1 必须认到当前项目');
    const slot = (await vscode.commands.executeCommand('het.getSlotState')) as { open: unknown };
    assert.strictEqual(slot.open, null, '深链是页内锚点：不该顺手开一个页内 Slot（那不是用户点的东西）');

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
  // 证据落盘（`out/c6-<phase>-evidence.txt`）：驱动脚本据此判定“用例真跑过 + 跑在哪”。
  writeEvidence(`c6-${phase}`, [`phase=${phase}`, 'ok=1'], provenance);
  console.log('[c6] OK');
}
