/**
 * T17a: Windows managed lane **self-provisioned distro** — pure logic.
 *
 * 计划附录 G 的实现起点。这里只有"决定"与"文本"，没有 fs/网络/vscode：
 *   · 命名与"0 侵入"不变式（I1/I2/I3）
 *   · 同名冲突策略（用户自己起了同名 → 换名，**绝不接管**）
 *   · 状态机分支（无 wsl / 无虚拟化 / 内核过旧 / 可自建 / 已就绪）
 *   · 权威源 + sha256 校验规则（**不提供"跳过校验"开关**）
 *   · import / bootstrap / 撤销 的命令与脚本文本
 *
 * 为什么单独成模块：这些是"用户环境边界"的决定，必须能被单测锁死 ——
 * 一旦写错就是动了用户的发行版，是不对称的错误（可测成本极低、犯错代价极高）。
 *
 * 不变式（附录 G.2）：
 *   I1 只碰带我们标记的发行版（名字前缀 + 双 owner 标记一致）
 *   I2 从不改别人的（不 `--set-default`、不对非我们的发行版 `--unregister`、不在其中写文件）
 *   I3 不侵占系统位置（安装目录固定在 %LOCALAPPDATA%\het-fti\wsl\<name>，可被 envRemove 完全撤销）
 */

import { localSourcePath } from './wslRootfs';

/** 我们的发行版前缀 —— 名字所有权靠它 + owner 标记共同证明。 */
export const LANE_DISTRO_PREFIX = 'het-lane-';
/** 发行版对应的 Ubuntu LTS 代号后缀（2404 = 24.04 noble）。 */
export const LANE_DISTRO_RELEASE = '2404';
/** 换名上限（同名冲突时追加 -2/-3…）。 */
export const LANE_DISTRO_MAX_SUFFIX = 3;
/** 我们拥有的发行版名必须匹配这个形状（I1 的第一半）。 */
export const LANE_DISTRO_NAME_RE = /^het-lane-\d{4}(-\d+)?$/u;
/** 车道 id：写进 owner 标记，防止"别的功能造的发行版"被我们认领。 */
export const LANE_DISTRO_LANE_ID = 'wsl2-managed';

/**
 * Canonical 权威源（实测：HTTP 200 / 356,739,129 B / 2024-04-25；
 * sha256 取自同目录 `SHA256SUMS`）。选 `-wsl.rootfs.tar.gz` 而不是 `ubuntu-base`：
 * 后者没有 `/etc/wsl.conf`、缺 locale，heal 负担更大（计划 §8）。
 */
export const LANE_ROOTFS = {
  url: 'https://cloud-images.ubuntu.com/wsl/releases/24.04/current/ubuntu-noble-wsl-amd64-wsl.rootfs.tar.gz',
  sha256: '8251e27ffff381a4af5f41dcb94d867de3e0d9774a9241908ab34555d99315ea',
  bytes: 356739129,
} as const;

/** 我们造出来的发行版的默认名字（带版本后缀，换 26.04 时可并存）。 */
export function laneDistroBaseName(): string {
  return `${LANE_DISTRO_PREFIX}${LANE_DISTRO_RELEASE}`;
}

/** I1 第一半：这个名字"看起来"是我们的吗（owner 标记是第二半，见 adoptionVerdict）。 */
export function isOurDistroName(name: string): boolean {
  return LANE_DISTRO_NAME_RE.test((name ?? '').trim());
}

/**
 * 车道该用哪个发行版（纯函数，便于单测）。
 *
 * 优先级（**T17d 修正**，2026-09-15 CI 实测 run 34944081639）：
 *   ① **我们自己的**（调用方用双标记判据算出的 `ourDistros`）—— 唯一可信的来源；
 *   ② 名字落在**我们的命名空间**但**没有双标记**的（如别人手建的 `het-lane-2404`）→
 *      **一律不用**：它们是"保留名但不是我们的"，导入层会绕开它们换名（`-2`），
 *      把它们当车道就等于往别人的发行版里写我们的东西；
 *   ③ 其余（用户自己的 Ubuntu/Debian…，或历史托管名 `het-fcpp`）→ 复用第一个 ——
 *      "用你已有的官方发行版当车道宿主"是既有且有意保留的语义。
 *
 * 旧实现是 `list.find(isOurDistroName)`：**只按名字**，于是同名无标记的发行版会抢先被选中
 * （仪表盘显示它的空状态、车道被装进它里面），而导入层同一时刻正确地把它当外人 ——
 * 两条路必须用同一个判据。
 */
