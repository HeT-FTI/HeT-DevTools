/**
 * **Task 状态机**（§3.2 / §3.3 的纯逻辑层，B 块承重墙）。
 *
 * 为什么要它：现状里"在跑"只有一张 `Map<action, startedAt>`（`core/busy.ts`），于是
 * 三件本该被机制保证的事全变成"靠自觉"：
 *   · 没有 **deadline** → 脚本挂住就"转两小时"（用户只能猜是死是活）；
 *   · 没有 **心跳** → 无从判断"还在干活"还是"已经僵住"；
 *   · 没有 **出口状态** → 取消/超时/失败/成功混在同一个"忙点开关"里，UI 只能显示
 *     "进行中"，永远回不到确定态（实测反馈："构建时 chip 飘红"）。
 *
 * 这里把 Task 的生命周期写成**一张可穷举的转换表**（`TRANSITIONS`）+ **六条不变量**，
 * 并保证任何"未知动作/非法转换"都是**显式失败**（记 reason，不静默丢弃 —— 那是"点了
 * 没反应"的根治）。
 *
 * 纯逻辑：不 import vscode，时间与副作用全部由调用方注入，因此可以在无人值守测试里
 * 把超时/取消/重启恢复全跑一遍（门禁 G4）。
 */
import { deadlineFor, type DeadlineKind, type DeadlineOverrides } from './deadlines';

export type TaskState =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'timedOut'
  | 'cancelled'
  | 'stale';

/** 出口状态：到了就不再动（`stale` 是"结果失效"，由事实变化触发）。 */
export const TERMINAL_STATES: readonly TaskState[] = [
  'succeeded',
  'failed',
  'timedOut',
  'cancelled',
  'stale',
];

/**
 * 允许的转换（穷举表；G4 会拿它当"预期值"逐条对账）。
 * `running → running` = 心跳/进度更新，所以它也是合法的一条。
 */
export const TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  queued: ['running', 'cancelled'],
  running: ['running', 'succeeded', 'failed', 'timedOut', 'cancelled'],
  succeeded: ['stale'],
  failed: ['stale'],
  timedOut: [],
  cancelled: [],
  stale: [],
};

/** 心跳超过这个间隔没打点，就认为"僵住"（§3.2 不变量 1 的阈值）。 */
export const HEARTBEAT_STALE_MS = 10_000;

/** 谁发起的这次执行（问责用：出问题要能说清是哪条入口点出来的）。 */
export type TaskOwner = 'card' | 'hover' | 'palette' | 'reconciler' | 'recovery' | string;

export interface TaskArtifact {
  label: string;
  path?: string;
  command?: string;
}

export interface Task {
  /** 幂等键：`<action>·<target>`（同目标重复点击 = 同一任务）。 */
  id: string;
  /** 动作 id（与 `core/outputChannels.ts` 的 busy action 同名）。 */
  action: string;
  label: string;
  state: TaskState;
  owner: TaskOwner;
  deadlineKind: DeadlineKind;
  deadlineMs: number;
  createdAt: number;
  startedAt?: number;
  updatedAt: number;
  heartbeatAt?: number;
  progress?: number;
  message?: string;
  errorTail?: string;
  nextStep?: string;
  artifacts?: TaskArtifact[];
}

export interface TaskSnapshot {
  version: 1;
  savedAt: number;
  tasks: Task[];
}

export type DispatchKind = 'accepted' | 'duplicate' | 'rejected';

export interface DispatchDecision {
  kind: DispatchKind;
  task?: Task;
  /** 拒绝原因（人话）。三种拒绝：并发上限 / 前置不满足 / 未知动作。 */
  reason?: string;
}

export interface DispatchInput {
  action: string;
  label: string;
  owner: TaskOwner;
  deadlineKind: DeadlineKind;
  /** 目标（幂等键的一部分）：同一个动作对不同对象应视为不同任务。 */
  target?: string;
  /** 前置条件检查的结果（不满足就显式拒绝，并给"一键修复"的动作名）。 */
  precondition?: { ok: boolean; reason?: string; fixCommand?: string };
  /** 并发上限：不同动作之间最多同时跑几个（§3.3：N=2，避免拥塞）。 */
  maxConcurrent?: number;
  idempotent?: boolean;
}

/** 非法/未知输入一律抛这个（调用方转成"显式拒绝 + 日志"，绝不静默）。 */
export class TaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskError';
  }
}

const DEFAULT_MAX_CONCURRENT = 2;

export function taskId(action: string, target?: string): string {
  return target ? `${action}·${target}` : action;
}

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(state: TaskState): boolean {
  return TERMINAL_STATES.includes(state);
}

/**
 * **Task 仓库**（single writer：只有它写 Task，UI 与功能模块只读）。
 *
 * 有意做成纯数据 + 纯函数：`now` 由调用方给，越界/非法转换直接抛，
 * 这样"状态机是不是真的按表走"可以用穷举测试证明。
 */
