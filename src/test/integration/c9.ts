/**
 * C9：**一致性会话**（计划 §6-H / G14 / G15，0 人工 + 喂狗）。
 *
 * 要回答的问题：*"任务 / 输出 / 前端三面说的是不是同一件事"* —— 用户遇到的"转两小时"
 * "按钮点了没反应""构建中却显示失败"全是这三面互相打架的**症状**，而它们在单测里
 * 看不出来（单测各自只持有一面）。所以这里在**真实扩展宿主**里跑一段脚本化的高频会话：
 *
 *   ① 页面开合压力：逐个 Section 深链 + 逐个 Slot 开合 + ≥50 次来回切换；
 *   ② 长动作四连：成功（体检）/ 失败（测试）/ 取消（构建）/ 超时（文档）；
 *   ③ 依赖视图：在会话里开合一次（搜索/添加/重复/移除的**纯逻辑**由单测与 c2 覆盖 ——
 *      这里跑不动，因为没有 conan 索引也没有网络；见下方"范围与取舍"）。
 *
 * 每一步都断言**三元组**：
 *   · Task  —— `het.getUiSnapshot().tasks`（终态必须与出口一致；running 必有 owner/deadline/心跳）；
 *   · 输出  —— `het.getOutputLines()`（每个任务恰好一对 `▶` / 终态行；只有 1 个通道）；
 *   · 前端  —— `het.getUiSnapshot()`（三档同源：chip 文字 / 悬停表格 / 页内 status）+ 页签数恒为 1。
 *
 * **范围与取舍（写给下一个维护者）**：长动作用的是 `het.testRunTask` 的**注入体**
 * （`ok` / `fail` / `hang`），不是真实 conan 构建。理由：四出口（成功/失败/超时/取消）
 * 是 `runWithBusy` 这一层的性质，注入体让四种出口在 ~40 秒内各跑一遍，而**四种出口走的是
 * 同一条产品代码**（同一个 TaskStore、同一个唯一通道、同一套三档投影）；真实工具链由
 * c1（真实构建）/ c2（全旅程）/ real（跨平台）覆盖。注入体只在测试宿主且
 * `HET_TASK_INJECT=1` 时存在（见 `extension.ts` 的守卫）。
 *
 * Run with:  npm run test:c9
 */
import * as assert from 'node:assert';
import * as vscode from 'vscode';

import { EXTENSION_ID } from '../hostExtension';
import { assertHostIsTrustworthy, logProvenance, writeEvidence } from './support/hostProvenance';
import { SLOT_VIEWS } from './support/slotViews';
import { EXIT_STEPS, TIMEOUT_OVERRIDE_MS, type ExitStep } from './support/sessionPlan';
import { intentForBusy } from '../../core/intents';
import { parseLogLine, type LogEntry } from '../../core/outputChannels';
import { SECTIONS } from '../../features/cockpit/singlepage/sections';
import { statusText } from '../../core/status';

/** 会话压力：Section/Slot 来回切换次数（计划要求 ≥50）。 */
const SWITCHES = 52;
/** 超时用例最多等多久（对账器 15s 一跳 + 设置覆盖 2s 阈值）。 */
const TIMEOUT_WAIT_MS = 30_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface TaskShape {
  id: string;
  action: string;
  label: string;
  state: string;
  owner: string;
  deadlineMs: number;
  heartbeatAt?: number;
}

interface Snapshot {
  tabs: number;
  tabReport: string;
  slot: { open: { id: string; title: string } | null; dropped: number };
  chip: { text: string; tooltip: string; command?: string } | null;
  items: Array<{ id: string; state: string; text: string }>;
  busy: { action: string; text: string; domain: string | null } | null;
  page: { status: { action: string; text: string } | null };
  sections: { focus: string | null; folded: string[]; opened: string[] };
  tasks: { active: TaskShape[]; recent: TaskShape[] };
}

async function snapshot(): Promise<Snapshot> {
  return (await vscode.commands.executeCommand('het.getUiSnapshot')) as Snapshot;
}

async function outputEntries(): Promise<LogEntry[]> {
  const lines = (await vscode.commands.executeCommand<string[]>('het.getOutputLines', 300)) ?? [];
  return lines.map((line) => {
    const parsed = parseLogLine(line);
    assert.ok(parsed, `输出行必须可解析（域是参数、不是手写文案）：${line}`);
    return parsed;
  }).reverse(); // 最新的在前，便于"找这个动作那对行"
}

