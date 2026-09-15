/**
 * T01/T02 (兼容性收敛 P0): lane compiler & arch LADDER — pure module.
 *
 * 背景（E1/E2/E5）：车道此前把编译器写死 `/usr/bin/gcc-13`、把架构写死
 * `x86_64`，探针却只检查"有没有 gcc"。于是任何非 Ubuntu-24.04 形状的宿主
 * （22.04 无 gcc-13 / 25.04 默认 gcc-14 / arm64 / 复用任意发行版）都会在
 * conan create 深处报 `not a full path to an existing compiler tool`。
 *
 * 本模块是**唯一允许出现 CI 事实**的地方，并把它变成阶梯：
 *   首选 gcc-13（CI 基线）→ 兼容 14 / 15 / 12 → 发行版默认 gcc（12–15）
 *   都拿不到 → guide（PPA / 升级 24.04 / toolchain=system）——绝不静默降级。
 *
 * 规则（写进类型与 CI 审计 T22）：
 *   - 选中的**实际**编译器路径/版本必须如实写入 conan profile（绝不说谎）；
 *   - 架构来自宿主探测（uname -m），不支持时明确报错，不得沿用 CI 的 x86_64；
 *   - gcov 与所选编译器对齐（E5）——通过 lane venv 内的 shim，不碰系统文件。
 *
 * Pure (no vscode / fs / exec): fully unit-testable.
 */
import { basename } from 'node:path';
import { managedProfile } from './managedEnv';

export type LaneBaseline = 'ci' | 'compatible' | 'native';

/** A concrete compiler the lane can use (facts, never a guess). */
export interface LaneCompiler {
  /** gcc-13 / gcc-14 / gcc（发行版默认别名）. */
  name: string;
  cc: string;
  cxx: string;
  /** Major version written into the conan profile (must match reality). */
  version: string;
  libcxx: string;
  /** 'ci' = manifest baseline (gcc 13, ubuntu-24.04 runner), 'compatible' = accepted fallback. */
  baseline: LaneBaseline;
}

export interface LaneFacts {
  /** Raw `uname -m` (e.g. x86_64 / aarch64). */
  archRaw: string;
  /** conan arch setting (x86_64 / armv8); '' = unsupported → caller must block. */
  arch: string;
  compiler?: LaneCompiler;
  /** Absolute path of the gcov matching the chosen compiler. */
  gcov?: string;
  /** `lcov --version` first line when present. */
  lcov?: string;
}

/** Ladder slots probed in order (name:version:baseline). CI baseline first. */
export const COMPILER_LADDER: ReadonlyArray<{ name: string; version: string; baseline: LaneBaseline }> = [
  { name: 'gcc-13', version: '13', baseline: 'ci' },
  { name: 'gcc-14', version: '14', baseline: 'compatible' },
  { name: 'gcc-15', version: '15', baseline: 'compatible' },
  { name: 'gcc-12', version: '12', baseline: 'compatible' },
];

/**
 * Best-effort apt attempts (in order) when the ladder finds nothing.
 * 1) CI baseline (24.04+, Debian 13) 2) newer default (25.04+) 3) jammy's gcc-12
 * (jammy 仓库**没有** gcc-13 —— 已核实 packages.ubuntu.com，故必须有第二级).
 */
export const GCC_APT_ATTEMPTS: ReadonlyArray<readonly string[]> = [
  ['gcc-13', 'g++-13'],
  ['gcc-14', 'g++-14'],
  ['gcc-12', 'g++-12'],
];

/**
 * Deterministic probe script (runs INSIDE the lane, bash). Line-oriented
 * `key:value` output survives both the WSL file transport and local bash;
 * the parser below is pure. Includes arch + compiler ladder + gcov + lcov so
 * status/ensure/verify all read the SAME facts (no probe/requirement drift).
 */
