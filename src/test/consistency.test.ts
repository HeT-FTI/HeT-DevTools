/**
 * **三元组一致性门禁**（计划 §6-H / G14 / G15）。
 *
 * H 块要回答的问题是：*"任务 / 输出 / 前端"三面说的是不是同一件事*。真实宿主里由
 * `c9` 会话证；但"新增长动作会不会漏掉某个出口"这种问题必须在**每次 `npm test`**
 * 就被抓到，所以这里把它做成**穷举矩阵**：
 *
 *   `BUSY_ACTIONS`（17 个动作） × 四种出口（成功 / 失败 / 超时 / 取消）
 *
 * 每一格都断言同一组事实（缺一条就是"用户会看到自相矛盾的状态"）：
 *   1. **Task**：终态必须是这一格该有的那一个（超时 ≠ 失败 ≠ 取消，语义不许混）；
 *      `running` 期间必有 owner + deadline + 心跳（不变量 1）；
 *   2. **输出**：恰好 1 行 `▶ 开始` + 恰好 1 行终态（`✓`/`✗`/`⌛`/`⊘`），且每行都能被
 *      `parseLogLine` 解析（域标签是**参数**，不是手写文案）；失败才多一行"下一步"；
 *   3. **通道**：全程只碰 `HeT DevTools` 这一个通道名（D 块的收敛不许被新动作破）；
 *   4. **前端**：忙点开→关各一次（`notifyBusy`），完成提示恰好一次（`notifyDone`），
 *      且页内「输出」视图读的那份环形缓冲（`outputLog`）与通道里的行**逐字一致**。
 *
 * 为什么要穷举而不是"挑一个动作试试"：`runWithBusy` 的出口分支是按状态机的**实际
 * 状态**选词的（`store.get(id).state` → 超时/取消/失败三选一）。某个动作若走了别的
 * 路径（比如自己 catch 了错误、或没接 `ctx.signal`），症状就是"取消后仍显示失败"、
 * "转两小时" —— 只有逐格断言才拦得住。
 */
import * as assert from 'node:assert';
import {
  cancelBusy,
  reconcileBusy,
  resetBusy,
  runWithBusy,
  taskStore,
  type BusyHost,
} from '../core/busy';
import { intentForBusy } from '../core/intents';
import { DEADLINES_MS } from '../core/deadlines';
import { outputLog, resetLog } from '../core/outputLog';
import {
  BUSY_ACTIONS,
  OUTPUT_CHANNEL_NAME,
  parseLogLine,
  type LogEntry,
  type LogLevel,
} from '../core/outputChannels';
import { SLOT_VIEWS } from './integration/support/slotViews';
import { EXIT_STEPS } from './integration/support/sessionPlan';
import { SLOT_TITLES } from '../features/slots/titles';
import { deadlineKindForAction } from '../core/busy';

/** 有意不纳入会话的 Slot：理由必须写在这里，否则下一个人会以为是漏了。 */
const SLOTS_NOT_IN_SESSION: Readonly<Record<string, string>> = {
  testResults:
    '打开前必须先有测试结果（`het.showTestResults` 会先弹“尚无测试结果”而不开视图）——写进会话会得到一个“永远失败的假期望”',
};

/** 假 host：把"通道名 / 行 / 忙点 / 完成提示 / 时钟"全记在内存里（0 人工、可复现）。 */
interface FakeHost extends BusyHost {
  at: number;
  lines: string[];
  channelNames: string[];
  busy: string[];
  done: string[];
}

function fakeHost(start = 1_700_000_000_000): FakeHost {
  const lines: string[] = [];
  const channelNames: string[] = [];
  const busy: string[] = [];
  const done: string[] = [];
  const self: FakeHost = {
    at: start,
    lines,
    channelNames,
    busy,
    done,
    now: () => self.at,
    outputChannel: (name: string) => {
      channelNames.push(name);
      return { appendLine: (line: string) => lines.push(line) };
    },
    notifyBusy: (action: string, on: boolean) => {
      busy.push(`${on ? 'on' : 'off'}:${action}`);
    },
    notifyDone: (action: string, ok: boolean, message: string) => {
      done.push(`${ok ? 'ok' : 'fail'}:${action}:${message}`);
    },
  };
  return self;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitUntil(what: string, ok: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ok()) {
      return;
    }
    await sleep(2);
  }
  assert.fail(`等待「${what}」超时（${timeoutMs}ms）`);
}

const EXITS = ['ok', 'fail', 'timeout', 'cancel'] as const;
type Exit = (typeof EXITS)[number];

