/**
 * V4-1: Toolchain Manifest + capability probe → Provider decision (pure).
 *
 * Rework principle: instead of "sniff & reuse whatever the user has", a managed
 * build needs a *deterministic* toolchain. This module is the contract:
 *   - `TOOLCHAIN_MANIFEST` pins the canonical versions.
 *   - `HostCapabilities` describes ONLY the host's capabilities (platform,
 *     WSL2 availability, virtualization, disk, admin…), never tool versions.
 *   - `resolveProviderDecision(caps)` picks the Provider that guarantees the
 *     same build semantics per platform (Windows via WSL2 = Linux by
 *     construction, macOS clang). Windows without a usable WSL2 is NOT
 *     silently degraded — the user is guided to enable WSL2 or to opt into
 *     the explicit `toolchain: system` (MSVC) compatibility mode.
 *
 * Pure logic (no `vscode`): fully unit-testable with injected capabilities and
 * the `HET_FAKE_HOST` JSON override used by both tests and the host adapter.
 */

import { laneDistroBaseName, laneImportCostText } from './wslDistro';

/** T17：`win-wsl2-pending` 时由托管车道**自建**发行版（一键），而不是让用户自己去装。 */
export interface LaneSetup {
  kind: 'wsl-import';
  /** 建议的发行版名（真实名字在执行时按同名冲突规则确定）。 */
  distro: string;
  /** 给人看的代价（下载/磁盘/预计时间）。 */
  costText: string;
}

export type ProviderId =
  | 'linux-native'
  | 'linux-managed'
  | 'win-wsl2'
  | 'win-wsl2-pending'
  | 'win-wsl-required'
  | 'macos-native'
  | 'unsupported';

export type CoverageSemantic = 'full' | 'partial' | 'none';

export interface ToolchainManifest {
  /** gcc-style toolchain (managed or WSL2/Linux system kernel). */
  gcc: string;
  /** clang (macOS system CLT). */
  clang: string;
  cmake: string;
  conan: string;
  ninja: string;
  python: string;
  lcov: string;
}

/** Canonical, version-pinned manifest (the ONLY source of truth for versions). */
export const TOOLCHAIN_MANIFEST: ToolchainManifest = {
  gcc: '13.2', // managed gcc toolchain (Linux/WSL2 lane)
  clang: '16', // macOS system CLT baseline
  cmake: '4.x', // pinned at provision time from the conan-required line
  conan: '2.x',
  ninja: '1.11+',
  python: '3.11+',
  lcov: '2.x',
};

export interface HostCapabilities {
  platform: NodeJS.Platform | string;
  arch: string;
  /** wsl.exe present and callable (Windows). */
  wslAvailable: boolean;
  /** A default WSL2 distro is ready to use. */
  wslDefaultReady: boolean;
  /** Virtualization enabled (best effort on Windows). */
  virtualizationEnabled: boolean;
  isAdmin: boolean;
  /** Free bytes on the storage drive (undefined = unknown). */
  diskFreeBytes?: number;
  /** VS Build Tools / MSVC present (Windows compatibility mode). */
  msvcAvailable: boolean;
  /** apt-get present (Debian/Ubuntu family — the managed-lane provisioning path). */
  linuxApt: boolean;
  /** uid 0 or passwordless `sudo -n` — can run root apt self-heal non-interactively. */
  linuxAptSudo: boolean;
}

export interface ProviderDecision {
  provider: ProviderId;
  /** Human reason (zh) shown on the dashboard env block. */
  reason: string;
  /** T17：托管车道可**自建**宿主（目前只有 Windows 自建 WSL2 发行版）。 */
  setup?: LaneSetup;
  /** Coverage semantic this provider guarantees. */
  coverage: CoverageSemantic;
  /** The manifest slice this provider must satisfy. */
  manifest: ToolchainManifest;
  /** Extra human note (zh), e.g. how to upgrade to full semantics. */
  note: string;
}

const MAN = TOOLCHAIN_MANIFEST;

