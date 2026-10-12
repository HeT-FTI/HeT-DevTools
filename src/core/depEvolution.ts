/**
 * **依赖演进**（V3 计划 §7.1 · L5b / G6）—— 纯函数，**不 import vscode**。
 *
 * 痛点原文：**「依赖演进」** —— 一个库跑上一年，真正会变的不是代码而是依赖：
 * 上游发了新版、新加的依赖在 CI 里没有系统头、conandata 与 metadata 两份清单各走各的。
 * 这三件事里，前两件机器都判得了，而它们都有**真实后果**：
 *
 * · **系统头缺口**：模板的 `security-linters.yml` 自己写着
 *   `# system packages derive from conandata.yml; extend the mapping for new deps whose headers land in src/`
 *   —— 也就是说"你在 src 里 include 了某个依赖的头、但 CI 的 apt 映射里没有它" = CI 的
 *   clang-tidy 必然找不到头文件。这条**不是猜的**，是 workflow 自己的约定。
 * · **上游最新**：只能靠一次真实的网络查询（`conan search <pkg> -r conancenter`）。
 *   所以这里只负责**解析与比较**，且规矩是"**没真取到就不显示**"（不编造版本号）。
 *
 * 两份清单一致性的判据**不在这里**：那属于依赖管理器/工程审计（一处写就行），
 * 卡片不再重复第二遍（P7：同一件事不写两处）。
 */
/** 与 `singlepage/model.ts` 的 `CardState` 同形 —— core 不反向依赖 features
 * （类型自己声明，渲染侧的门禁负责对账）。 */
export type DepState = 'ok' | 'warn' | 'fail' | 'na' | 'idle' | 'running';

