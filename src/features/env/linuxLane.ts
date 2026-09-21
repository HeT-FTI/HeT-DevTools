/**
 * A3 (marketplace-readiness): native Linux managed lane — execution layer.
 *
 * Architecturally identical to the WSL2 lane (`features/env/wslLane`) but for
 * a host that IS Linux: the SAME platform-neutral pure commands from
 * `core/wslLane` (aliased `managedLane*`) run under LOCAL bash (no wsl.exe,
 * no `/mnt` path mapping) against `~/.het-fti/managed-env` — a private venv
 * (conan/cmake/ninja), a private CONAN_HOME and a GENERATED gcc-13 profile.
 * The root-level self-heal (python3-venv / gcc-13 / lcov / doxygen / graphviz
 * / make) runs through uid-0 apt or passwordless `sudo -n` — never through
 * the user's conda envs, never touching the system environment otherwise.
 *
 * Safe to call on any platform: status probes return `null` off-Linux, and
 * the ensure/build entry points throw with clear guidance if the host cannot
 * self-provision (matching the "no silent degradation" policy).
 *
 * NOTE: this module only runs for real when the extension host IS Linux (the
 * ubuntu CI / a Linux desktop). Locally (Windows dev box) it is validated by
 * unit tests and by the P1-B-5 DoD harness, which executes the SAME pure lane
 * commands inside WSL Ubuntu (Linux semantics by construction).
 */
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, writeFileSync } from 'node:fs';
import { run } from '../../utils/exec';
import { recordAptInstall } from '../../core/laneAptLog';
import { log } from '../../constants';
import type { BuildSummary } from '../../core/conanService';
import {
  managedLaneBuildCommand,
  managedLaneDocsEnsureCommand,
  managedLaneDocsRunCommand,
  laneReportLines,
  managedLaneEnsureCommand,
  managedLaneLayout,
  managedLaneProfile,
} from '../../core/wslLane';
import {
  GCC_APT_ATTEMPTS,
  LaneCompiler,
  LaneFacts,
  baselineNote,
  laneCompilerGuide,
  laneFactsScript,
  parseLaneFacts,
  unsupportedArchMessage,
} from '../../core/laneProfile';
import { settingsCompilerKey } from '../../core/laneSettings';
import { LaneMirror, mirrorCacheKey } from '../../core/laneMirror';

const uidRoot = (() => {
  try {
    return (process.getuid?.() ?? -1) === 0;
  } catch {
    return false;
  }
})();

/** Where the lane lives on a native Linux host ($HOME). */
export function linuxLaneHome(): string {
  return homedir();
}

/** Local bash file transport (mirror of the WSL lane's file transport). */
let scriptSeq = 0;
function writeLinuxScript(content: string): string {
  scriptSeq += 1;
  const p = join(tmpdir(), `het-linux-lane-${process.pid}-${scriptSeq}.sh`);
  writeFileSync(p, content, 'utf8');
  return p;
}

/** Run a lane script with the LOCAL bash (native Linux; rejects on failure to start). */
export async function runLinuxScript(
  content: string,
  timeoutMs = 15_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const f = writeLinuxScript(content);
  try {
    const r = await run('bash', [f], { timeoutMs });
    return { code: r.code ?? -1, stdout: r.stdout, stderr: r.stderr };
  } finally {
    rmSync(f, { force: true });
  }
}

/** uid-0 or passwordless `sudo -n` — can we run root apt non-interactively? */
export async function linuxRootAvailable(): Promise<boolean> {
  if (uidRoot) {
    return true;
  }
  try {
    const r = await run('sudo', ['-n', 'true'], { timeoutMs: 4000 });
    return r.code === 0;
  } catch {
    return false;
  }
}

