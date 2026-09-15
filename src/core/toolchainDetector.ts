import { ToolStatus } from '../types';
import { run, which } from '../utils/exec';
import { CMAKE_MIN_DEFAULT } from './laneProfile';
import { PYTHON_DOCS_FLOOR } from './lanePython';

/**
 * External toolchain probe (development-plan T-1.2).
 * Pure logic on top of exec utils — no VS Code imports.
 */

export interface ToolSpec {
  name: string;
  versionArgs?: string[];
  /** Human readable requirement, e.g. ">= 2". First integer is compared. */
  required?: string;
}

export const STANDARD_TOOLS: ToolSpec[] = [
  { name: 'conan', versionArgs: ['--version'], required: '>= 2' },
  // 下限从**归属模块**派生（T22 门禁：不允许把 CI 事实抄成第二份字面量）
  { name: 'cmake', versionArgs: ['--version'], required: `>= ${CMAKE_MIN_DEFAULT}` },
  { name: 'python', versionArgs: ['--version'], required: `>= ${PYTHON_DOCS_FLOOR}` },
  { name: 'doxygen', versionArgs: ['--version'] },
  { name: 'dot', versionArgs: ['-V'] },
  { name: 'make', versionArgs: ['--version'] },
  { name: 'clang-format', versionArgs: ['--version'] },
  { name: 'git', versionArgs: ['--version'] },
];

const FIRST_NUMBER = /\d+(?:\.\d+)*/;

/** Compare the first numeric token of a version against a requirement like ">= 2" or "3.28". */
export function versionMeetsRequirement(version: string | undefined, required?: string): boolean {
  if (!required) {
    return true;
  }
  if (!version) {
    return true; // unknown version → treat as ok, do not block
  }
  const vMatch = FIRST_NUMBER.exec(version);
  const rMatch = FIRST_NUMBER.exec(required);
  if (!vMatch || !rMatch) {
    return true;
  }
  const parts = (s: string): number[] => s.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const v = parts(vMatch[0]);
  const r = parts(rMatch[0]);
  for (let i = 0; i < Math.max(v.length, r.length); i++) {
    const a = v[i] ?? 0;
    const b = r[i] ?? 0;
    if (a > b) {
      return true;
    }
    if (a < b) {
      return false;
    }
  }
  return true;
}

async function probe(tool: ToolSpec): Promise<ToolStatus> {
  const base: ToolStatus = { name: tool.name, state: 'ok', required: tool.required };
  const foundPath = await which(tool.name);
  if (!foundPath) {
    return { ...base, state: 'missing' };
  }
  base.foundPath = foundPath;

  if (tool.versionArgs) {
    try {
      const res = await run(foundPath, tool.versionArgs, { timeoutMs: 8000 });
      const firstLine = res.stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
      base.version = (firstLine ?? '').trim();
      if (!versionMeetsRequirement(base.version, tool.required)) {
        base.state = 'versionMismatch';
      }
    } catch {
      base.state = 'missing';
    }
  }
  return base;
}

/** Probe all configured tools, keyed by tool name. */
export async function detectToolchain(
  tools: readonly ToolSpec[] = STANDARD_TOOLS,
): Promise<Record<string, ToolStatus>> {
  const result: Record<string, ToolStatus> = {};
  await Promise.all(
    tools.map(async (tool) => {
      result[tool.name] = await probe(tool);
    }),
  );
  return result;
}
