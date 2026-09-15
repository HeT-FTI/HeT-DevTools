/**
 * V5-1: WSL2 managed build lane — pure helpers.
 *
 * The Windows "managed" toolchain lane runs `conan create` INSIDE a Linux
 * distro via wsl.exe: Linux semantics by construction (gcc + gcov/lcov, same
 * as Linux hosts), fully isolated from whatever the user has inside the distro
 * (conda base / FEniCS envs / other toolchains) by using a private venv under
 * `~/.het-fti/managed-env`, a private CONAN_HOME and a GENERATED (never
 * detected) conan profile.
 *
 * Pure module (no vscode): layout, command strings and output mapping — unit
 * testable. The wsl.exe execution layer lives in features/env/wslLane.
 */
import { posix } from 'node:path';
import { LaneCompiler, laneProfileFor } from './laneProfile';
import { LaneMirror, conanRemoteUpdateLine, mirrorShellExports } from './laneMirror';
import { laneSettingsEnsureSteps, profileCompilerVersion } from './laneSettings';
import { lanePythonFloorGuardSteps, laneVenvBootstrapSteps } from './lanePython';

/** Lane root & tools inside the distro's Linux home (ext4 — venv-safe). */
export interface WslLaneLayout {
  root: string;
  venv: string;
  conanHome: string;
  profilesDir: string;
  profile: string;
  marker: string;
}

/**
 * Where the lane lives (always under `~/.het-fti/managed-env`).
 *
 * The conan home is deliberately named `.conan2` (not `conan2`): the fcpp
 * template's coverage step hard-codes the cache layout glob ending in
 * `/.conan2/p/b/…` (the GitHub CI default is `CONAN_HOME=~/.conan2`). A
 * differently-named home
 * (e.g. `…/conan2`) makes `lcov --extract` match nothing → local coverage
 * fails while the online Action passes. Naming it `.conan2` keeps the lane
 * byte-identical to CI semantics while still isolated under managed-env.
 */
export function wslLaneLayout(home: string): WslLaneLayout {
  const root = posix.join(home, '.het-fti', 'managed-env');
  const conanHome = posix.join(root, '.conan2');
  const profilesDir = posix.join(conanHome, 'profiles');
  return {
    root,
    venv: posix.join(root, 'venv'),
    conanHome,
    profilesDir,
    profile: posix.join(profilesDir, 'default'),
    marker: posix.join(root, '.het-wsl-lane.json'),
  };
}

/**
 * T01/T02: the lane compiler AND arch are NOT pinned here anymore.
 *
 * They come from the facts probe + ladder in `core/laneProfile` (the single
 * place where CI facts are allowed to live): gcc-13 baseline → 14/15/12
 * compatible → distro default, with the host arch probed via `uname -m`.
 * Hard-coding `/usr/bin/gcc-13` + `x86_64` here was the E1/E2 bug class
 * (see workspace/develope/env-onboarding-plan.md).
 */
export interface LaneEnsureOptions {
  /** Chosen compiler facts — echoed back into the lane report/contract. */
  compiler?: LaneCompiler;
  /** conan arch setting derived from the host (x86_64 / armv8). */
  arch?: string;
  /** gcov matching the chosen compiler (written as a venv-local shim). */
  gcov?: string;
  /** conan settings.yml key for this lane's compiler (`apple-clang` / `gcc`). */
  settingsCompiler?: string;
  /** T18: corporate mirror/proxy (pip index · conan remote · http proxy). */
  mirror?: LaneMirror;
}

/**
 * Idempotent bootstrap script (runs as the distro's default user):
 *   1. mkdir lane/conan2/profiles
 *   2. create a private venv (prefers /usr/bin/python3, falls back to any
 *      python3/python on PATH — e.g. the user's conda base) and pip install
 *      conan/cmake/ninja into it (only when conan is missing)
 *   3. write the generated default profile (never detected)
 *   4. CONAN_HOME marker
 *   5. report lane tool versions (conan/cmake/selected compiler/lcov) + the
 *      gcov shim that keeps coverage aligned with the chosen compiler
 * Never touches the user's conda envs: nothing is installed into base, no
 * `pip install --user`, no profile detection.
 */
