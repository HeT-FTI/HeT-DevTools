/**
 * T05 (E13): one-shot, redacted environment dump — the remote-diagnosis出口.
 *
 * The impure collection (probes, versions, logs) lives in the command layer;
 * this module is pure so the SHAPE and the redaction rules are unit-testable
 * (a dump is meant to be pasted into an issue tracker, so paths must be safe).
 */
import { homedir } from 'node:os';

export const ENV_DUMP_SCHEMA = 1;

export interface EnvDump {
  schema: number;
  ts: string;
  extension: { version: string; vscode: string };
  host: Record<string, unknown>;
  provider: Record<string, unknown> | null;
  lane: Record<string, unknown> | null;
  managed: Record<string, unknown> | null;
  tools: Array<{ key: string; source: string; exe: string }>;
  versions: Record<string, string>;
  mirrors: Record<string, string>;
  health?: Record<string, unknown> | null;
  /** Tail of the last `conan create` output (already mapped to Windows paths). */
  lastBuildTail: string[];
}

/** Directories that must never leak into a shared dump (home first). */
export function redactRoots(home = homedir(), extra: Array<string | undefined> = []): string[] {
  return [home, process.env.USERPROFILE, process.env.LOCALAPPDATA, process.env.HOME, ...extra].filter(
    (r): r is string => typeof r === 'string' && r.length > 3,
  );
}

/** Replace every root occurrence with `~` (order matters: longest first). */
export function redact(text: string, roots: string[]): string {
  let out = text;
  for (const root of [...roots].sort((a, b) => b.length - a.length)) {
    out = out.split(root).join('~');
    out = out.split(root.replace(/\\/g, '/')).join('~');
  }
  return out;
}

/** Deep redaction for JSON-able values (strings only; keys are kept). */
export function redactDeep(value: unknown, roots: string[]): unknown {
  if (typeof value === 'string') {
    return redact(value, roots);
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactDeep(v, roots));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v, roots);
    }
    return out;
  }
  return value;
}

/** Build the dump document (deterministic shape; `now` injectable for tests). */
export function buildEnvDump(
  input: Omit<EnvDump, 'schema' | 'ts'>,
  roots: string[],
  now: Date = new Date(),
): EnvDump {
  const doc = { schema: ENV_DUMP_SCHEMA, ts: now.toISOString(), ...input };
  return redactDeep(doc, roots) as EnvDump;
}

/** `het-env-dump-2026-09-14T10-00-00-000Z.json` (filesystem-safe). */
export function dumpFileName(now: Date = new Date()): string {
  return `het-env-dump-${now.toISOString().replace(/[:.]/g, '-')}.json`;
}
