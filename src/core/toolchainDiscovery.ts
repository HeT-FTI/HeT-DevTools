import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, platform } from 'node:os';
import { run } from '../utils/exec';
import { wslExePath } from './wslHost';

/**
 * Generic toolchain discovery (V2 follow-up: "environment completeness").
 *
 * VS Code starts with a plain PowerShell PATH. Tools (conan, cmake, doxygen,
 * graphviz/dot, sphinx, clang-format, …) can live in many places: conda envs
 * (`build`, base), mamba, uv, a workspace venv, plain PATH — and on Windows
 * also WSL (gcc, mingw, lcov…). This module probes them all with heuristic env
 * names, reports each tool's best source, and NEVER over-promises: when a tool
 * is missing it is reported as missing so the dashboard can offer a manual
 * override. Pure-ish (fs/os/exec only) — unit-testable with fake roots.
 */

export type EnvKind = 'path' | 'conda' | 'mamba' | 'uv' | 'venv' | 'wsl' | 'override' | 'missing';

export interface ToolRow {
  key: string;
  label: string;
  /** Human summary shown on the dashboard. */
  exe: string;
  source: EnvKind;
  sourceDetail: string;
  /** True when the user pinned a manual override. */
  overridden: boolean;
  /** For WSL rows: purely informational (not usable by the Windows build). */
  informational?: boolean;
  /** Managed by conan (gtest/benchmark): no host install needed. */
  managed?: boolean;
  /** Optional Linux/WSL-only tool: absence on Windows is not an error. */
  optional?: boolean;
}

export interface DiscoveryOptions {
  /** name → manual override exe path (config het.tools). */
  overrides?: Record<string, string>;
  /** Extra venv/install dirs to search (e.g. workspace .venv). */
  searchDirs?: string[];
  /** Extra bin dirs (tests inject fake dirs; default = PATH scan). */
  extraBinDirs?: string[];
  /** Probe WSL on Windows (default true; slow-ish, cached by the caller). */
  wsl?: boolean;
  /** Skip the real process PATH scan (deterministic tests). */
  skipPath?: boolean;
  /** Preferred env names, heuristic. */
  preferEnvNames?: string[];
  /** Extra conda/mamba-like roots (appended to the defaults). */
  extraRoots?: string[];
  /** REPLACE the conda/mamba root candidates entirely (hermetic tests). */
  rootCandidates?: string[];
}

interface ToolDef {
  key: string;
  label: string;
  exeNames: string[];
  managed?: boolean;
  optional?: boolean;
}

export const TOOL_DEFS: ToolDef[] = [
  { key: 'conan', label: 'Conan', exeNames: ['conan'] },
  { key: 'python', label: 'Python', exeNames: ['python', 'python3'] },
  { key: 'cmake', label: 'CMake', exeNames: ['cmake'] },
  { key: 'ninja', label: 'Ninja', exeNames: ['ninja'] },
  { key: 'doxygen', label: 'Doxygen', exeNames: ['doxygen'] },
  { key: 'graphviz', label: 'Graphviz (dot)', exeNames: ['dot'] },
  { key: 'sphinx', label: 'Sphinx (sphinx-build)', exeNames: ['sphinx-build'] },
  { key: 'make', label: 'Make', exeNames: ['make'] },
  { key: 'clang-format', label: 'clang-format', exeNames: ['clang-format'] },
  { key: 'clang-tidy', label: 'clang-tidy', exeNames: ['clang-tidy'] },
  { key: 'gitleaks', label: 'Gitleaks', exeNames: ['gitleaks'] },
  { key: 'gtest', label: 'GTest', exeNames: ['gtest'], managed: true },
  { key: 'benchmark', label: 'Google Benchmark', exeNames: ['benchmark'], managed: true },
  { key: 'gcc', label: 'GCC (gcc)', exeNames: ['gcc'] },
  { key: 'g++', label: 'G++ (g++)', exeNames: ['g++'] },
  { key: 'lcov', label: 'LCOV', exeNames: ['lcov'], optional: true },
  { key: 'gcovr', label: 'gcovr', exeNames: ['gcovr'], optional: true },
];

/** Windows-friendly exe candidates for a base name. */
export function exeCandidates(name: string): string[] {
  return platform() === 'win32' ? [name, `${name}.exe`, `${name}.bat`, `${name}.cmd`] : [name];
}

