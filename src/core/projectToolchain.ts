/**
 * V4-8 project toolchain semantics — pure metadata helpers.
 *
 * A project may declare which toolchain lane it is built with:
 *   - "managed": the extension's self-provisioned environment (default for new
 *                projects; deterministic, uninstall-clean).
 *   - "system":  an explicit user choice to use the machine's own toolchain
 *                (e.g. MSVC compatibility mode → coverage:none).
 * V5-3: writes go through surgical text patching (fcpp formatting preserved).
 */
import { surgicalPatch } from './metadataText';

export const TOOLCHAIN_MANAGED = 'managed';
export const TOOLCHAIN_SYSTEM = 'system';
export type ProjectToolchain = 'managed' | 'system';

/** Read metadata.toolchain → 'managed' | 'system' | undefined. */
export function parseProjectToolchain(metaText: string): ProjectToolchain | undefined {
  try {
    const meta = JSON.parse(metaText) as Record<string, unknown>;
    const v = meta.toolchain;
    return v === TOOLCHAIN_MANAGED || v === TOOLCHAIN_SYSTEM ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Set metadata.toolchain and return the rewritten text (formatting preserved). */
export function withProjectToolchain(metaText: string, value: ProjectToolchain): string {
  return surgicalPatch(metaText, { toolchain: value }).text;
}

/** Human label for a toolchain semantic (or undefined → absent). */
export function projectToolchainLabel(v: ProjectToolchain | undefined): string {
  if (v === 'system') {
    return 'system（本机环境 · 兼容模式）';
  }
  if (v === 'managed') {
    return 'managed（扩展托管环境）';
  }
  return '未声明（按托管语义处理）';
}

/**
 * T12 (E7): the build type used for LOCAL `conan create`.
 *
 * metadata.build_type is the project's declared semantics (the release flow
 * writes Release), but the previous code hard-coded 'Debug' at every call site,
 * so a Release project was never locally verified as Release. Coverage runs are
 * the one exception: instrumentation is Debug-only by construction.
 */
export function localBuildType(meta?: { build_type?: string; activate_code_coverage?: boolean }): 'Debug' | 'Release' {
  if (meta?.activate_code_coverage === true) {
    return 'Debug';
  }
  return meta?.build_type === 'Release' ? 'Release' : 'Debug';
}
