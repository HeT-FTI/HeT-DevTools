/**
 * **编译期成本**（V3 · L6e —— L6 领域专项最后一项）—— **纯函数**（不 import vscode）。
 *
 * 为什么只给"仅头文件"的库看这张卡：头文件库**没有符号表**（ABI 那套对它没意义），
 * 它真正的对外成本就是"**别人 include 你一下要花多久**"。这个数字一旦悄悄涨上去，
 * 每个下游的每次编译都要多等 —— 而没有任何一条 CI 会在意它。
 *
 * 怎么量（可复现、可比较）：
 *   · 编一个**只 include 你的公开头**的探针 TU，再编一个**空 TU**，两个各跑 N 次取中位；
 *   · 报的是**差值**（`include 你` 比 `什么都不 include` 多花的时间）—— 进程启动与
 *     标准库那一份固定开销被扣掉，剩下的才是**你的头**带来的成本；
 *   · 快照里连**编译器、标准、额外 include 目录**一起记：换编译器/换标准以后
 *     **不能直接跟旧基线比**（那种"对比"是假的 → 卡会直说"先重测"）。
 *
 * 量不出来就说量不出来：探针编不过（缺依赖头）、本机没有 C++ 编译器 → 如实报错 +
 * 给补 include 的地方，**绝不编一个数字**。
 */
import { baseName } from '../utils/paths';

/** 卡片三态 + 白（"还没量"）—— 与同族模块（ABI / 性能基线）同一套取值。 */
export type HeaderCostState = 'ok' | 'warn' | 'fail' | 'idle';

/** 一次实测（快照；落 workspaceState，不进用户工程）。 */
export interface HeaderCostRun {
  /** 采集时间（人话，如 `14:05`）。 */
  at?: string;
  /** 探针 include 的那个公开头（相对路径）—— 数字要能追溯到"量的是谁"。 */
  header: string;
  /** 编译器（可读串，含版本；比如 `g++ 13.3.0`）—— 换编译器就不能跟旧基线比。 */
  compiler: string;
  /** 编译标准（如 `c++17`）。 */
  std: string;
  /** 探针额外用到的 include 目录（用户显式配置的那些）。 */
  extraIncludes?: string[];
  /** 每个 TU 跑了几次（取中位）。 */
  runs: number;
  /** 空 TU 的中位耗时（ms）—— 进程启动 + 标准库的固定开销。 */
  emptyMs: number;
  /** 只 include 公开头的中位耗时（ms）。 */
  includeMs: number;
  /** **头条数字**：`includeMs - emptyMs`（ms）。 */
  deltaMs: number;
}

export interface HeaderCostInput {
  baseline?: HeaderCostRun;
  now?: HeaderCostRun;
  /** 阈值（%）：涨幅超过它才提醒（唯一来源 = 设置 `het.header.costPct`）。 */
  costPct: number;
}

export interface HeaderCostView {
  state: HeaderCostState;
  fact: string;
  next?: string;
}