const PROVIDER_LABEL: Record<ProviderId, string> = {
  'linux-native': 'Linux 原生（系统 gcc，未隔离）',
  'linux-managed': 'Linux · 派生 managed（隔离 gcc-13 + lcov 全语义）',
  'win-wsl2': 'Windows · WSL2 托管 distro（gcc + lcov 全语义）',
  'win-wsl2-pending': 'Windows · WSL2 已装但无发行版（需创建托管 distro）',
  'win-wsl-required': 'Windows · 需要启用 WSL2（或设 toolchain=system 用本机 MSVC）',
  'macos-native': 'macOS 原生（clang；覆盖率暂不支持）',
  unsupported: '暂不支持该平台',
};

export function providerLabel(id: ProviderId): string {
  return PROVIDER_LABEL[id];
}

/** Minimal free-disk guidance (MB) before we warn about provisioning. */
export const MIN_FREE_MB = 2048;

/**
 * Parse the `HET_FAKE_HOST` JSON override (tests + zero-manual harness simulate
 * "a brand new machine" by injecting capabilities). Returns a partial object to
 * merge over real detection.
 */
export function parseFakeHost(json?: string): Partial<HostCapabilities> {
  if (!json || !json.trim()) {
    return {};
  }
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    const out: Partial<HostCapabilities> = {};
    if (typeof raw.platform === 'string') {
      out.platform = raw.platform;
    }
    if (typeof raw.arch === 'string') {
      out.arch = raw.arch;
    }
    for (const k of ['wslAvailable', 'wslDefaultReady', 'virtualizationEnabled', 'isAdmin', 'msvcAvailable', 'linuxApt', 'linuxAptSudo'] as const) {
      if (typeof raw[k] === 'boolean') {
        out[k] = raw[k];
      }
    }
    if (typeof raw.diskFreeBytes === 'number') {
      out.diskFreeBytes = raw.diskFreeBytes;
    }
    return out;
  } catch {
    return {};
  }
}

function lowDisk(caps: HostCapabilities): boolean {
  if (caps.diskFreeBytes === undefined) {
    return false;
  }
  return caps.diskFreeBytes < MIN_FREE_MB * 1024 * 1024;
}

/**
 * Provider preferences (reserved for future user toggles).
 * Kept as an opaque bag so future keys do not ripple through signatures.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ProvisionPrefs {
  // (empty — MinGW fallback removed; add future toggles here)
}

/**
 * Provider selection — deterministic, capability-first.
 *
 * Linux semantics (A3, derived-first): when apt + passwordless-root are both
 * available the host can self-provision the ISOLATED managed lane
 * (`~/.het-fti/managed-env` private venv + CONAN_HOME + generated gcc-13
 * profile + root apt self-heal), so `linux-managed` wins — deterministic,
 * never touching the system env. `linux-native` stays for hosts without that
 * provisioning path (no apt / no passwordless root) and for explicit
 * `toolchain: system` overrides (handled by the caller).
 *
 * Windows semantics:
 *   WSL2 present + distro ready → win-wsl2 (full, Linux-identical);
 *   WSL2 present but NO distro  → win-wsl2-pending (guide to create one);
 *   no usable WSL2 → win-wsl-required (guide: enable WSL2 or set
 *                     `toolchain: system` for the explicit MSVC compat mode);
 *   MSVC is NEVER auto-chosen — only an explicit `toolchain: system` override
 *   (handled by the caller) routes to the MSVC compatibility mode.
 */