export function laneFactsScript(): string {
  return [
    'set -u',
    `printf 'lane_arch_raw:%s\\n' "$(uname -m 2>/dev/null || echo unknown)"`,
    'hit=""',
    'ver=""',
    'for spec in gcc-13:13:ci gcc-14:14:compatible gcc-15:15:compatible gcc-12:12:compatible; do',
    '  name="${spec%%:*}"',
    '  rest="${spec#*:}"',
    '  ver="${rest%%:*}"',
    '  if command -v "$name" >/dev/null 2>&1 && command -v "g++-$ver" >/dev/null 2>&1; then',
    `    printf 'lane_cc:%s\\n' "$(command -v "$name")"`,
    `    printf 'lane_cxx:%s\\n' "$(command -v "g++-$ver")"`,
    `    printf 'lane_cc_name:%s\\n' "$name"`,
    `    printf 'lane_cc_version:%s\\n' "$ver"`,
    `    printf 'lane_cc_baseline:%s\\n' "\${rest##*:}"`,
    '    hit=1',
    '    break',
    '  fi',
    'done',
    'if [ -z "$hit" ]; then',
    '  if command -v gcc >/dev/null 2>&1 && command -v g++ >/dev/null 2>&1; then',
    '    ver="$(gcc -dumpversion 2>/dev/null | cut -d. -f1)"',
    `    printf 'lane_cc:%s\\n' "$(command -v gcc)"`,
    `    printf 'lane_cxx:%s\\n' "$(command -v g++)"`,
    '    printf \'lane_cc_name:gcc\\n\'',
    `    printf 'lane_cc_version:%s\\n' "\${ver:-?}"`,
    '    printf \'lane_cc_baseline:compatible\\n\'',
    '    hit=1',
    '  fi',
    'fi',
    'printf \'lane_cc_hit:%s\\n\' "${hit:-0}"',
    'gcov_path=""',
    'if [ -n "$hit" ] && [ -n "$ver" ]; then',
    '  for cand in "/usr/bin/gcov-$ver" "$(command -v "gcov-$ver" 2>/dev/null || true)"; do',
    '    if [ -n "$cand" ] && [ -x "$cand" ]; then gcov_path="$cand"; break; fi',
    '  done',
    'fi',
    'if [ -z "$gcov_path" ] && command -v gcov >/dev/null 2>&1; then gcov_path="$(command -v gcov)"; fi',
    `printf 'lane_gcov:%s\\n' "\${gcov_path:--}"`,
    `printf 'lane_lcov:%s\\n' "$([ -x /usr/bin/lcov ] && lcov --version 2>/dev/null | head -1 || echo -)"`,
  ].join('\n');
}

/** Map `uname -m` to the conan arch setting ('' = not supported by the lane). */
export function mapLaneArch(raw: string): string {
  const m = raw.trim().toLowerCase();
  if (m === 'x86_64' || m === 'amd64') {
    return 'x86_64';
  }
  if (m === 'aarch64' || m === 'arm64') {
    return 'armv8';
  }
  return '';
}

/** Parse the `lane_*` facts script output (pure; tolerant to noise/CRLF). */
export function parseLaneFacts(text: string): LaneFacts {
  const kv: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const i = raw.indexOf(':');
    if (i <= 0) {
      continue;
    }
    const key = raw.slice(0, i).trim();
    const value = raw.slice(i + 1).trim();
    if (key.startsWith('lane_') && value && value !== '-') {
      kv[key] = value;
    }
  }
  const archRaw = kv['lane_arch_raw'] ?? '';
  const facts: LaneFacts = { archRaw, arch: mapLaneArch(archRaw) };
  if (kv['lane_cc'] && kv['lane_cxx'] && kv['lane_cc_version']) {
    facts.compiler = {
      name: kv['lane_cc_name'] ?? basename(kv['lane_cc']),
      cc: kv['lane_cc'],
      cxx: kv['lane_cxx'],
      version: kv['lane_cc_version'],
      libcxx: 'libstdc++11',
      baseline: kv['lane_cc_baseline'] === 'ci' ? 'ci' : kv['lane_cc_baseline'] === 'native' ? 'native' : 'compatible',
    };
  }
  if (kv['lane_gcov']) {
    facts.gcov = kv['lane_gcov'];
  }
  if (kv['lane_lcov']) {
    facts.lcov = kv['lane_lcov'];
  }
  return facts;
}

