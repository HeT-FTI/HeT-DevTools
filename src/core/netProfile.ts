/**
 * 网络与源策略（计划 §10 / G16 + G22）—— **纯函数**，不 import vscode。
 *
 * 用户需求 9 的两条硬约束：
 * 1. **不弹窗**：国内外用户都反感"检测到你是中国人，要不要换源"的对话框 →
 *    改为在输出面板打一行决策记录（`netDecisionLine`），卡片上常驻一行摘要（`netSummaryLine`）；
 * 2. **不静默降级**：换了源要说清换了哪个（`details` 里逐类列出），兜底到第二候选时也要写出来。
 *
 * 候选顺序 = 优先级（第二轮第 4 条锁定）：**pip / apt / rootfs 三类统一以 NJU 为主源**，
 * TUNA / 阿里只作兜底；rootfs 之所以只能 NJU，是因为只有它镜像了 `wsl/` 子树（实测 TUNA/USTC/阿里/BFSU 404/403）。
 */
import { LANE_ROOTFS } from './wslDistro';

export type NetProfile = 'auto' | 'cn' | 'global' | 'custom';
export type NetEffective = 'cn' | 'global' | 'custom';

/** 源的类别（与 §10 的候选链一一对应）。 */
export type SourceKind = 'pip' | 'apt' | 'rootfs' | 'ghAccel' | 'docker';

export const NET_PROFILES: readonly NetProfile[] = ['auto', 'cn', 'global', 'custom'];
export const DEFAULT_NET_PROFILE: NetProfile = 'auto';

/** pip：`/pypi/web/simple` 是**实测 200** 的那个路径（`/pypi/simple` 实测 404）。 */
export const CN_PIP_INDEXES: readonly string[] = [
  'https://mirror.nju.edu.cn/pypi/web/simple',
  'https://pypi.tuna.tsinghua.edu.cn/simple',
  'https://mirrors.aliyun.com/pypi/simple',
];

export const CN_APT_MIRRORS: readonly string[] = [
  'https://mirror.nju.edu.cn/ubuntu',
  'https://mirrors.tuna.tsinghua.edu.cn/ubuntu',
  'https://mirrors.aliyun.com/ubuntu',
];

/** GH 加速前缀（三个互为备用；`hub.gitmirror.com`/`kkgithub.com` 实测连不上，不要用）。 */
export const GH_ACCEL_PREFIXES: readonly string[] = [
  'https://ghfast.top/',
  'https://gh-proxy.com/',
  'https://ghproxy.net/',
];

/** Canonical → NJU 的路径映射（同路径镜像；实测 200）。 */
export const NJU_ROOTFS_PREFIX = 'https://mirror.nju.edu.cn/ubuntu-cloud-images/';
export const CANONICAL_ROOTFS_PREFIX = 'https://cloud-images.ubuntu.com/';

/**
 * 把 Canonical 的 rootfs 地址映射到 NJU（只换 host+前缀，路径原样保留）。
 *
 * 2026-09-18 实测（HEAD 对比，两个都是 200）：
 * · `content-length: 356739129` —— 与我们 pin 的字节数一致；
 * · `last-modified: Thu, 25 Apr 2024 17:10:56 GMT` —— 与 Canonical **完全相同**（镜像保留了 mtime）；
 * · ETag 格式不同（各自服务器生成），不算差异。
 * 所以 CN 档把 NJU 当**主源**是安全的；即便某天它变了，`acquireRootfs` 会兑底回 Canonical
 * 且**照旧过同一个 sha256**。
 */
export function njuRootfsUrl(canonical: string = LANE_ROOTFS.url): string {
  const c = (canonical ?? '').trim();
  return c.startsWith(CANONICAL_ROOTFS_PREFIX)
    ? `${NJU_ROOTFS_PREFIX}${c.slice(CANONICAL_ROOTFS_PREFIX.length)}`
    : c;
}

