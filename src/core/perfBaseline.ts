/**
 * **性能基线与回归对比**（V3 计划 §7.1 · L6a / G7）—— 纯函数，**不 import vscode**。
 *
 * 痛点原文：**「性能回归」**（求解器/算法）—— 跑完 bench 只看到一串数字，
 * 没人记得上次是多少，于是"变慢了没有"永远答不上来。
 *
 * 事实来源（都是真的）**：
 * · 跑出来的结果 = `RESULT|case|value` 协议解析后的逐用例原始值（`core/benchmark.ts`）；
 * · 基线 = **用户自己钉住的那次结果**（不是我们编的"目标值"，也不是别人的机器）。
 *
 * 三条硬规矩：
 * 1. **没有基线就直说"基线未设"**，并给出怎么设 —— 绝不给一张空表（G7 的门禁原文）；
 * 2. 数字是**原始值**（MCU 上通常是 cycles、Linux 上≈us），所以只说"变大/变小"，
 *    **不说"更快/更慢"**（吞吐类用例变大反而是好事 —— 语义由人判）；
 * 3. 阈值只有一个来源：设置 `het.bench.regressPct`（默认 20），且**文案里写出来**，
 *    不藏一个魔法数字。
 */

/** 一次 bench 的逐用例结果（原始值）。 */
export interface BenchRun {
  /** 人话时间（`14:05` / `2026-09-17 14:05`）。 */
  at?: string;
  /** 目标（可选：板上目标 key / `linux`）。 */
  target?: string;
  /** 逐用例原始值（保序）。 */
  values: { name: string; value: number }[];
  /** 是否收到 `BENCHMARK_END`（协议完整）。 */
  complete?: boolean;
}

export interface BaselineCompare {
  /** 变了的用例（按变化幅度降序）。 */
  changed: { name: string; from: number; to: number; pct: number }[];
  /** 这次新增的用例（基线里没有 → 不算回归）。 */
  added: string[];
  /** 基线里有、这次没跑的用例（缺了要说，不能装作没事）。 */
  missing: string[];
  /** 超过阈值的那几条（`regressPct`）。 */
  beyond: string[];
}

/** 变化百分比（基线为 0 时不下结论，返回 undefined）。 */
function pctOf(from: number, to: number): number | undefined {
  if (from === 0) {
    return undefined;
  }
  return ((to - from) / Math.abs(from)) * 100;
}

/** 对比（纯函数）：**只认同名用例**；新增/缺失分开报，不混进"回归"。 */
export function compareToBaseline(
  baseline: readonly { name: string; value: number }[],
  run: readonly { name: string; value: number }[],
  regressPct: number,
): BaselineCompare {
  const base = new Map(baseline.map((c) => [c.name, c.value]));
  const now = new Map(run.map((c) => [c.name, c.value]));
  const changed: BaselineCompare['changed'] = [];
  const added: string[] = [];
  const missing: string[] = [];
  for (const [name, value] of now) {
    const from = base.get(name);
    if (from === undefined) {
      added.push(name);
      continue;
    }
    const pct = pctOf(from, value);
    if (pct === undefined) {
      continue; // 基线是 0：算不出百分比 → 不下结论（不计入"变了"）
    }
    if (Math.abs(pct) >= 0.05) {
      changed.push({ name, from, to: value, pct });
    }
  }
  for (const name of base.keys()) {
    if (!now.has(name)) {
      missing.push(name);
    }
  }
  changed.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
  const beyond = changed.filter((c) => Math.abs(c.pct) >= regressPct).map((c) => c.name);
  return { changed, added, missing, beyond };
}

/** 变化的方向词：**只说数值方向**（原始值语义由人判）。 */
function dirText(pct: number): string {
  return pct >= 0 ? `+${pct.toFixed(0)}%` : `${pct.toFixed(0)}%`;
}

export interface PerfFactInput {
  /** 钉住的基线（没钉 = undefined）。 */
  baseline?: BenchRun;
  /** 最近一次跑（没跑 = undefined）。 */
  run?: BenchRun;
  /** 阈值（来自设置 `het.bench.regressPct`）。 */
  regressPct: number;
}

export interface PerfFact {
  state: 'ok' | 'warn' | 'idle';
  fact: string;
  next?: string;
  compare?: BaselineCompare;
}

/**
 * 卡片那两行。三态泾渭分明（G7：**基线缺失必须显式说明**）：
 * 1. 没基线 → idle + "基线未设" + 怎么设（**不给空表**）；
 * 2. 有基线、还没跑 → idle + "基线 N 例 · 存于 X（还没跑过对比）"；
 * 3. 有对比 → ok/warn（超过设置的阈值才 warn），并点名变化最大的那条。
 */
export function perfFact(input: PerfFactInput): PerfFact {
  const runCases = input.run?.values.length ?? 0;
  if (!input.baseline || input.baseline.values.length === 0) {
    const tail = runCases > 0 ? `（最近一次跑了 ${runCases} 例）` : '';
    return {
      state: 'idle',
      fact: `基线未设${tail}`,
      next: '需要你执行：跑一次 bench（⑧ 交付站「上板验证」或粘贴串口输出解析）后点「存为基线」',
    };
  }
  const n = input.baseline.values.length;
  const at = input.baseline.at ? ` · 存于 ${input.baseline.at}` : '';
  if (!input.run || runCases === 0) {
    return {
      state: 'idle',
      fact: `基线 ${n} 例${at}（还没有新结果可比）`,
      next: '需要你执行：跑一次 bench 再回来对比',
    };
  }
  const compare = compareToBaseline(input.baseline.values, input.run.values, input.regressPct);
  const biggest = compare.changed[0];
  const bits: string[] = [`基线 ${n} 例`, `${compare.changed.length} 例变化`];
  if (biggest) {
    bits.push(`最大 ${biggest.name} ${dirText(biggest.pct)}`);
  }
  if (compare.added.length > 0) {
    bits.push(`新增 ${compare.added.length}`);
  }
  if (compare.missing.length > 0) {
    bits.push(`缺 ${compare.missing.length}`);
  }
  const head = bits.join(' · ');
  if (compare.beyond.length > 0) {
    return {
      state: 'warn',
      fact: `${head}（超过设置的 ${input.regressPct}%）`,
      next: `需要你执行：确认 ${compare.beyond.slice(0, 2).join('、')} 是否真的变慢（重跑一次排除噪声）；数字是**原始值**，变大不一定是坏事`,
      compare,
    };
  }
  return {
    state: 'ok',
    fact: `${head}（都在设置的 ${input.regressPct}% 内）`,
    ...(compare.changed.length > 0
      ? { next: `变化最大的 ${compare.changed[0].name} 从 ${compare.changed[0].from} 到 ${compare.changed[0].to}（原始值）` }
      : {}),
    compare,
  };
}
