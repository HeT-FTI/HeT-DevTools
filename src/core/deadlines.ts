/**
 * **有界超时的单一来源**（§3.5 阈值表 + G2 / G17）。
 *
 * 背景（实测反馈）：编译文档那次用了 `timeoutMs: 0`，脚本一挂住就是"转两小时不回来"，
 * 用户只能以为扩展死了。计划里把阈值收成一张表，并要求"超时要能回答下一步"。
 *
 * 三条规矩：
 *   1. **长动作一律不许 `timeoutMs: 0`**（`deadlines.test.ts` 扫产品代码强制，不再靠自觉）；
 *   2. 阈值只在这里定义，可用设置 `het.task.deadlines` 覆盖（不必改代码）；
 *   3. 超时**必须翻译成人话**（`withDeadline`）：中文主体 + 实际阈值 + 下一步，
 *      而不是把 `command timed out after 900000ms` 这种原文丢给用户。
 */
export type DeadlineKind =
  | 'build'
  | 'test'
  | 'docs'
  | 'quality'
  | 'envPrepare'
  | 'cross'
  | 'board'
  | 'cacheClean'
  | 'cacheCleanDanger'
  | 'switchTarget'
  | 'misc';

/** §3.5 定稿表（键名与设置项 `het.task.deadlines.<kind>` 一一对应）。 */
export const DEADLINES_MS: Readonly<Record<DeadlineKind, number>> = {
  build: 15 * 60_000,
  test: 15 * 60_000,
  docs: 30 * 60_000,
  quality: 15 * 60_000,
  envPrepare: 45 * 60_000,
  cross: 30 * 60_000,
  board: 30 * 60_000,
  cacheClean: 10 * 60_000,
  cacheCleanDanger: 30 * 60_000,
  switchTarget: 10 * 60_000,
  misc: 10 * 60_000,
};

export const DEADLINE_KINDS = Object.keys(DEADLINES_MS) as DeadlineKind[];
export const DEADLINE_SETTING = 'het.task.deadlines';

export type DeadlineOverrides = Readonly<Record<string, number | undefined>>;

/** 取阈值：设置覆盖 → 表。非法值（0 / 负数 / NaN）一律退回表里的默认，不许"关掉超时"。 */
export function deadlineFor(kind: DeadlineKind, overrides: DeadlineOverrides = {}): number {
  const raw = overrides[kind];
  const ms = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : DEADLINES_MS[kind];
  return Math.max(1_000, Math.round(ms));
}

export function deadlineLabel(ms: number): string {
  const minutes = ms / 60_000;
  return Number.isInteger(minutes) ? `${minutes} 分钟` : `${Math.round(ms / 1000)} 秒`;
}

/** `utils/exec` 的超时原文（英文 + 毫秒）判定。 */
export function isTimeoutError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /timed out after \d+ms/u.test(msg);
}

/** 超时错误的人话版本（含"下一步"，否则用户只知道"失败了"）。 */
export function timeoutError(
  subject: string,
  kind: DeadlineKind,
  overrides: DeadlineOverrides = {},
): Error {
  const ms = deadlineFor(kind, overrides);
  return new Error(
    `⏱ ${subject} 超过 ${deadlineLabel(ms)} 仍未结束，已中止（子进程已杀掉）。` +
      `首次运行要拉依赖/装工具链，偶发偏慢可重跑一次；仍超时就调大设置 ${DEADLINE_SETTING}.${kind}`,
  );
}

/**
 * 用表里的阈值跑一个长动作：`fn` 拿到 `timeoutMs` 直接传给 `exec`，
 * 超时被翻译成人话后重抛（其余错误原样上抛，不吞）。
 */
export async function withDeadline<T>(
  subject: string,
  kind: DeadlineKind,
  fn: (timeoutMs: number) => Promise<T>,
  overrides: DeadlineOverrides = {},
): Promise<T> {
  try {
    return await fn(deadlineFor(kind, overrides));
  } catch (err) {
    if (isTimeoutError(err)) {
      throw timeoutError(subject, kind, overrides);
    }
    throw err;
  }
}
