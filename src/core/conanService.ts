import { ExecResult, run, which } from '../utils/exec';
import { pathExists } from '../utils/fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CondaConanRuntime, discoverConanRuntime, runtimeFromExePath } from './condaEnv';

/**
 * Conan 2 command service (development-plan T-1.6).
 * Locates the conan executable (override → PATH → common conda envs) and runs
 * the canonical local build command. Pure logic; no VS Code imports.
 */

export interface ConanLocationOptions {
  /** Absolute path override (extension setting, may be empty). */
  conanPath?: string;
  /** Extra candidate executable paths to try before conda scan. */
  extraCandidates?: string[];
}

export interface ConanRunOptions {
  buildType?: 'Debug' | 'Release';
  /** Cross-build host profile (e.g. 'arm_profile'); undefined = native. */
  profileHost?: string;
  buildMissing?: boolean;
  /** Conan --test-folder override; '' disables the test package step. */
  testFolder?: string | null;
  /** Extra -pr profile files appended (dev machine adaptations). */
  profiles?: string[];
  /** Additional raw args appended verbatim. */
  extraArgs?: string[];
}

export interface BuildSummary {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Resolved conan executable + optional conda runtime context. */
export interface ConanRuntime {
  exe: string;
  runtime?: CondaConanRuntime;
}

/**
 * Resolve conan: override path → PATH → conda env sniffing (roots + envs).
 * Returns null when conan is nowhere to be found.
 */
export async function resolveConanRuntime(options: ConanLocationOptions = {}): Promise<ConanRuntime | null> {
  const candidates = [options.conanPath ?? '', ...(options.extraCandidates ?? [])];
  for (const c of candidates) {
    if (c && (await pathExists(c))) {
      return { exe: c, runtime: runtimeFromExePath(c) };
    }
  }
  const fromPath = await which('conan');
  if (fromPath) {
    return { exe: fromPath, runtime: runtimeFromExePath(fromPath) };
  }
  const rt = await discoverConanRuntime();
  if (rt) {
    return { exe: rt.exe, runtime: rt };
  }
  return null;
}

/** Resolve the conan executable, or null when not found anywhere. */
export async function locateConan(options: ConanLocationOptions = {}): Promise<string | null> {
  const r = await resolveConanRuntime(options);
  return r?.exe ?? null;
}

/** conan 2's default profile path (CONAN_HOME override, else ~/.conan2). */
export function conanDefaultProfilePath(): string {
  const conanHome = (process.env.CONAN_HOME ?? '').trim() || join(homedir(), '.conan2');
  return join(conanHome, 'profiles', 'default');
}

/**
 * P2 (fresh machines / native lane): conan 2 refuses to run without a default
 * profile. Runs `conan profile detect` ONLY when the default is missing —
 * never overwrites an existing user profile. Returns whether a default profile
 * is present afterwards.
 */
export async function ensureConanDefaultProfile(conanExe: string): Promise<boolean> {
  if (await pathExists(conanDefaultProfilePath())) {
    return true;
  }
  try {
    const r = await run(conanExe, ['profile', 'detect'], { timeoutMs: 120_000 });
    return r.code === 0;
  } catch {
    return false;
  }
}

/** Build the canonical `conan create` argument list (see development-plan §9.1). */
export function conanCreateArgs(options: ConanRunOptions = {}): string[] {
  const args = ['create', '.'];
  if (options.profileHost) {
    args.push('-pr:b=default', `-pr:h=${options.profileHost}`);
  }
  const buildType = options.buildType ?? 'Debug';
  // Separate `-s` from its value: Conan 2 rejects a single combined token.
  args.push('-s', `build_type=${buildType}`);
  if (options.profiles) {
    for (const profile of options.profiles) {
      args.push('-pr', profile);
    }
  }
  if (options.buildMissing !== false) {
    args.push('--build=missing');
  }
  if (options.testFolder === '') {
    args.push('-tf=""');
  } else if (options.testFolder) {
    args.push(`-tf=${options.testFolder}`);
  }
  if (options.extraArgs) {
    args.push(...options.extraArgs);
  }
  return args;
}

/**
 * Run `conan create` in `cwd`. Resolves with a summary; does NOT throw on a
 * non-zero exit (failure is a normal build outcome).
 */
export async function runConanCreate(
  conanExe: string,
  cwd: string,
  options: ConanRunOptions = {},
  execOptions: { onStdout?: (c: string) => void; onStderr?: (c: string) => void; timeoutMs?: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<BuildSummary> {
  let result: ExecResult;
  try {
    result = await run(conanExe, conanCreateArgs(options), {
      cwd,
      timeoutMs: execOptions.timeoutMs ?? 0,
      signal: execOptions.signal,
      onStdout: execOptions.onStdout,
      onStderr: execOptions.onStderr,
      env: execOptions.env,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, code: null, stdout: '', stderr: message };
  }
  return { ok: result.code === 0, code: result.code, stdout: result.stdout, stderr: result.stderr };
}
