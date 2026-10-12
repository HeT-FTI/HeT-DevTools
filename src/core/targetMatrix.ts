/**
 * **交叉目标矩阵**（V3 · L6d / L6 领域专项第 4 项）—— **纯函数**（不 import vscode）。
 *
 * 要回答的问题：**"多目标真的全绿了吗"**。
 *
 * 为什么需要它：交叉编译一次只编一个目标（`het.crossBuild` 的目标来自
 * `.hetai/build-matrix.yml`），于是"发布时每个目标都验证过"这件事**从来没有人替你记**——
 * 编过 armv7、过了三天，armv8 是没编过还是编挂了，只有翻终端历史才知道。
 * 而 `metadata.workflow_triggers.cross_compile=true` 的工程，CI 里每个目标都要绿。
 *
 * 资料来源 = **构建账本**（`core/buildLedger.ts`）+ 目标矩阵（`core/buildMatrix.ts`），
 * 两条都是本地真事实，不联网、不猜。三条硬规矩：
 *
 * 1. **记的是"最近一次有结论的尝试"**（成功或失败）—— 用户取消的那次没有结论，
 *    不写账本（否则矩阵会把"取消"说成"红"）。
 * 2. **没有结论的旧记录 ≠ 绿**（早期账本只记"用过哪个目标"，没记成不成）→ 当成
 *    "没编过"要重编，而不是替它说绿。
 * 3. **红/缺都必须说清"哪个目标"**（矩阵的价值就在"点名"，不是一句"有问题"）。
 */
import type { BuildLedger } from './buildLedger';

/** 矩阵里的一个目标（来自 `.hetai/build-matrix.yml` 的启用项）。 */
export interface MatrixTarget {
  id: string;
  arch?: string;
  isDefault?: boolean;
}

/** 某个目标"最近一次有结论的尝试"。 */
export interface TargetRun {
  target: string;
  ok: boolean;
  at?: number;
  /** 相对时间（宿主格式化好；纯函数里不引入"现在"）。 */
  atText?: string;
  arch?: string;
}

/** 矩阵里的一格（给 Slot/面板用；卡片只读汇总）。 */
export interface MatrixCell {
  id: string;
  arch?: string;
  isDefault?: boolean;
  /** `undefined` = 没有结论（没编过 / 只有旧记录）。 */
  ok?: boolean;
  atText?: string;
}

export interface MatrixView {
  state: 'ok' | 'warn' | 'fail' | 'idle';
  fact: string;
  next?: string;
  cells: MatrixCell[];
}

/**
 * 账本 → 目标记录视图。
 *
 * `agoText` 由宿主给（纯函数不读表）；**只有带 `ok` 的记录才算"有结论"** ——
 * 早期账本（只记"用过哪个目标"）虽然有时间戳，但没人知道成不成，那样不能算绿。
 */
export function recordedRuns(ledger: BuildLedger, agoText?: (at: number) => string): Record<string, TargetRun> {
  const out: Record<string, TargetRun> = {};
  for (const rec of Object.values(ledger.byTarget ?? {})) {
    if (typeof rec?.ok !== 'boolean') {
      continue;
    }
    out[rec.target] = {
      target: rec.target,
      ok: rec.ok,
      ...(typeof rec.at === 'number' ? { at: rec.at } : {}),
      ...(typeof rec.at === 'number' && agoText ? { atText: agoText(rec.at) } : {}),
      ...(rec.arch ? { arch: rec.arch } : {}),
    };
  }
  return out;
}

/** 名字串：最多列 3 个（卡片一行读得完），多的写"等 N 个"。 */
function nameList(names: readonly string[], max = 3): string {
  if (names.length <= max) {
    return names.join('、');
  }
  return `${names.slice(0, max).join('、')} 等 ${names.length} 个`;
}

/**
 * 一次汇总（三态 + 一行文案）：
 * · 矩阵里没有启用的目标 → **黄**（交叉编译没有目标可选，配置没写完）；
 * · 有目标红 → **红**（点名 + 怎么重跑）；
 * · 有目标没编过（含"只有旧记录、没有结论"）→ **黄**；
 * · 全部有结论且都绿 → 绿（附上最近一次是哪天，让"绿得有多新"可见）。
 */
export function matrixView(
  targets: readonly MatrixTarget[],
  runs: Readonly<Record<string, TargetRun>>,
): MatrixView {
  if (targets.length === 0) {
    return {
      state: 'warn',
      fact: '矩阵里没有启用的目标',
      next: '需要你执行：在 .hetai/build-matrix.yml 里至少启用一个目标（否则交叉编译没有目标可选）',
      cells: [],
    };
  }
  const cells: MatrixCell[] = targets.map((t) => {
    const run = runs[t.id];
    return {
      id: t.id,
      ...(t.arch ? { arch: t.arch } : {}),
      ...(t.isDefault ? { isDefault: true } : {}),
      ...(run ? { ok: run.ok } : {}),
      ...(run?.atText ? { atText: run.atText } : {}),
    };
  });
  const red = targets.filter((t) => runs[t.id]?.ok === false).map((t) => t.id);
  const missing = targets.filter((t) => runs[t.id] === undefined).map((t) => t.id);
  const green = targets.length - red.length - missing.length;

  if (red.length > 0 || missing.length > 0) {
    const parts = [`${targets.length} 个目标`, `${green} 绿`];
    if (red.length > 0) {
      parts.push(`${red.length} 红（${nameList(red)}）`);
    }
    if (missing.length > 0) {
      parts.push(`${missing.length} 没编过（${nameList(missing)}）`);
    }
    const steps: string[] = [];
    if (red.length > 0) {
      steps.push(`重跑 ${nameList(red)}（⑧ 交付站「交叉编译」选目标；失败原因在输出里）`);
    }
    if (missing.length > 0) {
      steps.push(`把没编过的编一遍：${nameList(missing)}`);
    }
    return {
      state: red.length > 0 ? 'fail' : 'warn',
      fact: parts.join(' · '),
      next: `需要你执行：${steps.join('；')}`,
      cells,
    };
  }

  // 全绿：把"最近一次是哪天"写出来 —— 绿得有多新是判断"还能不能信"的一半信息。
  const newest = targets
    .map((t) => runs[t.id])
    .filter((r): r is TargetRun => r !== undefined && typeof r.at === 'number')
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))[0];
  const freshness = newest?.atText ? ` · 最近 ${newest.target}（${newest.atText}）` : '';
  return {
    state: 'ok',
    fact: `${targets.length}/${targets.length} 个目标绿${freshness}`,
    cells,
  };
}

/**
 * 交付前门禁条目（`required`：多目标工程的交付就是"每个目标都验证过"）。
 *
 * 只有**真有目标矩阵**的工程才有这条 —— 单目标桌面库不该看到"矩阵"这种说法。
 */
export function matrixGateItem(
  view: MatrixView,
  targetCount: number,
): { label: string; ok: boolean | undefined; detail?: string; required: boolean } {
  return {
    label: `交叉目标矩阵（${targetCount} 个目标都绿）`,
    // 绿灯 → 有结论（true）；红/缺 → 有结论（false）；没启用目标 → 无法判定
    ok: targetCount === 0 ? undefined : view.state === 'ok',
    detail: view.fact,
    required: true,
  };
}