/** `312ms` / `1.42s` —— 秒级才换单位（毫秒数在秒以下时更直观）。 */
export function msText(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

/**
 * 把一次测量的原始读数变成快照 —— **头条数字在这里算**（`includeMs - emptyMs`）。
 *
 * 为什么差值才是头条：进程启动 + 标准库那一份固定开销跟你的头**没关系**；
 * 报绝对值会把"编译一个空文件要 90ms"算成你的成本（小头文件上尤其离谱）。
 * 差为负（抖动）时按 0 算 —— 不编一个"负成本"。
 */
export function makeHeaderCostRun(input: {
  at?: string;
  header: string;
  compiler: string;
  std: string;
  extraIncludes?: string[];
  runs: number;
  emptyMs: number;
  includeMs: number;
}): HeaderCostRun {
  return {
    ...(input.at ? { at: input.at } : {}),
    header: input.header,
    compiler: input.compiler,
    std: input.std,
    ...(input.extraIncludes && input.extraIncludes.length > 0 ? { extraIncludes: input.extraIncludes } : {}),
    runs: input.runs,
    emptyMs: input.emptyMs,
    includeMs: input.includeMs,
    deltaMs: Math.max(0, input.includeMs - input.emptyMs),
  };
}

/**
 * 挑"用哪个公开头当探针"（**只从产物事实推**，不猜）：
 * `include/<name>.hpp` → `include/<name>.h` → 只有一个头文件时用它；其余情况如实说
 * "判不了"。
 *
 * 为什么不"取第一个"：头文件库的对外成本取决于**入口头**是哪一个 —— 随便挑一个量出来
 * 的数字对用户没有意义（却很容易被当成"官方数字"）。
 */
export function pickPublicHeader(
  files: readonly string[],
  name: string | undefined,
): { header?: string; issue?: string } {
  const headers = files.filter((p) => p.startsWith('include/') && /\.(h|hpp|hh|hxx)$/u.test(p)).sort();
  if (headers.length === 0) {
    return { issue: 'include/ 下没有头文件 —— 没有可量的公开头' };
  }
  for (const ext of ['hpp', 'h', 'hh', 'hxx']) {
    const hit = name ? `include/${name}.${ext}` : undefined;
    if (hit && headers.includes(hit)) {
      return { header: hit };
    }
  }
  if (headers.length === 1) {
    return { header: headers[0] };
  }
  return {
    issue: `include/ 下有 ${headers.length} 个候选（${headers.slice(0, 3).join('、')}…）—— 判不了哪个是入口头，先按 <模块名>.hpp / .h 命名`,
  };
}

/** 两套测量能否直接对比：编译器、标准、额外 include 目录都要一致（否则是假对比）。 */
export function comparable(a: HeaderCostRun, b: HeaderCostRun): boolean {
  return (
    a.compiler === b.compiler &&
    a.std === b.std &&
    (a.extraIncludes ?? []).join('|') === (b.extraIncludes ?? []).join('|')
  );
}

/** 涨幅（%）；基线为 0 时不给假数字（返回 undefined，文案侧如实说"没法算"）。 */
export function deltaPct(baselineMs: number, nowMs: number): number | undefined {
  if (!(baselineMs > 0)) {
    return undefined;
  }
  return ((nowMs - baselineMs) / baselineMs) * 100;
}

/**
 * 一行文案（四态 + "还没量"）：
 * · 没实测过 → 白（**不是**"成本为零"）；度量失败由动作侧如实报错，不在这里编；
 * · 量了、没基线 → 绿，但事实里写明"还没有基线"（不说"与谁比都行"）；
 * · 编译器/标准/额外 include 与基线不同 → 黄（**先重测再比**，不拿两套参数对比）；
 * · 涨幅超过阈值 → 黄（提醒；涨不涨是人的决定，所以不是红）。
 */
export function headerCostFact(input: HeaderCostInput): HeaderCostView {
  const { baseline, now, costPct } = input;
  if (!now) {
    return {
      state: 'idle',
      fact: '还没实测过（不等于"成本为零"）',
      next: '需要你执行：点「实测一次」量一个数（同时编一个空 TU 作对照，扣掉进程启动那一份）',
    };
  }
  const head = `include ${baseName(now.header)} 额外 ${msText(now.deltaMs)}（中位 ${now.runs} 次）`;
  if (!baseline) {
    return { state: 'ok', fact: `${head} · 还没有基线` };
  }
  if (!comparable(baseline, now)) {
    return {
      state: 'warn',
      fact: `${head} · 与基线不可比`,
      next: `需要你执行：基线是「${baseline.compiler} · ${baseline.std}」测的，现在这套不同 —— 重测一次再比（拿两套参数对比是假数字）`,
    };
  }
  const pct = deltaPct(baseline.deltaMs, now.deltaMs);
  if (pct === undefined) {
    return { state: 'ok', fact: `${head} · 基线太低，算不出百分比` };
  }
  const sign = pct >= 0 ? '+' : '';
  const pctText = `${sign}${pct.toFixed(0)}%`;
  if (pct >= costPct) {
    return {
      state: 'warn',
      fact: `${head} · 比基线 ${pctText}（超过 ${costPct}%）`,
      next: `需要你执行：看看 ${now.header} 最近改了什么（涨的是它的解析成本，下游每次编译都要多等）`,
    };
  }
  return { state: 'ok', fact: `${head} · 比基线 ${pctText}` };
}