/** Well-known conda/mamba roots (incl. user + ProgramData + user-local). */
export function envRootCandidates(extra: string[] = []): { root: string; kind: 'conda' | 'mamba' }[] {
  const home = homedir();
  const out: { root: string; kind: 'conda' | 'mamba' }[] = [];
  const push = (root: string, kind: 'conda' | 'mamba'): void => {
    if (root) {
      out.push({ root, kind });
    }
  };
  // explicit hints
  if (process.env.MAMBA_ROOT_PREFIX) {
    push(process.env.MAMBA_ROOT_PREFIX, 'mamba');
  }
  if (process.env.CONDA_EXE) {
    push(dirname(dirname(process.env.CONDA_EXE)), 'conda');
  }
  for (const n of ['miniforge3', 'miniconda3', 'anaconda3', 'mambaforge', 'micromamba']) {
    push(join(home, n), n === 'mambaforge' || n === 'micromamba' ? 'mamba' : 'conda');
  }
  push(join(home, '.conda'), 'conda');
  push(join(home, 'AppData', 'Local', 'miniconda3'), 'conda');
  push(join(home, 'AppData', 'Local', 'miniforge3'), 'conda');
  for (const n of ['miniforge3', 'miniconda3', 'anaconda3', 'Anaconda3', 'mambaforge']) {
    push(join('C:/ProgramData', n), n === 'mambaforge' ? 'mamba' : 'conda');
  }
  push('C:/tools/miniconda3', 'conda');
  for (const e of extra) {
    push(e, 'conda');
  }
  // de-dupe by root
  const seen = new Set<string>();
  return out.filter((r) => (seen.has(r.root.toLowerCase()) ? false : (seen.add(r.root.toLowerCase()), true)));
}

/** uv-managed pythons + uv tools; a lightweight venv in ~/.venv(s). */
export function uvAndVenvDirs(extra: string[] = []): { dir: string; kind: 'uv' | 'venv' }[] {
  const home = homedir();
  const out: { dir: string; kind: 'uv' | 'venv' }[] = [];
  out.push({ dir: join(home, '.local', 'share', 'uv', 'python'), kind: 'uv' });
  out.push({ dir: join(home, '.local', 'share', 'uv', 'tools'), kind: 'uv' });
  for (const d of [join(home, '.venv'), join(home, '.venvs')]) {
    out.push({ dir: d, kind: 'venv' });
  }
  for (const d of extra) {
    out.push({ dir: d, kind: 'venv' });
  }
  return out;
}

/** Candidate subdirectories that hold binaries inside an env dir. */
function binSubdirs(envDir: string): string[] {
  // include the env root itself: conda/venv/uv keep python.exe at the root.
  return [envDir, join(envDir, 'Scripts'), join(envDir, 'Library', 'bin'), join(envDir, 'bin'), join(envDir, 'Library', 'mingw-w64', 'bin')];
}

/** Scan one env dir for the first hit of an exe name. */
function findInEnv(envDir: string, exeName: string): string | undefined {
  for (const sub of binSubdirs(envDir)) {
    for (const cand of exeCandidates(exeName)) {
      const p = join(sub, cand);
      if (exists(p)) {
        return p;
      }
    }
  }
  return undefined;
}

function exists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Env heuristic: pick env names matching a semantic list first. */
const DEFAULT_PREFER = ['build', 'dev', 'het', 'fcpp', 'tools', 'base'];

function rankEnv(name: string, prefer: string[]): number {
  const i = prefer.indexOf(name);
  return i >= 0 ? i : prefer.length;
}

/** Parse `tool=/path` lines produced by a WSL snapshot (pure). */
export function parseWslSnapshot(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq > 0) {
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim();
      if (k && v && v !== 'none' && v !== '(none)') {
        out[k] = v;
      }
    }
  }
  return out;
}

/** Run one WSL snapshot to learn which POSIX tools exist inside WSL. */
export async function probeWslTools(timeoutMs = 8000): Promise<Record<string, string>> {
  if (platform() !== 'win32') {
    return {};
  }
    const script =
      'for t in gcc g++ make cmake lcov gcovr mingw32-make python3; do printf "%s=%s\\n" "$t" "$(command -v $t 2>/dev/null || echo none)"; done';
    const r = await run(wslExePath(), ['-e', 'sh', '-lc', script], { timeoutMs }).catch(() => null);
  return r && r.code === 0 ? parseWslSnapshot(r.stdout) : {};
}

/**
 * Discover every tool across sources.
 * Order of preference per tool: manual override → PATH → conda/mamba envs
 * (heuristic env names first) → uv → venv; WSL is reported informationally.
 */