async function waitFor<T>(what: string, fn: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await fn();
    if (last !== undefined) {
      return last;
    }
    await sleep(250);
  }
  const s = await snapshot();
  assert.fail(`等待「${what}」超时（${timeoutMs}ms）；三面快照：${JSON.stringify({ tabs: s.tabs, slot: s.slot, busy: s.busy, chip: s.chip?.text, tasks: s.tasks.active.map((t) => `${t.id}:${t.state}`) })}`);
  throw new Error('unreachable');
}

function assertOneTab(s: Snapshot, where: string): void {
  assert.strictEqual(
    s.tabs,
    1,
    `${where}：页签必须恒为 1（"有且只有 1 个 tab"）—— ${s.tabReport}`,
  );
}

/** 三档（chip / 悬停 / 页内）哪些**没**对齐（空数组 = 完全一致）。 */
function threeTiersFailures(s: Snapshot, action: string, chip: boolean): string[] {
  const fails: string[] = [];
  const text = statusText(action);
  if (s.busy?.action !== action) {
    fails.push(`仓库级状态 busy=${JSON.stringify(s.busy)}（期望 ${action}）`);
  }
  const chipText = s.chip?.text ?? '';
  if (chip && !chipText.includes(text)) {
    fails.push(`chip 文字=「${chipText}」（期望含「${text}」）`);
  }
  if (!chip && chipText.includes(text)) {
    // 环境域是**有意例外**（秒级动作抢芯片会让它一闪一闪）：chip 保持安静，
    // 但悬停与页内照样要说"进行中" —— 这条断言就是钉住这个设计的。
    fails.push(`chip 文字=「${chipText}」不该被环境域的秒级动作抢走（设计如此）`);
  }
  if (!(s.chip?.tooltip ?? '').split('\n').some((l) => l.includes('进行中'))) {
    fails.push('悬停表格里没有「进行中」那一行');
  }
  if (s.page.status?.action !== action) {
    fails.push(`页内 status=${JSON.stringify(s.page.status)}（期望 ${action}）`);
  }
  const running = s.items.filter((it) => it.state === 'running');
  if (running.length === 0) {
    fails.push('三档共用的状态项里没有 running 的那一项');
  } else if (!running.every((it) => it.text === '进行中')) {
    fails.push(`状态项文案=${JSON.stringify(running.map((it) => it.text))}（期望全为「进行中」）`);
  }
  return fails;
}

/**
 * 等三档一致，再断言（**不能**用"发现任务在跑"的那一次快照直接断言：chip 是异步重画的，
 * 那个瞬间它很可能还没跟上 —— 这是测试自己的 race，不是产品的错）。
 */
async function waitThreeTiers(step: ExitStep, where: string, timeoutMs = 15_000): Promise<Snapshot> {
  const deadline = Date.now() + timeoutMs;
  let best: { s: Snapshot; fails: string[] } | undefined;
  while (Date.now() < deadline) {
    const s = await snapshot();
    const fails = threeTiersFailures(s, step.action, step.chip);
    if (fails.length === 0) {
      return s;
    }
    // 只把"任务确实在跑"的那几次当作候选：任务结束后的快照没有诊断价值
    if (s.busy?.action === step.action && (!best || best.fails.length > fails.length)) {
      best = { s, fails };
    }
    await sleep(200);
  }
  assert.ok(best, `${where}：整段等待里都没有看到「${step.action} 在跑」（动作没起来？会话太快？）`);
  assert.fail(
    `${where}：三档没对齐 —— 差的：${best.fails.join('；')}；快照：${JSON.stringify({
      busy: best.s.busy,
      chip: best.s.chip?.text,
      tooltip: best.s.chip?.tooltip,
      page: best.s.page,
      items: best.s.items,
      tasks: best.s.tasks.active.map((t) => `${t.id}:${t.state}`),
    })}`,
  );
  throw new Error('unreachable');
}

