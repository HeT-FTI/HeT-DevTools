/**
 * T07: macOS managed lane — execution layer (POSIX, user level, no root).
 *
 * Mirrors `features/env/linuxLane` but with the macOS contract:
 *   - CLT (`xcode-select --install`) is the one manual prerequisite → guide;
 *   - private venv + generated apple-clang profile under `~/.het-fti/managed-env`;
 *   - docs: venv sphinx (+ brew doxygen/graphviz if present — never installed
 *     by us, macOS has no passwordless root and brew must stay user-owned);
 *   - coverage: `unsupported` by construction (Apple clang → no GNU gcov).
 *
 * Safe to call on any platform: probes return empty off-darwin and the ensure
 * entry points throw actionable guidance instead of touching the system.
 */
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, writeFileSync } from 'node:fs';
import { run } from '../../utils/exec';
import type { BuildSummary } from '../../core/conanService';
import { laneProfileWith } from '../../core/laneProfile';
import { LaneMirror, mirrorCacheKey } from '../../core/laneMirror';
import { macCompiler, macFactsScript, macDocsGuide, macGuide, macLaneDocsEnsureCommand, parseMacFacts, MacFacts } from '../../core/macLane';
import { WSL_DOCS_PIP, managedLaneBuildCommand, managedLaneDocsRunCommand, managedLaneEnsureCommand } from '../../core/wslLane';

export interface MacLaneStatus {
  available: boolean;
  clt: boolean;
  devDir?: string;
  ready: boolean;
  arch?: string;
  clangVersion?: string;
  tools: { conan?: string; cmake?: string; ninja?: string; sphinx?: string; doxygen?: string; dot?: string; make?: string };
  /** Limited support: coverage is never available on macOS. */
  coverage: 'none';
  note?: string;
}

let scriptSeq = 0;
function writeMacScript(content: string): string {
  scriptSeq += 1;
  const p = join(tmpdir(), `het-mac-lane-${process.pid}-${scriptSeq}.sh`);
  writeFileSync(p, content, 'utf8');
  return p;
}

/** Run a lane script with the LOCAL bash (macOS ships bash 3.2 — POSIX only). */
export async function runMacScript(content: string, timeoutMs = 15_000): Promise<{ code: number; stdout: string; stderr: string }> {
  const f = writeMacScript(content);
  try {
    const r = await run('bash', [f], { timeoutMs });
    return { code: r.code ?? -1, stdout: r.stdout, stderr: r.stderr };
  } finally {
    rmSync(f, { force: true });
  }
}

/** Read the macOS lane facts (CLT + clang + python + docs tools). */
export async function probeMacFacts(): Promise<MacFacts> {
  const empty: MacFacts = { archRaw: '', arch: '', devDir: '', python: '' };
  if (process.platform !== 'darwin') {
    return empty;
  }
  try {
    const r = await runMacScript(macFactsScript(), 15_000);
    return r.code === 0 ? parseMacFacts(r.stdout) : empty;
  } catch {
    return empty;
  }
}

/**
 * Lane home (user level). Kept identical to the Linux/WSL lanes so the
 * dump/contract and the removal path (`het.envRemove`) stay uniform.
 */
export function macLaneHome(): string {
  return homedir();
}

export interface MacLaneEnsureResult {
  home: string;
  facts: MacFacts;
  note?: string;
}

/**
 * Idempotent bootstrap: CLT check → guide when missing → private venv +
 * generated apple-clang profile + CONAN_HOME (shared builder, so the macOS lane
 * cannot drift from the Linux/WSL ones). Cached 60 s.
 */
let cache: { at: number; home: string; note?: string; mirrorKey?: string } | null = null;

export async function ensureMacLane(opts: { mirror?: LaneMirror } = {}): Promise<MacLaneEnsureResult> {
  const facts = await probeMacFacts();
  if (!facts.devDir) {
    throw new Error(macGuide('clt'));
  }
  if (!facts.python) {
    throw new Error(macGuide('python'));
  }
  // Policy (maintainer decision): macOS x64 is NOT supported anymore; arm64
  // (macos-latest) is the committed platform.
  if (facts.archRaw && facts.archRaw !== 'arm64' && facts.archRaw !== 'aarch64') {
    throw new Error(
      [
        `macOS 车道仅承诺 arm64（Apple Silicon）；当前架构：${facts.archRaw}。`,
        '（macOS x64 已不再兼容。）',
      ].join('\n'),
    );
  }
  const compiler = macCompiler(facts);
  if (!compiler) {
    throw new Error(macGuide('clt'));
  }
  const home = macLaneHome();
  const arch = facts.arch || 'armv8';
  const mirrorKey = mirrorCacheKey(opts.mirror);
  if (cache && Date.now() - cache.at < 60_000 && cache.mirrorKey === mirrorKey) {
    return { home: cache.home, facts, note: cache.note };
  }
  const cmd = managedLaneEnsureCommand(home, laneProfileWith('Macos', compiler, arch, 'Release'), {
    compiler,
    arch,
    mirror: opts.mirror,
  });
  const r = await runMacScript(cmd, 20 * 60_000);
  if (r.code !== 0) {
    const tail = `${r.stdout}\n${r.stderr}`.split(/\r?\n/u).filter((s) => s.trim().length > 0).slice(-8).join('\n');
    throw new Error(`macOS 托管工具链准备失败（exit=${r.code}）：\n${tail}`);
  }
  const note = `${compiler.name} ${compiler.version}（系统原生）`;
  cache = { at: Date.now(), home, note, mirrorKey };
  return { home, facts, note };
}

