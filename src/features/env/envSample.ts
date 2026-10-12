/**
 * V5-2B single environment sample — ONE source of truth for the chip hover
 * "开发环境" row, the chip hover and the cockpit env view (no second, sniffed view).
 *
 * Gathers the Provider decision + managed-env state + WSL/macOS lane snapshot
 * into one object with a short `summary` line and a `conan` readiness fact for
 * the health check. Calls go through the real probe modules (cached there).
 */
import { getCurrentProvisionPlan } from './provisionHost';
import { currentManagedStatus } from './managedProvisioner';
import { getWslLaneStatus } from './wslProbe';
import { getMacosLaneStatus } from './macosProbe';
import { getLinuxLaneStatus, linuxLaneConanPresent } from './linuxLane';
import { getMacLaneStatus, macLaneConanPresent } from './macLane';
import { laneConanPresent } from './wslLane';
import { providerLabel } from '../../core/provisionPlan';
import type { ManagedState } from '../../core/managedEnv';

export interface EnvSample {
  providerId: string | null;
  providerLabel: string;
  coverage: 'full' | 'partial' | 'none' | '';
  reason?: string;
  managed: { state: ManagedState; tools: Record<string, string>; note?: string } | null;
  wsl: { distro?: string; ready: boolean; tools: Record<string, string>; note?: string; arch?: string; baseline?: 'ci' | 'compatible' | 'native' } | null;
  osx: { clt: boolean; clangVersion?: string; python?: string; note?: string } | null;
  /** A3: native-Linux managed lane (linux + linux-managed provider). */
  linux: { home: string; ready: boolean; tools: Record<string, string>; note?: string; arch?: string; baseline?: 'ci' | 'compatible' | 'native' } | null;
  /** conan readiness: true/false under managed semantics; null = system sniff. */
  conan: boolean | null;
  /** One short line for the hover "开发环境" row (no long runtime details). */
  summary: string;
}

/** First dotted version number (e.g. 'Conan version 2.32.0' → '2.32.0'). */
function versionNum(s: string | undefined): string | null {
  if (!s) {
    return null;
  }
  return /(\d+(?:\.\d+)+)/u.exec(s)?.[1] ?? null;
}

/** Short gcc token: prefer 'gcc-13', else its dotted version. */
function gccShort(s: string | undefined): string | null {
  if (!s) {
    return null;
  }
  return (/(gcc-\d+)/u.exec(s) ?? /(\d+(?:\.\d+)+)/u.exec(s))?.[1] ?? null;
}

/** Compact human line from a sample (pure — unit tested, kept SHORT). */
export function envSummaryOf(
  s: Pick<EnvSample, 'providerId' | 'providerLabel' | 'wsl' | 'linux' | 'managed' | 'osx'>,
): string {
  const wslTools = s.wsl?.tools ?? {};
  if (s.wsl?.ready) {
    const bits = ['WSL2'];
    if (s.wsl.distro) {
      bits.push(s.wsl.distro);
    }
    const gcc = gccShort(wslTools.gcc);
    if (gcc) {
      bits.push(gcc.startsWith('gcc-') ? gcc : `gcc ${gcc}`);
    }
    const conan = versionNum(wslTools.conan);
    if (conan) {
      bits.push(`conan ${conan}`);
    }
    return bits.join(' · ');
  }
  // A3: native-Linux managed lane (derived-first) — authoritative for builds.
  if (s.linux) {
    const t = s.linux.tools ?? {};
    if (s.linux.ready) {
      const bits = ['Linux 派生 managed'];
      const conan = versionNum(t.conan);
      if (conan) {
        bits.push(`conan ${conan}`);
      }
      const cmake = versionNum(t.cmake);
      if (cmake) {
        bits.push(`cmake ${cmake}`);
      }
      return bits.join(' · ');
    }
  }
  if (s.managed && s.managed.state === 'ready') {
    const t = s.managed.tools;
    const conan = versionNum(t.conan);
    const cmake = versionNum(t.cmake);
    return `托管环境${conan ? ` · conan ${conan}` : ''}${cmake ? ` · cmake ${cmake}` : ''}`;
  }
  if (s.osx && s.osx.clt) {
    return `macOS · CLT${s.osx.clangVersion ? ` · clang ${s.osx.clangVersion}` : ''}`;
  }
  if (s.providerLabel) {
    return s.providerLabel;
  }
  return '环境未检测';
}