/** 一个任务在输出里必须**恰好**留下 1 行开始 + 1 行终态，且终态级别与出口对得上（G14）。 */
function assertOutputPair(entries: LogEntry[], step: ExitStep, where: string): void {
  const name = intentForBusy(step.action)?.name ?? step.action;
  const domain = intentForBusy(step.action)?.output?.domain ?? 'env';
  const mine = entries.filter((e) => e.domain === domain && e.text.includes(name));
  const steps = mine.filter((e) => e.level === 'step');
  const terminals = mine.filter((e) =>
    (['ok', 'fail', 'timeout', 'cancel'] as string[]).includes(e.level),
  );
  assert.strictEqual(steps.length, 1, `${where}：恰好 1 行开始（▶ ${name}）—— ${JSON.stringify(mine.map((e) => e.text))}`);
  assert.strictEqual(terminals.length, 1, `${where}：恰好 1 行终态 —— ${JSON.stringify(mine.map((e) => e.text))}`);
  assert.strictEqual(terminals[0].level, step.level, `${where}：终态行必须是 ${step.level}（出口不许混）`);
  // "下一步"只属于**失败**（取消/超时是用户/环境造成的，不该再劝人排错）。
  // 它按**域**数：那行的文案是 `下一步：<提示>`，里面不一定有动作名（所以不能拿名字去筛）。
  const nextSteps = entries.filter((e) => e.domain === domain && e.text.startsWith('下一步：'));
  assert.strictEqual(
    nextSteps.length,
    step.expect === 'failed' ? 1 : 0,
    `${where}："下一步"行数不对（${step.expect} 应为 ${step.expect === 'failed' ? 1 : 0} 行）`,
  );
}

async function openSlot(view: { command: string; slot: string }): Promise<void> {
  await vscode.commands.executeCommand(view.command);
  await waitFor(`Slot ${view.slot} 成为当前页内视图`, async () => {
    const s = await snapshot();
    return s.slot.open?.id === view.slot ? s : undefined;
  });
}

/** 跑一个注入的长动作到指定出口，并在"在跑"那一刻断言三面一致。 */
async function runExit(step: ExitStep): Promise<void> {
  const running = waitFor(`${step.action} 进入 running（三面）`, async () => {
    const s = await snapshot();
    return s.tasks.active.some((t) => t.action === step.action) ? s : undefined;
  });
  const done = vscode.commands.executeCommand('het.testRunTask', {
    action: step.action,
    mode: step.mode,
    // 成功/失败也要"在跑一会儿"：快到来不及看，就观察不到"三档都说进行中"这件事
    // （那是 chip 异步重画 + 会话轮流取快照的必然结果，不是产品的错）。
    ms: 3_000,
  });
  const busy = await running;

  // ── 三面一致（在跑的那一刻）──
  assertOneTab(busy, `[${step.action}] 长动作进行中`);
  await waitThreeTiers(step, `[${step.action}] 进行中`);
  const task = busy.tasks.active.find((t) => t.action === step.action);
  assert.ok(task, `[${step.action}] 必须出现在任务清单里`);
  assert.ok(task?.owner, `[${step.action}] running 必须有 owner（问责）`);
  assert.ok((task?.deadlineMs ?? 0) > 0, `[${step.action}] running 必须有 deadline（无界长动作是事故）`);
  assert.ok(task?.heartbeatAt !== undefined, `[${step.action}] running 必须有心跳`);

  if (step.settle === 'cancel') {
    await vscode.commands.executeCommand('het.task.cancel');
  } else if (step.settle === 'timeout') {
    // 不催它：由对账器按 deadline 收敛（这正是"脚本挂住"的真实现场）
    assert.strictEqual(
      task?.deadlineMs,
      TIMEOUT_OVERRIDE_MS,
      `[${step.action}] 阈值必须来自设置覆盖（§3.5 的 het.task.deadlines）`,
    );
    await waitFor(
      `${step.action} 被对账器判超时`,
      async () => {
        const s = await snapshot();
        const t = [...s.tasks.active, ...s.tasks.recent].find(
          (x) => x.action === step.action && x.state === step.expect,
        );
        return t ? s : undefined;
      },
      TIMEOUT_WAIT_MS,
    );
  }
  await done;

  // ── 收尾：三面都回到同一件事（终态）──
  const after = await waitFor(`${step.action} 从"在跑"回到安静`, async () => {
    const s = await snapshot();
    return s.busy === null ? s : undefined;
  });
  assertOneTab(after, `[${step.action}] 结束`);
  const settled = [...after.tasks.active, ...after.tasks.recent].find((t) => t.action === step.action);
  assert.strictEqual(settled?.state, step.expect, `[${step.action}] Task 终态必须是 ${step.expect}`);
  const entries = await outputEntries();
  assertOutputPair(entries, step, `[${step.action}] ${step.expect}`);
  console.log(
    `[c9] ${step.action} × ${step.expect} OK — 三面一致（chip/悬停/页内）+ 输出恰好一对行（${step.level}）`,
  );
}

