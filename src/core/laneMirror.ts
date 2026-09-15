/**
 * T18 (E7): corporate network support — pip index / conan remote / HTTP proxy.
 *
 * The managed lanes run pip (conan/cmake/ninja, sphinx), apt (compiler/lcov in
 * the Linux/WSL lanes) and conan (ConanCenter), all of which fail on an
 * intranet without a mirror or proxy. These settings are injected into the lane
 * scripts as plain `export`s, and the conan remote is updated INSIDE the lane's
 * private CONAN_HOME (never the user's ~/.conan2, never a system file).
 *
 * Pure module: shell snippets are strings, so the exact behaviour is testable.
 */
import { posix } from 'node:path';
import type { ManagedLayout } from './managedEnv';

export interface LaneMirror {
  /** e.g. https://pypi.tuna.tsinghua.edu.cn/simple — exported as PIP_INDEX_URL. */
  pipIndexUrl?: string;
  /** Replaces the `conancenter` remote URL (mirror/proxy of ConanCenter). */
  conanRemote?: string;
  /** http://proxy.corp:8080 — exported for pip/conan/apt. */
  httpProxy?: string;
}

export interface LaneMirrorInput {
  pipIndexUrl?: string;
  conanRemote?: string;
  httpProxy?: string;
}

/** Normalise settings → mirror (undefined when nothing is configured). */
export function laneMirrorOf(input: LaneMirrorInput): LaneMirror | undefined {
  const out: LaneMirror = {};
  for (const key of ['pipIndexUrl', 'conanRemote', 'httpProxy'] as const) {
    const value = (input[key] ?? '').trim();
    if (value) {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Stable cache key (lane caches must be invalidated when the mirror changes). */
export function mirrorCacheKey(m?: LaneMirror): string {
  return m ? `${m.pipIndexUrl ?? ''}|${m.conanRemote ?? ''}|${m.httpProxy ?? ''}` : '';
}

/** One short human line for the card/dump ('' when default). */
export function mirrorSummary(m?: LaneMirror): string {
  if (!m) {
    return '';
  }
  const bits: string[] = [];
  if (m.pipIndexUrl) {
    bits.push(`pip ${m.pipIndexUrl}`);
  }
  if (m.conanRemote) {
    bits.push(`conan ${m.conanRemote}`);
  }
  if (m.httpProxy) {
    bits.push(`proxy ${m.httpProxy}`);
  }
  return bits.join(' · ');
}

/** `export …` lines prepended to lane scripts (pip/conan/apt all honour them). */
export function mirrorShellExports(m?: LaneMirror): string[] {
  if (!m) {
    return [];
  }
  const out: string[] = [];
  if (m.httpProxy) {
    out.push(
      `export http_proxy="${m.httpProxy}"`,
      `export https_proxy="${m.httpProxy}"`,
      `export HTTP_PROXY="${m.httpProxy}"`,
      `export HTTPS_PROXY="${m.httpProxy}"`,
      'export no_proxy="${no_proxy:-localhost,127.0.0.1}"',
    );
  }
  if (m.pipIndexUrl) {
    out.push(`export PIP_INDEX_URL="${m.pipIndexUrl}"`);
    // pip refuses plain-http intranet indexes unless the host is trusted.
    out.push(`export PIP_TRUSTED_HOST="$(printf '%s' "$PIP_INDEX_URL" | sed -e 's#^[a-zA-Z]*://##' -e 's#/.*$##')"`);
  }
  return out;
}

/**
 * Point the lane's PRIVATE conan home at a mirror. Runs only when conan exists
 * (after the venv bootstrap); failures stay non-fatal so an offline first run
 * still surfaces the real pip/apt error instead of this line.
 */
export function conanRemoteUpdateLine(m: LaneMirror | undefined, venvBin: string): string | undefined {
  if (!m?.conanRemote) {
    return undefined;
  }
  const conan = posix.join(venvBin, 'conan');
  return `[ -x "${conan}" ] && "${conan}" remote update conancenter --url "${m.conanRemote}" --force >/dev/null 2>&1 || true`;
}

/** Env overrides for executors that spawn without a shell script (docs pip). */
export function mirrorEnv(m?: LaneMirror): Record<string, string> {
  const env: Record<string, string> = {};
  if (m?.pipIndexUrl) {
    env.PIP_INDEX_URL = m.pipIndexUrl;
  }
  if (m?.httpProxy) {
    env.http_proxy = m.httpProxy;
    env.https_proxy = m.httpProxy;
    env.HTTP_PROXY = m.httpProxy;
    env.HTTPS_PROXY = m.httpProxy;
  }
  return env;
}

/** Layout helper kept for symmetry with the other lane modules (unit-tested). */
export function laneVenvBin(layout: ManagedLayout, isWin: boolean): string {
  return posix.join(layout.pyVenv, isWin ? 'Scripts' : 'bin');
}