export function chooseDistroForLane(
  distros: readonly string[],
  opts: { ourDistros?: readonly string[]; legacyManaged?: string } = {},
): string | undefined {
  const legacy = opts.legacyManaged ?? 'het-fcpp';
  const list = [...distros].map((d) => d.trim()).filter(Boolean);
  const ours = new Set((opts.ourDistros ?? []).map((d) => d.trim()).filter(Boolean));
  const owned = list.filter((d) => ours.has(d));
  if (owned.length > 0) {
    return owned.find((d) => d === legacy) ?? owned[0];
  }
  // 命名空间内但没双标记 → 不是我们的：绝不使用（导入层会换名绕开）。
  const candidates = list.filter((d) => !isOurDistroName(d));
  return candidates.find((d) => d === legacy) ?? candidates[0];
}

export interface DistroNameChoice {
  /** 选定的名字；`undefined` = 无法安全命名（走 A/C）。 */
  name?: string;
  /** `none`=用基名；`reuse`=基名已存在且是我们的；`renamed`=被外来的同名占用而换名；`exhausted`=换名次数用尽 */
  outcome: 'none' | 'reuse' | 'renamed' | 'blocked-by-foreign' | 'exhausted';
  /** 触发换名的那个外来发行版名（诊断用）。 */
  blockedBy?: string;
  note: string;
}

/**
 * 选一个"绝对不碰用户东西"的发行版名。
 *
 * `existing` = `wsl -l -q` 的结果；`ours` = 其中**带我们双标记**的那些。
 * 关键分支：基名被**外来**同名占用时换名（`-2`/`-3`…），绝不接管；
 * 换名次数用尽就返回 `exhausted`（调用方给 A/C 两条路）。
 */
export function pickLaneDistroName(existing: readonly string[], ours: readonly string[]): DistroNameChoice {
  const base = laneDistroBaseName();
  const set = new Set([...existing].map((n) => n.trim()).filter(Boolean));
  const oursSet = new Set([...ours].map((n) => n.trim()).filter(Boolean));

  if (!set.has(base)) {
    return { name: base, outcome: 'none', note: `新建 ${base}（本机没有同名发行版）` };
  }
  if (oursSet.has(base)) {
    return { name: base, outcome: 'reuse', note: `${base} 是我们的（带双标记）→ 复用，不重建` };
  }
  for (let i = 2; i <= 1 + LANE_DISTRO_MAX_SUFFIX; i += 1) {
    const candidate = `${base}-${i}`;
    if (!set.has(candidate)) {
      return {
        name: candidate,
        outcome: 'renamed',
        blockedBy: base,
        note: `${base} 已存在但**不是我们的**（无 owner 标记）→ 换名 ${candidate}，绝不接管`,
      };
    }
    if (oursSet.has(candidate)) {
      return { name: candidate, outcome: 'reuse', note: `${candidate} 是我们的（带双标记）→ 复用` };
    }
  }
  return {
    outcome: 'exhausted',
    blockedBy: base,
    note: `${base} 及其 -2…-${1 + LANE_DISTRO_MAX_SUFFIX} 都被占用且非我们所有 → 不自建（给 A/C 两条路）`,
  };
}

/** 写进发行版 `/etc/het-lane.json` 与 Windows 侧 `owner.json` 的内容。 */
export interface DistroOwnerRecord {
  lane: string;
  name: string;
  rootfsSha256: string;
  extensionVersion: string;
  createdAt: string;
}

export function laneDistroOwnerRecord(input: Omit<DistroOwnerRecord, 'lane'>): DistroOwnerRecord {
  return { lane: LANE_DISTRO_LANE_ID, ...input };
}