export async function discoverTools(opts: DiscoveryOptions = {}): Promise<ToolRow[]> {
  const overrides = opts.overrides ?? {};
  const prefer = opts.preferEnvNames ?? DEFAULT_PREFER;
  const rows: ToolRow[] = [];

  // (a) PATH dirs + injected extra bin dirs
  const pathDirs = opts.skipPath ? [] : (process.env.PATH ?? '').split(/[;:]/).filter(Boolean);
  const extraDirs = opts.extraBinDirs ?? [];

  // (b) env roots (conda/mamba) + envs under them
  const rootHits: { envDir: string; kind: 'conda' | 'mamba'; name: string }[] = [];
  const envRoots =
    opts.rootCandidates !== undefined
      ? opts.rootCandidates.map((root) => ({ root, kind: 'conda' as const }))
      : envRootCandidates(opts.extraRoots);
  for (const { root, kind } of envRoots) {
    rootHits.push({ envDir: root, kind, name: 'base' });
    let envNames: string[] = [];
    try {
      envNames = readdirSync(join(root, 'envs')).filter((n) => !n.startsWith('.'));
    } catch {
      /* none */
    }
    for (const name of envNames) {
      rootHits.push({ envDir: join(root, 'envs', name), kind, name });
    }
  }
  rootHits.sort((a, b) => rankEnv(a.name, prefer) - rankEnv(b.name, prefer) || a.name.localeCompare(b.name));

  // (c) uv + venv dirs
  const uvVenv = uvAndVenvDirs(opts.searchDirs);

  for (const def of TOOL_DEFS) {
    const override = overrides[def.key];
    if (override) {
      rows.push({ key: def.key, label: def.label, exe: override, source: 'override', sourceDetail: '手动指定（het.tools.' + def.key + '）', overridden: true });
      continue;
    }
    let found: { exe: string; kind: EnvKind; detail: string } | undefined;

    // PATH (including its env subdirs handled implicitly)
    for (const dir of [...extraDirs, ...pathDirs]) {
      for (const n of def.exeNames) {
        for (const cand of exeCandidates(n)) {
          const p = join(dir, cand);
          if (exists(p)) {
            found = { exe: p, kind: 'path', detail: 'PATH' };
            break;
          }
        }
        if (found) {
          break;
        }
      }
      if (found) {
        break;
      }
    }
    if (found) {
      rows.push({ key: def.key, label: def.label, exe: found.exe, source: found.kind, sourceDetail: found.detail, overridden: false });
      continue;
    }

    // conda / mamba envs
    outer: for (const hit of rootHits) {
      for (const n of def.exeNames) {
        const exe = findInEnv(hit.envDir, n);
        if (exe) {
          found = { exe, kind: hit.kind, detail: hit.name === 'base' ? `${hit.kind} base` : `${hit.kind} env ${hit.name}` };
          break outer;
        }
      }
    }
    if (!found) {
      // uv / venv (uv stores pythons in per-version subdirs)
      outer: for (const d of uvVenv) {
        for (const n of def.exeNames) {
          let exe = findInEnv(d.dir, n);
          if (!exe && d.kind === 'uv') {
            let children: string[] = [];
            try {
              children = readdirSync(d.dir).filter((c) => !c.startsWith('.'));
            } catch {
              /* not a container */
            }
            for (const c of children) {
              exe = findInEnv(join(d.dir, c), n);
              if (exe) {
                break;
              }
            }
          }
          if (exe) {
            found = { exe, kind: d.kind, detail: `${d.kind} ${d.dir}` };
            break outer;
          }
        }
      }
    }
    if (found) {
      rows.push({ key: def.key, label: def.label, exe: found.exe, source: found.kind, sourceDetail: found.detail, overridden: false });
      continue;
    }

    rows.push({ key: def.key, label: def.label, exe: '', source: 'missing', sourceDetail: '', overridden: false });
  }

  // NOTE (A1 marketplace-readiness): the WSL informational snapshot block was
  // removed — under managed semantics the WSL2 lane is a REAL build lane (env
  // display comes from getWslLaneStatus, not from this generic sniff), and on
  // hosts without WSL2 marking a Windows-missing tool as "ok in WSL" was
  // misleading. probeWslTools stays for tooling/tests only.

  // Post-tag managed/optional semantics on the final rows.
  for (const def of TOOL_DEFS) {
    const row = rows.find((r) => r.key === def.key);
    if (row && row.source === 'missing' && def.managed) {
      row.managed = true;
    }
    if (row && def.optional) {
      row.optional = true;
    }
  }
  return rows;
}

/** Get a dir to prepend to PATH so `which` finds an overridden binary. */
export function overrideBinDir(exe: string): string {
  return dirname(exe);
}