/** 出口 → Task 终态 / 终态行的级别 / 完成提示的 ok 标志。 */
const EXPECT: Readonly<Record<Exit, { state: string; level: LogLevel; ok: boolean }>> = {
  ok: { state: 'succeeded', level: 'ok', ok: true },
  fail: { state: 'failed', level: 'fail', ok: false },
  timeout: { state: 'timedOut', level: 'timeout', ok: false },
  cancel: { state: 'cancelled', level: 'cancel', ok: false },
};

/** running 期间抓一次快照（不变量 1 的证据）。 */
interface RunningFacts {
  owner: string;
  deadlineMs: number;
  heartbeatAt?: number;
}

async function drive(
  host: FakeHost,
  action: string,
  exit: Exit,
): Promise<RunningFacts | undefined> {
  let running: RunningFacts | undefined;
  const run = runWithBusy(host, action, async (ctx) => {
    if (exit === 'ok') {
      return 'ok';
    }
    if (exit === 'fail') {
      throw new Error('注入的失败');
    }
    // hang：**不心跳、不结束** —— 只等 abort（用户取消 / 对账器判超时）
    return await new Promise((_resolve, reject) => {
      ctx.signal?.addEventListener('abort', () => reject(new Error('注入体被中止')), { once: true });
    });
  });

  if (exit === 'timeout' || exit === 'cancel') {
    await waitUntil(`${action} 进入 running`, () => taskStore().get(action)?.state === 'running');
    const task = taskStore().get(action);
    assert.ok(task, `${action} 必须在仓库里`);
    running = { owner: task.owner, deadlineMs: task.deadlineMs, heartbeatAt: task.heartbeatAt };
    if (exit === 'timeout') {
      // 对账器的判据就是"超过 deadline"：把时钟推过去，让它自己收敛（不手动改状态）
      host.at += task.deadlineMs + 1;
      const changed = reconcileBusy();
      assert.ok(
        changed.some((t) => t.id === action),
        `${action} 超过 deadline 后，对账器必须把它收敛成超时（否则就是"转两小时"）`,
      );
    } else {
      assert.strictEqual(cancelBusy(action, '测试取消'), true, '取消必须被受理');
    }
  }
  await run;
  return running;
}

