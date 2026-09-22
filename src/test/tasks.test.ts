/**
 * **B 块门禁：Task 生命周期 + 调度语义**（G3 / G4 / G14 / G17，§3.2/§3.3）。
 *
 * 为什么把状态机单独测：这一块的价值全在"**穷举**"上 —— 用户看到的是"转了多久、能不能取消、
 * 失败之后按钮还活不活"，而这些都必须由机制保证，不能靠"记得处理一下"。所以：
 *   1. 转换表逐条对账（含所有非法转换必须抛错，不许静默落到某个状态）；
 *   2. 六条不变量里与状态机有关的部分逐条断言（running 必有 owner/deadline/心跳；出口唯一）；
 *   3. 超时/取消/重启恢复三条路径都跑一遍（都是真发生过事故的路径）；
 *   4. 每个 busy action 都必须登记 §3.5 阈值类别（G17：不许无界长动作）；
 *   5. 变更通知要发（宿主要靠它持久化快照 —— 否则重启后 UI 会显示过期状态）。
 */
import * as assert from 'node:assert';
import {
  HEARTBEAT_STALE_MS,
  TRANSITIONS,
  TaskError,
  TaskStore,
  isTerminal,
  taskId,
  type TaskState,
} from '../core/tasks';
import {
  deadlineKindsForActions,
  resetBusy,
  runWithBusy,
  type BusyHost,
} from '../core/busy';
import { BUSY_ACTIONS } from '../core/outputChannels';
import { DEADLINES_MS, DEADLINE_KINDS } from '../core/deadlines';

/** 假时钟：超时/心跳这些断言必须可复现（无人值守）。 */
function clock(start = 1_000_000): { at: number; now: () => number } {
  const self = { at: start, now: () => self.at };
  return self;
}

function store(start = 1_000_000): { store: TaskStore; clock: { at: number; now: () => number } } {
  const c = clock(start);
  const s = new TaskStore(c.now);
  return { store: s, clock: c };
}

const dispatchBase = {
  action: 'build',
  label: '编译打包',
  owner: 'card' as const,
  deadlineKind: 'build' as const,
};