/** Quiet root apt operation (direct when uid-0, else `sudo -n apt-get …`). */
async function rootAptLinux(...pkgs: string[]): Promise<void> {
  const env = { ...process.env, DEBIAN_FRONTEND: 'noninteractive' };
  // sudo is the COMMAND when not uid-0 — never pass `-n` to apt-get itself
  // (that produced "Command line option 'n' is not understood").
  const runApt = (args: string[]): ReturnType<typeof run> =>
    uidRoot
      ? run('apt-get', args, { timeoutMs: 10 * 60_000, env })
      : run('sudo', ['-n', 'apt-get', ...args], { timeoutMs: 10 * 60_000, env });
  await runApt(['update', '-qq']).catch(() => {
    /* update may fail offline — install will tell us */
  });
  const r = await runApt(['install', '-y', '-qq', ...pkgs]);
  if (r.code !== 0) {
    const tail = `${r.stdout}\n${r.stderr}`.split(/\r?\n/u).filter((s) => s.trim().length > 0).slice(-6).join('\n');
    throw new Error(`root apt 安装失败（${pkgs.join(' ')}）：\n${tail}`);
  }
  // ADR-8：如实记账本车道为系统装过什么 → 「移除托管环境」会列出清单 + 给卸载命令（不自动卸）。
  const added = recordAptInstall(join(linuxLaneHome(), '.het-fti', 'managed-env'), pkgs);
  if (added.length) {
    log(`[env] 车道通过 apt 安装系统包：${added.join('、')}（移除托管环境时只提示，不自动卸载）`);
  }
}

/** Root-level gcov alignment is handled by the venv-local shim written by the
 *  lane ensure command (E5) — no system files are touched anymore. */

let cache: { at: number; home: string; note?: string; mirrorKey?: string } | null = null;

/** T02: read the lane facts (arch + compiler ladder + gcov/lcov) on the native host. */
export async function probeLinuxLaneFacts(): Promise<LaneFacts> {
  try {
    const r = await runLinuxScript(laneFactsScript(), 15_000);
    return r.code === 0 ? parseLaneFacts(r.stdout) : { archRaw: '', arch: '' };
  } catch {
    return { archRaw: '', arch: '' };
  }
}

/**
 * T01: resolve a usable compiler via the LADDER — probe → (nothing usable &&
 * passwordless root) apt attempts → re-probe → honest guidance. The previous
 * hard-coded `/usr/bin/gcc-13` (E1) became an unreadable CMake failure on any
 * host without that exact package (e.g. Ubuntu 22.04: jammy has no gcc-13).
 */
async function resolveLinuxLaneFacts(root: boolean): Promise<LaneFacts & { compiler: LaneCompiler }> {
  let facts = await probeLinuxLaneFacts();
  if (!facts.compiler && root) {
    for (const pkgs of GCC_APT_ATTEMPTS) {
      await rootAptLinux(...pkgs).catch(() => {
        /* best effort: continue down the ladder */
      });
      facts = await probeLinuxLaneFacts();
      if (facts.compiler) {
        break;
      }
    }
  }
  if (!facts.compiler) {
    const sudoHint = root ? '' : '\n当前无免密 root，无法自动安装：请手动执行上面的 ① 或 ②。';
    throw new Error(laneCompilerGuide() + sudoHint);
  }
  if (!facts.arch) {
    throw new Error(unsupportedArchMessage(facts.archRaw));
  }
  return facts as LaneFacts & { compiler: LaneCompiler };
}

/**
 * Idempotent bootstrap of the isolated lane (cached 60 s). Mirrors
 * `ensureWslLane`: creates the private venv + generated profile + CONAN_HOME
 * from the FACTS LADDER (compiler + arch), then SELF-HEALS the root-level
 * system packages when passwordless root is available (python3-venv / the
 * compiler ladder / lcov). Throws with the output tail — and actionable
 * guidance — when provisioning is impossible.
 */