describe('§H：三元组一致性（Task × 输出 × 前端）—— 全动作 × 四出口', () => {
  for (const action of BUSY_ACTIONS) {
    for (const exit of EXITS) {
      it(`${action} × ${exit}：终态/输出对/唯一通道/忙点/环形缓冲 全部一致`, async () => {
        resetBusy();
        resetLog();
        const host = fakeHost();
        const running = await drive(host, action, exit);
        const expect = EXPECT[exit];
        const intent = intentForBusy(action);
        const domain = intent?.output?.domain ?? 'env';

        // ── 前端（1/3）：忙点开→关各一次；完成提示恰好一次且 ok 与出口一致 ──
        assert.deepStrictEqual(
          host.busy,
          [`on:${action}`, `off:${action}`],
          '忙点必须开一次关一次（多一次=闪烁，少一次=永久禁用）',
        );
        assert.strictEqual(host.done.length, 1, '完成提示恰好一次');
        assert.ok(host.done[0].startsWith(`${expect.ok ? 'ok' : 'fail'}:${action}:`), host.done[0]);

        // ── 输出（2/3）：恰好一对 开始/终态，且每行都带已知域标签 ──
        assert.deepStrictEqual(
          [...new Set(host.channelNames)],
          [OUTPUT_CHANNEL_NAME],
          'D 块之后只允许一个通道（新动作不许自开通道）',
        );
        const entries = host.lines.map((line) => {
          const parsed = parseLogLine(line);
          assert.ok(parsed, `输出行必须可解析（域是参数、不是手写文案）：${line}`);
          return parsed;
        });
        const steps = entries.filter((e) => e.level === 'step');
        const terminals = entries.filter((e) =>
          (['ok', 'fail', 'timeout', 'cancel'] as LogLevel[]).includes(e.level),
        );
        assert.strictEqual(steps.length, 1, `恰好 1 行开始（▶）：${JSON.stringify(host.lines)}`);
        assert.strictEqual(
          terminals.length,
          1,
          `恰好 1 行终态（✓/✗/⌛/⊘）：${JSON.stringify(host.lines)}`,
        );
        assert.strictEqual(terminals[0].level, expect.level, '终态行的级别必须与出口一致');
        assert.strictEqual(steps[0].domain, domain, '开始行的域来自 Intent 表');
        assert.strictEqual(terminals[0].domain, domain, '终态行与开始行同域（否则页内过滤会把一对拆开）');
        // 动作名同样来自 Intent 表（§5.2 定稿），不许调用方各写一个
        assert.ok(
          intent ? steps[0].text.includes(intent.name) : steps[0].text.length > 0,
          `开始行必须用 Intent 名（${intent?.name ?? '未登记'}）：${steps[0].text}`,
        );
        // "下一步"只属于**失败**（取消/超时是用户/环境造成的，不该再劝人排错）
        const nextSteps = entries.filter((e) => e.level === 'info');
        assert.strictEqual(
          nextSteps.length,
          exit === 'fail' ? 1 : 0,
          `${exit} 的"下一步"行数不对：${JSON.stringify(host.lines)}`,
        );

        // ── Task（3/3）：终态正确，且 running 期间不变量成立 ──
        const task = taskStore().get(action);
        assert.ok(task, `${action} 必须在 Task 仓库里（否则页内/悬停无从投影）`);
        assert.strictEqual(task.state, expect.state, `${action} × ${exit} 的终态`);
        if (running) {
          assert.ok(running.owner, 'running 必须有 owner（问责）');
          assert.ok(running.deadlineMs > 0, 'running 必须有 deadline（无界长动作是事故）');
          assert.ok(running.heartbeatAt !== undefined, 'running 必须有心跳（否则无法判断僵死）');
          assert.strictEqual(task.heartbeatAt, running.heartbeatAt, '心跳时间戳不许被终态抹掉');
        }

        // ── 环形缓冲 = 通道内容（页内「输出」视图读的就是它）──
        assert.deepStrictEqual(
          outputLog.all().map((e: LogEntry) => `[${e.domain}]${e.level}:${e.text}`),
          entries.map((e) => `[${e.domain}]${e.level}:${e.text}`),
          '通道与页内缓冲必须逐字一致（否则"面板里看到的"和"页内看到的"会不一样）',
        );
      });
    }
  }

  it('一个动作连跑四种出口：每轮各留一对行，不互相污染', async () => {
    resetBusy();
    resetLog();
    const host = fakeHost();
    for (const exit of EXITS) {
      await drive(host, 'build', exit);
      resetBusy(); // 下一轮从干净状态开始（同一动作的幂等键）
    }
    const entries = host.lines.map((l) => parseLogLine(l)).filter((e): e is LogEntry => !!e);
    assert.strictEqual(entries.filter((e) => e.level === 'step').length, EXITS.length);
    assert.deepStrictEqual(
      entries.filter((e) => e.level !== 'step' && e.level !== 'info').map((e) => e.level),
      ['ok', 'fail', 'timeout', 'cancel'],
      '四种出口各留下自己的终态行（顺序 = 跑的顺序）',
    );
  });
});