export class TaskStore {
  private readonly tasks = new Map<string, Task>();
  private readonly aborts = new Map<string, AbortController>();
  private nowFn: () => number;
  private readonly listeners = new Set<(task: Task) => void>();
  /**
   * 阈值覆盖的来源（H 块修的坑）：设置 `het.task.deadlines` 从 B 块起就写在
   * 文档与错误提示里（"仍超时就调大设置 …"），但**只有 exec 层读了它**，
   * 状态机的 `deadlineMs` 一直取表里的默认值 —— 于是用户调大设置后，
   * 对账器照样按默认值把任务收敛成 `timedOut` 并 abort 子进程。
   * 现在两条路径读**同一份**覆盖值。
   */
  private overridesFn: () => DeadlineOverrides = () => ({});

  constructor(now: () => number = () => Date.now()) {
    this.nowFn = now;
  }

  /** 换时间源（宿主注入 `host.now` / 单测用假时钟）。 */
  useClock(now: () => number): void {
    this.nowFn = now;
  }

  /** 换阈值覆盖来源（宿主注入设置读取；缺省 = 只用 `core/deadlines.ts` 的表）。 */
  useDeadlineOverrides(fn: () => DeadlineOverrides): void {
    this.overridesFn = fn;
  }

  /** 订阅状态变化（宿主用它持久化快照；返回退订函数）。 */
  onChange(fn: (task: Task) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(task: Task): void {
    for (const fn of this.listeners) {
      fn({ ...task });
    }
  }

  private now(): number {
    return this.nowFn();
  }

  list(): Task[] {
    return [...this.tasks.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  /** 正在跑（含排队）的任务。 */
  active(): Task[] {
    return this.list().filter((t) => t.state === 'running' || t.state === 'queued');
  }

  countRunning(): number {
    return this.list().filter((t) => t.state === 'running').length;
  }

  /** 取消信号：动作实现可以把它接到子进程上（`run` 的 `signal` 参数）。 */
  signalFor(id: string): AbortSignal | undefined {
    return this.aborts.get(id)?.signal;
  }

  /**
   * 登记一个任务（入队）。**不做重复合并之外的花活**：
   * 幂等键相同且仍在跑 → duplicate（UI 显示"已在执行"，不是错误）；否则排队。
   */
  dispatch(input: DispatchInput): DispatchDecision {
    if (!input.action) {
      throw new TaskError('dispatch 缺少 action（未知动作必须显式拒绝，不许静默）');
    }
    if (input.precondition && !input.precondition.ok) {
      return {
        kind: 'rejected',
        reason: `${input.label} 现在不能跑：${input.precondition.reason ?? '前置条件不满足'}${
          input.precondition.fixCommand ? `（可先执行 ${input.precondition.fixCommand}）` : ''
        }`,
      };
    }
    const id = taskId(input.action, input.target);
    const existing = this.tasks.get(id);
    if (existing && (existing.state === 'running' || existing.state === 'queued')) {
      return { kind: 'duplicate', task: existing, reason: `${existing.label} 正在执行` };
    }
    const maxConcurrent = input.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    if (this.countRunning() >= maxConcurrent) {
      return {
        kind: 'rejected',
        reason: `同时在跑的任务已到上限（${maxConcurrent}）—— 等其中一个结束再试`,
      };
    }
    const now = this.now();
    const deadlineMs = deadlineFor(input.deadlineKind, this.overridesFn());
    const task: Task = {
      id,
      action: input.action,
      label: input.label,
      state: 'queued',
      owner: input.owner,
      deadlineKind: input.deadlineKind,
      deadlineMs,
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(id, task);
    this.aborts.set(id, new AbortController());
    this.emit(task);
    return { kind: 'accepted', task: { ...task } };
  }

  /** `queued → running`（登记 deadline 计时起点 + 第一个心跳）。 */
  start(id: string): Task {
    return this.move(id, 'running', (task) => {
      const now = this.now();
      const started: Task = { ...task, startedAt: now, heartbeatAt: now };
      // 不变量 1：running 必须有 owner + deadline + 心跳 —— 缺一个就不许进入 running
      if (!started.owner) {
        throw new TaskError(`任务 ${id} 没有 owner，不许进入 running（出问题要能问责）`);
      }
      if (!(started.deadlineMs > 0)) {
        throw new TaskError(`任务 ${id} 没有 deadline，不许进入 running（无界长动作是事故）`);
      }
      return started;
    });
  }

  /** 心跳（含进度）：`running → running`。 */
  heartbeat(id: string, progress?: number, message?: string): Task {
    const task = this.require(id);
    if (task.state !== 'running') {
      throw new TaskError(`任务 ${id} 当前是 ${task.state}，不能打心跳`);
    }
    const now = this.now();
    const next: Task = { ...task, heartbeatAt: now, updatedAt: now };
    if (typeof progress === 'number') {
      next.progress = Math.max(0, Math.min(100, Math.round(progress)));
    }
    if (message !== undefined) {
      next.message = message;
    }
    this.tasks.set(id, next);
    return { ...next };
  }

  succeed(id: string, patch: { message?: string; artifacts?: TaskArtifact[] } = {}): Task {
    return this.move(id, 'succeeded', (task) => ({
      ...task,
      message: patch.message ?? task.message,
      artifacts: patch.artifacts ?? task.artifacts,
      progress: 100,
    }));
  }

  fail(id: string, patch: { message?: string; errorTail?: string; nextStep?: string } = {}): Task {
    return this.move(id, 'failed', (task) => ({
      ...task,
      message: patch.message ?? task.message,
      errorTail: patch.errorTail ?? task.errorTail,
      nextStep: patch.nextStep ?? task.nextStep,
    }));
  }

  /** 超时（由 reconciler 判定或执行层上报）：杀进程的责任在执行层，这里只落状态。 */
  timeout(id: string, message?: string): Task {
    return this.move(id, 'timedOut', (task) => ({ ...task, message: message ?? task.message }));
  }

  cancel(id: string, reason = '用户取消'): Task {
    const task = this.require(id);
    this.aborts.get(id)?.abort();
    if (isTerminal(task.state)) {
      // 已经结束的任务再取消：不改状态，避免把"失败"洗成"取消"
      return { ...task };
    }
    return this.move(id, 'cancelled', (t) => ({ ...t, message: reason }));
  }

  /** 事实变化 → 旧结果失效（`succeeded/failed → stale`）。 */
  markStale(id: string, reason: string): Task {
    return this.move(id, 'stale', (task) => ({ ...task, message: reason }));
  }

  /**
   * **对账**（§3.3 Reconciler）：把"超 deadline 还在跑"和"心跳断了"的任务收敛成
   * `timedOut` —— 这样 UI 永远不会显示一个"永久进行中"。
   */
  reconcile(): Task[] {
    const now = this.now();
    const changed: Task[] = [];
    for (const task of this.list()) {
      if (task.state !== 'running') {
        continue;
      }
      const started = task.startedAt ?? task.createdAt;
      const overdue = now - started > task.deadlineMs;
      const flat = now - (task.heartbeatAt ?? started) > HEARTBEAT_STALE_MS;
      if (overdue || flat) {
        const reason = overdue
          ? `超过 ${Math.round(task.deadlineMs / 60000)} 分钟仍未结束`
          : `心跳断了（超过 ${Math.round(HEARTBEAT_STALE_MS / 1000)} 秒没有进展）`;
        this.aborts.get(task.id)?.abort();
        changed.push(this.timeout(task.id, reason));
      }
    }
    return changed;
  }

  /**
   * **重启恢复**（§3.3 Recovery）：进程随宿主一起没了，所以快照里的 `running/queued`
   * 一律记为 `cancelled`（并写明原因）——**绝不留一个"永久进行中"**。
   */
  restore(snapshot: TaskSnapshot | undefined, reason = '扩展重启，未完成的任务已中止'): Task[] {
    this.tasks.clear();
    this.aborts.clear();
    if (!snapshot?.tasks?.length) {
      return [];
    }
    const recovered: Task[] = [];
    for (const task of snapshot.tasks) {
      if (task.state === 'running' || task.state === 'queued') {
        const now = this.now();
        const cancelled: Task = {
          ...task,
          state: 'cancelled',
          message: reason,
          updatedAt: now,
        };
        this.tasks.set(task.id, cancelled);
        recovered.push({ ...cancelled });
      } else {
        this.tasks.set(task.id, { ...task });
      }
    }
    return recovered;
  }

  /** 持久化快照（只留最近 50 条，避免无限增长）。 */
  snapshot(limit = 50): TaskSnapshot {
    const now = this.now();
    return {
      version: 1,
      savedAt: now,
      tasks: this.list().slice(0, limit).map((task) => ({ ...task })),
    };
  }

  /** 清空（测试用；生产不要调）。 */
  reset(): void {
    for (const controller of this.aborts.values()) {
      controller.abort();
    }
    this.tasks.clear();
    this.aborts.clear();
    this.overridesFn = () => ({});
  }

  private require(id: string): Task {
    const task = this.tasks.get(id);
    if (!task) {
      throw new TaskError(`未知任务 ${id}（不许静默忽略：这就是"点了没反应"的来源）`);
    }
    return task;
  }

  private move(id: string, to: TaskState, patch: (task: Task) => Task = (t) => t): Task {
    const task = this.require(id);
    if (!canTransition(task.state, to)) {
      throw new TaskError(`非法状态转换：${task.state} → ${to}（任务 ${id}）`);
    }
    const now = this.now();
    const next: Task = { ...patch(task), state: to, updatedAt: now };
    this.tasks.set(id, next);
    if (isTerminal(to)) {
      this.aborts.delete(id);
    }
    this.emit(next);
    return { ...next };
  }
}