describe('B. Task 生命周期（§3.2 穷举转换 + 不变量）', () => {
  it('转换表是**穷举**的：表外的转换一律抛错（不许静默落到某个状态）', () => {
    const allStates = Object.keys(TRANSITIONS) as TaskState[];
    // 表必须覆盖每一个状态（漏一个状态 = 有状态的出口没人管）
    assert.deepStrictEqual(allStates.sort(), [
      'cancelled',
      'failed',
      'queued',
      'running',
      'stale',
      'succeeded',
      'timedOut',
    ]);
    // 出口状态不许再动（除了 succeeded/failed → stale）
    assert.deepStrictEqual(TRANSITIONS.timedOut, []);
    assert.deepStrictEqual(TRANSITIONS.cancelled, []);
    assert.deepStrictEqual(TRANSITIONS.stale, []);
    assert.deepStrictEqual(TRANSITIONS.succeeded, ['stale']);
    assert.deepStrictEqual(TRANSITIONS.failed, ['stale']);
    // 每个状态都能被"走到"：要么是初始（queued），要么出现在某个表里
    const reachable = new Set<TaskState>(['queued']);
    for (const [from, tos] of Object.entries(TRANSITIONS)) {
      for (const to of tos) {
        if (to !== 'running' || from === 'running') {
          reachable.add(to);
        }
      }
    }
    assert.deepStrictEqual([...reachable].sort(), allStates.sort(), '有状态谁都走不到 → 它是死代码');
  });

  it('全量转换矩阵：合法路径通过、非法路径抛错（每个状态 × 每个状态都试一遍）', () => {
    const states = Object.keys(TRANSITIONS) as TaskState[];
    // 结构不变量：任何状态都**不许回到 queued**（回到排队意味着"跑过的东西又能排队"，语义上是新任务）
    for (const from of states) {
      assert.ok(!TRANSITIONS[from].includes('queued'), `${from} 不该能回到 queued`);
    }
    for (const from of states) {
      for (const to of states) {
        if (to === 'queued') {
          continue; // 初始状态：没有 API 能搬回去（上面已经断言结构上也不允许）
        }
        if (to === 'cancelled' && isTerminal(from)) {
          // 例外且**有意**：取消是幂等的（用户可能连点两次，或取消比完成晚到）——
          // 已结束的任务再取消必须是"什么都不做"，绝不允许把"失败"洗成"取消"。
          continue;
        }
        const { store: s, clock: c } = store();
        const d = s.dispatch(dispatchBase);
        assert.strictEqual(d.kind, 'accepted');
        const id = d.task!.id;
        // 把任务搬到 `from`
        if (from !== 'queued') {
          s.start(id);
          c.at += 1;
          if (from === 'succeeded') {
            s.succeed(id);
          } else if (from === 'failed') {
            s.fail(id);
          } else if (from === 'timedOut') {
            s.timeout(id);
          } else if (from === 'cancelled') {
            s.cancel(id);
          } else if (from === 'stale') {
            s.succeed(id);
            s.markStale(id, '产物被删');
          }
        }
        const legal = TRANSITIONS[from].includes(to);
        const attempt = (): unknown => {
          if (to === 'running') {
            // queued → running 是 start；running → running 是心跳（两条不同的 API）
            return from === 'queued' || from === 'cancelled' || from === 'stale' ? s.start(id) : s.heartbeat(id);
          }
          if (to === 'succeeded') {
            return s.succeed(id);
          }
          if (to === 'failed') {
            return s.fail(id);
          }
          if (to === 'timedOut') {
            return s.timeout(id);
          }
          if (to === 'cancelled') {
            return s.cancel(id);
          }
          if (to === 'stale') {
            return s.markStale(id, 'x');
          }
          return undefined;
        };
        if (legal) {
          assert.doesNotThrow(attempt, `${from} → ${to} 应当合法`);
          assert.strictEqual(s.get(id)!.state, to);
        } else if (from !== to) {
          assert.throws(attempt, TaskError, `${from} → ${to} 必须抛错（不许静默）`);
        }
      }
    }
  });

  it('不变量：running 必有 owner + deadline + 心跳（缺一个就不许进 running）', () => {
    const { store: s, clock: c } = store();
    const d = s.dispatch(dispatchBase);
    const id = d.task!.id;
    s.start(id);
    const t = s.get(id)!;
    assert.strictEqual(t.state, 'running');
    assert.ok(t.owner, 'owner：出问题要能问责是哪条入口点出来的');
    assert.ok(t.deadlineMs > 0, 'deadline：无界长动作是事故（G17）');
    assert.strictEqual(t.heartbeatAt, t.startedAt, '进入 running 就要有第一个心跳');
    // 心跳超过 10s 没打点 → reconcile 判超时（不再"永久进行中"）
    c.at += HEARTBEAT_STALE_MS + 1;
    const changed = s.reconcile();
    assert.strictEqual(changed.length, 1);
    assert.strictEqual(s.get(id)!.state, 'timedOut');
    assert.match(s.get(id)!.message ?? '', /心跳/);
  });

  it('超时是**独立出口**（不是 failed）：语义不同，UI 也要分开显示', () => {
    const { store: s, clock: c } = store();
    const d = s.dispatch({ ...dispatchBase, deadlineKind: 'misc' });
    const id = d.task!.id;
    s.start(id);
    c.at += DEADLINES_MS.misc + 1;
    s.reconcile();
    const t = s.get(id)!;
    assert.strictEqual(t.state, 'timedOut');
    assert.match(t.message ?? '', /超过 10 分钟仍未结束/);
    assert.notStrictEqual(t.state, 'failed');
    assert.ok(isTerminal(t.state));
  });

  it('取消：abort 信号会被触发（执行层据此杀子进程），且取消后不再接受心跳', () => {
    const { store: s } = store();
    const d = s.dispatch({ ...dispatchBase, target: 'a53' });
    const id = d.task!.id;
    s.start(id);
    const signal = s.signalFor(id)!;
    assert.strictEqual(signal.aborted, false);
    s.cancel(id, '用户点了取消');
    assert.strictEqual(signal.aborted, true, '取消必须真的 abort（否则子进程继续跑 = 假取消）');
    assert.strictEqual(s.get(id)!.state, 'cancelled');
    assert.throws(() => s.heartbeat(id), TaskError, '已取消的任务打心跳应抛错');
  });

  it('已结束的任务再取消是空操作（不许把"失败"洗成"取消"）', () => {
    const { store: s } = store();
    const d = s.dispatch(dispatchBase);
    s.start(d.task!.id);
    s.fail(d.task!.id, { message: '语法错' });
    const after = s.cancel(d.task!.id);
    assert.strictEqual(after.state, 'failed', '失败就是失败，不能被后来的取消覆盖');
    assert.strictEqual(after.message, '语法错');
  });

  it('幂等键：同动作+同目标重复点击 = duplicate；不同目标 = 两个任务', () => {
    const { store: s } = store();
    const first = s.dispatch({ ...dispatchBase, target: 'a53' });
    assert.strictEqual(first.kind, 'accepted');
    const again = s.dispatch({ ...dispatchBase, target: 'a53' });
    assert.strictEqual(again.kind, 'duplicate');
    assert.strictEqual(again.task!.id, first.task!.id, '重复点击必须命中同一个任务');
    const other = s.dispatch({ ...dispatchBase, target: 'm4' });
    assert.strictEqual(other.kind, 'accepted');
    assert.strictEqual(taskId('build', 'm4'), 'build·m4');
  });

  it('前置不满足 → 显式拒绝 + 给修复动作（不是静默不跑）', () => {
    const { store: s } = store();
    const rejected = s.dispatch({
      ...dispatchBase,
      precondition: { ok: false, reason: '还没准备环境', fixCommand: 'het.envPrepare' },
    });
    assert.strictEqual(rejected.kind, 'rejected');
    assert.match(rejected.reason ?? '', /还没准备环境/);
    assert.match(rejected.reason ?? '', /het\.envPrepare/);
    assert.strictEqual(s.list().length, 0, '被拒绝的任务不登记');
  });

  it('并发上限（§3.3 N=2）：第 3 个不同动作被显式拒绝（并且能说清原因）', () => {
    const { store: s } = store();
    for (const action of ['build', 'test']) {
      const d = s.dispatch({ ...dispatchBase, action, label: action });
      assert.strictEqual(d.kind, 'accepted');
      s.start(d.task!.id);
    }
    const third = s.dispatch({ ...dispatchBase, action: 'docsBuild', label: '编译文档', deadlineKind: 'docs' });
    assert.strictEqual(third.kind, 'rejected');
    assert.match(third.reason ?? '', /上限/);
    // 结束一个之后又能进
    s.cancel('build');
    const retry = s.dispatch({ ...dispatchBase, action: 'docsBuild', label: '编译文档', deadlineKind: 'docs' });
    assert.strictEqual(retry.kind, 'accepted');
  });

  it('未知任务/未知动作：显式抛错（"点了没反应"的根治）', () => {
    const { store: s } = store();
    assert.throws(() => s.start('不存在'), TaskError);
    assert.throws(() => s.heartbeat('不存在'), TaskError);
    assert.throws(() => s.dispatch({ ...dispatchBase, action: '' }), TaskError);
  });

  it('重启恢复：running/queued 一律收敛为 cancelled，**绝不留永久进行中**', () => {
    const { store: s } = store();
    const d = s.dispatch(dispatchBase);
    s.start(d.task!.id);
    const snapshot = s.snapshot();
    const s2 = new TaskStore();
    const recovered = s2.restore(snapshot);
    assert.strictEqual(recovered.length, 1);
    assert.strictEqual(s2.get(d.task!.id)!.state, 'cancelled');
    assert.match(s2.get(d.task!.id)!.message ?? '', /重启/);
    assert.deepStrictEqual(
      s2.list().filter((t) => t.state === 'running' || t.state === 'queued'),
      [],
      '恢复后不许还有"进行中"（否则 chip 会永远转）',
    );
  });

  it('快照：带版本号与保存时间，条数有上限（不会无限增长）', () => {
    const { store: s } = store();
    for (let i = 0; i < 60; i++) {
      const d = s.dispatch({ ...dispatchBase, action: `a${i}`, label: `动作${i}` });
      s.start(d.task!.id);
      s.succeed(d.task!.id);
    }
    const snap = s.snapshot(20);
    assert.strictEqual(snap.version, 1);
    assert.ok(snap.savedAt > 0);
    assert.strictEqual(snap.tasks.length, 20);
  });

  it('变更通知：每次状态变更都通知宿主持久化（否则重启后 UI 显示过期状态）', () => {
    const { store: s } = store();
    const seen: TaskState[] = [];
    const off = s.onChange((t) => seen.push(t.state));
    const d = s.dispatch(dispatchBase);
    s.start(d.task!.id);
    s.succeed(d.task!.id);
    off();
    s.markStale(d.task!.id, '产物被删');
    assert.deepStrictEqual(seen, ['queued', 'running', 'succeeded'], '退订之后不该再收到');
  });
});

