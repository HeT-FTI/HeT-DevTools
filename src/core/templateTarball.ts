/**
 * 模板 tarball 的**纯逻辑**（计划 §11 / G17）：候选链、解压后的形状校验、缓存命名、失败话术。
 *
 * 为什么选 tarball 而不是 `git clone`：不需要 git、更快、**可 sha256 校验**（clone 只能校 ref）。
 * `git clone` 保留为兜底（用户想跟 main 时用）。
 *
 * 实测（2026-09-17，本机）：
 * - `git ls-remote` 显示 `v0.1.2` 与 `main` 都是 `cae2f5a7…`（上游在 main 顶端打的 tag）；
 * - codeload tarball 3,027,910 B，两次下载 sha256 一致 → **可以钉死**；
 * - 经 `gh-proxy.com` 前缀取到的**字节完全相同**（同一 sha256）→ 一条 sha 覆盖所有候选；
 * - `ghfast.top` / `ghproxy.net` 对 codeload 路径返回 **403** → 仍留作候选（别的网络可能通），
 *   但顺序上不能把它们排在唯一主源位置。
 */

export type TarballVia = 'direct' | 'accel';

export interface TarballCandidate {
  url: string;
  via: TarballVia;
  /** 人话标签（日志/失败提示里用）。 */
  label: string;
}

/** 解压后**必须有**的文件（缺一个就不是完整的 fcpp 模板）。 */
export const TEMPLATE_REQUIRED_FILES: readonly string[] = ['metadata.json', 'CMakeLists.txt', 'conanfile.py'];

/** ref 的形状（决定 codeload 路径怎么写 —— 写错了是 404，不是"内容不对"）。 */
export function refKindOf(ref: string): 'tag' | 'branch' | 'commit' {
  const r = (ref ?? '').trim();
  if (/^[0-9a-f]{40}$/iu.test(r)) {
    return 'commit';
  }
  if (r === 'main' || r === 'master') {
    return 'branch';
  }
  return 'tag';
}

/** codeload 的规范地址（不带加速前缀）。 */
export function templateTarballUrl(owner: string, repo: string, ref: string): string {
  const base = `https://codeload.github.com/${owner}/${repo}/tar.gz`;
  switch (refKindOf(ref)) {
    case 'commit':
      return `${base}/${ref}`;
    case 'branch':
      return `${base}/refs/heads/${ref}`;
    default:
      return `${base}/refs/tags/${ref}`;
  }
}

/** 加速前缀 + 规范地址（我们实测的格式：`https://gh-proxy.com/https://codeload…`）。 */
export function accelUrl(prefix: string, direct: string): string {
  const p = (prefix ?? '').trim();
  if (!p) {
    return direct;
  }
  return `${p.endsWith('/') ? p : `${p}/`}${direct}`;
}

/**
 * 候选顺序。
 *
 * - `accelFirst = true`（CN 档）：加速前缀在前 —— 直连在目标网络可能慢/被墙；
 * - `accelFirst = false`（官方档）：直连在前，前缀只当备用。
 *
 * 无论哪种顺序，**最终都会试到直连**（网络环境千差万别，不假设哪个一定行）。
 */
export function templateTarballCandidates(
  owner: string,
  repo: string,
  ref: string,
  opts: { accel?: readonly string[]; accelFirst?: boolean } = {},
): TarballCandidate[] {
  const direct = templateTarballUrl(owner, repo, ref);
  const accel: TarballCandidate[] = (opts.accel ?? [])
    .filter((p) => (p ?? '').trim().length > 0)
    .map((prefix) => ({ url: accelUrl(prefix, direct), via: 'accel' as const, label: `加速前缀（${new URL(prefix).host}）` }));
  const directCand: TarballCandidate = { url: direct, via: 'direct', label: '官方 codeload' };
  return opts.accelFirst === true ? [...accel, directCand] : [directCand, ...accel];
}

/** 去掉 `./`、忽略 `pax_global_header`/空行。 */
export function normalizeEntries(entries: readonly string[]): string[] {
  return entries
    .map((e) => (e ?? '').trim())
    .filter((e) => e.length > 0 && e !== 'pax_global_header')
    .map((e) => (e.startsWith('./') ? e.slice(2) : e));
}

/** 单一顶层目录（tag tarball 是 `fcpp-0.1.2/`；commit tarball 是 `fcpp-<你给的那个 ref>/` ——
 * 给短哈希就是 `fcpp-6278d01/`，给完整 sha 就是 `fcpp-<40 位>/`）。 */
