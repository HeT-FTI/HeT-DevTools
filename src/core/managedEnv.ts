/**
 * V4-2/V4-8: managed environment storage — pure layout + state + profiles.
 *
 * Everything the provisioner creates lives under `globalStorage/managed-env`
 * so VS Code deletes it on uninstall ("卸载即清"). Conan's whole cache is
 * redirected with `CONAN_HOME` into the same tree. Profiles are generated
 * (never guessed) from the canonical `ToolchainManifest` semantics.
 *
 * Pure module (node:fs sync ok) — unit-testable with temp dirs.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type ManagedState = 'absent' | 'provisioning' | 'ready' | 'error';

export interface ManagedLayout {
  envRoot: string;
  toolsDir: string;
  /** Python venv that hosts conan/cmake/ninja (tools/py). */
  pyVenv: string;
  /** CONAN_HOME — the whole conan2 cache, removable with the extension. */
  conanHome: string;
  profilesDir: string;
  logPath: string;
  markerPath: string;
}

/** Where the managed environment lives (always under extension storage). */
export function managedLayout(storageRoot: string): ManagedLayout {
  const envRoot = join(storageRoot, 'managed-env');
  const toolsDir = join(envRoot, 'tools');
  return {
    envRoot,
    toolsDir,
    pyVenv: join(toolsDir, 'py'),
    conanHome: join(envRoot, 'conan2'),
    profilesDir: join(envRoot, 'profiles'),
    logPath: join(envRoot, 'provision.log'),
    markerPath: join(envRoot, '.het-managed.json'),
  };
}

export interface ManagedMarker {
  /** schema version. */
  version: number;
  state: ManagedState;
  /** provider id or 'managed' (managed venv), see provisionPlan. */
  provider: string;
  createdAt: number;
  updatedAt: number;
  /** resolved tool versions, e.g. { conan: '2.9.0', cmake: '4.3.1' }. */
  tools: Record<string, string>;
  /** Human note (zh), e.g. which provider semantics are satisfied. */
  note?: string;
}

export function readMarker(layout: ManagedLayout): ManagedMarker | null {
  if (!existsSync(layout.markerPath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(layout.markerPath, 'utf8')) as ManagedMarker;
  } catch {
    return null;
  }
}

export function writeMarker(layout: ManagedLayout, marker: ManagedMarker): void {
  mkdirSync(layout.envRoot, { recursive: true });
  writeFileSync(layout.markerPath, JSON.stringify(marker, null, 2), 'utf8');
}

/** State without touching the toolchain (marker only, fast for the chip hover). */
export function markerState(marker: ManagedMarker | null): ManagedState {
  return marker?.state ?? 'absent';
}

/** Delete the whole managed tree (het.env remove / uninstall semantics). */
export function removeManagedEnv(layout: ManagedLayout): void {
  rmSync(layout.envRoot, { recursive: true, force: true });
}

/** venv bin dir (Scripts on Windows, bin elsewhere). */
export function venvBinDir(layout: ManagedLayout, isWin: boolean): string {
  return join(layout.pyVenv, isWin ? 'Scripts' : 'bin');
}

/** Absolute path of a managed tool inside the venv, e.g. venv/bin/conan. */
export function venvTool(layout: ManagedLayout, isWin: boolean, name: string): string {
  const exe = isWin ? `${name}.exe` : name;
  return join(venvBinDir(layout, isWin), exe);
}

/** PATH for child processes: managed venv bin first, then the caller's PATH. */
export function envWithManaged(layout: ManagedLayout, isWin: boolean, basePath: string): Record<string, string> {
  const sep = isWin ? ';' : ':';
  return {
    CONAN_HOME: layout.conanHome,
    PATH: [venvBinDir(layout, isWin), basePath].filter(Boolean).join(sep),
  };
}

/**
 * Generate a conan default profile for a managed gcc/clang toolchain.
 * Only the settings that the manifest owns are written; the caller passes the
 * exact compiler executables (managed gcc) so nothing is "detected".
 * Conan 2 profile syntax: compiler executables go in `[conf]` via
 * `tools.build:compiler_executables` (Conan 1's `[env]` is rejected).
 */
export function managedProfile(
  compiler: { cc: string; cxx: string; version: string; libcxx: string },
  os: 'Linux' | 'Macos' | 'Windows',
  arch: string,
  buildType: string,
  cppstd = '17',
): string {
  const settings = [
    `[settings]`,
    `os=${os}`,
    `arch=${arch}`,
    `compiler=${os === 'Macos' ? 'apple-clang' : 'gcc'}`,
    `compiler.version=${compiler.version}`,
    `compiler.libcxx=${compiler.libcxx}`,
    `compiler.cppstd=${cppstd}`,
    `build_type=${buildType}`,
    ``,
    `[conf]`,
    `tools.build:compiler_executables={"c": "${compiler.cc}", "cpp": "${compiler.cxx}"}`,
    `tools.build:download_source=True`,
  ].join('\n');
  return settings;
}

/** Files a provisioner must leave behind to be considered "ready". */
export function requiredReadyFiles(layout: ManagedLayout, isWin: boolean): string[] {
  return [
    layout.markerPath,
    join(layout.conanHome, '.conan_home_marker'),
    venvTool(layout, isWin, 'python'),
    venvTool(layout, isWin, 'conan'),
    venvTool(layout, isWin, 'cmake'),
    venvTool(layout, isWin, 'ninja'),
  ];
}

export interface GcDecision {
  action: 'keep' | 'remove';
  reason?: string;
}

/**
 * V4-8 activation GC — decide whether leftover managed state should be removed.
 * Never auto-deletes a partially-provisioned tree (retry may reuse it); it only
 * removes pure leftovers (a marker/log/conan cache with NO venv attempt) so a
 * fully-wiped or abandoned storage does not leave cruft. The heavy "uninstall
 * clean" is VS Code deleting globalStorage itself.
 */
export function gcManagedEnv(layout: ManagedLayout): GcDecision {
  if (!existsSync(layout.envRoot)) {
    return { action: 'keep', reason: '无托管目录' };
  }
  const marker = readMarker(layout);
  // An in-progress/ready tree with a tools attempt must be kept (retry/resume).
  if (existsSync(layout.toolsDir) && readdirSyncSafe(layout.toolsDir).length > 0) {
    return { action: 'keep', reason: marker?.state ?? 'unknown' };
  }
  if (marker) {
    return { action: 'keep', reason: `marker=${marker.state}` };
  }
  // No marker, no tools → only stray files (e.g. a half-written marker/log).
  return { action: 'remove', reason: '无 marker 且无工具目录的残留' };
}

/** readdir that never throws (empty array on error). */
function readdirSyncSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

