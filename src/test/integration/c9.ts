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
import { which } from '../../utils/exec';

/** 模板里的目标矩阵（夹具里没有这份文件：先验"没有时的说法"，再写进去验"目标只来自它"）。 */
const MATRIX_YAML = [
  'package_ref: mini-fcpp/1.0.0',
  '',
  'defaults:',
  '  mode: default',
  '  toolchain_version: 11.3.rel1',
  '  create_extra_args: --build=missing --test-folder=',
  '',
  'targets:',
  '  - id: linux-armv7',
  '    default: true',
  '    enabled: true',
  '    build_kind: linux',
  '    os: Linux',
  '    arch: armv7',
  '    toolchain_versions:',
  '      - 11.3.rel1',
  '',
].join('\n');

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

/** `het.getTaskCenter`（J 块）：任务中心面板渲染的就是这个模型。 */
interface TaskCenterRowShape {
  id: string;
  label: string;
  state: string;
  stateText: string;
  durationText: string;
  ownerText: string;
  progressText?: string;
  reasonText?: string;
  nextStep?: string;
  artifacts: Array<{ label: string; command?: string; arg?: string; path?: string }>;
}
interface TaskCenterShape {
  running: TaskCenterRowShape[];
  recent: TaskCenterRowShape[];
  ci: { label: string; conclusion: string; glyph: string; whenText: string; url: string } | null;
  ciNote?: { reason: string; fix: string[] };
}