export function tarballTopDir(entries: readonly string[]): { top?: string; reason?: string } {
  const list = normalizeEntries(entries);
  if (list.length === 0) {
    return { reason: '压缩包是空的' };
  }
  const tops = new Set(list.map((e) => e.split('/')[0]).filter(Boolean));
  if (tops.size !== 1) {
    return { reason: `压缩包里有 ${tops.size} 个顶层目录（期望 1 个）：${[...tops].slice(0, 5).join(', ')}` };
  }
  return { top: [...tops][0] };
}

export interface TarballShape {
  ok: boolean;
  top?: string;
  missing: string[];
  reason?: string;
}

/** 形状校验：单一顶层目录 + 必备文件都在（解压前就能判，省得解一半再失败）。 */
export function verifyTemplateEntries(entries: readonly string[]): TarballShape {
  const top = tarballTopDir(entries);
  if (!top.top) {
    return { ok: false, missing: [], reason: top.reason };
  }
  const files = new Set(normalizeEntries(entries));
  const missing = TEMPLATE_REQUIRED_FILES.filter((f) => !files.has(`${top.top}/${f}`));
  if (missing.length > 0) {
    return { ok: false, top: top.top, missing, reason: `缺少必备文件：${missing.join('、')}` };
  }
  return { ok: true, top: top.top, missing: [] };
}

/** 缓存按 sha256 命名（换版本/重试都不重复下载；与 rootfs 的缓存口径一致）。 */
export function templateCacheName(sha256: string): string {
  return `${(sha256 ?? '').toLowerCase()}.tar.gz`;
}

/** 下载失败时的"下一步"（§10：不许只说失败）。 */
export function templateFetchNextStep(owner: string, repo: string, ref: string): string {
  return (
    `可改用 git 兜底：git clone --branch ${ref} https://github.com/${owner}/${repo}.git；` +
    '或设 `het.net.profile=global` 直连；内网可配 `het.env.httpProxy`。'
  );
}

/** 全失败时的兜底说明：内置快照是**等价可用**的，不是"残废模式"。 */
export function snapshotFallbackNotice(snapshotVersion: string): string {
  return (
    `在线获取失败 → 用**内置快照**（v${snapshotVersion}）建工程：内容自洽、可离线、秒建；` +
    '联网后再跑一次「模板：在线获取」即可切到上游版本。'
  );
}
/** 建工程时的取模板决定（G17b）。 */
export interface TarballPlan {
  /** 能不能走 tarball（不需要 git、快、可 sha256 校验）。 */
  useTarball: boolean;
  /** 校验值（只有我们钉过的 ref 才有）。 */
  sha256?: string;
  /** 写进 `.het/template-ref.json` 的 ref。 */
  markerRef: string;
  /** 人话说明（日志/降级话术里用）。 */
  note: string;
}

/**
 * **只有我们钉过 sha256 的 ref 才走 tarball**。
 *
 * - `tag`（正式发版）与固定提交：字节可重现 → tarball + sha256 校验，且**不需要 git**；
 * - `main`：移动目标，我们手上没有它的 sha256 → **走 git clone**（那里也不适合钉 sha）。
 *
 * 这是"宁可保守"的分界线：没有校验值的下载路径，不如不提供。
 */
export function tarballPlanFor(ref: string, pins: { tag: string; commit: string; sha256: string }): TarballPlan {
  const r = (ref ?? '').trim();
  if (!pins.sha256 || !/^[0-9a-f]{64}$/iu.test(pins.sha256)) {
    return { useTarball: false, markerRef: r, note: '未配置 sha256 → 走 git clone' };
  }
  if (r === pins.tag) {
    return {
      useTarball: true,
      sha256: pins.sha256.toLowerCase(),
      markerRef: pins.commit || r,
      note: `tarball + sha256 校验（${pins.tag} → ${pins.commit.slice(0, 12)}）`,
    };
  }
  if (r === pins.commit) {
    return {
      useTarball: true,
      sha256: pins.sha256.toLowerCase(),
      markerRef: r,
      note: 'tarball + sha256 校验（固定提交）',
    };
  }
  return {
    useTarball: false,
    markerRef: r,
    note: r === 'main' ? 'main 是移动目标（无钉死 sha256）→ 走 git clone' : `${r} 没有钉死的 sha256 → 走 git clone`,
  };
}