export interface NetChains {
  /** pip 索引（顺序 = 优先级）。空数组 = 不改，用 PyPI 默认。 */
  pip: string[];
  /** apt 镜像基址。空数组 = 不动发行版自带的 sources.list。 */
  apt: string[];
  /** rootfs 候选（完整 URL；sha256 始终是我们 pin 的那个）。 */
  rootfs: string[];
  /** GitHub 加速前缀（三个互为备用）。 */
  ghAccel: string[];
}

export interface TemplateSources {
  /** 先看内置快照（离线可用）。 */
  builtinSnapshot: boolean;
  /** 官方 codeload tarball（要过 sha256）。 */
  codeload: boolean;
  /** 加速前缀，按顺序套在 codeload 前面。 */
  accel: string[];
  /** 最后才 git clone（含前缀）。 */
  gitClone: boolean;
}

export interface NetPlan {
  /** 用户设的档（原样回显）。 */
  profile: NetProfile;
  /** 实际生效的档（auto 已经按 locale 解析过）。 */
  effective: NetEffective;
  chains: NetChains;
  template: TemplateSources;
  /** Docker registry 镜像；**默认关闭**（CN 镜像实测基本已死），只给企业自填。 */
  dockerMirror: string;
  /** 用户显式覆盖的项（覆盖优先于链，并在决策行里点名）。 */
  overrides: { pip?: string; rootfs?: string };
  /** 逐类"生效了什么"（给输出面板，可诊断）。 */
  details: string[];
  /** 一行决策记录（进输出面板）。 */
  decision: string;
  /** 一行摘要（卡片常驻显示）。 */
  summary: string;
}

export interface NetPlanInput {
  /** `het.net.profile`。 */
  profile?: string;
  /** `vscode.env.language`（如 `zh-cn`）。 */
  locale?: string;
  /** 系统时区（如 `Asia/Shanghai`）—— auto 档的第二判据（英文系统 + 国内时区）。 */
  timeZone?: string;
  /** `het.env.pipIndexUrl`（显式覆盖，优先于链）。 */
  pipIndexUrl?: string;
  /** `het.env.wslRootfsUrl`（显式覆盖，优先于链）。 */
  wslRootfsUrl?: string;
  /** `het.net.dockerMirror`（空 = 关闭）。 */
  dockerMirror?: string;
  /** `het.net.mirrors`（custom 档用；每类一个字符串或字符串数组）。 */
  custom?: unknown;
}

function asProfile(raw: string | undefined): NetProfile {
  const v = (raw ?? '').trim().toLowerCase();
  return (NET_PROFILES as readonly string[]).includes(v) ? (v as NetProfile) : DEFAULT_NET_PROFILE;
}

function stringsOf(raw: unknown): string[] {
  if (typeof raw === 'string') {
    const v = raw.trim();
    return v ? [v] : [];
  }
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x ?? '').trim()).filter(Boolean);
  }
  return [];
}

/**
 * `auto` 的判据（实测反馈修订）：locale `zh*` **或** 时区在 `Asia/Shanghai` 等国内
 * 时区 → CN 源；否则官方源。**不弹窗、不问用户**（§10 第二轮第 3 条）。
 *
 * 为什么加时区：Windows 装英文版但在国内用时 locale=`en-US`，于是被判成 global，
 * 结果 rootfs 走 Canonical（实测反馈里那行 `[wsl-import] rootfs: https://cloud-images…`）。
 * 时区是同样零成本、零打扰的第二信号；两者都不满足才用官方源。
 */
const CN_TIMEZONES: readonly string[] = [
  'asia/shanghai',
  'asia/chongqing',
  'asia/harbin',
  'asia/urumqi',
  'asia/hong_kong',
  'asia/macau',
  'asia/taipei',
];

export function inCnTimezone(timeZone: string | undefined): boolean {
  return CN_TIMEZONES.includes((timeZone ?? '').trim().toLowerCase());
}