/**
 * Generated conan profile for a compiler fact + host arch, on a given OS
 * (macOS uses apple-clang/libc++; Linux uses gcc/libstdc++11).
 */
export function laneProfileWith(
  os: 'Linux' | 'Macos',
  compiler: LaneCompiler,
  arch: string,
  buildType = 'Release',
  cppstd = '17',
): string {
  return managedProfile(
    { cc: compiler.cc, cxx: compiler.cxx, version: compiler.version, libcxx: compiler.libcxx },
    os,
    arch,
    buildType,
    cppstd,
  );
}

/** Generated conan profile for the CHOSEN compiler + host arch (never guessed). */
export function laneProfileFor(compiler: LaneCompiler, arch: string, buildType = 'Release', cppstd = '17'): string {
  return laneProfileWith('Linux', compiler, arch, buildType, cppstd);
}

/** Short human note for logs/contracts: baseline vs compatible vs native mode. */
export function baselineNote(compiler: LaneCompiler): string {
  if (compiler.baseline === 'ci') {
    return `编译器 ${compiler.name}（与 CI 同基线）`;
  }
  if (compiler.baseline === 'native') {
    return `编译器 ${compiler.name}（系统原生）`;
  }
  return `编译器 ${compiler.name}（兼容模式 · 覆盖率口径可能与 CI 有差异）`;
}

/**
 * Actionable guidance when no usable compiler could be found/installed.
 * Three options, copy-paste ready — this is the replacement for the previous
 * deep CMake failure (`not a full path to an existing compiler tool`).
 */
export function laneCompilerGuide(): string {
  return [
    '托管工具链缺少可用的 gcc/g++（CI 基线为 gcc-13，允许 12–15 的兼容版本）。请在发行版内任选一条：',
    '  ① 安装 CI 基线编译器：sudo apt-get update && sudo apt-get install -y gcc-13 g++-13',
    '  ② 使用发行版自带编译器：sudo apt-get install -y gcc g++（12–15 任一版本）',
    '  ③ 本项目改用本机工具链：把 metadata.json 的 toolchain 设为 "system"（形如 "toolchain": "system"）',
    '（Ubuntu 22.04 的仓库不含 gcc-13：可用 ②，或先加 PPA：sudo add-apt-repository ppa:ubuntu-toolchain-r/test）',
  ].join('\n');
}

/**
 * Honest message when the host arch is outside the MANAGED lane's contract.
 *
 * Policy (maintainer decision 2026-09-14): arm64 = macOS (macos-latest, handled
 * by the macOS-native lane, which never calls these helpers); the managed
 * Linux/WSL lanes commit to x86_64 only. macOS x64 is NOT supported anymore.
 */
export function unsupportedArchMessage(archRaw: string): string {
  return [
    `托管车道（Linux/WSL2）目前只承诺 x86_64；当前宿主架构为 ${archRaw || '未知'}。`,
    '（arm64 由 macOS 原生车道承担：macos-latest；macOS x64 不再兼容。）',
    '请改用 metadata.json 的 "toolchain": "system" 走本机工具链，或换用受支持的机器。',
  ].join('\n');
}

/* -------------------------------------------------------------------------- *
 * CMake: which binary may the NATIVE (toolchain=system) build use?
 *
 * Mirrors the template's `cmake_minimum_required` default (see
 * assets/template/CMakeLists.txt); the template already understands
 * `-DHET_CMAKE_MIN=<ver>` to lower it, so this is a POLICY floor, not a
 * technical one. The lane passes `HET_CMAKE_BUILD_REQUIRE=none` and uses its
 * own venv cmake; before this the NATIVE path always let the template pull
 * `cmake/<metadata.cmake_version>` from ConanCenter — i.e. "use your own
 * toolchain" still downloaded a ~40 MB CMake and failed on intranets.
 * -------------------------------------------------------------------------- */