export async function run(): Promise<void> {
  console.log('[c9] starting — 一致性会话（页签恒 1 · 三元组 · 四出口）');
  const provenance = assertHostIsTrustworthy({ tag: 'c9', workspaceContains: ['c9'] });
  logProvenance('c9', provenance);
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(ext, 'extension must be discovered');
  await ext.activate();
  await sleep(400);
  // 注入体开关必须真的传进了宿主进程（驱动脚本两路都传：process.env + extensionTestsEnv）。
  // 这一条放在最前面：否则失败会伪装成"长动作没起来"这种看着像产品 bug 的样子。
  assert.strictEqual(
    process.env.HET_TASK_INJECT,
    '1',
    '长动作注入体开关没传进宿主（scripts/run-c9.mjs 必须设置 HET_TASK_INJECT=1）',
  );

  // ── ① 页面开合压力 ────────────────────────────────────────────────────
  await vscode.commands.executeCommand('het.dashboard');
  await waitFor('唯一页签出现', async () => ((await snapshot()).tabs >= 1 ? true : undefined));
  await sleep(400);
  assertOneTab(await snapshot(), '打开驾驶舱后');

  for (const def of SECTIONS) {
    await vscode.commands.executeCommand('het.dashboard', [def.id]);
    await waitFor(`段 ${def.id} 被深链定位并展开`, async () => {
      const { sections } = await snapshot();
      return sections.focus === def.id && sections.opened.includes(def.id) && !sections.folded.includes(def.id)
        ? sections
        : undefined;
    });
    assertOneTab(await snapshot(), `深链到段 ${def.id}`);
  }
  console.log(`[c9] 段落 OK — ${SECTIONS.length} 段逐个深链，页签恒为 1`);

  for (const view of SLOT_VIEWS) {
    await openSlot(view);
    const s = await snapshot();
    assertOneTab(s, `打开 Slot ${view.slot}`);
    assert.ok(
      s.slot.open?.title?.includes('：'),
      `Slot 标题要按"<领域>：<对象>"格式，实际「${s.slot.open?.title}」`,
    );
  }
  console.log(`[c9] Slot OK — ${SLOT_VIEWS.length} 个视图逐个打开，页签恒为 1`);

  // ≥50 次来回切换：Section 深链 ↔ Slot 打开，穿插快照抽查
  for (let i = 0; i < SWITCHES; i++) {
    if (i % 2 === 0) {
      await vscode.commands.executeCommand('het.dashboard', [SECTIONS[i % SECTIONS.length].id]);
    } else {
      await openSlot(SLOT_VIEWS[i % SLOT_VIEWS.length]);
    }
    if (i % 7 === 0) {
      assertOneTab(await snapshot(), `第 ${i} 次切换后`);
    }
  }
  await vscode.commands.executeCommand('het.detail.close');
  await sleep(300);
  const after = await snapshot();
  assert.strictEqual(after.slot.open, null, '关闭后不该还有 Slot');
  assertOneTab(after, '关掉 Slot 后');
  assert.strictEqual(after.slot.dropped, 0, `消息丢弃数必须为 0（不是 0 就是有视图没接住消息）`);
  console.log(`[c9] 高频切换 OK — ${SWITCHES} 次切换 · 页签恒为 1 · 丢弃消息数 ${after.slot.dropped}`);

  // ── ② 长动作四连（每种出口都断言三元组；脚本表在 support/sessionPlan.ts）──
  for (const step of EXIT_STEPS) {
    await runExit(step);
  }
  assert.deepStrictEqual(
    EXIT_STEPS.map((s) => s.expect),
    ['succeeded', 'failed', 'cancelled', 'timedOut'],
    '四种出口都要在会话里真的跑到（成功/失败/取消/超时）',
  );

  const end = await snapshot();
  assertOneTab(end, '会话结束');
  assert.strictEqual(end.tasks.active.length, 0, '会话结束时不该有还在跑的任务（喂狗之外的第二道兜底）');
  assert.strictEqual(end.slot.dropped, 0, '整场会话说下来，一条消息都不许丢');

  // 证据落盘：驱动脚本据此判定"用例真的跑过 + 跑在哪"（CLI 忽略参数也退 0 的假绿）
  writeEvidence(
    'c9',
    [
      `tabs=${end.tabs}`,
      `switches=${SWITCHES}`,
      `slots=${SLOT_VIEWS.length}`,
      'exits=ok,fail,cancel,timeout',
      `dropped=${end.slot.dropped}`,
    ],
    provenance,
  );
  console.log('[c9] OK');
}
