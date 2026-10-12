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
import { bindLiveness, unbindLiveness } from '../utils/liveness';
import { DeadlineExceededError, type DeadlineKind, type DeadlineOverrides } from './deadlines';
import { TaskStore, STATE_TEXT, exitWord, type Task, type TaskArtifact, type TaskSnapshot } from './tasks';

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
  /**
   * 登记一个产物（任务中心里可点）。
   *
   * 为什么由执行体登记、而不是"任务中心自己去猜目录"：产物在哪是**动作自己**最清楚的
   * 事（doxygen 的入口页是 `docs/doxygen/build/docs.html`，sphinx 是 `index.html`）——
   * 面板再猜一遍就是第二个真相，而且猜错时用户看到的是一个打不开的链接。
   */
  artifact(label: string, opts?: { path?: string; command?: string; arg?: string }): void;
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

/**
 * **动作自己已经给过结论**时抛它（例如弹了一个带按钮的对话框）。
 *
 * 为什么需要这个出口（2026-10-12 真机走查）：`runWithBusy` 是动作结论的**唯一出口**
 * （一行输出 + 一条通知），但有些失败必须**带交互** —— "改用本机工具链（兼容模式）/
 * 导出环境诊断" 那个对话框本身就是用户看到的结果。于是只剩两条路：
 *   · 抛普通 Error → 同一个结果弹两次（两条通知都在说失败，用户不知道看哪条）；
 *   · 不抛 → 任务停在 `✓ …完成`，而实际什么都没干成（走查里的问题 ②）。
 * 所以给第三条：状态照落 `failed`（chip/卡片/任务中心必须一致），通知**不补**。
 */
export class ReportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportedError';
  }
}

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

  /** 执行体登记的产物（成功时才落到 Task 上） */
  const artifacts: TaskArtifact[] = [];
  const beat = (): void => {
    try {
      store.heartbeat(taskId);
    } catch {
      /* 已经结束的任务再心跳：忽略（可能是刚被取消） */
    }
  };
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
    artifact: (label: string, opts?: { path?: string; command?: string; arg?: string }) => {
      // 重复登记同名产物 = 覆盖（动作里多次打点不该看成两件东西）
      const at = artifacts.findIndex((a) => a.label === label);
      const next = { label, ...opts };
      if (at >= 0) {
        artifacts[at] = next;
      } else {
        artifacts.push(next);
      }
    },
  };
  // 把"报活"绑到这个动作的取消信号上（`utils/liveness.ts`）：执行体起的**子进程**只要还活着
  // 就自动打点 —— 于是"静默几十秒的构建被判僵死"从机制上不再可能，而不是靠每个调用点记得传回调。
  bindLiveness(ctx.signal, beat);

  try {
    const out = await fn(ctx);
    const end = host.now?.() ?? Date.now();
    const durationMs = Math.max(0, end - now);
    const dur = `${(durationMs / 1000).toFixed(1)}s`;
    // 用户取消**在先**、动作**随后**才结束：终态保持「已取消」（用户意图不许被动作的返回改写），
    // 但要如实记一行 —— "它其实跑完了"是事实，复盘时看得见（而不是静默丢失）。
    if (store.get(taskId)?.state === 'cancelled') {
      const cancelledMsg = `${shown}已取消（动作随后结束，结果不采纳）`;
      line('info', `${cancelledMsg}（${dur}）`, end);
      host.notifyDone(action, false, cancelledMsg);
      return { status: 'done', out, durationMs, message: cancelledMsg };
    }
    // 对账器是**启发式**（心跳断了/超阈值），动作的返回才是**事实**：两者冲突时让事实落地。
    // 没有这一段，`succeed()` 会撞上"非法状态转换"抛错 → 变成一条假的"失败"，界面结论与实际相反。
    const lateCorrection = store.get(taskId)?.state === 'timedOut';
    line('ok', `${shown}完成（${dur}）`, end);
    if (lateCorrection) {
      line('info', `${shown}：对账器曾判超时，但动作随后正常结束 —— 以这次真实结论为准`, end);
    }
    const message = `${shown}完成（${dur}）`;
    store.succeed(taskId, { message, artifacts: artifacts.length ? artifacts : undefined });
    host.notifyDone(action, true, message);
    return { status: 'done', out, durationMs, message };
  } catch (err) {
    const end = host.now?.() ?? Date.now();
    const durationMs = Math.max(0, end - now);
    const error = err instanceof Error ? err : new Error(String(err));
    // 注意：此刻 state **往往还是 running**（落终态发生在写日志之后）—— 所以下面走 `exitWord`。
    const state = store.get(taskId)?.state;
    // **真超时**（exec 层按 §3.5 的阈值杀掉子进程）是 `timedOut` 这个**独立出口**，不是"失败"：
    // 状态、图标（⌛ vs ✗）、结论行、任务中心都必须说同一件事。
    // 以前这条路径落的是 `failed`，而结论行里写着"超时" —— 同一件事两种说法
    // （2026-10-12 真机走查问题 ① 的同类：用户不知道信哪一条）。
    const deadlineHit = error instanceof DeadlineExceededError && state === 'running';
    const word = deadlineHit ? STATE_TEXT.timedOut : exitWord(state);
    const level: LogLevel =
      deadlineHit || state === 'timedOut' ? 'timeout' : state === 'cancelled' ? 'cancel' : 'fail';
    const message = `${shown}${word}（${(durationMs / 1000).toFixed(1)}s）：${error.message}`;
    line(level, message, end);
    if (deadlineHit) {
      store.timeout(taskId, message);
    } else if (state === 'running') {
      store.fail(taskId, { message, errorTail: error.message, nextStep: nextStepHint(action) });
    }
    // 对账器（超时）/ 用户（取消）已经落过终态时只如实记一行，不改写 —— 但"下一步"仍然要给。
    if (deadlineHit || state === 'running') {
      line('info', `下一步：${nextStepHint(action)}`, end);
    }
    // 结论只许有一条：动作自己已经给过结论（`ReportedError`）时不再补通知，免得同一个结果弹两次。
    if (!(error instanceof ReportedError)) {
      host.notifyDone(action, false, message);
    }
    return { status: 'failed', error, durationMs, message };
  } finally {
    // 动作结束就撤掉报活（子进程即使还在收尾也不该再给这个任务续命）
    unbindLiveness(ctx.signal);
    host.notifyBusy(action, false);
  }
}