export function resolveProviderDecision(caps: HostCapabilities, _prefs?: ProvisionPrefs): ProviderDecision {
  if (caps.platform === 'linux') {
    if (caps.linuxApt && caps.linuxAptSudo) {
      // Derived-first: the host can self-provision the isolated managed lane.
      return {
        provider: 'linux-managed',
        reason: 'Linux：隔离 managed lane（派生优先，不 touch 系统环境）',
        coverage: 'full',
        manifest: MAN,
        note: lowDisk(caps)
          ? '磁盘空间偏低，准备环境可能需要 ≥2 GB。'
          : '托管 lane 位于 ~/.het-fti/managed-env（私有 venv + CONAN_HOME + gcc-13/lcov 免密自愈）；设 metadata.toolchain=system 可显式回本机原生。',
      };
    }
    // No self-provisioning path → native system gcc (explicit, honest note).
    const why = caps.linuxApt
      ? '检测到 apt 但无免密 root（uid0 或 `sudo -n`）；托管 lane 的 root 自愈需要其一。'
      : '未检测到 apt（托管 lane 需 Debian/Ubuntu 系 apt 自愈）。';
    return {
      provider: 'linux-native',
      reason: 'Linux：系统内核 + 本机 gcc（未隔离）',
      coverage: 'full',
      manifest: MAN,
      note: lowDisk(caps)
        ? '磁盘空间偏低，准备环境可能需要 ≥2 GB。'
        : `${why} 设 metadata.toolchain=system 用本机 gcc；或提供免密 root 后重开工作区以启用派生 managed。`,
    };
  }
  if (caps.platform === 'darwin') {
    return {
      provider: 'macos-native',
      reason: 'macOS：系统 clang（覆盖率暂不支持：Apple clang 无 GNU gcov/lcov，llvm-cov 适配列入后续）',
      coverage: 'none',
      manifest: MAN,
      note: lowDisk(caps) ? '磁盘空间偏低，准备环境可能需要 ≥2 GB。' : '构建语义完整（真机 CI 验证）；覆盖率请使用 Linux/WSL lane。',
    };
  }
  if (caps.platform === 'win32') {
    if (caps.wslAvailable && caps.wslDefaultReady) {
      return {
        provider: 'win-wsl2',
        reason: 'Windows：经 WSL2 托管 distro（het-fcpp）执行，与 Linux 构造性同语义',
        coverage: 'full',
        manifest: MAN,
        note: caps.virtualizationEnabled
          ? '覆盖率由 WSL2 内 gcov/lcov 全量支持。'
          : '虚拟化未确认：WSL2 可能无法启动，将引导创建发行版。',
      };
    }
    if (caps.wslAvailable && !caps.wslDefaultReady) {
      // WSL exists but no distro: guide to create one — never degrade.
      return {
        provider: 'win-wsl2-pending',
        reason: 'Windows：检测到 WSL2，但尚无可用发行版',
        coverage: 'partial',
        manifest: MAN,
        setup: { kind: 'wsl-import', distro: laneDistroBaseName(), costText: laneImportCostText() },
        note:
          '可直接「一键自建私有发行版」（' + laneImportCostText() + '），不会改动你已有的发行版；' +
          '也可自行安装官方发行版（`wsl --install -d Ubuntu-24.04`），或设 metadata.toolchain=system 走本机兼容模式。',
      };
    }
    // No usable WSL2 → explicit guidance only (no silent gcc-style fallback;
    // MinGW lane was removed as a non-self-provisioned degradation channel).
    return {
      provider: 'win-wsl-required',
      reason: 'Windows：无可用 WSL2（托管车道需要启用 WSL2）',
      coverage: 'none',
      manifest: MAN,
      note: caps.msvcAvailable
        ? '请启用 WSL2（`wsl --install -d Ubuntu-24.04`，需虚拟化）以获得完整语义；或在项目 metadata 显式设 toolchain=system 走本机 MSVC 兼容模式（无覆盖率）。'
        : '请启用 WSL2（`wsl --install -d Ubuntu-24.04`，需虚拟化）；托管车道会在构建时自动准备 gcc/lcov 全套工具，无需手动安装。',
    };
  }
  return {
    provider: 'unsupported',
    reason: `平台 ${caps.platform} 暂不支持`,
    coverage: 'none',
    manifest: MAN,
    note: '请在 Linux / Windows / macOS 上使用。',
  };
}