async function taskCenter(): Promise<TaskCenterShape> {
  return (await vscode.commands.executeCommand('het.getTaskCenter')) as TaskCenterShape;
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
  // J 块：任务中心的面板模型必须**跟着事实走**（它就是面板渲染的东西）
  const tc = await taskCenter();
  const row = [...tc.running, ...tc.recent].find((r) => r.id === step.action);
  assert.ok(row, `[${step.action}] 任务中心必须有这一行（会话刚跑完它）`);
  assert.strictEqual(row?.state, step.expect, `[${step.action}] 任务中心的结论 = Task 终态`);
  assert.strictEqual(row?.id, step.action);
  assert.ok((row?.durationText ?? '').length > 0, '耗时来自 Task（不许空着）');
  assert.ok(!tc.running.some((r) => r.id === step.action), '跑完了就不该还在"正在运行"里');
  if (step.expect === 'failed') {
    assert.ok((row?.reasonText ?? '').length > 0, '失败必须在任务中心给原因（一行）');
    assert.ok((row?.nextStep ?? '').length > 0, '失败必须在任务中心给下一步');
  } else {
    assert.strictEqual(row?.nextStep, undefined, `${step.expect} 不该再劝人排错`);
  }
  if (step.action === 'test') {
    // 注入体登记过一个真产物 → 面板拿到的必须是**可点的那个标签**
    assert.deepStrictEqual(row?.artifacts.map((a) => a.label), ['注入产物'], '产物必须从 Task 传到面板');
    assert.ok(row?.artifacts[0].path, '产物要有可打开的路径');
  }
  console.log(
    `[c9] ${step.action} × ${step.expect} OK — 三面一致（chip/悬停/页内）+ 输出恰好一对行（${step.level}）+ 任务中心跟随事实`,
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

  // ── ③ K 块：交叉编译（目标只来自矩阵；缺工具链时给定向提示）──────────
  // 夹具里**没有** .hetai/build-matrix.yml：先验"没有它时的说法"（不许静默空下拉），
  // 再把矩阵写进去 —— 目标必须跟着文件变（单一来源）。
  const noMatrix = (await vscode.commands.executeCommand('het.crossBuild')) as { ok: boolean; message: string };
  assert.strictEqual(noMatrix.ok, false, '没有矩阵时不许"编一个默认目标"');
  assert.match(noMatrix.message, /build-matrix\.yml/u, `要说清缺哪份文件：${noMatrix.message}`);
  const matrixHint = (await vscode.commands.executeCommand('het.getBuildMatrix')) as { error?: string };
  assert.match(matrixHint.error ?? '', /build-matrix\.yml/u, '诊断命令也要如实报错（不许返回空目标表）');

  const ws = vscode.workspace.workspaceFolders?.[0];
  assert.ok(ws, '会话必须有工作区');
  const matrixFile = vscode.Uri.joinPath(ws.uri, '.hetai', 'build-matrix.yml');
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(ws.uri, '.hetai'));
  await vscode.workspace.fs.writeFile(matrixFile, Buffer.from(MATRIX_YAML, 'utf8'));
  const matrix = (await vscode.commands.executeCommand('het.getBuildMatrix')) as {
    packageRef?: string;
    targets?: Array<{ id: string; arch?: string; toolchain?: string }>;
  };
  assert.strictEqual(matrix.targets?.length, 1, '目标表必须来自刚写的文件（没有第二份清单）');
  assert.strictEqual(matrix.targets?.[0].id, 'linux-armv7');
  assert.strictEqual(matrix.targets?.[0].arch, 'armv7');

  const cc = 'arm-linux-gnueabihf-gcc';
  const hasCc = !!(await which(cc));
  const cross = (await vscode.commands.executeCommand('het.crossBuild', 'linux-armv7')) as { ok: boolean; message: string };
  const crossLines = (await outputEntries()).filter((e) => e.text.includes('交叉编译'));
  assert.strictEqual(crossLines.filter((e) => e.level === 'step').length, 1, '交叉编译只留一行开始');
  assert.strictEqual(
    crossLines.filter((e) => ['ok', 'fail', 'timeout', 'cancel'].includes(e.level)).length,
    1,
    '交叉编译只留一行终态',
  );
  if (!hasCc) {
    // 本机没有交叉工具链（开发机的常态）：失败必须是**定向的** —— 点名包名 + 指一条 CI 路
    assert.strictEqual(cross.ok, false);
    // 找"定向"的两行要看整段输出（“怎么觡”行不一定带动作名）
    const tail = (await outputEntries()).slice(0, 30).map((e) => e.text).join('\n');
    const msg = `${cross.message}\n${tail}`;
    assert.match(msg, new RegExp(cc, 'u'), `要说清缺哪个可执行：${msg}`);
    assert.match(msg, /apt-get install/u, '要给可复制的安装命令');
    assert.match(msg, /cross-compile\.yml/u, '要给"交给 CI"这条路');
    const tc = await taskCenter();
    const row = [...tc.running, ...tc.recent].find((r) => r.id === 'crossBuild');
    assert.ok(row, '交叉编译必须进任务中心');
    assert.strictEqual(row?.state, 'failed');
    assert.match(row?.reasonText ?? '', /arm-linux-gnueabihf-gcc|工具链/u, '任务中心也要能看到原因');
    assert.ok((row?.nextStep ?? '').length > 0, '失败必须给下一步');
  } else {
    console.log(`[c9] 本机装了 ${cc}：交叉编译走了真实路径（结论：${cross.ok ? 'ok' : cross.message}）`);
    assert.ok(crossLines.some((e) => e.level === 'ok' || e.level === 'fail'), '必须有终态行');
  }
  console.log(`[c9] 交叉编译 OK — 目标来自矩阵 · ${hasCc ? '本机有工具链' : '缺工具链时提示含包名与 CI 路线'}`);

  // ── ④ K 块下半：上板前置检查（有没有板子都要"说得清"）────────────────
  // 夹具（mini-fcpp）不带 benchmark 目录：会话自己铺最小的一份，这样"前置检查/确认门"
  // 这些**真机路径**能被真跑一遍，而不是只被单测盖住。
  const benchDir = vscode.Uri.joinPath(ws.uri, 'benchmark');
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(benchDir, 'script'));
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(benchDir, 'platform'));
  await vscode.workspace.fs.writeFile(
    vscode.Uri.joinPath(benchDir, 'script', 'run_bench.py'),
    Buffer.from('# 会话夹具：真实脚本在 fcpp 模板里\nprint("[bench] session stub")\n', 'utf8'),
  );
  await vscode.workspace.fs.writeFile(
    vscode.Uri.joinPath(benchDir, 'platform', 'bench_config.json'),
    Buffer.from(
      JSON.stringify({ target_mcu: 'cortex-m4', flash_tool: 'jlink', serial_port: '/dev/ttyUSB0' }, null, 2) + '\n',
      'utf8',
    ),
  );
  const boardPlan = (await vscode.commands.executeCommand('het.getBoardPlan')) as {
    mode: string;
    missing: string[];
    canFlash: boolean;
    hints: { lines: string[]; fix: string[] };
    trigger: { state: string; text: string };
  };
  assert.ok(boardPlan, '前置检查必须能取到（面板开头就是它）');
  assert.strictEqual(boardPlan.mode, 'build-only', '默认必须是只构建（安全默认：不静默刷芯片）');
  assert.strictEqual(boardPlan.canFlash, false, '夹具没接板 → 不能刷');
  const boardText = [...boardPlan.hints.lines, ...boardPlan.hints.fix].join('\n');
  assert.match(boardText, /cortex-m4|arm-none-eabi/u, `前置检查要认得配置里的 cpu：${boardText}`);
  assert.match(`${boardText}\n${boardPlan.missing.join('、')}`, /arm-none-eabi-gcc/u, '缺什么要点名');
  assert.match(boardText, /apt-get install/u, '要给装法');
  assert.match(boardText, /hetai-package-matrix\.yml/u, '要给 CI 那条路');
  assert.match(boardPlan.trigger.text, /workflow_triggers|cross_compile/u, '触发开关也要说得出来');
  // 会刷板的那条路必须**问过**才走（自动化宿主里 askModal 视作取消 → 不静默刷）
  const flash = (await vscode.commands.executeCommand('het.boardBuild', 'on-board')) as { ok: boolean; message: string };
  assert.strictEqual(flash.ok, false, '没人确认就不许刷写芯片');
  assert.match(flash.message, /取消/u, `要明说"已取消上板"：${flash.message}`);
  const flashLines = (await outputEntries()).slice(0, 12).map((e) => `${e.level}:${e.text}`).join('\n');
  assert.ok(!flashLines.includes('step:上板验证') || flashLines.includes('cancel:'), '没确认就不该真的开跑上板');
  // 只构建那条路：本机没交叉工具链 → 定向失败（同样不许是一句裸错）
  const build = (await vscode.commands.executeCommand('het.boardBuild', 'cross')) as { ok: boolean; message: string };
  const boardLines = (await outputEntries()).slice(0, 20).map((e) => e.text).join('\n');
  assert.match(boardLines, /真机前置检查|--no-flash|本机缺|bench_config/u, `前置检查要写进输出：${boardLines}`);
  if (!build.ok) {
    assert.match(
      `${build.message}\n${boardLines}`,
      /apt-get install|hetai-package-matrix/u,
      '失败要给定向提示（装包或去 CI）',
    );
  }
  console.log('[c9] 上板前置检查 OK — 默认只构建 · 上板要确认 · 缺东西给定向提示');
  assertOneTab(await snapshot(), 'K 块会话结束');

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