describe('§H：会话脚本的覆盖面（新页面/新动作不许绕过一致性会话）', () => {
  it('每个登记过的 Slot 都必须在会话脚本里被开过一次（除白名单带理由外）', () => {
    const covered = new Set(SLOT_VIEWS.map((v) => v.slot));
    const missing = Object.keys(SLOT_TITLES).filter(
      (id) => !covered.has(id) && !(id in SLOTS_NOT_IN_SESSION),
    );
    assert.deepStrictEqual(
      missing,
      [],
      `这些 Slot 没有被会话覆盖（新增视图时请加进 support/slotViews.ts，或写明为何不纳入）：${missing.join('、')}`,
    );
    // 白名单不许过期（Slot 删了，理由还挂着 = 下一个人会被误导）
    for (const id of Object.keys(SLOTS_NOT_IN_SESSION)) {
      assert.ok(id in SLOT_TITLES, `白名单里的 ${id} 已经不存在了（请删掉这条理由）`);
      assert.ok(!covered.has(id), `${id} 已经在会话里了，白名单该删`);
    }
    const commands = SLOT_VIEWS.map((v) => v.command);
    assert.strictEqual(new Set(commands).size, commands.length, '会话表里的命令不许重复（重复=有一格其实没跑）');
  });

  it('会话的四个出口互不相同、动作真实存在且不重复，超时那一格真的靠 deadline', () => {
    const expects = EXIT_STEPS.map((s) => s.expect);
    assert.deepStrictEqual(
      [...new Set(expects)].sort(),
      ['cancelled', 'failed', 'succeeded', 'timedOut'],
      '四种出口必须各覆盖一次（成功/失败/取消/超时）',
    );
    assert.strictEqual(
      new Set(EXIT_STEPS.map((s) => s.action)).size,
      EXIT_STEPS.length,
      '同一个动作不许在会话里出现两次（输出断言是"这个动作恰好一对行"，复用会把计数变成 2）',
    );
    for (const step of EXIT_STEPS) {
      assert.ok(
        (BUSY_ACTIONS as readonly string[]).includes(step.action),
        `${step.action} 必须是登记过的长动作（否则会话在跑一个不存在的东西）`,
      );
      assert.ok(intentForBusy(step.action), `${step.action} 必须有一条 Intent（动作名/域/阈值都从那里来）`);
      assert.ok(deadlineKindForAction(step.action).length > 0);
      if (step.mode === 'hang') {
        assert.notStrictEqual(step.settle, 'natural', '挂住的注入体必须有个东西把它收掉（取消或 deadline）');
      }
      // chip 的例外只能是"环境域"这一条（`chipBusyItem` 有意不认 env）——
      // 否则就是有人把某个域的动作从芯片上悄悄拿掉了
      if (!step.chip) {
        assert.strictEqual(
          intentForBusy(step.action)?.output?.domain,
          'env',
          `${step.action} 不抢芯片的唯一合法理由 = 它是环境域（秒级动作）`,
        );
      }
    }
    // 至少三格是 chip 可见的（否则"三档同源"只剩悬停/页内两档，chip 永远没人管）
    assert.ok(
      EXIT_STEPS.filter((s) => s.chip).length >= 3,
      '四个出口里至少三个要能真的驱动状态栏 chip（否则 chip 那一档等于没测）',
    );
    // 超时那一格必须是 docs（run-c9.mjs 通过设置把它的阈值压到 2 秒）——两边必须对得上
    const timeoutStep = EXIT_STEPS.find((s) => s.expect === 'timedOut');
    assert.strictEqual(timeoutStep?.action, 'docsBuild');
    assert.strictEqual(deadlineKindForAction('docsBuild'), 'docs');
  });
});

describe('§H：阈值覆盖（设置 het.task.deadlines）必须同时作用于执行层与对账器', () => {
  it('状态机的 deadlineMs 取设置覆盖值（不是只读表里的默认）', () => {
    resetBusy();
    taskStore().useDeadlineOverrides(() => ({ docs: 2_000 }));
    const decision = taskStore().dispatch({
      action: 'docsBuild',
      label: '编译文档',
      owner: 'test',
      deadlineKind: 'docs',
    });
    assert.ok(decision.task, '必须被受理');
    assert.strictEqual(decision.task.deadlineMs, 2_000, '调大/调小都要生效');
    assert.notStrictEqual(decision.task.deadlineMs, DEADLINES_MS.docs, '这一格必须与默认值不同（否则断言无效）');
    taskStore().reset();
  });

  it('非法覆盖值（0 / 负数 / NaN）一律退回表里的默认（不存在"关掉超时"）', () => {
    resetBusy();
    for (const bad of [0, -1, Number.NaN]) {
      taskStore().useDeadlineOverrides(() => ({ build: bad }));
      const d = taskStore().dispatch({ action: 'build', label: '编译打包', owner: 'test', deadlineKind: 'build' });
      assert.strictEqual(d.task?.deadlineMs, DEADLINES_MS.build, `${bad} 必须被忽略`);
      taskStore().reset();
    }
  });

  it('对账器按**覆盖后**的阈值判超时（B 块的坑：设置只喂了 exec 层）', async () => {
    resetBusy();
    resetLog();
    const host = fakeHost();
    // 把 docs 的阈值设成 1s（表里是 30 分钟）—— 若对账器仍读表，这条断言就永远不成立
    host.deadlineOverrides = () => ({ docs: 1_000 });
    const run = runWithBusy(host, 'docsBuild', async (ctx) =>
      new Promise((_resolve, reject) => {
        ctx.signal?.addEventListener('abort', () => reject(new Error('被中止')), { once: true });
      }),
    );
    await waitUntil('docsBuild 进入 running', () => taskStore().get('docsBuild')?.state === 'running');
    host.at += 1_001;
    const changed = reconcileBusy();
    assert.ok(changed.some((t) => t.id === 'docsBuild'), '1 秒阈值必须生效（不是 30 分钟）');
    await run;
    assert.strictEqual(taskStore().get('docsBuild')?.state, 'timedOut');
  });
});
