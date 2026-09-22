/**
 * 长耗时动作的统一语义（计划 §7 + V2 §3.2/§3.3 的落地）
 *
 * 一条规则：凡是可能 >1s 的动作，都必须同时具备 5 件事（缺一不算完成）：
 * 1. 触发处转圈 + 禁用（webview 侧）+ **同一动作进行中重复点击直接忽略**（本文
 *    件的注册表）
 * 2. 输出通道有字（开始行含真实命令、阶段行、结束行含耗时与结论）
 * 3. L1 忙点（host 通过 `notifyBusy` 告知 webview）
 * 4. 完成通知（成功静默刷新 + 轻提示；失败 toast + tail）
 * 5. 可复盘（通道保留最近一次；失败给"下一步"）
 *
 * **V2 B 块的改动**：内部不再是"一张 `Map<action, 开始时间>`"，而是 `core/tasks.ts`
 * 的 Task 状态机 —— 于是"在跑"这件事第一次有了 owner / deadline / 心跳 / 确定出口。
 * 公开 API 全部保持不变（`beginBusy/endBusy/isBusy/busyActions/busyEntries/currentStatus/
 * runWithBusy`），所以 15 个动作的调用点**一行不用改**就获得状态机。
 *
 * 本文件仍是**纯逻辑**（不 import vscode）：OutputChannel / 通知 / 时钟由 `BusyHost`
 * 注入，因此可以在无人值守环境里把超时/取消/恢复全跑一遍。
 */
import { BUSY_ACTIONS, OUTPUT_CHANNEL_NAME, channelDef, formatLogLine, nextStepHint, type LogDomain, type LogEntry, type LogLevel } from './outputChannels';
import { intentForBusy } from './intents';
import { outputLog } from './outputLog';
import { pickActiveStatus, type ActiveStatus } from './status';
import type { DeadlineKind, DeadlineOverrides } from './deadlines';
import { TaskStore, type Task, type TaskSnapshot } from './tasks';

/** single writer：整个扩展只有这一份 Task 仓库（UI 与功能模块只读）。 */
const store = new TaskStore();

/** 诊断与集成测试读同一份（`het.getTasks`）。 */
export function taskStore(): TaskStore {
  return store;
}

/**
 * 长动作 → §3.5 阈值类别（I 块后**从 Intent 表推导**：阈值只在 `deadlines.ts` 定稿，
 * 动作→类别的对应只在 `intents.ts` 登记一处）。
 *
 * `wslImport` 没有卡片/命令入口（它在环境准备流程里被调用）→ 单列，仍然显式登记。
 */
const EXTRA_DEADLINE_KINDS: Readonly<Record<string, DeadlineKind>> = {
  wslImport: 'envPrepare',
};

export function deadlineKindForAction(action: string): DeadlineKind {
  return intentForBusy(action)?.deadline ?? EXTRA_DEADLINE_KINDS[action] ?? 'misc';
}

export function deadlineKindsForActions(): Readonly<Record<string, DeadlineKind>> {
  const out: Record<string, DeadlineKind> = { ...EXTRA_DEADLINE_KINDS };
  for (const a of BUSY_ACTIONS) {
    out[a] = deadlineKindForAction(a);
  }
  return out;
}

/**
 * 执行上下文（给动作实现用）：
 *   · `signal` —— 用户取消或 reconcile 判超时时会被 abort，动作应转给子进程；
 *   · `heartbeat()` —— 保证"心跳不超 10s"（长动作里打点，否则会被判僵死）；
 *   · `progress()` —— 可写百分比，悬停/页内可用。
 */
export interface TaskRunContext {
  signal: AbortSignal | undefined;
  heartbeat(message?: string): void;
  progress(pct: number, message?: string): void;
}

/** 幂等注册表：同一动作进行中，后续调用一律**跳过**（不是排队）。 */
export function beginBusy(action: string, now: number = Date.now()): boolean {
  store.useClock(() => now);
  const decision = store.dispatch({
    action,
    label: action,
    owner: 'card',
    deadlineKind: deadlineKindForAction(action),
  });
  if (decision.kind !== 'accepted' || !decision.task) {
    return false;
  }
  store.start(decision.task.id);
  return true;
}

export function endBusy(action: string): boolean {
  const task = store.get(action);
  if (!task || (task.state !== 'running' && task.state !== 'queued')) {
    return false;
  }
  store.cancel(action, '已结束（外部调用）');
  return true;
}

export function isBusy(action: string): boolean {
  const task = store.get(action);
  return !!task && (task.state === 'running' || task.state === 'queued');
}