export function effectiveProfile(
  profile: NetProfile,
  locale: string | undefined,
  timeZone?: string,
): NetEffective {
  if (profile === 'custom') {
    return 'custom';
  }
  if (profile === 'cn' || profile === 'global') {
    return profile;
  }
  if ((locale ?? '').toLowerCase().startsWith('zh')) {
    return 'cn';
  }
  return inCnTimezone(timeZone) ? 'cn' : 'global';
}

/** 镜像的人话标签（NJU / TUNA / 阿里 / Canonical / PyPI / 自定义）。 */
export function mirrorLabel(url: string, kind?: SourceKind): string {
  return kindLabel(kind ?? 'pip', url);
}

function kindLabel(kind: SourceKind, url: string): string {
  if (!url) {
    return '关';
  }
  if (url.includes('mirror.nju.edu.cn')) {
    return 'NJU';
  }
  if (url.includes('tuna.tsinghua')) {
    return 'TUNA';
  }
  if (url.includes('aliyun')) {
    return '阿里';
  }
  if (url.includes('cloud-images.ubuntu.com')) {
    return 'Canonical';
  }
  if (url.includes('pypi.org')) {
    return 'PyPI';
  }
  if (kind === 'ghAccel') {
    return '自定义前缀';
  }
  return '自定义';
}

export function netPlanFor(input: NetPlanInput = {}): NetPlan {
  const profile = asProfile(input.profile);
  const effective = effectiveProfile(profile, input.locale, input.timeZone);
  const custom = input.custom as Record<string, unknown> | undefined;
  /**
   * custom 档的取值口径：**写了就用写的**（包括写空数组 = "这一类不要"），
   * 没写才回落到我们实测过的 CN 链 —— 否则用户 `ghAccel: []` 会被当成"没配"。
   */
  const customOf = (kind: SourceKind): string[] | undefined =>
    custom && custom[kind] !== undefined ? stringsOf(custom[kind]) : undefined;
  const useCn = effective === 'cn' || effective === 'custom';

  const pipOverride = (input.pipIndexUrl ?? '').trim();
  const rootfsOverride = (input.wslRootfsUrl ?? '').trim();
  const docker = (input.dockerMirror ?? '').trim();

  const pip = pipOverride ? [] : useCn ? (customOf('pip') ?? [...CN_PIP_INDEXES]) : [];
  const apt = useCn ? (customOf('apt') ?? [...CN_APT_MIRRORS]) : [];
  const rootfs = rootfsOverride
    ? []
    : useCn
      ? [njuRootfsUrl(), LANE_ROOTFS.url]
      : [LANE_ROOTFS.url];
  const ghAccel = useCn ? (customOf('ghAccel') ?? [...GH_ACCEL_PREFIXES]) : [];

  const chains: NetChains = { pip, apt, rootfs, ghAccel };
  const template: TemplateSources = {
    builtinSnapshot: true,
    codeload: true,
    accel: [...ghAccel],
    gitClone: true,
  };

  const details: string[] = [];
  details.push(
    pipOverride
      ? `pip=自定义（het.env.pipIndexUrl）`
      : pip.length
        ? `pip=${kindLabel('pip', pip[0])}（兜底 ${pip.slice(1).map((u) => kindLabel('pip', u)).join('/') || '无'}）`
        : 'pip=PyPI 默认',
  );
  details.push(
    apt.length
      ? `apt=${kindLabel('apt', apt[0])}（只换我们自建发行版的 apt 源；本机车道不动）`
      : 'apt=发行版自带（不改）',
  );
  details.push(
    rootfsOverride
      ? 'rootfs=自定义（het.env.wslRootfsUrl）'
      : rootfs.length > 1
        ? `rootfs=${kindLabel('rootfs', rootfs[0])} → 兜底 ${kindLabel('rootfs', rootfs[1])}`
        : `rootfs=${kindLabel('rootfs', rootfs[0] ?? '')}`,
  );
  details.push(ghAccel.length ? `gh-accel=${ghAccel.length} 个备用` : 'gh-accel=未启用');
  details.push(docker ? 'docker=自定义镜像' : 'docker=关闭');

  const why =
    profile === 'auto'
      ? `profile=auto（locale=${input.locale ?? '未知'} · tz=${input.timeZone ?? '未知'}）`
      : `profile=${profile}（手动）`;
  const decision = `[net] ${why} → ${useCn ? '启用 CN 源' : '使用官方源'}：${details.join(' · ')}`;

  const summaryBits: string[] = [];
  summaryBits.push(effective === 'cn' ? '国内源' : effective === 'custom' ? '自定义源' : '官方源');
  if (profile === 'auto') {
    summaryBits.push('自动');
  }
  if (pipOverride || rootfsOverride) {
    summaryBits.push('含自定义覆盖');
  }
  if (docker) {
    summaryBits.push('Docker 镜像已启用');
  }
  return {
    profile,
    effective,
    chains,
    template,
    dockerMirror: docker,
    overrides: { ...(pipOverride ? { pip: pipOverride } : {}), ...(rootfsOverride ? { rootfs: rootfsOverride } : {}) },
    details,
    decision,
    summary: summaryBits.join(' · '),
  };
}