/** Template `cmake_minimum_required` default (policy floor, see U1/ADR-1). */
export const CMAKE_MIN_DEFAULT = '3.28';

const VERSION_IN_TEXT = /\d+(?:\.\d+){0,3}/;

/** First dotted version found in a version line ('cmake version 3.31.6' → [3,31,6]). */
export function parseVersion(text: string | undefined | null): number[] | undefined {
  const m = text ? VERSION_IN_TEXT.exec(text) : null;
  return m ? m[0].split('.').map((n) => Number.parseInt(n, 10)) : undefined;
}

/**
 * Compare two dotted versions. Missing components count as 0.
 * Returns -1 (a<b) / 0 (equal or unknown) / 1 (a>b) — "unknown" never blocks.
 */
export function compareVersions(a: string | undefined | null, b: string | undefined | null): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) {
    return 0;
  }
  for (let i = 0; i < Math.max(va.length, vb.length); i += 1) {
    const x = va[i] ?? 0;
    const y = vb[i] ?? 0;
    if (x !== y) {
      return x > y ? 1 : -1;
    }
  }
  return 0;
}

/** Effective CMake floor: `HET_CMAKE_MIN` (template contract) wins over the default. */
export function effectiveCmakeFloor(envValue?: string | null): string {
  const v = (envValue ?? '').trim();
  return v.length > 0 ? v : CMAKE_MIN_DEFAULT;
}

export interface NativeCmakePlan {
  /** true → the native build may use the host cmake (no ConanCenter download). */
  useHost: boolean;
  /** Value to export as `HET_CMAKE_BUILD_REQUIRE`. */
  buildRequire: string;
  /** One-line reason for the build log. */
  reason: string;
  /** Actionable paths when the host cmake cannot be used ('' when useHost). */
  guide: string;
}

/**
 * Decide which CMake a NATIVE build uses.
 *  - host cmake ≥ floor → `HET_CMAKE_BUILD_REQUIRE=none` (主机工具，一份 CMake)
 *  - otherwise          → keep the template's pinned ConanCenter cmake, said
 *                         out loud with the three exact ways out (never a silent
 *                         download).
 */
export function nativeCmakePlan(hostVersion: string | undefined | null, floor = CMAKE_MIN_DEFAULT, pinned = ''): NativeCmakePlan {
  const meets = compareVersions(hostVersion, floor) >= 0 && !!parseVersion(hostVersion);
  if (meets) {
    return {
      useHost: true,
      buildRequire: 'none',
      reason: `宿主 cmake ${parseVersion(hostVersion)!.join('.')} ≥ 下限 ${floor} → 使用宿主 cmake（不再从 ConanCenter 拉取）`,
      guide: '',
    };
  }
  const shown = hostVersion ? parseVersion(hostVersion)?.join('.') ?? hostVersion.trim() : '未找到';
  const pin = pinned.trim().length > 0 ? pinned.trim() : 'metadata.cmake_version';
  return {
    useHost: false,
    buildRequire: '',
    reason: `宿主 cmake ${shown} 不满足模板下限 ${floor} → 本次改用模板钉死的 cmake/${pin}（ConanCenter，需联网）`,
    guide: [
      `宿主 CMake 不满足模板下限 ${floor}（当前：${shown}）。本次构建将从 ConanCenter 拉取模板钉死的 cmake/${pin}，需要联网。三条出路：`,
      `  ① 安装 cmake ≥ ${floor}：Linux sudo apt-get install -y cmake ｜ macOS brew install cmake ｜ Windows winget install Kitware.CMake`,
      `  ② 若工程不需要 ${floor} 的新特性：自降底线 -DHET_CMAKE_MIN=${shown === '未找到' ? '3.22' : shown}（或在环境变量里设 HET_CMAKE_MIN）`,
      '  ③ 改回 "toolchain": "managed"：托管车道自带 cmake（无需联网拉取）',
    ].join('\n'),
  };
}
