/**
 * V5-1: WSL2 managed build lane — component (real wsl.exe execution).
 *
 * `ensureWslLane` bootstraps the isolated lane once (idempotent, cached 60 s):
 * private venv (conan/cmake/ninja) + generated profile + private CONAN_HOME
 * under `~/.het-fti/managed-env`. `runWslConanCreate` then runs the canonical
 * `conan create .` inside the distro with Linux semantics, streaming output
 * exactly like the native lane and mapping `/mnt/<drive>/…` paths back to
 * Windows for the diagnostics parser.
 */
import { run } from '../../utils/exec';
import { decodeWslOutput, toWslPath, wslRunArgs } from '../../core/wslHost';
import { settingsCompilerKey } from '../../core/laneSettings';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, writeFileSync } from 'node:fs';
import type { BuildSummary } from '../../core/conanService';
import {
  wslLaneBuildCommand,
  wslLaneDocsEnsureCommand,
  wslLaneDocsRunCommand,
  wslLaneEnsureCommand,
  wslLaneLayout,
  wslOutToWin,
} from '../../core/wslLane';
import {
  GCC_APT_ATTEMPTS,
  LaneCompiler,
  LaneFacts,
  baselineNote,
  laneCompilerGuide,
  laneFactsScript,
  laneProfileFor,
  parseLaneFacts,
  unsupportedArchMessage,
} from '../../core/laneProfile';
import { LaneMirror, mirrorCacheKey } from '../../core/laneMirror';

export interface WslLaneEnsureResult {
  home: string;
  note?: string;
  /** T01/T02: the facts the lane actually built with (compiler/arch/baseline). */
  facts?: LaneFacts;
}

let cache: { at: number; home: string; note?: string; mirrorKey?: string } | null = null;

// IMPORTANT: wsl.exe round-trips `bash -c/-lc <argv script>` through the
// Windows command line, which mangles multi-line/meta-char scripts (command
// substitutions break with a syntax error; even plain double-quoted `$lane`
// variables fail to expand reliably). ALWAYS run lane scripts from a
// file: write the script to a Windows temp path and `wsl.exe … -- bash <file>`
// (Linux side can read `/mnt/c/…` directly).
let scriptSeq = 0;
function writeWslTempScript(content: string): { win: string; wsl: string } {
  scriptSeq += 1;
  const win = join(tmpdir(), `het-lane-${process.pid}-${scriptSeq}.sh`);
  writeFileSync(win, content, 'utf8');
  return { win, wsl: toWslPath(win) };
}

/** Run a lane script through the file transport (only reliable wsl path). */
export async function runWslScript(
  distro: string,
  content: string,
  timeoutMs = 15_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const tmp = writeWslTempScript(content);
  try {
    const r = await run('wsl.exe', wslRunArgs(distro, 'bash', [tmp.wsl]), { timeoutMs });
    return { code: r.code ?? -1, stdout: r.stdout, stderr: r.stderr };
  } finally {
    rmSync(tmp.win, { force: true });
  }
}

/** Resolve the distro default user's $HOME (as the lane will run). */
async function distroHome(distro: string): Promise<string> {
  const r = await run('wsl.exe', wslRunArgs(distro, 'bash', ['-lc', 'printf %s "$HOME"']), {
    timeoutMs: 15_000,
  });
  if (r.code !== 0 || !decodeWslOutput(r.stdout).trim()) {
    throw new Error(`WSL 发行版 ${distro} 不可用（exit=${r.code}）`);
  }
  return decodeWslOutput(r.stdout).trim();
}

/**
 * Fast, NON-provisioning check that the lane venv already has conan (used by
 * the health/env sample — never bootstraps, just `test -x` on the venv bin).
 * NOTE: must go through the FILE transport — the previous inline
 * `bash <"test -x …">` (no -lc) made bash treat the shell text as a FILENAME
 * and always returned exit 127 → the "conan 就绪" fact was permanently false
 * even after successful builds (issue-3 root cause).
 */
export async function laneConanPresent(distro: string): Promise<boolean> {
  try {
    const home = await distroHome(distro);
    const venvConan = `${wslLaneLayout(home).venv}/bin/conan`;
    const r = await runWslScript(distro, `test -x "${venvConan}" && echo 1`, 8000);
    return r.code === 0 && /1/u.test(r.stdout);
  } catch {
    return false;
  }
}

/** Lane docs-tool fact (file transport): python/sphinx from the venv,
 *  doxygen/dot/make from the distro system (as apt-provisioned). */
export interface LaneDocsTools {
  python?: string;
  sphinx?: string;
  doxygen?: string;
  dot?: string;
  make?: string;
}

