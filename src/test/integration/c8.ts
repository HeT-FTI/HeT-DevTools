/**
 * C8：**页签恒为 1 + 页内 Slot 互斥**（A 块验收，0 人工 + 喂狗）。
 *
 * 为什么必须用真宿主验证：这一块的正确性完全在"VS Code 会不会真的开第二个页签"上 ——
 * 单测只能证明"代码里没有别处调 createWebviewPanel"，证明不了**运行时**页签数。
 * 用户的诉求是"有且只有 1 个 tab"，那就直接数 `vscode.window.tabGroups` 里的 `het.*` 页签。
 *
 * 覆盖（每一步都断言，不靠肉眼看）：
 *   1. 打开驾驶舱 → 1 个页签；
 *   2. 依次打开 6 个细节视图（依赖/文档/质量/预检/设置/测试结果）→ 页签数**始终**是 1；
 *   3. 每开一个，`het.getSlotState` 报的当前 Slot 必须是它（互斥折叠：上一个自动关掉）；
 *   4. `het.detail.close` → Slot 关掉，页签数仍然 1（驾驶舱不许被连带关掉）；
 *   5. 全流程无人值守：打印每一步，出错即抛（外层驱动带看门狗，卡住会被杀并报 97）。
 *
 * Run with:  npm run test:c8
 */
import * as assert from 'node:assert';
import * as vscode from 'vscode';

import { EXTENSION_ID } from '../hostExtension';
import { assertHostIsTrustworthy, logProvenance, writeEvidence } from './support/hostProvenance';

interface SlotState {
  open: { id: string; title: string } | null;
  dropped: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 全部页签的快照（诊断用：失败时能看出"到底开了什么"，而不是只说一句 []）。 */
function tabSnapshot(): string[] {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .map((tab) => {
      const input = tab.input as { viewType?: string } | undefined;
      return input?.viewType ?? `(${(tab.input as object | undefined)?.constructor?.name ?? 'unknown'})${tab.label}`;
    });
}

/** 轮询等待（CI 上慢一点不该变红：等条件成立，超时才失败）。 */
async function waitFor(what: string, ok: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ok()) {
      return;
    }
    await sleep(250);
  }
  assert.fail(`等待「${what}」超时（${timeoutMs}ms）—— 当前页签：${JSON.stringify(tabSnapshot())}`);
}

/** 我们自己的页签（按 viewType **或** label 识别）。
 *
 * 为什么不能只看 `input.viewType`：在真实宿主里实测拿不到（VS Code 1.134 给的是
 * `mainThreadWebview-het.cockpit` 这种内部形状）—— 只看 viewType 会得到空数组，
 * 于是“页签数正确”变成永远不成立的假断言。 */
function hetTabs(): string[] {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .map((tab) => {
      const viewType = (tab.input as { viewType?: string } | undefined)?.viewType;
      return { viewType, label: tab.label };
    })
    .filter((t) => (t.viewType ?? '').startsWith('het.') || t.label.includes('het.') || t.label.includes('HeT DevTools'))
    .map((t) => t.viewType ?? t.label);
}

async function slotState(): Promise<SlotState> {
  return (await vscode.commands.executeCommand('het.getSlotState')) as SlotState;
}

/**
 * 依次打开这些视图，每次都断言"页签恒为 1 + 当前 Slot 正确"。
 *
 * **为什么不带 `het.showTestResults`**：它要求先有测试结果（`lastTestSummary`），没有就只
 * 弹一句"尚无测试结果"、不开视图 —— 那是**正确行为**。把它写进来会得到一个"永远失败的
 * 假期望"（"断言照着自己想象的产品行为写"这个坑，计划里已经记过一次）。
 */
const VIEWS: readonly { command: string; slot: string }[] = [
  { command: 'het.openDeps', slot: 'deps' },
  { command: 'het.docs', slot: 'docs' },
  { command: 'het.quality', slot: 'quality' },
  { command: 'het.preflight', slot: 'preflight' },
  { command: 'het.openSettings', slot: 'settings' },
  { command: 'het.newModule', slot: 'moduleWizard' },
  { command: 'het.coverage', slot: 'coverage' },
];

export async function run(): Promise<void> {
  console.log('[c8] starting — 页签恒为 1 + 页内 Slot 互斥');
  // 宿主自证：远端宿主 / web 宿主 / 别的扩展目录 → 结论无意义，直接红。
  const provenance = assertHostIsTrustworthy({ tag: 'c8', workspaceContains: ['c8'] });
  logProvenance('c8', provenance);
  const seen: string[] = [];
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(ext, 'extension must be discovered');
  await ext.activate();
  await sleep(400);

  await vscode.commands.executeCommand('het.dashboard');
  await waitFor('驾驶舱页签出现', () => hetTabs().length >= 1);
  await sleep(400);
  assert.strictEqual(
    hetTabs().length,
    1,
    `打开驾驶舱后应当只有 1 个页签，实际：${JSON.stringify(tabSnapshot())}`,
  );
  console.log('[c8] 驾驶舱 OK — 页签 = 1');

  for (const view of VIEWS) {
    await vscode.commands.executeCommand(view.command);
    // 命令是异步的（面板首帧还在渲染）→ 轮询等它成为当前 Slot，而不是"睡固定毫秒"
    let state: SlotState = { open: null, dropped: 0 };
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      state = await slotState();
      if (state.open?.id === view.slot) {
        break;
      }
      await sleep(250);
    }
    assert.strictEqual(
      state.open?.id,
      view.slot,
      `当前 Slot 应当是 ${view.slot}（互斥折叠：上一个自动关掉），实际 ${state.open?.id}`,
    );
    const tabs = hetTabs();
    assert.strictEqual(
      tabs.length,
      1,
      `打开 ${view.slot} 后页签必须仍是 1 个，实际：${JSON.stringify(tabSnapshot())}` +
        '（多出来的就是"它自己又开了页签"）',
    );
    const state2 = await slotState();
    assert.ok(state2.open, `打开 ${view.slot} 后 het.getSlotState 必须报告当前 Slot`);
    assert.strictEqual(
      state2.open?.id,
      view.slot,
      `当前 Slot 应当是 ${view.slot}（互斥折叠：上一个自动关掉），实际 ${state2.open?.id}`,
    );
    assert.ok(
      state2.open?.title?.includes('：'),
      `Slot 标题要按"<领域>：<对象>"格式（品牌名只留在页签上），实际「${state2.open?.title}」`,
    );
    console.log(`[c8] ${view.slot} OK — 页签 = 1 · Slot 标题「${state2.open?.title}」`);
    seen.push(`${view.slot}=1tab`);
  }

  await vscode.commands.executeCommand('het.detail.close');
  await sleep(300);
  const closed = await slotState();
  assert.strictEqual(closed.open, null, '关闭后不该还有 Slot');
  assert.strictEqual(hetTabs().length, 1, '关掉 Slot 不许连带关掉驾驶舱');
  console.log(`[c8] 关闭 OK — 页签 = 1 · 丢弃消息数 ${closed.dropped}`);
  // 证据落盘：驱动脚本据此判定"用例真的跑过"——否则 VS Code CLI 忽略参数、退出码 0
  // 也会被当成通过（假绿）。宿主上下文一并写入，供驱动回验版本。
  writeEvidence('c8', [`tabs=1`, ...seen, `dropped=${closed.dropped}`], provenance);
  console.log('[c8] OK');
}
