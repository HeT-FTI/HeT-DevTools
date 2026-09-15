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
import { chooseDistroForLane, isOurDistroName } from '../../core/wslDistro';
import { laneLocalAppData, ourDistroNames } from './wslImport';
import { LaneFacts, baselineNote, laneFactsScript, parseLaneFacts, unsupportedArchMessage } from '../../core/laneProfile';
import { runWslScript } from './wslLane';

export interface WslLaneStatus {
  available: boolean;
  distro?: string;
  ready: boolean;
  tools: WslToolSnapshot;
  note?: string;
  /** T17d：选中的发行版确实是我们的（双标记）吗 —— 复用了别人的发行版时为 false。 */
  owned?: boolean;
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

/** 车道宿主的选择结果（T17d：选谁 + 谁真的是我们的 + 哪些是"占着我们的名字但不是我们的"）。 */
export interface LaneHostChoice {
  chosen?: string;
  ours: string[];
  /** 命名空间是我们的、但没有双标记 → 绝不碰（导入层会换名绕开）。 */
  foreignReserved: string[];
}

/** 一次算清"车道该用谁"：双标记判据（I1）与名字判据合并成**一个**入口。 */
export async function resolveLaneHost(distros: readonly string[]): Promise<LaneHostChoice> {
  const list = [...distros];
  const ours = await ourDistroNames(list, laneLocalAppData());
  const chosen = chooseDistroForLane(list, { ourDistros: ours, legacyManaged: MANAGED_DISTRO });
  const foreignReserved = list.filter((d) => isOurDistroName(d) && !ours.includes(d));
  return { chosen, ours, foreignReserved };
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
    status.note = '未检测到 WSL2 发行版：可「一键准备环境」由托管车道自建私有发行版（无需手动安装），或设 metadata.toolchain=system 走本机兼容模式。';
    cache = { at: Date.now(), status };
    return status;
  }
  // T17d（2026-09-15 CI 实测 run 34944081639）：选发行版**必须用双标记判据**，不能只按名字。
  // 旧实现 `find(isOurDistroName)` 会把"同名但没标记"的发行版当车道 → 仪表盘显示它的空状态，
  // 而且车道会被装进它里面（导入层同一时刻却把它当外人）。两条路现在用同一个判据。
  const host = await resolveLaneHost(distros);
  if (host.chosen === undefined) {
    status.available = false;
    status.note =
      host.foreignReserved.length > 0
        ? `检测到 ${host.foreignReserved.join('、')}：名字在我们的命名空间里但**没有我们的双标记** → 不接管、不往里写任何东西；「一键准备环境」会换名自建一个（如 ${host.foreignReserved[0]}-2）。`
        : status.note;
    cache = { at: Date.now(), status };
    return status;
  }
  status.distro = host.chosen;
  status.owned = host.ours.includes(host.chosen);
  // T02: compiler/arch/lcov from the SAME ladder the build uses.
  const facts = await probeDistroFacts(host.chosen);
  if (facts.compiler) {
    status.tools.gcc = `${facts.compiler.name} (${facts.compiler.version})`;
    status.baseline = facts.compiler.baseline;
  }
  if (facts.lcov) {
    status.tools.lcov = facts.lcov;
  }
  status.arch = facts.arch || undefined;
  const lane = await probeLaneTools(host.chosen);
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
  status.note = status.owned
    ? `托管 distro（自建 · ${host.chosen}）`
    : host.chosen === MANAGED_DISTRO
      ? `托管 distro（${MANAGED_DISTRO}）`
      : `复用你已有的发行版 ${host.chosen}（gcc 系统级；车道只在自己名下 ~/.het-fti 里放东西）`;
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