/** conandata.yml 的 `requirements:` 列表（`pkg/version`）。 */export function conandataRequirements(text: string): { pkg: string; version: string }[] {
  const out: { pkg: string; version: string }[] = [];
  const block = /requirements:\s*\n((?:\s*[-#].*\n?)*)/u.exec(text);
  if (!block) {
    return out;
  }
  for (const m of block[1].matchAll(/^\s*-\s*"([^"/]+)\/([^"]+)"/gmu)) {
    out.push({ pkg: m[1].trim(), version: m[2].trim() });
  }
  return out;
}

/**
 * CI 里"给哪些包装了系统头"。
 *
 * 两种真实形态：
 * 1. python 字典字面量 `mapping = {'zlib': 'zlib1g-dev', …}`（apt 包名一起取出来，
 *    因为"装成了哪个包"正是用户要抄进终端的东西）；
 * 2. 单独的安装步骤（如 ETL 是 header-only，自己 curl）—— 用 `startswith('etl/')` 认出来。
 */
export function ciSystemHeaders(workflowText: string): Record<string, string> {
  const out: Record<string, string> = {};
  const dict = /mapping\s*=\s*\{([^}]*)\}/u.exec(workflowText);
  if (dict) {
    for (const m of dict[1].matchAll(/['"]([^'"]+)['"]\s*:\s*['"]([^'"]+)['"]/gu)) {
      out[m[1]] = m[2];
    }
  }
  for (const m of workflowText.matchAll(/startswith\(\s*['"]([^'"]+)\//gu)) {
    out[m[1]] = ''; // 空串 = 由专门步骤装（没有 apt 包名）
  }
  return out;
}

/** src/ 里被 `#include <...>` 引到的头文件（去重、保序）。 */
export function includedHeaders(srcFiles: Readonly<Record<string, string>>): string[] {
  const out = new Set<string>();
  for (const text of Object.values(srcFiles)) {
    for (const m of text.matchAll(/^\s*#\s*include\s*[<"]([^>"]+)[>"]/gmu)) {
      out.add(m[1].trim());
    }
  }
  return [...out];
}

/**
 * 头文件 → conandata 里的包名（只认**能明确对上**的：`zlib.h`→zlib、`etl/...`→etl）。
 *
 * 对不上就返回 undefined —— 宁可漏报，也不要凭猜给出一条"假缺口"（那会让人白改 CI）。
 */
export function packageForHeader(header: string, pkgs: readonly string[]): string | undefined {
  const base = (header.split(/[\\/]/u).pop() ?? header).toLowerCase();
  const top = (header.split(/[\\/]/u)[0] ?? '').toLowerCase();
  const stem = base.replace(/\.(h|hpp|hh|hxx)$/u, '');
  for (const p of pkgs) {
    const lc = p.toLowerCase();
    if (stem === lc || top === lc) {
      return p;
    }
  }
  return undefined;
}

export interface DeclaredDep {
  /** metadata.json 里的显示名（如 ZLIB / Eigen3）—— **给人看的**。 */
  name: string;
  /**
   * conandata.yml 里的 conan 包名（如 zlib / eigen）。
   *
   * **查询与比对都用它**：上游缓存是按 conan 包名存的（`conan search zlib`），
   * 拿显示名去查会永远查不到（"ZLIB" ≠ "zlib"）。
   */
  conan?: string;
  /** conandata.yml 里对上的版本；**undefined = 两份清单对不上**。 */
  version?: string;
}

export interface DepEvolutionInput {
  /**
   * metadata 声明的直接依赖（由 `listDependencies()` 给出 —— 依赖管理器用的同一份）。
   * **不给 = 还没取到** → 卡片只显示 `—`，不编造数字。
   */
  declared?: readonly DeclaredDep[];
  /** conandata.yml 原文（读得到就给）。 */
  conandataText?: string;
  /** CI 里装系统头的 workflow 原文（读得到就给）。 */
  ciWorkflowText?: string;
  /** src/ 下的源码文本（键=相对路径）——用来判"哪些依赖的头被 src 用到"。 */
  srcFiles?: Readonly<Record<string, string>>;
  /** 上游最新版本（**只有真取到才给**）：包名 → 最新版本。 */
  latest?: Readonly<Record<string, string>>;
  /** 上游最新那次查询的时间（人话，如 `3 分钟前`）。 */
  latestAt?: string;
}

export interface DepEvolution {
  state: DepState;
  fact: string;
  next?: string;
  /** 直接依赖数（= metadata 声明的数量）。 */
  direct: number;
  /** 两份清单对不上的包名（metadata 有、conandata 没有）。 */
  mismatched: string[];
  /** src 用到、但 CI 里没有系统头来源的包（真会让 CI 红）。 */
  sysHeaderGaps: string[];
  /** 有上游新版的包。 */
  outdated: { name: string; local: string; latest: string }[];
}

/** 版本比较（数字段逐段比；不猜预发布语义）。 */
function newestOf(versions: readonly string[]): string | undefined {
  if (versions.length === 0) {
    return undefined;
  }
  const key = (v: string): (number | string)[] =>
    v.split(/[.+-]/u).map((s) => (/^\d+$/u.test(s) ? Number(s) : s));
  return [...versions]
    .sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      for (let i = 0; i < Math.max(ka.length, kb.length); i += 1) {
        const x = ka[i];
        const y = kb[i];
        if (x === undefined) {
          return -1;
        }
        if (y === undefined) {
          return 1;
        }
        if (x === y) {
          continue;
        }
        if (typeof x === 'number' && typeof y === 'number') {
          return x - y;
        }
        return String(x) < String(y) ? -1 : 1;
      }
      return 0;
    })
    .at(-1);
}

/** `conan search <pkg> -r conancenter --format=json` 的输出 → 这个包最新的版本。 */
export function latestVersionFromSearch(jsonText: string): string | undefined {
  try {
    const j = JSON.parse(jsonText) as { results?: { items?: ({ ref?: string } | string)[] }[] };
    const versions: string[] = [];
    for (const res of j.results ?? []) {
      for (const item of res.items ?? []) {
        const ref = typeof item === 'string' ? item : (item.ref ?? '');
        const v = /^[^/]+\/(.+)$/u.exec(ref)?.[1];
        if (v) {
          versions.push(v.trim());
        }
      }
    }
    return versions.length > 0 ? newestOf(versions) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 一行事实 + 状态。
 *
 * 优先序（要紧的在前，一次只给**一个**下一步）：
 * 1. **两份清单对不上**（metadata 有、conandata 没有）→ fail：构建时会找不到依赖；
 * 2. **CI 缺系统头**（src 用到）→ warn：CI 的 clang-tidy 会红；
 * 3. **上游有新版**（真取到才算）→ ok + 怎么升；
 * 4. 都没有 → `直接 N`（全绿不啰嗦）。
 *
 * 说明：这里**不显示"间接依赖数"** —— 那是个没有事实来源的数字（曾经写死过），
 * 要么从真实的依赖图里取，要么不显示（P7）。
 */
export function depEvolution(input: DepEvolutionInput): DepEvolution {
  if (input.declared === undefined) {
    return { state: 'idle', fact: '—', direct: 0, mismatched: [], sysHeaderGaps: [], outdated: [] };
  }
  const declared = input.declared;
  const direct = declared.length;
  const mismatched = declared.filter((d) => d.version === undefined).map((d) => d.name);

  const reqs = input.conandataText ? conandataRequirements(input.conandataText) : [];
  const headers = input.ciWorkflowText ? ciSystemHeaders(input.ciWorkflowText) : {};
  const used = input.srcFiles ? includedHeaders(input.srcFiles) : [];
  const pkgs = reqs.map((r) => r.pkg);
  const sysHeaderGaps =
    pkgs.length === 0 || used.length === 0
      ? []
      : (() => {
          const gaps = new Set<string>();
          for (const h of used) {
            const pkg = packageForHeader(h, pkgs);
            if (pkg && headers[pkg] === undefined) {
              gaps.add(pkg);
            }
          }
          return [...gaps];
        })();

  const keyOf = (d: DeclaredDep): string => d.conan ?? d.name;
  const outdated = declared
    .filter((d) => {
      const latest = input.latest?.[keyOf(d)];
      return d.version !== undefined && latest !== undefined && latest !== d.version;
    })
    .map((d) => ({ name: d.name, local: d.version ?? '', latest: input.latest?.[keyOf(d)] ?? '' }));

  if (mismatched.length > 0) {
    return {
      state: 'fail',
      fact: `两份清单不一致：${mismatched.slice(0, 3).join('、')}（metadata 有、conandata 没有）`,
      next: '需要你执行：在依赖管理器里补齐（它同时写 conandata 与 metadata，避免再漂）',
      direct,
      mismatched,
      sysHeaderGaps,
      outdated,
    };
  }
  if (sysHeaderGaps.length > 0) {
    return {
      state: 'warn',
      fact: `CI 缺系统头：${sysHeaderGaps.slice(0, 3).join('、')}（src 里用到）· 直接 ${direct}`,
      next: `需要你执行：在 .github/workflows/security-linters.yml 的 mapping 里补上 ${sysHeaderGaps
        .map((g) => `${g}:<apt 包名>`)
        .join('、')}，否则 CI 的 clang-tidy 找不到头文件`,
      direct,
      mismatched,
      sysHeaderGaps,
      outdated,
    };
  }
  if (outdated.length > 0) {
    const first = outdated[0];
    return {
      state: 'ok',
      fact: `直接 ${direct} · 上游有新版 ${outdated.length}（${first.name} ${first.latest}${input.latestAt ? ` · ${input.latestAt}` : ''}）`,
      next: '需要你执行：在依赖管理器里升级（conandata 与 metadata 一起改），升完跑一次全量测试',
      direct,
      mismatched,
      sysHeaderGaps,
      outdated,
    };
  }
  return {
    state: 'ok',
    fact: input.latestAt ? `直接 ${direct} · 上游已是最新（${input.latestAt}）` : `直接 ${direct}`,
    direct,
    mismatched,
    sysHeaderGaps,
    outdated,
  };
}