/** 解析/校验 owner 标记（跨越进程边界的输入，必须当成不可信数据）。 */
export function parseOwnerRecord(raw: string): { ok: boolean; record?: DistroOwnerRecord; reason?: string } {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'owner 标记不是合法 JSON' };
  }
  const o = data as Partial<DistroOwnerRecord>;
  if (o?.lane !== LANE_DISTRO_LANE_ID) {
    return { ok: false, reason: `owner 标记的 lane 不是 ${LANE_DISTRO_LANE_ID}` };
  }
  if (!o.name || !isOurDistroName(o.name)) {
    return { ok: false, reason: 'owner 标记的 name 不符合我们的命名' };
  }
  if (!o.rootfsSha256 || !/^[0-9a-f]{64}$/u.test(o.rootfsSha256)) {
    return { ok: false, reason: 'owner 标记的 rootfsSha256 缺失或不是 sha256' };
  }
  return {
    ok: true,
    record: {
      lane: o.lane,
      name: o.name,
      rootfsSha256: o.rootfsSha256,
      extensionVersion: o.extensionVersion ?? '',
      createdAt: o.createdAt ?? '',
    },
  };
}

export interface AdoptionVerdict {
  adopt: boolean;
  reason: string;
}

/**
 * I1 的第二半：能不能"接管/复用"这个发行版。
 *
 * 必须同时满足：名字形状是我们的 + 发行版内标记 + Windows 侧标记 + 三者（名字/lane/rootfs sha）互相一致。
 * 任何一条不满足都**不接管**（调用方换名或给 A/C），而不是"凑合修一下"。
 */
export function adoptionVerdict(input: {
  name: string;
  ownerInDistro?: string;
  ownerOnWindows?: string;
  isListed?: boolean;
}): AdoptionVerdict {
  const name = (input.name ?? '').trim();
  if (!isOurDistroName(name)) {
    return { adopt: false, reason: `${name} 不符合我们的命名（^${LANE_DISTRO_NAME_RE.source}）` };
  }
  if (!input.isListed) {
    return { adopt: false, reason: `${name} 不在 wsl -l -q 里` };
  }
  const a = parseOwnerRecord(input.ownerInDistro ?? '');
  const b = parseOwnerRecord(input.ownerOnWindows ?? '');
  if (!a.ok) {
    return { adopt: false, reason: `发行版内标记不可信：${a.reason}` };
  }
  if (!b.ok) {
    return { adopt: false, reason: `Windows 侧标记不可信：${b.reason}` };
  }
  if (a.record!.name !== name || b.record!.name !== name) {
    return { adopt: false, reason: `owner 标记的名字与 ${name} 不一致` };
  }
  if (a.record!.rootfsSha256 !== b.record!.rootfsSha256) {
    return { adopt: false, reason: '两侧 owner 标记的 rootfs sha256 不一致（曾被外部改动？）' };
  }
  return { adopt: true, reason: `${name} 是我们的（双标记一致）→ 可复用` };
}

/** 解析 rootfs 源：内网/离线覆盖必须**同时**给出 sha256（不提供"跳过校验"开关）。 */
export function laneRootfsSource(overrides: { url?: string; sha256?: string } = {}): {
  ok: boolean;
  url?: string;
  sha256?: string;
  bytes?: number;
  reason?: string;
} {
  const url = (overrides.url ?? '').trim();
  const sha = (overrides.sha256 ?? '').trim().toLowerCase();
  if (!url) {
    return { ok: true, url: LANE_ROOTFS.url, sha256: LANE_ROOTFS.sha256, bytes: LANE_ROOTFS.bytes };
  }
  // 口径必须与真正去取文件的模块一致（core/wslRootfs.localSourcePath），
  // 否则会出现"这里放行、那里取不到"或反过来的分裂（T17b 桩测试抓到过：POSIX 绝对路径被误拒）。
  if (!/^https?:\/\//u.test(url) && localSourcePath(url) === undefined) {
    return { ok: false, reason: `het.env.wslRootfsUrl 必须是 http(s)/file://、本地绝对路径或 UNC 共享：${url}` };
  }
  if (!sha) {
    return {
      ok: false,
      reason:
        'het.env.wslRootfsUrl 覆盖时必须同时给出 het.env.wslRootfsSha256（镜像内容与官方未必一致）—— ' +
        '我们不提供“跳过校验”的开关',
    };
  }
  if (!/^[0-9a-f]{64}$/u.test(sha)) {
    return { ok: false, reason: `het.env.wslRootfsSha256 不是 sha256：${sha}` };
  }
  return { ok: true, url, sha256: sha };
}