export async function probeLaneDocsTools(distro: string): Promise<LaneDocsTools> {
  const script = [
    'P="$HOME/.het-fti/managed-env/venv/bin"',
    'printf "python:"; [ -x "$P/python" ] && "$P/python" --version 2>/dev/null | head -1 || echo -; echo',
    'printf "sphinx:"; [ -x "$P/sphinx-build" ] && "$P/sphinx-build" --version 2>/dev/null | head -1 || echo -; echo',
    'printf "doxygen:"; [ -x /usr/bin/doxygen ] && doxygen --version 2>/dev/null || echo -; echo',
    'printf "dot:"; [ -x /usr/bin/dot ] && dot -V 2>&1 | head -1 || echo -; echo',
    'printf "make:"; [ -x /usr/bin/make ] && make --version 2>/dev/null | head -1 || echo -; echo',
  ].join('\n');
  const r = await runWslScript(distro, script, 15_000).catch(() => null);
  if (!r) {
    return {};
  }
  const out: LaneDocsTools = {};
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

/** Quiet, idempotent root apt install of one or more packages (no conda). */
async function rootApt(distro: string, ...pkgs: string[]): Promise<void> {
  await run('wsl.exe', ['-d', distro, '-u', 'root', '--', 'bash', '-lc',
    `export DEBIAN_FRONTEND=noninteractive; apt-get update -qq >/dev/null 2>&1 || true; apt-get install -y -qq ${pkgs.join(' ')} >/dev/null 2>&1 || true`,
  ], { timeoutMs: 15 * 60_000 });
}

/** T02: read the lane facts (arch + compiler ladder + gcov/lcov) — file transport. */
export async function probeLaneFacts(distro: string): Promise<LaneFacts> {
  try {
    const r = await runWslScript(distro, laneFactsScript(), 15_000);
    return r.code === 0 ? parseLaneFacts(r.stdout) : { archRaw: '', arch: '' };
  } catch {
    return { archRaw: '', arch: '' };
  }
}

/**
 * T01: resolve a usable compiler via the LADDER — probe → (nothing usable)
 * root apt attempts → re-probe → honest guidance. Never returns a hard-coded
 * gcc-13 path and never blocks silently: a missing compiler surfaces as an
 * actionable lane error instead of a deep CMake one (E1).
 */
async function resolveLaneFacts(distro: string): Promise<LaneFacts & { compiler: LaneCompiler }> {
  let facts = await probeLaneFacts(distro);
  if (!facts.compiler) {
    for (const pkgs of GCC_APT_ATTEMPTS) {
      await rootApt(distro, ...pkgs);
      facts = await probeLaneFacts(distro);
      if (facts.compiler) {
        break;
      }
    }
  }
  if (!facts.compiler) {
    throw new Error(laneCompilerGuide());
  }
  if (!facts.arch) {
    throw new Error(unsupportedArchMessage(facts.archRaw));
  }
  return facts as LaneFacts & { compiler: LaneCompiler };
}

/**
 * Idempotent bootstrap of the isolated lane. Cached 60 s (provisioning is
 * slow only the first time; afterwards it is a few `test -x`/`cat` calls).
 */
export async function ensureWslLane(distro: string, opts: { mirror?: LaneMirror } = {}): Promise<WslLaneEnsureResult> {
  const mirrorKey = mirrorCacheKey(opts.mirror);
  if (cache && Date.now() - cache.at < 60_000 && cache.mirrorKey === mirrorKey) {
    return { home: cache.home, note: cache.note };
  }
  const home = await distroHome(distro);
  // T01/T02: compiler + arch from the facts ladder (never pinned here).
  const facts = await resolveLaneFacts(distro);
  const cmd = wslLaneEnsureCommand(home, laneProfileFor(facts.compiler, facts.arch, 'Release'), {
    compiler: facts.compiler,
    arch: facts.arch,
    gcov: facts.gcov,
    mirror: opts.mirror,
    settingsCompiler: settingsCompilerKey(facts.compiler.name, 'Linux'),
  });
  const runEnsure = async (): Promise<Awaited<ReturnType<typeof run>>> => {
    const tmp = writeWslTempScript(cmd);
    try {
      return await run('wsl.exe', wslRunArgs(distro, 'bash', [tmp.wsl]), {
        timeoutMs: 15 * 60_000,
      });
    } finally {
      rmSync(tmp.win, { force: true });
    }
  };
  let r = await runEnsure();
  // Self-heal (all-in-one): the distro may lack `python3-venv` (Ubuntu ships
  // the module but not ensurepip). WSL root is passwordless by design — a
  // one-time, system-wide apt install of python3-venv fixes it WITHOUT
  // touching any conda env; then retry the user-level bootstrap.
  if (r.code === 3) {
    await rootApt(distro, 'python3-venv');
    r = await runEnsure();
  }
  // V5-6 coverage self-heal: `conan create` with activate_code_coverage=true
  // runs lcov+genhtml inside the test package (mirror of the GitHub Action's
  // `sudo apt install lcov`). When the lane report shows lcov missing, install
  // it (root, quiet) and re-report. gcov alignment is handled by the venv-local
  // shim written by the ensure command (E5) — no system files are touched.
  if (r.code === 0 && /lane_lcov:-\s*$/m.test(`${r.stdout}\n`)) {
    await rootApt(distro, 'lcov');
    r = await runEnsure();
  }
  if (r.code !== 0) {
    const tail = `${r.stdout}\n${r.stderr}`.split(/\r?\n/u).filter((s) => s.trim().length > 0).slice(-8).join('\n');
    throw new Error(`WSL 托管工具链准备失败（exit=${r.code}）：\n${tail}`);
  }
  cache = { at: Date.now(), home, note: baselineNote(facts.compiler), mirrorKey };
  return { home, note: cache.note, facts };
}

/**
 * Run `conan create .` inside the WSL2 managed lane and return a
 * conanService-compatible summary (Windows-mapped output for diagnostics).
 */
export async function runWslConanCreate(
  distro: string,
  cwdWin: string,
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
  const { home } = await ensureWslLane(distro, { mirror: opts.mirror });
  const cwdWsl = toWslPath(cwdWin);
  // Windows-style profile paths must become /mnt/<drive>/… inside the distro.
  const profiles = (opts.profiles ?? []).map((p) => (/^[a-zA-Z]:[\\/]/u.test(p.trim()) ? toWslPath(p) : p));
  const cmd = wslLaneBuildCommand(cwdWsl, home, opts.buildType ?? 'Debug', opts.forceSelf, profiles);
  const tmp = writeWslTempScript(cmd);
  let stdout = '';
  let stderr = '';
  try {
    const r = await run('wsl.exe', wslRunArgs(distro, 'bash', [tmp.wsl], cwdWsl), {
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
    return { ok: r.code === 0, code: r.code, stdout: wslOutToWin(stdout), stderr: wslOutToWin(stderr) };
  } finally {
    rmSync(tmp.win, { force: true });
  }
}

let docsCache: { at: number; home: string } | null = null;

/** Root-level system packages the docs stack needs (idempotent, quiet). */
function aptDocsInstallArgs(distro: string): string[] {
  return ['-d', distro, '-u', 'root', '--', 'bash', '-lc',
    'export DEBIAN_FRONTEND=noninteractive; ' +
      'if ! command -v doxygen >/dev/null 2>&1 || ! command -v dot >/dev/null 2>&1 || ! command -v make >/dev/null 2>&1; then ' +
      'apt-get update -qq >/dev/null 2>&1 || true; apt-get install -y -qq doxygen graphviz make >/dev/null 2>&1 || true; fi',
  ];
}

/**
 * V5-4: ensure the lane DOCS stack — venv sphinx packages (pip, user) plus
 * system doxygen/graphviz/make (passwordless-root apt self-heal). Never
 * touches the distro's conda envs. Cached 60 s; throws with the output tail.
 */
export async function ensureWslDocs(distro: string, opts: { mirror?: LaneMirror } = {}): Promise<void> {
  if (docsCache && Date.now() - docsCache.at < 60_000) {
    return;
  }
  const home = await distroHome(distro);
  // System tools first (root self-heal when any is missing).
  await run('wsl.exe', aptDocsInstallArgs(distro), { timeoutMs: 15 * 60_000 });
  // Then the venv docs packages + report (user level).
  const cmd = wslLaneDocsEnsureCommand(home, { mirror: opts.mirror });
  const tmp = writeWslTempScript(cmd);
  try {
    const r = await run('wsl.exe', wslRunArgs(distro, 'bash', [tmp.wsl]), { timeoutMs: 20 * 60_000 });
    if (r.code !== 0) {
      const tail = `${r.stdout}\n${r.stderr}`.split(/\r?\n/u).filter((s) => s.trim().length > 0).slice(-8).join('\n');
      throw new Error(`WSL 文档工具链准备失败（exit=${r.code}）：\n${tail}`);
    }
    if (!/docs_sphinx:.+/.test(r.stdout) || !/docs_doxygen:.+/.test(r.stdout) || !/docs_dot:.+/.test(r.stdout) || !/docs_make:.+/.test(r.stdout)) {
      throw new Error(`WSL 文档工具未齐备：\n${r.stdout.slice(-800)}`);
    }
  } finally {
    rmSync(tmp.win, { force: true });
  }
  docsCache = { at: Date.now(), home };
}

/** V5-4: run `python docs/build.py` inside the lane (venv python + system tools). */
export async function runWslDocs(
  distro: string,
  cwdWin: string,
  opts: { mirror?: LaneMirror; onStdout?: (c: string) => void; onStderr?: (c: string) => void; timeoutMs?: number } = {},
): Promise<BuildSummary> {
  const { home } = await ensureWslLane(distro, { mirror: opts.mirror });
  await ensureWslDocs(distro, { mirror: opts.mirror });
  const cwdWsl = toWslPath(cwdWin);
  const cmd = wslLaneDocsRunCommand(cwdWsl, home);
  const tmp = writeWslTempScript(cmd);
  let stdout = '';
  let stderr = '';
  try {
    const r = await run('wsl.exe', wslRunArgs(distro, 'bash', [tmp.wsl], cwdWsl), {
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
    return { ok: r.code === 0, code: r.code, stdout: wslOutToWin(stdout), stderr: wslOutToWin(stderr) };
  } finally {
    rmSync(tmp.win, { force: true });
  }
}