/** 卡片/状态条用的一行（`当前生效：国内源（自动）`）。 */
export function netSummaryLine(plan: NetPlan): string {
  return `当前生效：${plan.summary}`;
}

/** 输出面板用的一行（含逐类明细，可诊断）。 */
export function netDecisionLine(plan: NetPlan): string {
  return plan.decision;
}

/**
 * rootfs 的尝试顺序：**主源失败才退到官方源**，且不退到"跳过校验"（永远带我们 pin 的 sha256）。
 * 显式覆盖（`het.env.wslRootfsUrl`）时不参与链 —— 用户说了算。
 */
export function rootfsFallbackOrder(plan: NetPlan): string[] {
  if (plan.overrides.rootfs) {
    return [plan.overrides.rootfs];
  }
  const seen = new Set<string>();
  return [plan.chains.rootfs[0], LANE_ROOTFS.url].filter((u): u is string => {
    if (!u || seen.has(u)) {
      return false;
    }
    seen.add(u);
    return true;
  });
}

/**
 * 给 WSL 导入层用的候选：主源 + 兜底（都已带上我们 pin 的 sha256）。
 *
 * `primary === undefined` 时表示**别碰用户的设置**（显式覆盖的情况），调用方自己决定。
 */
export function rootfsCandidatesFor(plan: NetPlan): {
  primary?: { url: string; sha256: string };
  fallback: { url: string; sha256: string }[];
} {
  const order = rootfsFallbackOrder(plan);
  if (plan.overrides.rootfs) {
    // 用户显式指定的镜像：只用它自己（sha 由设置提供，不在我们这儿猜）
    return { fallback: [] };
  }
  const [first, ...rest] = order;
  const sha = LANE_ROOTFS.sha256;
  return {
    ...(first ? { primary: { url: first, sha256: sha } } : {}),
    fallback: rest.map((url) => ({ url, sha256: sha })),
  };
}

/** 换源/下载失败时的"下一步"（§10：不许只说失败）。 */
export function netSourceHelp(kind: SourceKind): string {
  switch (kind) {
    case 'pip':
      return '换源：设置 › HeT DevTools › 网络与源（`het.net.profile`），或直接填 `het.env.pipIndexUrl`。';
    case 'apt':
      return 'apt 走发行版自带源；内网请设 `het.net.profile=custom` 并在 `het.net.mirrors.apt` 填镜像基址。';
    case 'rootfs':
      return '可手动下载 rootfs 后指定 `het.env.wslRootfsUrl` + `het.env.wslRootfsSha256`（必须同时给 sha256）。';
    case 'ghAccel':
      return 'GitHub 加速前缀都不通时可配 HTTP 代理（`het.env.httpProxy`），或用 `het.net.profile=global` 直连。';
    case 'docker':
      return 'Docker 镜像默认关闭；企业内网可用 `het.net.dockerMirror` 指向自建 registry 镜像。';
    default:
      return '可在「设置 › HeT DevTools › 网络与源」里调整。';
  }
}
