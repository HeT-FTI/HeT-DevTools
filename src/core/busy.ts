/**
 * 长耗时动作的统一语义（计划 §7，repo-level 硬规则）。
 *
 * 一条规则：凡是可能 >1s 的动作，都必须同时具备 5 件事（缺一不算完成）：
 * 1. 触发处转圈 + 禁用（webview 侧）+ **同一动作进行中重复点击直接忽略**（本文件的注册表）
 * 2. 输出通道有字（开始行含真实命令、阶段行、结束行含耗时与结论）
 * 3. L1 忙点（host 通过 `notifyBusy` 告知 webview）
 * 4. 完成通知（成功静默刷新 + 轻提示；失败 toast + tail）
 * 5. 可复盘（通道保留最近一次；失败给"下一步"）
 *
 * 本文件是**纯逻辑**（不 import vscode）：真正的 OutputChannel / 通知由 `BusyHost` 注入，
 * 因此可以在没有 VS Code 的环境里单测（无人值守测试的前提）。
 */
import { channelDef, nextStepHint } from './outputChannels';
import { pickActiveStatus, type ActiveStatus } from './status';

/** 幂等注册表：同一动作进行中，后续调用一律**跳过**（不是排队）。 */
const inflight = new Map<string, number>();

export function beginBusy(action: string, now: number = Date.now()): boolean {
  if (inflight.has(action)) {
    return false;
  }
  inflight.set(action, now);
  return true;
}

export function endBusy(action: string): boolean {
  return inflight.delete(action);
}

export function isBusy(action: string): boolean {
  return inflight.has(action);
}

/** 正在跑的动作（按开始时间排序，供 L1 展示）。 */
export function busyActions(): string[] {
  return [...inflight.entries()].sort((a, b) => a[1] - b[1]).map(([a]) => a);
}

/** 正在跑的动作 + 开始时间（"仓库级状态"要从这里取，别自己各记一份）。 */
export function busyEntries(): Array<{ action: string; startedAt: number }> {
  return [...inflight.entries()].map(([action, startedAt]) => ({ action, startedAt }));
}

/**
 * **当前仓库级状态**：吸顶右侧 / chip / HUD / 悬停卡都读这一份（`core/status.ts` 定义口吻）。
 * 空闲返回 null —— 调用方负责把"空闲"渲染成历史结果，而不是把它渲染成"正在跑"。
 */
export function currentStatus(): ActiveStatus | null {
  return pickActiveStatus(busyEntries());
}

/** 测试用：清空注册表（生产代码不得调用）。 */
export function resetBusy(): void {
  inflight.clear();
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

function ts(now: number): string {
  const d = new Date(now);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 跑一个长动作：转圈 → 输出 → 结论 → 恢复。
 *
 * `skipped` 表示"同一动作已在跑"（幂等；webview 侧也会禁用按钮，这里是最后一道保险）。
 */
export async function runWithBusy<T>(
  host: BusyHost,
  action: string,
  label: string,
  fn: () => Promise<T>,
  detail?: string,
): Promise<BusyResult<T>> {
  const def = channelDef(action);
  const shown = label || def?.label || action;
  if (!beginBusy(action)) {
    const msg = `正在执行：${shown}（已忽略重复点击）`;
    return { status: 'skipped', durationMs: 0, message: msg };
  }
  const now = host.now?.() ?? Date.now();
  const channel = def?.channel ? host.outputChannel(def.channel) : null;
  const line = (text: string): void => {
    channel?.appendLine(text);
  };
  channel?.show?.();
  line(`[${ts(now)}] ▶ ${shown}${detail ? ` — ${detail}` : ''}`);
  host.notifyBusy(action, true);
  try {
    const out = await fn();
    const end = host.now?.() ?? Date.now();
    const durationMs = Math.max(0, end - now);
    line(`[${ts(end)}] ✓ ${shown} 完成（${(durationMs / 1000).toFixed(1)}s）`);
    const message = `${shown}完成（${(durationMs / 1000).toFixed(1)}s）`;
    host.notifyDone(action, true, message);
    return { status: 'done', out, durationMs, message };
  } catch (err) {
    const end = host.now?.() ?? Date.now();
    const durationMs = Math.max(0, end - now);
    const error = err instanceof Error ? err : new Error(String(err));
    line(`[${ts(end)}] ✗ ${shown} 失败（${(durationMs / 1000).toFixed(1)}s）：${error.message}`);
    line(`        下一步：${nextStepHint(action)}`);
    const message = `${shown}失败：${error.message}`;
    host.notifyDone(action, false, message);
    return { status: 'failed', error, durationMs, message };
  } finally {
    endBusy(action);
    host.notifyBusy(action, false);
  }
}