export function wslLaneEnsureCommand(home: string, profileText: string, opts: LaneEnsureOptions = {}): string {
  const l = wslLaneLayout(home);
  const venvBin = posix.join(l.venv, 'bin');
  const steps = [
    'set -e',
    ...mirrorShellExports(opts.mirror),
    `DIR="${l.root}"`,
    // One-time migration (V5-6): the conan home was `…/managed-env/conan2`;
    // CI-parity coverage needs the literal `…/.conan2/…` cache layout.
    `[ -d "${posix.join(l.root, 'conan2')}" ] && [ ! -d "${l.conanHome}" ] && mv "${posix.join(l.root, 'conan2')}" "${l.conanHome}"`,
    `mkdir -p "${l.profilesDir}"`,
    // The lane owns a private venv but uses the HOST's Python (never installs
    // one). Preference order + the docs floor live in ./lanePython.
    ...laneVenvBootstrapSteps(l.venv, LANE_VENV_PIP),
    // T18: point the lane's PRIVATE conan home at the corporate mirror (if any).
    ...(conanRemoteUpdateLine(opts.mirror, venvBin) ? [conanRemoteUpdateLine(opts.mirror, venvBin) as string] : []),
    `cat > "${l.profile}" <<'HET_WSL_PROFILE'`,
    profileText,
    'HET_WSL_PROFILE',
    // conan's settings.yml is a closed vocabulary: a brand-new compiler version
    // makes EVERY build fail (`Invalid setting '21.0.0' …`). Teach the lane's
    // own copy before any build runs (never the user's).
    ...laneSettingsEnsureSteps(opts.settingsCompiler ?? '', profileCompilerVersion(profileText), venvBin, l.conanHome),
    `touch "${posix.join(l.conanHome, '.conan_home_marker')}"`,
    ...gcovShimSteps(opts.gcov, venvBin),
    `echo lane_conan:$(${posix.join(venvBin, 'conan')} --version 2>/dev/null | head -1 || echo -)`,
    `echo lane_cmake:$(${posix.join(venvBin, 'cmake')} --version 2>/dev/null | head -1 || echo -)`,
    `echo lane_arch:${opts.arch ?? '-'}`,
    `echo lane_cc_selected:${opts.compiler?.cc ?? '-'}`,
    `echo lane_cc_version:${opts.compiler?.version ?? '-'}`,
    `echo lane_cc_baseline:${opts.compiler?.baseline ?? '-'}`,
    'echo lane_lcov:$([ -x /usr/bin/lcov ] && lcov --version | head -1 || echo -)',
  ];
  return steps.join('\n');
}

/**
 * E5: lcov's geninfo resolves the UNVERSIONED `gcov` from PATH, while the lane
 * may build with gcc-14/12. A venv-local shim pins gcov to the chosen compiler
 * (the build command prepends the venv bin to PATH) without touching /usr/bin.
 */
function gcovShimSteps(gcov: string | undefined, venvBin: string): string[] {
  if (!gcov) {
    return [];
  }
  const shim = posix.join(venvBin, 'gcov');
  return [
    `cat > "${shim}" <<'HET_GCOV_SHIM'`,
    '#!/bin/sh',
    `exec "${gcov}" "$@"`,
    'HET_GCOV_SHIM',
    `chmod +x "${shim}"`,
  ];
}

/**
 * The `conan create` command inside the lane (runs from `cwdWsl`).
 *
 * `forceSelf` (V5-6): when a coverage-enabled project builds, the project's
 * own cached package is REMOVED first (`conan remove <name>/* --confirm`),
 * so conan rebuilds it from source with CURRENT absolute paths — exactly like
 * the GitHub CI (a fresh runner + end-of-job `conan remove`). This avoids two
 * real failure modes:
 *   - after the one-time lane CONAN_HOME rename (…/conan2 → …/.conan2) conan
 *     would otherwise reuse the pre-rename build whose .gcda embed
 *     moved-away paths → geninfo cannot open dependency headers;
 *   - the template's coverage step copies .gcda from the FIRST `conan list`
 *     package id — with multiple stale binaries it can pick the wrong one.
 */
export function wslLaneBuildCommand(cwdWsl: string, home: string, buildType = 'Debug', forceSelf?: string, profiles: string[] = []): string {
  const l = wslLaneLayout(home);
  const lines = [
    'set -o pipefail',
    `export PATH="${posix.join(l.venv, 'bin')}:$PATH"`,
    `export CONAN_HOME="${l.conanHome}"`,
    'unset CONDA_PREFIX CONDA_DEFAULT_ENV CONDA_PROMPT_MODIFIER 2>/dev/null || true',
  ];
  if (forceSelf) {
    lines.push(`conan remove "${forceSelf}/*" --confirm || true`);
  }
  // T11: user profiles (het.conan.profiles / HET_CONAN_PROFILES) apply INSIDE
  // the lane too — they used to be read only by the native branch, so the
  // documented escape hatch silently did nothing on the default path.
  const profileArgs = profiles.filter((p) => p.trim().length > 0).map((p) => `-pr "${p}"`).join(' ');
  lines.push(
    // T09: when the lane already provides CMake (private venv), skip the
    // template's ConanCenter `cmake/<version>` build_requires — one CMake
    // download instead of two, CI keeps its pinned behavior.
    `if [ -x "${posix.join(l.venv, 'bin', 'cmake')}" ]; then export HET_CMAKE_BUILD_REQUIRE=none; fi`,
    `cd "${cwdWsl}"`,
    `conan create . -s build_type=${buildType} --build=missing${profileArgs ? ` ${profileArgs}` : ''}`,
  );
  return lines.join('\n');
}