/** 正在跑的动作（按开始时间排序，供 L1 展示）。 */
export function busyActions(): string[] {
  return store
    .active()
    .map((t) => ({ action: t.id, at: t.startedAt ?? t.createdAt }))
    .sort((a, b) => a.at - b.at)
    .map((e) => e.action);
}

/** 正在跑的动作 + 开始时间（"仓库级状态"要从这里取，别自己各记一份）。 */
export function busyEntries(): Array<{ action: string; startedAt: number }> {
  return store.active().map((t) => ({ action: t.id, startedAt: t.startedAt ?? t.createdAt }));
}

/**
 * **当前仓库级状态**：吸顶右侧 / chip / 悬停卡都读这一份（`core/status.ts` 定义口吻）。
 * 空闲返回 null —— 调用方负责把"空闲"渲染成历史结果，而不是把它渲染成"正在跑"。
 */
export function currentStatus(): ActiveStatus | null {
  return pickActiveStatus(busyEntries());
}

/** 正在跑/排队的 Task（UI 只读）。 */
export function activeTasks(): Task[] {
  return store.active();
}

/** 打心跳（长动作里定期调；超过 10s 不打点会被 reconciler 判超时）。 */
export function heartbeatBusy(action: string, message?: string): void {
  store.heartbeat(action, undefined, message);
}

/** 用户取消：abort 信号 + 落 `cancelled`（不留半成品是执行层的责任）。 */
export function cancelBusy(action: string, reason?: string): boolean {
  try {
    store.cancel(action, reason);
    return true;
  } catch {
    return false;
  }
}

/** **对账**（§3.3 Reconciler）：把超 deadline / 心跳断了的任务收敛成 `timedOut`。 */
export function reconcileBusy(): Task[] {
  return store.reconcile();
}

/** 持久化快照（`globalStorage/tasks.json`）。 */
export function busySnapshot(): TaskSnapshot {
  return store.snapshot();
}

/**
 * 重启恢复：`running/queued` 一律记为 `cancelled` 并说明原因 ——
 * **绝不留一个"永久进行中"**（返回被收敛的任务，host 负责写日志/提示）。
 */
export function restoreBusy(snapshot: TaskSnapshot | undefined): Task[] {
  return store.restore(snapshot);
}

/** 测试用：清空注册表与状态机（生产代码不得调用）。 */
export function resetBusy(): void {
  store.reset();
  store.useClock(() => Date.now());
}

/** host 需要提供的最小能力（VS Code 适配层在 `features/busyHost.ts`）。 */
export interface BusyHost {
  /** 取（或建）输出通道；`terminal`/`chat` 类动作返回 null（它们不走 Output）。 */
  outputChannel(name: string): { appendLine(line: string): void; show?(): void } | null;
  /** 通知 webview 忙点开/关（`action` = undefined 表示全部结束）。 */
  notifyBusy(action: string, on: boolean): void;
  /** 完成提示（成功轻提示 / 失败警告），由 host 决定用哪种 UI。 */
  notifyDone(action: string, ok: boolean, message: string): void;
  /** 当前时间（注入便于单测）。 */
  now?(): number;
  /** 谁发起的这次执行（问责用）。缺省 = 'card'。 */
  owner?(): string;
  /** §3.5 阈值覆盖（宿主从设置 `het.task.deadlines` 读；缺省 = 只用表里的默认值）。 */
  deadlineOverrides?(): DeadlineOverrides;
}

export type BusyStatus = 'done' | 'skipped' | 'failed';

export interface BusyResult<T> {
  status: BusyStatus;
  /** status === 'done' 时的返回值。 */
  out?: T;
  /** status === 'failed' 时的错误（已写进输出通道）。 */
  error?: Error;
  /** 已耗时（ms）；skipped 为 0。 */
  durationMs: number;
  /** 给调用方的一句话（可直接进 toast / 卡片事实）。 */
  message: string;
}


/**
 * 跑一个长动作：转圈 → 输出 → 结论 → 恢复。
 *
 * **显示名不再由调用方传字串**（I 块）：它取自 Intent 表的领域术语名（§5.2 定稿）。
 * 以前 8 个调用点各写一个中文名，于是同一个动作在输出里叫"构建并测试"、在卡片上叫"全量测试" ——
 * 一个概念两个写法，而改一处忘了另一处没人会发现。
 *
 * `skipped` 表示"同一动作已在跑"（幂等；webview 侧也会禁用按钮，这里是最后一道保险）。
 */
