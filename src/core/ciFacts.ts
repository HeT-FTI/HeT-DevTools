/**
 * CI 卡片的事实与文案（计划 §20 块 2d）—— 纯函数，不 import vscode。
 *
 * 两层，对应两个不同的问题：
 * 1. **本地层（不联网，永远有）**：仓库里有多少个 workflow、由什么事件触发 —— 回答"CI 会跑吗"；
 * 2. **在线层（要在 CI 面板拉一次）**：最近一次运行的结果与分支 —— 回答"上次绿不绿"。
 *
 * 拿不到就不编：没有在线数据时**不许**显示"绿/红"，只显示本地层，并在 `next` 里说清怎么取。
 */

export type CiLastRun = 'ok' | 'fail' | 'running';

export interface CiRunLike {
  name?: string;
  branch?: string;
  status?: string;
  conclusion?: string;
  /** 原始 ISO 时间（`created_at`）。 */
  createdAt?: string;
  url?: string;
}

export interface CiInput {
  lastRun?: CiLastRun;
  branch?: string;
  /** 人话时间（`3 小时前`）；由调用方用公共的 ago 文案转，避免这里再造一套。 */
  atText?: string;
  /** 最近这次运行的 workflow 名。 */
  workflow?: string;
  url?: string;
  /** 本地 workflow 数量。 */
  workflows?: number;
  /** 本地触发事件（去重，已排序）。 */
  triggers?: readonly string[];
}

export interface CiFact {
  state: 'ok' | 'fail' | 'running' | 'idle';
  fact: string;
  next?: string;
}

/** `ciFactsFromRuns` 的返回：事实 + 原始时间戳（人话时间由调用方转，见 `CiInput.atText`）。 */
export interface CiRunFacts extends CiInput {
  /** 原始 ISO 时间（`created_at`）。 */
  createdAt?: string;
}

/** GitHub 的 status/conclusion → 我们的三态；认不出就返回 undefined（不猜）。 */
export function ciStateFromRun(status?: string, conclusion?: string): CiLastRun | undefined {
  const s = (status ?? '').toLowerCase();
  const c = (conclusion ?? '').toLowerCase();
  if (['in_progress', 'queued', 'requested', 'waiting', 'pending', 'queued_in_progress'].includes(s)) {
    return 'running';
  }
  if (s === 'completed' || s === '') {
    if (c === 'success') {
      return 'ok';
    }
    if (['skipped', 'neutral'].includes(c)) {
      return 'ok'; // 跳过/中性不算失败（真失败另有 conclusion）
    }
    if (['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale'].includes(c)) {
      return 'fail';
    }
  }
  return undefined;
}

/**
 * 取**最近一次**运行（面板的查询已按时间倒序）→ 事实字段。
 * 认不出状态时只给分支/时间，不给三态。
 */
export function ciFactsFromRuns(
  runs: readonly CiRunLike[],
  opts: { workflows?: number; triggers?: readonly string[] } = {},
): CiRunFacts {
  const first = runs.find((r) => r && (r.status || r.conclusion || r.createdAt));
  const base: CiRunFacts = {
    ...(opts.workflows !== undefined ? { workflows: opts.workflows } : {}),
    ...(opts.triggers && opts.triggers.length > 0 ? { triggers: [...opts.triggers] } : {}),
  };
  if (!first) {
    return base;
  }
  const st = ciStateFromRun(first.status, first.conclusion);
  return {
    ...base,
    ...(st ? { lastRun: st } : {}),
    ...(first.branch ? { branch: first.branch } : {}),
    ...(first.createdAt ? { createdAt: first.createdAt } : {}),
    ...(first.name ? { workflow: first.name } : {}),
    ...(first.url ? { url: first.url } : {}),
  };
}

const ICON: Record<CiLastRun, string> = { ok: '✓', fail: '✗', running: '⟳' };

/**
 * 组装 L2 一行 + "下一步"。
 *
 * 文案优先级：在线三态（`上次 ✓ main · 3 小时前`）> 本地层（`3 个 workflow · push/pull_request`）。
 */
export function ciFactOf(input: CiInput): CiFact {
  const branches = input.branch ? ` ${input.branch}` : '';
  if (input.lastRun) {
    const icon = ICON[input.lastRun];
    const when = input.atText ? ` · ${input.atText}` : '';
    const fact = `上次 ${icon}${branches}${when}`;
    if (input.lastRun === 'fail') {
      return {
        state: 'fail',
        fact,
        next: input.url ? `需要你执行：打开 ${input.url} 看失败日志` : '需要你执行：在 CI 面板里打开失败那次运行',
      };
    }
    if (input.lastRun === 'running') {
      return { state: 'running', fact, next: `${input.workflow ?? 'CI'} 正在跑 —— 结果出来前不必重复触发` };
    }
    return { state: 'ok', fact };
  }
  const bits: string[] = [];
  if (typeof input.workflows === 'number') {
    bits.push(`${input.workflows} 个 workflow`);
  }
  if (input.triggers && input.triggers.length > 0) {
    bits.push(input.triggers.slice(0, 2).join('/'));
  }
  if (bits.length === 0) {
    return { state: 'idle', fact: '—' };
  }
  return {
    state: 'idle',
    fact: bits.join(' · '),
    next: '未取最新运行结果（点「打开 CI」拉一次，之后卡片会显示上次的绿/红）',
  };
}