/** 状态机分支（附录 G.1）。 */
export type DistroPlan =
  | { kind: 'win-wsl-required'; routes: string[]; message: string }
  | { kind: 'win-wsl-no-virtualization'; routes: string[]; message: string }
  | { kind: 'win-wsl-kernel-outdated'; routes: string[]; message: string }
  | { kind: 'win-wsl-import'; distroName: string; conflict: DistroNameChoice['outcome']; url: string; sha256: string; bytes: number; message: string }
  | { kind: 'win-wsl2-ready'; distroName: string; reuse: boolean; message: string };

/** 两条出路（**绝不静默转 MSVC**）。 */
export const LANE_ROUTES = {
  a: '路线 A：`wsl --install -d Ubuntu-24.04` 按系统指引安装官方发行版（管理员 + 可能需重启）',
  c: '路线 C：改用本机工具链（`toolchain: system`，MSVC，**无覆盖率**）',
} as const;

/**
 * 自建/自举失败时的统一尾巴（import 失败 → bootstrap 失败 → 发行版起不来）。
 * 这三种失败对用户是同一个处境（车道用不了），就不应该各说一套话 —— 路由文案只从
 * `LANE_ROUTES` 来。
 */
export function laneFailureHint(): string {
  return `可改走：${LANE_ROUTES.a}；或 ${LANE_ROUTES.c}。扩展不会自动改用 MSVC。`;
}

/** 人类可读的代价（needsConsent 文案用）：约 340MB 下载 + 1.5–2.5GB 磁盘。 */
export function laneImportCostText(bytes: number = LANE_ROOTFS.bytes): string {
  const mb = Math.round(bytes / (1024 * 1024));
  return `将下载约 ${mb}MB 的 Ubuntu 24.04 根文件系统并导入为私有发行版（磁盘约 1.5–2.5GB，预计 3–8 分钟）；` +
    '我们只创建/使用自己名字的发行版，不会改动你已有的任何发行版。';
}

/**
 * 由"外部探测结果"决定做什么。纯函数：调用方负责探测（wsl.exe/虚拟化/内核/发行版列表）。
 */
export function planWslDistro(input: {
  wslExe: boolean;
  virtualization?: boolean;
  kernelOk?: boolean;
  distros?: readonly string[];
  ourDistros?: readonly string[];
  rootfs?: { url?: string; sha256?: string };
}): DistroPlan {
  const routes = [LANE_ROUTES.a, LANE_ROUTES.c];
  if (!input.wslExe) {
    return {
      kind: 'win-wsl-required',
      routes,
      message: '本机没有可用的 WSL2（wsl.exe 不存在）。' + LANE_ROUTES.a + '；' + LANE_ROUTES.c,
    };
  }
  if (input.virtualization === false) {
    return {
      kind: 'win-wsl-no-virtualization',
      routes,
      message: 'WSL2 需要"虚拟机平台"能力（BIOS 虚拟化 + Windows 功能）。请按系统指引开启后重新检测；' + LANE_ROUTES.c,
    };
  }
  if (input.kernelOk === false) {
    return {
      kind: 'win-wsl-kernel-outdated',
      routes,
      message: 'WSL2 内核过旧，请先执行 `wsl --update`（可能要重启）后重新检测。',
    };
  }
  const src = laneRootfsSource(input.rootfs);
  if (!src.ok) {
    return { kind: 'win-wsl-required', routes, message: `rootfs 配置无效：${src.reason}` };
  }
  const choice = pickLaneDistroName(input.distros ?? [], input.ourDistros ?? []);
  if (choice.outcome === 'exhausted' || !choice.name) {
    return { kind: 'win-wsl-required', routes, message: choice.note };
  }
  if (choice.outcome === 'reuse') {
    return { kind: 'win-wsl2-ready', distroName: choice.name, reuse: true, message: choice.note };
  }
  return {
    kind: 'win-wsl-import',
    distroName: choice.name,
    conflict: choice.outcome,
    url: src.url!,
    sha256: src.sha256!,
    bytes: src.bytes ?? LANE_ROOTFS.bytes,
    message: `${choice.note}。${laneImportCostText(src.bytes ?? LANE_ROOTFS.bytes)}`,
  };
}

/** I3：安装目录固定在 LOCALAPPDATA 下（不是 Store 的 Packages 位置）。 */
export function laneWslInstallDir(localAppData: string, name: string): string {
  return `${localAppData}\\het-fti\\wsl\\${name}`;
}