export async function ensureLinuxLane(opts: { mirror?: LaneMirror } = {}): Promise<{ home: string; note?: string; facts?: LaneFacts }> {
  const mirrorKey = mirrorCacheKey(opts.mirror);
  if (cache && Date.now() - cache.at < 60_000 && cache.mirrorKey === mirrorKey) {
    return { home: cache.home, note: cache.note };
  }
  const home = linuxLaneHome();
  const root = await linuxRootAvailable();
  const facts = await resolveLinuxLaneFacts(root);
  const cmd = managedLaneEnsureCommand(home, managedLaneProfile(facts.compiler, facts.arch, 'Release'), {
    compiler: facts.compiler,
    arch: facts.arch,
    gcov: facts.gcov,
    mirror: opts.mirror,
    settingsCompiler: settingsCompilerKey(facts.compiler.name, 'Linux'),
  });
  const runEnsure = (): Promise<{ code: number; stdout: string; stderr: string }> => runLinuxScript(cmd, 15 * 60_000);
  let r = await runEnsure();
  // exit 3 = no python3 that can create venvs (Ubuntu ships the module but
  // not ensurepip) → one-time root apt of python3-venv, then retry.
  if (r.code === 3 && root) {
    await rootAptLinux('python3-venv');
    r = await runEnsure();
  }
  if (r.code === 3 && !root) {
    throw new Error(
      '托管 lane 需要 python3-venv（Ubuntu 默认缺 ensurepip —— 车道本体要用它建私有 venv）。\n' +
        '请执行一次：sudo apt-get install -y python3-venv 后重试。\n' +
        '若你不想动系统包：把设置 het.env.mode 改成 native（用本机工具链），或执行命令「改用本机工具链（system）」。',
    );
  }
  // lcov missing → root self-heal (mirror of the GitHub Action). gcov stays
  // aligned through the venv-local shim handed to the ensure command (E5).
  if (r.code === 0 && /lane_lcov:-\s*$/m.test(`${r.stdout}\n`) && root) {
    await rootAptLinux('lcov');
    r = await runEnsure();
  }
  // 构建链自愈：同 WSL 车道 —— CMake 默认生成器是 "Unix Makefiles"，
  // 缺 make 时源码编译的依赖会以 `CMAKE_MAKE_PROGRAM is not set` 失败
  // （宿主是瘦容器／精简发行版时会遇到；GitHub runner 自带 make，掩盖了这一点）。
  if (r.code === 0 && /lane_make:-\s*$/m.test(`${r.stdout}\n`) && root) {
    await rootAptLinux('make');
    r = await runEnsure();
  }
  if (r.code !== 0) {
    const tail = `${r.stdout}\n${r.stderr}`.split(/\r?\n/u).filter((s) => s.trim().length > 0).slice(-8).join('\n');
    throw new Error(`Linux 托管工具链准备失败（exit=${r.code}）：\n${tail}`);
  }
  cache = { at: Date.now(), home, note: baselineNote(facts.compiler), mirrorKey };
  // 自证行进日志（一行一事实）：与 WSL 车道同口径。
  for (const line of laneReportLines(r.stdout)) {
    log(`[lane] ${line}`);
  }
  return { home, note: cache.note, facts };
}

/**
 * Run `conan create .` inside the native Linux managed lane and return a
 * conanService-compatible summary (output is already native — no path map).
 */
export async function runLinuxConanCreate(
  cwd: string,
  opts: {
    buildType?: 'Debug' | 'Release';
    /** V5-6: force-rebuild the project's own recipe (coverage-enabled runs). */
    forceSelf?: string;
    /** T11: user `-pr` profiles (het.conan.profiles / HET_CONAN_PROFILES). */
    profiles?: string[];
    /** T18: corporate mirror/proxy for the lane's own provisioning. */
    mirror?: LaneMirror;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
    timeoutMs?: number;
  } = {},
): Promise<BuildSummary> {
  const { home } = await ensureLinuxLane({ mirror: opts.mirror });
  const cmd = managedLaneBuildCommand(cwd, home, opts.buildType ?? 'Debug', opts.forceSelf, opts.profiles ?? []);
  const f = writeLinuxScript(cmd);
  let stdout = '';
  let stderr = '';
  try {
    const r = await run('bash', [f], {
      cwd,
      timeoutMs: opts.timeoutMs ?? 0,
      onStdout: (c) => {
        stdout += c;
        opts.onStdout?.(c);
      },
      onStderr: (c) => {
        stderr += c;
        opts.onStderr?.(c);
      },
    });
    return { ok: r.code === 0, code: r.code, stdout, stderr };
  } finally {
    rmSync(f, { force: true });
  }
}

/** Fast, NON-provisioning check that the lane venv already has conan. */
export async function linuxLaneConanPresent(): Promise<boolean> {
  try {
    const home = linuxLaneHome();
    const exe = join(managedLaneLayout(home).venv, 'bin', 'conan');
    const r = await runLinuxScript(`test -x "${exe}" && echo 1`, 8000);
    return r.code === 0 && /1/u.test(r.stdout);
  } catch {
    return false;
  }
}