export async function runWithBusy<T>(
  host: BusyHost,
  action: string,
  fn: (ctx: TaskRunContext) => Promise<T>,
  detail?: string,
): Promise<BusyResult<T>> {
  const def = channelDef(action);
  // 单一来源：Intent 名 → 通道 label → action id（三级兜底，绝不显示 undefined）
  const shown = intentForBusy(action)?.name || def?.label || action;
  store.useClock(host.now ?? (() => Date.now()));
  // 阈值覆盖（§3.5 的设置）必须同时作用于**执行层**（`withDeadline`）与**对账器**
  // （`deadlineMs`）—— 否则用户调大设置后，对账器仍按默认值把任务判超时。
  store.useDeadlineOverrides(host.deadlineOverrides ?? (() => ({})));
  const decision = store.dispatch({
    action,
    label: shown,
    owner: host.owner?.() ?? 'card',
    deadlineKind: deadlineKindForAction(action),
  });
  if (decision.kind === 'duplicate') {
    return { status: 'skipped', durationMs: 0, message: `正在执行：${shown}（已忽略重复点击）` };
  }
  if (decision.kind === 'rejected' || !decision.task) {
    // 拒绝也要**显式回执**（不静默丢弃：用户点了就得知道为什么没跑）
    const message = `${shown} 未启动：${decision.reason ?? '前置条件不满足'}`;
    host.notifyDone(action, false, message);
    return { status: 'skipped', durationMs: 0, message };
  }
  const taskId = decision.task.id;
  const now = host.now?.() ?? Date.now();
  // D 块：**只有一个通道**；域的区分在行首标签（`[build] ▶ …`）。
  // 要不要把输出面板拉到前台由 Intent 声明（`output.focus`）—— 策略数据化，不再硬编在适配层。
  const it = intentForBusy(action);
  const domain: LogDomain = (it?.output?.domain as LogDomain) ?? 'env';
  const channel = def ? host.outputChannel(OUTPUT_CHANNEL_NAME) : null;
  const line = (level: LogLevel, text: string, at = host.now?.() ?? Date.now()): void => {
    const entry: LogEntry = { at, domain, level, text };
    channel?.appendLine(formatLogLine(entry));
    outputLog.append(entry);
  };
  if (it?.output?.focus) {
    channel?.show?.();
  }
  line('step', `${shown}${detail ? ` — ${detail}` : ''}`, now);
  store.start(taskId);
  host.notifyBusy(action, true);

  const ctx: TaskRunContext = {
    signal: store.signalFor(taskId),
    heartbeat: (message?: string) => {
      try {
        store.heartbeat(taskId, undefined, message);
      } catch {
        /* 已经结束的任务再心跳：忽略（可能是刚被取消） */
      }
    },
    progress: (pct: number, message?: string) => {
      try {
        store.heartbeat(taskId, pct, message);
      } catch {
        /* 同上 */
      }
    },
  };

  try {
    const out = await fn(ctx);
    const end = host.now?.() ?? Date.now();
    const durationMs = Math.max(0, end - now);
    line('ok', `${shown}完成（${(durationMs / 1000).toFixed(1)}s）`, end);
    const message = `${shown}完成（${(durationMs / 1000).toFixed(1)}s）`;
    store.succeed(taskId, { message });
    host.notifyDone(action, true, message);
    return { status: 'done', out, durationMs, message };
  } catch (err) {
    const end = host.now?.() ?? Date.now();
    const durationMs = Math.max(0, end - now);
    const error = err instanceof Error ? err : new Error(String(err));
    // 取消/超时是**不同的出口**（语义不同，UI 也要分开显示）：这里不再重复落状态
    const state = store.get(taskId)?.state;
    const cancelled = state === 'cancelled' || state === 'timedOut';
    const word = state === 'timedOut' ? '超时' : state === 'cancelled' ? '已取消' : '失败';
    line(state === 'timedOut' ? 'timeout' : state === 'cancelled' ? 'cancel' : 'fail', `${shown}${word}（${(durationMs / 1000).toFixed(1)}s）：${error.message}`, end);
    if (!cancelled) {
      line('info', `下一步：${nextStepHint(action)}`, end);
    }
    const message = `${shown}${word}：${error.message}`;
    if (!cancelled) {
      store.fail(taskId, { message, errorTail: error.message, nextStep: nextStepHint(action) });
    }
    host.notifyDone(action, false, message);
    return { status: 'failed', error, durationMs, message };
  } finally {
    host.notifyBusy(action, false);
  }
}