/** rootfs 缓存：按 sha256 命名 → 换名/修复导入都不重复下载。 */
export function laneRootfsCachePath(localAppData: string, sha256: string): string {
  return `${localAppData}\\het-fti\\wsl\\cache\\${sha256}.tar.gz`;
}

export function laneOwnerMarkerPath(localAppData: string, name: string): string {
  return `${localAppData}\\het-fti\\wsl\\${name}\\owner.json`;
}

/** `wsl --import <name> <dir> <tar> --version 2`（名字永远是我们自己的）。 */
export function wslImportArgs(name: string, installDir: string, tarPath: string): string[] {
  return ['--import', name, installDir, tarPath, '--version', '2'];
}

/** I2：只对我们自己的发行版 unregister/terminate（调用方必须先过 adoptionVerdict）。 */
export function wslUnregisterArgs(name: string): string[] {
  return ['--unregister', name];
}

export function wslTerminateArgs(name: string): string[] {
  return ['--terminate', name];
}

/**
 * `/etc/wsl.conf`：我们"必须要求"的键（其余一律**保留**）。
 *
 * 为什么要合并而不是覆写（T17b 实测）：Canonical 的官方 WSL 镜像自带
 * `[boot] systemd=true` —— 直接 `cat >` 会把厂商的选择改掉。我们只 **加** 自己需要的：
 *   · `[interop] appendWindowsPath=false`：Windows PATH 混进 Linux 会让 conan/gcc 探针
 *     看到"存在但跑不了"的 exe（E1 那类假就绪的温床），也与"与 CI 同构"相悖；
 *   · `[automount] options="metadata"`：/mnt/c 保留可执行位/权限元数据。
 */
export const WSL_CONF_DESIRED: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  interop: { enabled: 'true', appendWindowsPath: 'false' },
  automount: { enabled: 'true', options: '"metadata"' },
};

/** 解析成"前导 + 各 section"，保留注释/空行/未知 section 的原样（为后面原样写回）。 */
export function parseWslConf(text: string): { name?: string; lines: string[] }[] {
  const out: { name?: string; lines: string[] }[] = [{ lines: [] }];
  for (const line of (text ?? '').split(/\r?\n/u)) {
    const m = /^\s*\[([^\]]+)\]\s*$/u.exec(line);
    if (m) {
      out.push({ name: m[1].trim(), lines: [line] });
    } else {
      out[out.length - 1].lines.push(line);
    }
  }
  return out;
}

function serializeWslConf(sections: { name?: string; lines: string[] }[]): string {
  const body = sections.map((s) => s.lines.join('\n')).join('\n');
  // 去掉首/尾多余空行，统一以单个换行结尾（保证幂等：合并两次结果一致）
  return `${body.replace(/^\n+/u, '').replace(/\n+$/u, '')}\n`;
}

/** key 匹配宽松一点（`enabled = true` / `enabled=true` / 大小写）。 */
function keyOf(line: string): string | undefined {
  const m = /^\s*([A-Za-z0-9_.-]+)\s*=/u.exec(line);
  return m ? m[1].toLowerCase() : undefined;
}

/**
 * 把 `desired` 合并进已有的 wsl.conf：已存在的同名 section 只补/改我们管的键，
 * 其它键与注释原样保留；没有的 section 追加到末尾。**幂等**。
 */
export function mergeWslConf(existing: string, desired: Readonly<Record<string, Readonly<Record<string, string>>>> = WSL_CONF_DESIRED): string {
  const sections = parseWslConf(existing);
  for (const [section, keys] of Object.entries(desired)) {
    let target = sections.find((s) => s.name?.toLowerCase() === section.toLowerCase());
    if (!target) {
      target = { name: section, lines: [`[${section}]`] };
      // 已有内容且末尾不是空行时补一个空行，避免和上一段粘在一起
      const last = sections[sections.length - 1];
      if (last.lines.length > 0 && last.lines[last.lines.length - 1].trim() !== '') {
        last.lines.push('');
      }
      sections.push(target);
    }
    for (const [key, value] of Object.entries(keys)) {
      const lower = key.toLowerCase();
      const idx = target.lines.findIndex((l) => keyOf(l) === lower);
      const rendered = `${key} = ${value}`;
      if (idx >= 0) {
        target.lines[idx] = rendered;
      } else {
        // 插到该 section 的最后一行的**有效**键之后（保留其后的注释/空行）
        let at = target.lines.length;
        while (at > 1 && target.lines[at - 1].trim() === '') {
          at -= 1;
        }
        target.lines.splice(at, 0, rendered);
      }
    }
  }
  return serializeWslConf(sections);
}