/** Lane docs-tool fact (native Linux): venv sphinx + system doxygen/dot/make. */
export interface LinuxLaneDocsTools {
  python?: string;
  sphinx?: string;
  doxygen?: string;
  dot?: string;
  make?: string;
}

export async function probeLinuxLaneDocsTools(): Promise<LinuxLaneDocsTools> {
  const script = [
    'P="$HOME/.het-fti/managed-env/venv/bin"',
    'printf "python:"; [ -x "$P/python" ] && "$P/python" --version 2>/dev/null | head -1 || echo -; echo',
    'printf "sphinx:"; [ -x "$P/sphinx-build" ] && "$P/sphinx-build" --version 2>/dev/null | head -1 || echo -; echo',
    'printf "doxygen:"; [ -x /usr/bin/doxygen ] && doxygen --version 2>/dev/null || echo -; echo',
    'printf "dot:"; [ -x /usr/bin/dot ] && dot -V 2>&1 | head -1 || echo -; echo',
    'printf "make:"; [ -x /usr/bin/make ] && make --version 2>/dev/null | head -1 || echo -; echo',
  ].join('\n');
  const r = await runLinuxScript(script, 15_000).catch(() => null);
  if (!r) {
    return {};
  }
  const out: LinuxLaneDocsTools = {};
  for (const raw of r.stdout.split(/\r?\n/u)) {
    const m = /^(python|sphinx|doxygen|dot|make):(.*)$/u.exec(raw.trim());
    if (!m) {
      continue;
    }
    const v = m[2].trim();
    if (v && v !== '-') {
      (out as Record<string, string>)[m[1]] = v;
    }
  }
  return out;
}

let docsCache: { at: number; home: string } | null = null;

/** System tools the docs stack needs (root self-heal when any is missing). */
async function ensureLinuxDocsSystem(): Promise<void> {
  const check = await run('bash', ['-c', 'command -v doxygen >/dev/null 2>&1 && command -v dot >/dev/null 2>&1 && command -v make >/dev/null 2>&1'], { timeoutMs: 10_000 }).catch(() => null);
  if (check?.code === 0) {
    return;
  }
  await rootAptLinux('doxygen', 'graphviz', 'make').catch(() => {
    // No root: report honestly (venv parts may still work).
    throw new Error('文档车道需要系统 doxygen/graphviz/make；无免密 root 无法自愈。请 sudo apt-get install -y doxygen graphviz make，或提供免密 sudo。');
  });
}

/** Ensure the lane DOCS stack (venv sphinx via pip + system doxygen/dot/make). */
export async function ensureLinuxDocs(opts: { mirror?: LaneMirror } = {}): Promise<void> {
  if (docsCache && Date.now() - docsCache.at < 60_000) {
    return;
  }
  const home = linuxLaneHome();
  await ensureLinuxDocsSystem();
  const cmd = managedLaneDocsEnsureCommand(home, { mirror: opts.mirror });
  const r = await runLinuxScript(cmd, 20 * 60_000).catch(() => null);
  if (!r || r.code !== 0) {
    const tail = `${r?.stdout ?? ''}\n${r?.stderr ?? ''}`.split(/\r?\n/u).filter((s) => s.trim().length > 0).slice(-8).join('\n');
    throw new Error(`Linux 文档工具链准备失败：\n${tail}`);
  }
  if (!/docs_sphinx:.+/.test(r.stdout) || !/docs_doxygen:.+/.test(r.stdout) || !/docs_dot:.+/.test(r.stdout) || !/docs_make:.+/.test(r.stdout)) {
    throw new Error(`Linux 文档工具未齐备：\n${r.stdout.slice(-800)}`);
  }
  docsCache = { at: Date.now(), home };
}