/**
 * 车道 ensure 脚本打印的 `lane_*` 自证行（一行一事实：解释器/venv/conan/cmake/
 * settings/gcov shim/编译器/架构/lcov）。它们此前只存在于脚本的 stdout 里，
 * 成功了就丢掉 —— 于是"车道真的备好了什么"在 IDE 日志和 CI 日志里都看不见，
 * 只能靠"没抛异常"反推。上层（三个车道执行层）现在会把它们逐行打进日志。
 *
 * 纯函数 → 可单测。
 */
export function laneReportLines(stdout: string): string[] {
  return (stdout ?? '')
    .split(/\r?\n/u)
    .map((l) => l.trim())
    .filter((l) => /^lane_[a-z0-9_]+:/u.test(l));
}

/** V5-4: pip packages for the docs stack (loose pins, per the manifest). */
export const WSL_DOCS_PIP = ['"numpy>=1.26"', '"sphinx>=8,<9"', 'sphinx-intl', '"sphinx-rtd-theme>=2,<4"'];

/** Lane build tooling installed into the private venv (conan drives cmake/ninja). */
export const LANE_VENV_PIP = ['"conan>=2.0,<3"', '"cmake>=4.0,<5"', '"ninja>=1.11"'];

/**
 * V5-4: idempotent docs-stack bootstrap inside the lane venv (runs as the
 * default user). System packages (doxygen/graphviz/make) are installed by the
 * host via passwordless root apt — never through the user's conda envs.
 */
export function wslLaneDocsEnsureCommand(home: string, opts: LaneEnsureOptions = {}): string {
  const l = wslLaneLayout(home);
  const venvBin = posix.join(l.venv, 'bin');
  return [
    'set -e',
    ...mirrorShellExports(opts.mirror),
    `export PATH="${venvBin}:$PATH"`,
    ...lanePythonFloorGuardSteps(venvBin),
    `if [ ! -x "${posix.join(venvBin, 'sphinx-build')}" ]; then`,
    `  "${posix.join(venvBin, 'pip')}" install --disable-pip-version-check -q ${WSL_DOCS_PIP.join(' ')}`,
    'fi',
    `echo docs_sphinx:$([ -x "${posix.join(venvBin, 'sphinx-build')}" ] && sphinx-build --version | head -1 || echo -)`,
    'echo docs_doxygen:$([ -x /usr/bin/doxygen ] && doxygen --version || echo -)',
    'echo docs_dot:$([ -x /usr/bin/dot ] && dot -V 2>&1 | head -1 || echo -)',
    'echo docs_make:$([ -x /usr/bin/make ] && make --version | head -1 || echo -)',
  ].join('\n');
}

/** V5-4: `python docs/build.py` inside the lane (venv python + system tools). */
export function wslLaneDocsRunCommand(cwdWsl: string, home: string): string {
  const l = wslLaneLayout(home);
  return [
    'set -o pipefail',
    `export PATH="${posix.join(l.venv, 'bin')}:/usr/bin:/bin:$PATH"`,
    'unset CONDA_PREFIX CONDA_DEFAULT_ENV CONDA_PROMPT_MODIFIER 2>/dev/null || true',
    `cd "${cwdWsl}"`,
    'python docs/build.py',
  ].join('\n');
}

/**
 * Map WSL-side compiler paths back to Windows drive paths for the Problems
 * panel: `/mnt/c/Users/…/src/a.cpp` → `C:/Users/…/src/a.cpp`. Linux-only
 * paths (`/home/…`) and relative paths are left untouched.
 */
export function wslOutToWin(output: string): string {
  return output.replace(/\/mnt\/([a-zA-Z])\//g, (_m, drive: string) => `${drive.toUpperCase()}:/`);
}

/**
 * A3 (marketplace-readiness): platform-neutral aliases.
 *
 * Every builder above is plain POSIX shell taking a Linux `home` — nothing
 * references wsl.exe. The WSL lane executes them inside a distro; the native
 * Linux managed lane (`features/env/linuxLane`) executes the SAME commands
 * with local bash + root/sudo-non-interactive apt self-heal. The aliases give
 * the Linux lane a naming that does not imply WSL; behaviour is identical.
 */
export const managedLaneLayout = wslLaneLayout;
export const managedLaneProfile = laneProfileFor;
export const managedLaneEnsureCommand = wslLaneEnsureCommand;
export const managedLaneBuildCommand = wslLaneBuildCommand;
export const managedLaneDocsEnsureCommand = wslLaneDocsEnsureCommand;
export const managedLaneDocsRunCommand = wslLaneDocsRunCommand;
