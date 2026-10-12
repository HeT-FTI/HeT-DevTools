/**
 * **ABI / 导出符号**（V3 计划 §7.1 · L6b / G8）—— 纯函数，**不 import vscode**。
 *
 * 痛点原文：**「ABI/符号破坏（GUI/shared）」** —— 共享库的对外承诺是**符号表**：
 * 函数改个名、参数换个类型（C++ 里名字修饰就变了）、把一个符号删掉，
 * **已经编译好的下游**会在运行时炸（或者直接链不上）。而这些在源码 diff 里看起来
 * "只是改了个名"。
 *
 * 事实来源（真的、可复现）：
 * · 产物 = `conan list <ref>:*` → `conan cache path <ref>:<uid>` 拿到的包目录里的
 *   `lib/*.so*` 或 `lib/*.a`（与**交叉编译的架构报告同一条推导**，不猜路径）；
 * · 符号 = `nm -D --defined-only`（共享库）/ `nm --defined-only`（静态库）的**已定义全局符号**；
 * · 基线 = **用户自己钉住的那一次**（不是我们编的目标表）。
 *
 * 三条硬规矩：
 * 1. **C++ 名字修饰直接用**：`_Z3foov` → `_Z3barv` 就是"移除 + 新增" —— 这正是 ABI 破坏
 *    的真实形态（改名 = 破坏性），不去 demangle 之后"看起来一样"。
 * 2. **移除 = 红**（破坏性）；**新增 = 绿**（不影响已编译的下游）。
 * 3. 扫不到符号（产物没找到 / nm 不可用）**如实说**，不许给个"0 个符号 = 一致"。
 */

/** 一个已定义符号。 */
export interface AbiSymbol {
  /** 名字（C++ 是修饰后的名字 —— 比对就用它）。 */
  name: string;
  /** nm 的类型字母（`T` 代码 / `D` 数据 / `B` bss / `W` 弱符号…）。 */
  kind: string;
}

export interface AbiSnapshot {
  /** 人话时间。 */
  at?: string;
  /** 产物相对路径（面板/日志里给人看的）。 */
  artifact?: string;
  symbols: AbiSymbol[];
}

/**
 * 解析 `nm` 的输出（sysv 格式：`<地址> <类型> <名字>`；静态库还夹着 `x.o:` 段头）。
 *
 * 只留**已定义的全局符号**：小写类型（`t/d/b`）是局部符号，不构成 ABI；
 * `U` 是"未定义（引用外部）"，也不是我们导出的东西。
 */
export function parseNmOutput(stdout: string): AbiSymbol[] {
  const out: AbiSymbol[] = [];
  const seen = new Set<string>();
  for (const raw of stdout.split(/\r?\n/u)) {
    const line = raw.trimEnd();
    if (line === '' || /:$/u.test(line.trim())) {
      continue; // 段头（`foo.o:`）或空行
    }
    const m = /^\s*(?:[0-9a-fA-F]+)?\s*([A-Za-z])\s+(\S+)$/u.exec(line);
    if (!m) {
      continue;
    }
    const kind = m[1];
    const name = m[2];
    if (kind !== kind.toUpperCase() || kind === 'U') {
      continue; // 局部符号 / 未定义
    }
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    out.push({ name, kind });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export interface AbiCompare {
  /** 基线里有、现在没有 —— **破坏性**（改名也会落在这里）。 */
  removed: string[];
  /** 现在有、基线里没有 —— 不影响已编译的下游。 */
  added: string[];
  /** 两边都有的个数。 */
  same: number;
}

/** 对比（纯函数，保序：按名字排序后输出，便于逐版对比）。 */
export function compareSymbols(
  baseline: readonly AbiSymbol[],
  now: readonly AbiSymbol[],
): AbiCompare {
  const base = new Set(baseline.map((s) => s.name));
  const cur = new Set(now.map((s) => s.name));
  const removed = [...base].filter((n) => !cur.has(n)).sort();
  const added = [...cur].filter((n) => !base.has(n)).sort();
  return { removed, added, same: [...cur].filter((n) => base.has(n)).length };
}

export interface AbiFactInput {
  baseline?: AbiSnapshot;
  /** 最近一次扫描（`undefined` = 还没扫过）。 */
  now?: AbiSnapshot;
}

export interface AbiFact {
  state: 'ok' | 'fail' | 'idle';
  fact: string;
  next?: string;
  compare?: AbiCompare;
}

/**
 * 卡片那两行。四种情形都要说人话（**扫不到也要说清**）：
 * 1. 没基线 → idle + "符号基线未设" + 怎么设；
 * 2. 有基线、没扫过 → idle + "还没扫过当前产物"；
 * 3. 扫过但**一个符号都没有** → idle + "扫描没取到符号"（没找到产物 / nm 不可用）——
 *    **不许**说成"与基线一致"；
 * 4. 有对比 → **移除 → fail**（破坏性）/ 只有新增或完全一致 → ok。
 */
export function abiFact(input: AbiFactInput): AbiFact {
  if (!input.baseline || input.baseline.symbols.length === 0) {
    return {
      state: 'idle',
      fact: '符号基线未设',
      next: '需要你执行：先「扫描当前产物」，确认无误后「存为基线」（共享库比的是动态符号表）',
    };
  }
  const n = input.baseline.symbols.length;
  const at = input.baseline.at ? ` · 存于 ${input.baseline.at}` : '';
  if (!input.now) {
    return {
      state: 'idle',
      fact: `基线 ${n} 个符号${at}（还没扫过当前产物）`,
      next: '需要你执行：点「扫描当前产物」再回来对比',
    };
  }
  if (input.now.symbols.length === 0) {
    return {
      state: 'idle',
      fact: `扫描没取到符号（基线 ${n} 个还留着）`,
      next: '需要你执行：确认包目录里有 lib/*.so（或 *.a）且本机有 nm（binutils）—— 报告不写假的',
    };
  }
  const compare = compareSymbols(input.baseline.symbols, input.now.symbols);
  const total = input.now.symbols.length;
  if (compare.removed.length > 0) {
    const head = compare.removed.slice(0, 2).join('、');
    return {
      state: 'fail',
      fact: `符号 ${total} 个 · 移除 ${compare.removed.length}（${head}）${compare.added.length > 0 ? ` · 新增 ${compare.added.length}` : ''}`,
      next: `需要你执行：确认这是有意移除（**改名会同时产生"移除 + 新增"，已编译好的下游会链不上**）；确认后就重新存一次基线`,
      compare,
    };
  }
  return {
    state: 'ok',
    fact:
      compare.added.length > 0
        ? `符号 ${total} 个 · 与基线不冲突（新增 ${compare.added.length} 个，已编译的下游不受影响）`
        : `符号 ${total} 个 · 与基线完全一致`,
    ...(compare.added.length > 0 ? { next: `新增：${compare.added.slice(0, 3).join('、')}（确认后重新存基线即可收口）` } : {}),
    compare,
  };
}
