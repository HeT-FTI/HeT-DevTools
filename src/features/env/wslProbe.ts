/**
 * V4-3 Windows Provider (WSL2 lane) — host probe.
 *
 * Lists distros (`wsl -l -q`) and snapshots the toolchain inside a chosen
 * distro via a deterministic probe command (parsed by core/wslHost). All calls
 * go through the real `wsl.exe`; results are cached 60 s. No downloads, no
 * sudo, no human interaction — pure capability report for the dashboard.
 */
import { run } from '../../utils/exec';
import { MANAGED_DISTRO, WslToolSnapshot, decodeWslOutput, parseWslList, parseWslToolReport, wslExePath } from '../../core/wslHost';
import { LaneFacts, baselineNote, laneFactsScript, parseLaneFacts, unsupportedArchMessage } from '../../core/laneProfile';
import { runWslScript } from './wslLane';

export interface WslLaneStatus {
  available: boolean;
  distro?: string;
  ready: boolean;
  tools: WslToolSnapshot;
  note?: string;
  /** T02: facts the status derives from (compiler baseline / conan arch). */
  baseline?: 'ci' | 'compatible' | 'native';
  arch?: string;
}

let cache: { at: number; status: WslLaneStatus } | null = null;

// T02 (E1): the status probe and the BUILD must ask the same question. The old
// inline probe asked for an unversioned `gcc` while the lane required
// `/usr/bin/gcc-13`, so the dashboard could show "就绪" for a lane that would
// fail in CMake. Both now read the shared facts ladder (compiler ladder + arch
// + gcov/lcov) through the file transport (the only reliable wsl path).

async function listDistros(): Promise<string[]> {
  try {
    const r = await run(wslExePath(), ['-l', '-q'], { timeoutMs: 8000 });
    if (r.code !== 0) {
      return [];
    }
    return parseWslList(decodeWslOutput(`${r.stdout}\n${r.stderr}`));
  } catch {
    return [];
  }
}

/** Raw facts (arch + compiler ladder + gcov/lcov) inside one distro. */
export async function probeDistroFacts(distro: string): Promise<LaneFacts> {
  try {
    const r = await runWslScript(distro, laneFactsScript(), 15_000);
    return r.code === 0 ? parseLaneFacts(r.stdout) : { archRaw: '', arch: '' };
  } catch {
    return { archRaw: '', arch: '' };
  }
}

/** Probe one distro's system tools (compiler + lcov), facts-based. */
export async function probeDistroTools(distro: string): Promise<WslToolSnapshot> {
  const facts = await probeDistroFacts(distro);
  const snap: WslToolSnapshot = {};
  if (facts.compiler) {
    snap.gcc = `${facts.compiler.name} (${facts.compiler.version})`;
  }
  if (facts.lcov) {
    snap.lcov = facts.lcov;
  }
  return snap;
}

/** Probe the managed lane venv conan/cmake (no provisioning — read only). */
export async function probeLaneTools(distro: string): Promise<{ conan?: string; cmake?: string; ninja?: string }> {
  try {
    const script = [
      'P="$HOME/.het-fti/managed-env/venv/bin"',
      "printf 'conan:'; [ -x \"$P/conan\" ] && \"$P/conan\" --version 2>/dev/null | head -1 || echo -; echo",
      "printf 'cmake:'; [ -x \"$P/cmake\" ] && \"$P/cmake\" --version 2>/dev/null | head -1 || echo -; echo",
      "printf 'ninja:'; [ -x \"$P/ninja\" ] && \"$P/ninja\" --version 2>/dev/null | head -1 || echo -; echo",
    ].join('\n');
    const r = await runWslScript(distro, script, 15_000);
    if (r.code !== 0) {
      return {};
    }
    return parseWslToolReport(decodeWslOutput(r.stdout));
  } catch {
    return {};
  }
}

/**
 * Overall lane status: prefer the managed distro, else the first available.
 * `tools.conan`/`tools.cmake` reflect the MANAGED LANE venv (used toolchain);
 * the distro's own base conan/cmake are deliberately NOT reported (they are
 * never used under managed semantics — issue-1 feedback).
 */
export async function getWslLaneStatus(force = false): Promise<WslLaneStatus> {
  if (!force && cache && Date.now() - cache.at < 60_000) {
    return cache.status;
  }
  const distros = await listDistros();
  const status: WslLaneStatus = { available: distros.length > 0, tools: {}, ready: false };
  if (!status.available) {
    status.note = '未检测到 WSL2 发行版（托管车道需要启用 WSL2：wsl --install -d Ubuntu-24.04；或设 metadata.toolchain=system）。';
    cache = { at: Date.now(), status };
    return status;
  }
  const chosen = distros.includes(MANAGED_DISTRO) ? MANAGED_DISTRO : distros[0];
  status.distro = chosen;
  // T02: compiler/arch/lcov from the SAME ladder the build uses.
  const facts = await probeDistroFacts(chosen);
  if (facts.compiler) {
    status.tools.gcc = `${facts.compiler.name} (${facts.compiler.version})`;
    status.baseline = facts.compiler.baseline;
  }
  if (facts.lcov) {
    status.tools.lcov = facts.lcov;
  }
  status.arch = facts.arch || undefined;
  const lane = await probeLaneTools(chosen);
  if (lane.conan) {
    status.tools.conan = lane.conan;
  }
  if (lane.cmake) {
    status.tools.cmake = lane.cmake;
  }
  if (lane.ninja) {
    status.tools.ninja = lane.ninja;
  }
  status.ready = !!facts.compiler && !!facts.arch;
  status.note = chosen === MANAGED_DISTRO ? '托管 distro（het-fcpp）' : `复用现有发行版 ${chosen}（gcc 系统级）`;
  if (!facts.compiler) {
    status.note += ' · 编译器未就绪（首次「构建并测试」将按阶梯自动准备）';
  } else if (!facts.arch) {
    status.note += ` · ${unsupportedArchMessage(facts.archRaw).replace(/\n+/gu, ' ')}`;
  } else {
    status.note += ` · ${baselineNote(facts.compiler)}`;
  }
  if (!status.tools.conan || !status.tools.cmake) {
    status.note += ' · 托管车道 conan/cmake 未就绪（首次「构建并测试」将自动准备）';
  }
  cache = { at: Date.now(), status };
  return status;
}