/** Run `conan create` inside the macOS lane. */
export async function runMacConanCreate(
  cwd: string,
  opts: {
    buildType?: 'Debug' | 'Release';
    forceSelf?: string;
    profiles?: string[];
    /** T18: corporate mirror/proxy for the lane's own provisioning. */
    mirror?: LaneMirror;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
    timeoutMs?: number;
  } = {},
): Promise<BuildSummary> {
  const { home } = await ensureMacLane({ mirror: opts.mirror });
  const cmd = managedLaneBuildCommand(cwd, home, opts.buildType ?? 'Debug', opts.forceSelf, opts.profiles ?? []);
  const f = writeMacScript(cmd);
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

/** Lane docs: venv sphinx (auto) + brew doxygen/graphviz (guide only). */
export async function runMacDocs(
  cwd: string,
  opts: { mirror?: LaneMirror; onStdout?: (c: string) => void; onStderr?: (c: string) => void; timeoutMs?: number } = {},
): Promise<BuildSummary> {
  const { home, facts } = await ensureMacLane({ mirror: opts.mirror });
  const docsEnsure = macLaneDocsEnsureCommand(home, WSL_DOCS_PIP, { mirror: opts.mirror });
  const ensureDocs = await runMacScript(docsEnsure, 20 * 60_000);
  if (ensureDocs.code !== 0) {
    const tail = `${ensureDocs.stdout}\n${ensureDocs.stderr}`.split(/\r?\n/u).filter((s) => s.trim().length > 0).slice(-8).join('\n');
    throw new Error(`macOS 文档工具链准备失败：\n${tail}`);
  }
  const missing = [!facts.doxygen && 'doxygen', !facts.dot && 'graphviz', !facts.make && 'make'].filter(Boolean) as string[];
  if (missing.length > 0) {
    throw new Error(macDocsGuide(missing));
  }
  const cmd = managedLaneDocsRunCommand(cwd, home);
  const f = writeMacScript(cmd);
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

/** Fast, non-provisioning fact: does the lane venv already have conan? */
export async function macLaneConanPresent(): Promise<boolean> {
  try {
    const exe = join(macLaneHome(), '.het-fti', 'managed-env', 'venv', 'bin', 'conan');
    const r = await runMacScript(`test -x "${exe}" && echo 1`, 8000);
    return r.code === 0 && /1/u.test(r.stdout);
  } catch {
    return false;
  }
}

let statusCache: { at: number; status: MacLaneStatus } | null = null;

/** Status snapshot for the env card / dump (read-only, cached 60 s). */
export async function getMacLaneStatus(force = false): Promise<MacLaneStatus | null> {
  if (process.platform !== 'darwin') {
    return null;
  }
  if (!force && statusCache && Date.now() - statusCache.at < 60_000) {
    return statusCache.status;
  }
  const facts = await probeMacFacts();
  const tools: MacLaneStatus['tools'] = {};
  if (facts.doxygen) {
    tools.doxygen = facts.doxygen;
  }
  if (facts.dot) {
    tools.dot = facts.dot;
  }
  if (facts.make) {
    tools.make = facts.make;
  }
  // venv tools (the toolchain actually used by builds/docs).
  const vbin = join(macLaneHome(), '.het-fti', 'managed-env', 'venv', 'bin');
  const probe = await runMacScript(
    [
      `P="${vbin}"`,
      'printf "conan:"; [ -x "$P/conan" ] && "$P/conan" --version 2>/dev/null | head -1 || echo -; echo',
      'printf "cmake:"; [ -x "$P/cmake" ] && "$P/cmake" --version 2>/dev/null | head -1 || echo -; echo',
      'printf "ninja:"; [ -x "$P/ninja" ] && "$P/ninja" --version 2>/dev/null | head -1 || echo -; echo',
      'printf "sphinx:"; [ -x "$P/sphinx-build" ] && "$P/sphinx-build" --version 2>/dev/null | head -1 || echo -; echo',
    ].join('\n'),
    15_000,
  ).catch(() => null);
  if (probe) {
    for (const raw of probe.stdout.split(/\r?\n/u)) {
      const m = /^(conan|cmake|ninja|sphinx):(.*)$/u.exec(raw.trim());
      if (m && m[2].trim() && m[2].trim() !== '-') {
        (tools as Record<string, string>)[m[1]] = m[2].trim();
      }
    }
  }
  const ready = !!facts.devDir && !!facts.compiler && !!tools.conan;
  const note = !facts.devDir
    ? '未检测到 Xcode Command Line Tools（需 xcode-select --install 一次）。'
    : !facts.compiler
      ? 'CLT 已装但 clang 未解析成功。'
      : !tools.conan
        ? '托管车道 conan/cmake/ninja 未就绪（首次「构建并测试」将自动准备）。'
        : `托管 lane · ${macLaneHome()}/.het-fti/managed-env（隔离 venv + CONAN_HOME）· 覆盖率不支持（有限支持）`;
  const status: MacLaneStatus = {
    available: true,
    clt: !!facts.devDir,
    devDir: facts.devDir || undefined,
    ready,
    arch: facts.archRaw || undefined,
    clangVersion: facts.compiler?.version,
    tools,
    coverage: 'none',
    note,
  };
  statusCache = { at: Date.now(), status };
  return status;
}