/**
 * V5-2B: conan readiness fact for the health check. Under managed semantics it
 * reflects the REAL lane (venv conan exists): on Windows the WSL2 lane, on
 * Linux the native managed lane. For explicit system/native providers it
 * returns null so health falls back to system sniffing.
 */
export async function envConanFact(): Promise<{ conan?: boolean } | undefined> {
  const plan = await getCurrentProvisionPlan(false).catch(() => null);
  if (!plan) {
    return undefined; // native fallback: system conan decides
  }
  if (process.platform === 'win32') {
    if (plan.provider === 'win-wsl2-pending') {
      return { conan: false };
    }
    if (plan.provider === 'win-wsl2') {
      const wsl = await getWslLaneStatus(false).catch(() => null);
      if (!wsl?.distro) {
        return { conan: false };
      }
      return { conan: await laneConanPresent(wsl.distro).catch(() => false) };
    }
    return undefined;
  }
  if (process.platform === 'linux') {
    // A3: linux-managed → lane venv decides; linux-native → system sniff.
    if (plan.provider === 'linux-managed') {
      const lane = await getLinuxLaneStatus(false).catch(() => null);
      if (!lane?.available) {
        return { conan: false };
      }
      return { conan: await linuxLaneConanPresent().catch(() => false) };
    }
    return undefined;
  }
  if (process.platform === 'darwin') {
    // T07: the macOS lane facts decide conan readiness (venv conan present).
    const mac = await getMacLaneStatus(false).catch(() => null);
    if (mac) {
      return { conan: await macLaneConanPresent().catch(() => false) };
    }
    return undefined;
  }
  return undefined;
}

/** Assemble the full sample (component — uses cached real probes). */
export async function collectEnvSample(storageRoot: string): Promise<EnvSample> {
  const plan = await getCurrentProvisionPlan(false).catch(() => null);
  const managed = storageRoot ? currentManagedStatus(storageRoot, process.platform === 'win32') : null;
  const isWinWsl = process.platform === 'win32' && (plan?.provider === 'win-wsl2' || plan?.provider === 'win-wsl2-pending');
  const wsl = isWinWsl ? await getWslLaneStatus(false).catch(() => null) : null;
  const osx = process.platform === 'darwin' && plan?.provider === 'macos-native' ? await getMacosLaneStatus(false).catch(() => null) : null;
  // A3: native Linux managed lane (derived-first provider).
  const isLinuxManaged = process.platform === 'linux' && plan?.provider === 'linux-managed';
  const linux = isLinuxManaged ? await getLinuxLaneStatus(false).catch(() => null) : null;
  const sample: EnvSample = {
    providerId: plan?.provider ?? null,
    providerLabel: plan ? providerLabel(plan.provider) : '',
    coverage: plan?.coverage ?? '',
    reason: plan?.reason,
    managed:
      managed && managed.state !== 'absent'
        ? { state: managed.state, tools: managed.tools ?? {}, note: managed.note }
        : null,
    wsl: wsl && wsl.available ? { distro: wsl.distro, ready: wsl.ready, tools: (wsl.tools ?? {}) as Record<string, string>, note: wsl.note, arch: wsl.arch, baseline: wsl.baseline } : null,
    osx: osx ? { clt: osx.clt, clangVersion: osx.clangVersion, python: osx.python, note: osx.note } : null,
    linux: linux ? { home: linux.home, ready: linux.ready, tools: (linux.tools ?? {}) as Record<string, string>, note: linux.note, arch: linux.arch, baseline: linux.baseline } : null,
    conan: null,
    summary: '',
  };
  sample.conan = (await envConanFact().catch(() => undefined))?.conan ?? null;
  sample.summary = envSummaryOf(sample);
  return sample;
}