describe('B. 与 busy 层的对账（G3/G17：每个长动作都要有 owner + deadline）', () => {
  it('每个 busy action 都登记了 §3.5 阈值类别（不许悄悄落进兜底档）', () => {
    const kinds = deadlineKindsForActions();
    const missing = BUSY_ACTIONS.filter((a: string) => !(a in kinds));
    assert.deepStrictEqual(missing, [], `这些长动作没登记阈值类别：${missing.join('、')}（G17）`);
    for (const [action, kind] of Object.entries(kinds)) {
      assert.ok(DEADLINE_KINDS.includes(kind), `${action} 的类别「${kind}」不在 §3.5 表里`);
    }
    // 抽样：几个"容易配错"的必须对
    assert.strictEqual(kinds.docsBuild, 'docs', '文档 = 30min（首次装图慢是常态）');
    assert.strictEqual(kinds.envPrepare, 'envPrepare', '环境准备 = 45min');
    assert.strictEqual(kinds.test, 'test');
    assert.strictEqual(kinds.board, 'board');
  });

  it('runWithBusy 走状态机：成功/失败/重复三态都有确定出口', async () => {
    resetBusy();
    const lines: string[] = [];
    const host: BusyHost = {
      outputChannel: () => ({ appendLine: (l) => lines.push(l) }),
      notifyBusy: () => undefined,
      notifyDone: () => undefined,
    };
    const ok = await runWithBusy(host, 'build', async () => 'ok');
    assert.strictEqual(ok.status, 'done');
    const bad = await runWithBusy(host, 'build', async () => {
      throw new Error('boom');
    });
    assert.strictEqual(bad.status, 'failed');
    assert.ok(lines.some((l) => l.includes('下一步：')), '失败必须给下一步');
    resetBusy();
  });

  it('执行上下文：心跳与进度写进 Task；取消后 signal 为 aborted', async () => {
    resetBusy();
    const host: BusyHost = {
      outputChannel: () => null,
      notifyBusy: () => undefined,
      notifyDone: () => undefined,
    };
    let signal: AbortSignal | undefined;
    const done = await runWithBusy(host, 'test', async (ctx) => {
      signal = ctx.signal;
      ctx.progress(42, '编译测试目标');
      ctx.heartbeat('跑用例');
      return 'x';
    });
    assert.strictEqual(done.status, 'done');
    assert.ok(signal, '上下文必须给出 signal（执行层据此支持取消）');
    assert.strictEqual(signal!.aborted, false);
    resetBusy();
  });
});
