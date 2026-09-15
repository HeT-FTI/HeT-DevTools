/**
 * V4-1 host adapter: gather REAL HostCapabilities (cheap, cached) and resolve
 * the current Provider decision. The decision core stays pure
 * (`core/provisionPlan`); this module only collects platform facts and honours
 * the `HET_FAKE_HOST` JSON override (tests / zero-manual harness simulate a
 * brand-new machine without touching the real one).
 */
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { arch, platform } from 'node:os';
import { decodeWslOutput, parseWslList, wslExePath } from '../../core/wslHost';
import { run } from '../../utils/exec';
import { resolveLaneHost } from './wslProbe';
import {
  HostCapabilities,
  ProvisionPrefs,
  ProviderDecision,
  parseFakeHost,
  providerLabel,
  resolveProviderDecision,
} from '../../core/provisionPlan';

let cached: { at: number; caps: HostCapabilities } | null = null;

/** True when `leaf` sits in any PATH directory (cheap fs scan). */
function pathHas(leaf: string): boolean {
  const dirs = (process.env.PATH ?? '').split(delimiter);
  return dirs.some((d) => d && existsSync(join(d, leaf)));
}

/**
 * "现在能拿一个发行版当车道用吗" —— 必须与车道选择**同一个判据**：
 * 只有我们命名空间里**没有**双标记的发行版不算可用（那种情况要换名自建，属于 pending）。
 * 2026-09-15 CI 实测：早先这里只看 `wsl -l -q` 非空，于是"同名但不是我们的"发行版会让
 * 能力决策说 `win-wsl2`，而车道选择又说"没有可用车道" —— 两条路自相矛盾。
 */
async function wslDefaultReady(): Promise<boolean> {
  try {
    const r = await run(wslExePath(), ['-l', '-q'], { timeoutMs: 6000 });
    if (r.code !== 0) {
      return false;
    }
    const distros = parseWslList(decodeWslOutput(`${r.stdout}\n${r.stderr}`));
    if (distros.length === 0) {
      return false;
    }
    const host = await resolveLaneHost(distros);
    return host.chosen !== undefined;
  } catch {
    return false;
  }
}

/** `sudo -n true` exit 0 ⇒ passwordless sudo is available (Linux managed lane). */
async function sudoNonInteractive(): Promise<boolean> {
  try {
    const r = await run('sudo', ['-n', 'true'], { timeoutMs: 4000 });
    return r.code === 0;
  } catch {
    return false;
  }
}

async function detectCapabilities(): Promise<HostCapabilities> {
  const isWin = process.platform === 'win32';
  const isLin = process.platform === 'linux';
  const uidRoot = (process.getuid?.() ?? -1) === 0;
  const base: HostCapabilities = {
    platform: platform(),
    arch: arch(),
    wslAvailable: isWin && pathHas('wsl.exe'),
    wslDefaultReady: false,
    virtualizationEnabled: false,
    isAdmin: isWin ? false : uidRoot,
    msvcAvailable: isWin && (pathHas('cl.exe') || pathHas('cl')),
    linuxApt: isLin && pathHas('apt-get'),
    linuxAptSudo: false,
  };
  if (isWin && base.wslAvailable) {
    base.wslDefaultReady = await wslDefaultReady();
    // WSL2 answering implies the hypervisor is on (best effort).
    base.virtualizationEnabled = base.wslDefaultReady;
  }
  if (isLin && base.linuxApt) {
    base.linuxAptSudo = uidRoot || (await sudoNonInteractive());
  }
  const fake = parseFakeHost(process.env.HET_FAKE_HOST);
  return { ...base, ...fake };
}

export async function getHostCapabilities(force = false): Promise<HostCapabilities> {
  if (!force && cached && Date.now() - cached.at < 30_000) {
    return cached.caps;
  }
  const caps = await detectCapabilities();
  cached = { at: Date.now(), caps };
  return caps;
}

export async function getCurrentProvisionPlan(force = false, prefs?: ProvisionPrefs): Promise<ProviderDecision> {
  const caps = await getHostCapabilities(force);
  return resolveProviderDecision(caps, prefs);
}

export { providerLabel, resolveProviderDecision };