/** 官方镜像**缺**的东西（T17b 实测）：没有 `ensurepip`（Debian 把 venv 拆包）→ 建 venv 会失败。
 * 这是我们自己的发行版，直接在 bootstrap 里一次装好，比“第一次 ensure 失败后再自愈”确定得多。 */
export const LANE_BOOTSTRAP_APT = ['python3-venv'] as const;

/**
 * bootstrap 脚本（在新建发行版内跑一次）：补镜像缺的包 + 合并 wsl.conf + 写 owner 标记，并打印证据行。
 * 只接受 `isOurDistroName` 的名字 —— 违反者直接抛错（防调用方误传到用户发行版）。
 *
 * `wslConf` 由调用方先读-合并得到（`mergeWslConf`），这里只负责落盘。
 */
export function laneBootstrapScript(input: {
  name: string;
  sha256: string;
  extensionVersion: string;
  wslConf?: string;
  aptPackages?: readonly string[];
}): string {
  if (!isOurDistroName(input.name)) {
    throw new Error(`refusing to bootstrap a distro that is not ours: ${input.name}`);
  }
  const owner = JSON.stringify(laneDistroOwnerRecord({
    name: input.name,
    rootfsSha256: input.sha256,
    extensionVersion: input.extensionVersion,
    createdAt: '', // 由调用方在真机侧填 ISO 时间（这里不引入时钟依赖，保持纯函数）
  }));
  const apt = input.aptPackages ?? LANE_BOOTSTRAP_APT;
  const conf = input.wslConf ?? mergeWslConf('');
  return [
    'set -e',
    // 镜像自带 [boot] systemd=true 等厂商设置 → 只合并我们需要的键，其余原样保留（见 WSL_CONF_DESIRED）。
    `cat > /etc/wsl.conf <<'HET_WSL_CONF'`,
    conf.trimEnd(),
    'HET_WSL_CONF',
    // 官方 wsl 镜像缺 ensurepip（python3 -m venv 会失败）→ 我们自己的发行版，直接装好。
    `if [ ${apt.length} -gt 0 ]; then`,
    '  export DEBIAN_FRONTEND=noninteractive',
    '  apt-get update -qq',
    `  apt-get install -y -qq --no-install-recommends ${apt.join(' ')}`,
    'fi',
    // locale：镜像没有 locale-gen（实测），能跑就跑，跑不动就只落 LANG（C.UTF-8 本来也不需要生成）
    'if command -v locale-gen >/dev/null 2>&1; then locale-gen en_US.UTF-8 >/dev/null 2>&1 || true; fi',
    'echo LANG=C.UTF-8 > /etc/default/locale',
    `echo '${owner}' > /etc/het-lane.json`,
    `echo lane_distro:${input.name}`,
    `echo lane_distro_owner:${LANE_DISTRO_LANE_ID}`,
    `echo lane_distro_rootfs:${input.sha256}`,
    `echo lane_distro_python:$([ -x /usr/bin/python3 ] && /usr/bin/python3 -V 2>&1 || echo -)`,
    `echo lane_distro_venv:$([ -x /usr/bin/python3 ] && /usr/bin/python3 -m venv --help >/dev/null 2>&1 && echo ok || echo missing)`,
  ].join('\n');
}

/** 撤销（I3：一条命令完全撤销）。返回给人看的步骤，真实执行在 T17c 接线层。 */
export function laneTeardownPlan(name: string, localAppData: string, keepCache: boolean): string[] {
  if (!isOurDistroName(name)) {
    throw new Error(`refusing to plan a teardown for a distro that is not ours: ${name}`);
  }
  return [
    `wsl --terminate ${name}`,
    `wsl --unregister ${name}`,
    `删除目录 ${laneWslInstallDir(localAppData, name)}（含 owner.json）`,
    keepCache ? '保留 rootfs 缓存（het.env.keepRootfsCache=true）' : `删除缓存目录 ${localAppData}\\het-fti\\wsl\\cache`,
  ];
}