/** Run `python docs/build.py` inside the native Linux managed lane. */
export async function runLinuxDocs(
  cwd: string,
  opts: { mirror?: LaneMirror; onStdout?: (c: string) => void; onStderr?: (c: string) => void; timeoutMs?: number } = {},
): Promise<BuildSummary> {
  const { home } = await ensureLinuxLane({ mirror: opts.mirror });
  await ensureLinuxDocs({ mirror: opts.mirror });
  const cmd = managedLaneDocsRunCommand(cwd, home);
  const f = writeLinuxScript(cmd);
  let stdout = '';
  let stderr = '';
  try {
    const r = await run('bash', [f], {
      cwd,
      timeoutMs: opts.timeoutMs ?? 0,
      onStdout: (c) => {
        stdout += c;
        opts.onStdout?.(c);
      },
      onStderr: (c) => {
        stderr += c;
        opts.onStderr?.(c);
      },
    });
    return { ok: r.code === 0, code: r.code, stdout, stderr };
  } finally {
    rmSync(f, { force: true });
  }
}

/** Status snapshot for the dashboard (mirror of the WSL lane's status). */
export interface LinuxLaneStatus {
  available: boolean;
  home: string;
  ready: boolean;
  tools: { gcc?: string; lcov?: string; conan?: string; cmake?: string; ninja?: string };
  note?: string;
  /** T06/T02: the conan arch setting derived from the host facts. */
  arch?: string;
  /** T06: whether the chosen compiler is the CI baseline or a compatible fallback. */
  baseline?: 'ci' | 'compatible' | 'native';
}

let statusCache: { at: number; status: LinuxLaneStatus } | null = null;

/**
 * Overall lane status for the env page / HUD (no provisioning — read only).
 * Off-Linux hosts return null (safe to call everywhere). `tools.conan` /
 * `tools.cmake` come from the managed venv (the toolchain actually used);
 * `tools.gcc` / `tools.lcov` come from the system (apt-provisioned).
 */
export async function getLinuxLaneStatus(force = false): Promise<LinuxLaneStatus | null> {
  if (process.platform !== 'linux') {
    return null;
  }
  if (!force && statusCache && Date.now() - statusCache.at < 60_000) {
    return statusCache.status;
  }
  const home = linuxLaneHome();
  const script = [
    `P="${join(managedLaneLayout(home).venv, 'bin')}"`,
    'printf "conan:"; [ -x "$P/conan" ] && "$P/conan" --version 2>/dev/null | head -1 || echo -; echo',
    'printf "cmake:"; [ -x "$P/cmake" ] && "$P/cmake" --version 2>/dev/null | head -1 || echo -; echo',
    'printf "ninja:"; [ -x "$P/ninja" ] && "$P/ninja" --version 2>/dev/null | head -1 || echo -; echo',
  ].join('\n');
  const tools: LinuxLaneStatus['tools'] = {};
  const r = await runLinuxScript(script, 15_000).catch(() => null);
  if (r) {
    for (const raw of r.stdout.split(/\r?\n/u)) {
      const m = /^(conan|cmake|ninja):(.*)$/u.exec(raw.trim());
      if (!m) {
        continue;
      }
      const v = m[2].trim();
      if (v && v !== '-') {
        (tools as Record<string, string>)[m[1]] = v;
      }
    }
  }
  // T02: compiler/arch/lcov come from the SAME facts ladder the build uses.
  const facts = await probeLinuxLaneFacts();
  if (facts.compiler) {
    tools.gcc = `${facts.compiler.name} (${facts.compiler.version})`;
  }
  if (facts.lcov) {
    tools.lcov = facts.lcov;
  }
  const ready = !!facts.compiler && !!tools.conan;
  let note: string | undefined;
  if (!facts.compiler) {
    note = '编译器未就绪（首次托管构建将按阶梯尝试 apt 自愈 gcc-13 → 兼容版本）。';
  } else if (!facts.arch) {
    note = unsupportedArchMessage(facts.archRaw);
  } else if (!tools.conan || !tools.cmake) {
    note = '托管车道 conan/cmake 未就绪（首次「构建并测试」将自动准备）。';
  } else {
    note = `托管 lane · ${home}/.het-fti/managed-env（隔离 venv + CONAN_HOME）· ${baselineNote(facts.compiler)}`;
  }
  const status: LinuxLaneStatus = { available: true, home, ready, tools, note, arch: facts.arch || undefined, baseline: facts.compiler?.baseline };
  statusCache = { at: Date.now(), status };
  return status;
}
