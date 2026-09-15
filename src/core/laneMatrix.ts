/**
 * T21: LANE × REQUIREMENT matrix — "who can heal what, and where that is proven".
 *
 * Why this module exists: the same knowledge was spread over three places that
 * could drift apart silently —
 *   · `envContract.ts` decided how a missing row is *displayed*;
 *   · `extension.ts › collectEnvContract` hand-fed per-platform facts
 *     (`lcovSupported = false` on macOS, a hard-coded reason string…);
 *   · the lane shell scripts / execution layers actually *did* the healing.
 * Nothing checked that the three agreed. T21 makes the agreement a data
 * structure (this file) plus a test (`src/test/laneParity.test.ts`) that:
 *   1. requires a disposition for every lane × every lane-owned requirement
 *      (no gaps, and no silently "forgotten" cell);
 *   2. requires every cell to carry EVIDENCE — an artifact + a marker that must
 *      be found in the artefact the lane really runs — so a declarative lie
 *      ("we heal lcov") cannot survive deleting the shell step that heals it;
 *   3. forbids `unsupported` for anything a build needs, and requires a written
 *      `note` whenever a capability is refused (the macOS coverage decision).
 *
 * Pure data + pure lookups (no vscode/fs/exec).
 */
import { REQUIREMENT_IDS, type RequirementId } from './envContract';

export type LaneId = 'linux-managed' | 'win-wsl2' | 'macos-native';

/** Artefacts a heal rule can be proven by (see the parity test for resolvers). */
export type LaneArtifact =
  /** core/wslLane.wslLaneEnsureCommand — shared by Linux / WSL / macOS lanes. */
  | 'ensure'
  /** core/wslLane.wslLaneBuildCommand — shared by all three lanes. */
  | 'build'
  /** core/wslLane.wslLaneDocsEnsureCommand | core/macLane.macLaneDocsEnsureCommand. */
  | 'docs-ensure'
  /** core/wslLane.wslLaneDocsRunCommand. */
  | 'docs-run'
  /** core/laneProfile — the shared facts probe + the compiler LADDER itself. */
  | 'core-profile'
  /** features/env/linuxLane — root (apt) self-heal on a native Linux host. */
  | 'exec-linux'
  /** features/env/wslLane — root (apt) self-heal INSIDE the distro. */
  | 'exec-wsl'
  /** features/env/macLane — user-level lane (no root by design). */
  | 'exec-mac'
  /** core/macLane — macOS guide text (CLT / brew). */
  | 'core-mac';

export interface HealEvidence {
  artifact: LaneArtifact;
  /** Literal that must be present in that artefact (proves the rule is wired). */
  marker: string;
}

export type HealKind = 'auto' | 'guide' | 'unsupported';

export interface HealRule {
  /** auto = the lane does it · guide = we tell the user exactly what to run ·
   *  unsupported = the platform cannot do it (must be explained). */
  kind: HealKind;
  evidence: readonly HealEvidence[];
  /** Short honest sentence used in cards/dumps (zh). */
  note: string;
}

export interface LaneDescriptor {
  id: LaneId;
  label: string;
  /** Node `process.platform` values this lane serves. */
  platforms: readonly string[];
  /** Committed capability (mirrors §6 of the plan's promise matrix). */
  coverage: 'full' | 'limited' | 'none';
  heal: Readonly<Record<LaneRequirement, HealRule>>;
}

/**
 * Requirements a LANE owns. `git` is deliberately NOT here: it is a
 * project/CI prerequisite provided by the host (the template and the user own
 * it) — the lane never installs it, and the contract simply shows it when it
 * exists. The parity test asserts this split is explicit and total, so nobody
 * can quietly grow the blind spot.
 */
export const NON_LANE_REQUIREMENTS: readonly RequirementId[] = ['git'];

export type LaneRequirement = Exclude<RequirementId, 'git'>;

export const LANE_IDS: readonly LaneId[] = ['linux-managed', 'win-wsl2', 'macos-native'];

/** Lane-owned requirements, in canonical order. */
export const LANE_REQUIREMENTS: readonly LaneRequirement[] = REQUIREMENT_IDS.filter(
  (id): id is LaneRequirement => !NON_LANE_REQUIREMENTS.includes(id),
);

/* -------------------------------------------------------------------------- *
 * The matrix
 * -------------------------------------------------------------------------- */

/** Cells shared by the Linux host lane and the WSL2 lane (same pure builders;
 *  only the execution layer — and therefore the apt markers — differs). */
function posixLaneHeal(
  exec: 'exec-linux' | 'exec-wsl',
  apt: (pkgs: string) => string,
  docsInstall: string,
): Record<LaneRequirement, HealRule> {
  return {
    python: {
      kind: 'auto',
      evidence: [
        { artifact: 'ensure', marker: 'lane_python_candidates' },
        { artifact: 'ensure', marker: 'exit 3' },
        { artifact: exec, marker: apt('python3-venv') },
        { artifact: 'docs-ensure', marker: 'docs_python:below' },
      ],
      note: '车道挑宿主已有的解释器建私有 venv（新→旧、下限优先）；缺 venv 能力时 root 自愈 python3-venv。文档栈需 Python ≥ 3.10，低于则提前失败并给出办法。',
    },
    compiler: {
      kind: 'auto',
      evidence: [
        { artifact: 'core-profile', marker: 'gcc-13:13:ci' },
        { artifact: 'ensure', marker: 'lane_cc_selected:' },
        { artifact: exec, marker: 'GCC_APT_ATTEMPTS' },
      ],
      note: '阶梯：基线 gcc-13 → 兼容 14/15/12 → 发行版默认；免密 root 时按同一阶梯 apt 自愈，并把实际版本如实写进 profile。',
    },
    conan: {
      kind: 'auto',
      evidence: [{ artifact: 'ensure', marker: '"conan>=2.0,<3"' }],
      note: '装进车道私有 venv（连同私有 CONAN_HOME）；不碰用户的 conda/系统 conan。',
    },
    cmake: {
      kind: 'auto',
      evidence: [
        { artifact: 'ensure', marker: '"cmake>=4.0,<5"' },
        { artifact: 'build', marker: 'HET_CMAKE_BUILD_REQUIRE=none' },
      ],
      note: '车道 venv 自带 cmake，构建时跳过模板从 ConanCenter 拉取的那份（一份而不是两份）。',
    },
    ninja: {
      kind: 'auto',
      evidence: [{ artifact: 'ensure', marker: '"ninja>=1.11"' }],
      note: '车道 venv 自带 ninja。',
    },
    lcov: {
      kind: 'auto',
      evidence: [
        { artifact: 'ensure', marker: 'echo lane_lcov:' },
        { artifact: exec, marker: apt('lcov') },
        // E5: geninfo resolves the UNVERSIONED gcov, so the lane pins it to the
        // chosen compiler with a venv-local shim — proof that alignment is real.
        { artifact: 'ensure', marker: 'HET_GCOV_SHIM' },
      ],
      note: '仅覆盖率运行需要：缺失时 root 自愈 apt 安装 lcov；gcov 用车道 venv 内的 shim 对齐所选编译器（不动系统文件）。',
    },
    doxygen: {
      kind: 'auto',
      evidence: [
        { artifact: 'docs-ensure', marker: 'echo docs_doxygen:' },
        { artifact: exec, marker: docsInstall },
      ],
      note: '文档栈的系统依赖由 root 一次性安装（幂等、静默）。',
    },
    graphviz: {
      kind: 'auto',
      evidence: [
        { artifact: 'docs-ensure', marker: 'echo docs_dot:' },
        { artifact: exec, marker: docsInstall },
      ],
      note: '同 doxygen：随系统依赖一起自愈，缺则文档前置检查会明确报出。',
    },
    make: {
      kind: 'auto',
      evidence: [
        { artifact: 'ensure', marker: 'echo lane_make:' },
        { artifact: exec, marker: apt('make') },
        { artifact: 'docs-ensure', marker: 'echo docs_make:' },
        { artifact: exec, marker: docsInstall },
      ],
      note: '系统 make：**构建链与文档链都要** —— Conan/CMake 的默认生成器是 "Unix Makefiles"（模板的 cmake_layout + CMakeToolchain 都没指定 Ninja），所以工程自身与源码编译的依赖都依赖它；缺则 root 自愈。',
    },
  };
}

export const LANE_MATRIX: Readonly<Record<LaneId, LaneDescriptor>> = {
  'linux-managed': {
    id: 'linux-managed',
    label: 'Linux 托管（隔离 venv + 私有 CONAN_HOME）',
    platforms: ['linux'],
    coverage: 'full',
    heal: posixLaneHeal('exec-linux', (pkgs) => `rootAptLinux('${pkgs}')`, "rootAptLinux('doxygen', 'graphviz', 'make')"),
  },
  'win-wsl2': {
    id: 'win-wsl2',
    label: 'Windows + WSL2 托管（发行版内的同名隔离车道）',
    platforms: ['win32'],
    coverage: 'full',
    heal: posixLaneHeal('exec-wsl', (pkgs) => `rootApt(distro, '${pkgs}')`, 'apt-get install -y -qq doxygen graphviz make'),
  },
  'macos-native': {
    id: 'macos-native',
    label: 'macOS 原生（CLT + 车道 venv；有限支持）',
    platforms: ['darwin'],
    coverage: 'none',
    heal: {
      python: {
        kind: 'auto',
        evidence: [
          { artifact: 'ensure', marker: 'lane_python_candidates' },
          { artifact: 'core-mac', marker: 'brew install python' },
        ],
        note: 'CLT 自带 python3；宿主有更新的解释器时优先（文档栈需 Python ≥ 3.10，低于则提前失败并给出 brew 办法）。',
      },
      compiler: {
        kind: 'guide',
        evidence: [
          { artifact: 'core-mac', marker: 'xcode-select --install' },
          { artifact: 'ensure', marker: 'lane_cc_baseline:' },
        ],
        note: '需要一次人工确认的 Xcode Command Line Tools（GUI）；装好后车道自动生成 apple-clang profile，不猜版本。',
      },
      conan: {
        kind: 'auto',
        evidence: [{ artifact: 'ensure', marker: '"conan>=2.0,<3"' }],
        note: '装进车道私有 venv（用户级，无 root）。',
      },
      cmake: {
        kind: 'auto',
        evidence: [
          { artifact: 'ensure', marker: '"cmake>=4.0,<5"' },
          { artifact: 'build', marker: 'HET_CMAKE_BUILD_REQUIRE=none' },
        ],
        note: '车道 venv 自带 cmake；构建时不再从 ConanCenter 拉取。',
      },
      ninja: {
        kind: 'auto',
        evidence: [{ artifact: 'ensure', marker: '"ninja>=1.11"' }],
        note: '车道 venv 自带 ninja。',
      },
      lcov: {
        kind: 'unsupported',
        evidence: [{ artifact: 'core-mac', marker: 'coverage is NOT' }],
        note: 'Apple clang 不产生 GNU gcov 数据（模板产出的是 profraw）→ 覆盖率不在 macOS 承诺内；llvm-cov→gcov 路线见 T20。',
      },
      doxygen: {
        kind: 'guide',
        evidence: [
          { artifact: 'docs-ensure', marker: 'command -v doxygen' },
          { artifact: 'core-mac', marker: 'brew install' },
        ],
        note: '文档链的系统依赖走 Homebrew（macOS 无免密 root，brew 归用户所有）→ 只报告 + 给命令，绝不代装。',
      },
      graphviz: {
        kind: 'guide',
        evidence: [
          { artifact: 'docs-ensure', marker: 'echo docs_dot:' },
          { artifact: 'core-mac', marker: 'brew install' },
        ],
        note: '同 doxygen：brew install graphviz（缺失只影响文档，不影响构建/测试）。',
      },
      make: {
        kind: 'guide',
        evidence: [
          { artifact: 'docs-ensure', marker: 'command -v make' },
          { artifact: 'core-mac', marker: 'brew install' },
        ],
        note: '系统 make（Xcode CLT 自带；缺失时给 brew 指引）。',
      },
    },
  },
};

/* -------------------------------------------------------------------------- *
 * Pure lookups
 * -------------------------------------------------------------------------- */

export function laneForPlatform(platform: string): LaneDescriptor | undefined {
  return LANE_IDS.map((id) => LANE_MATRIX[id]).find((l) => l.platforms.includes(platform));
}

export function laneHeal(lane: LaneId, requirement: LaneRequirement): HealRule {
  return LANE_MATRIX[lane].heal[requirement];
}

/** Coverage capability of a lane (macOS: none — never a silent zero-score). */
export function laneCoverage(lane: LaneId): LaneDescriptor['coverage'] {
  return LANE_MATRIX[lane].coverage;
}

/**
 * Coverage facts for the contract: a lane whose lcov rule is `unsupported`
 * reports the capability as absent AND the reason that rule carries, so the
 * card can never say "覆盖率缺失" for a platform that simply cannot do it.
 */
export function laneLcovFacts(lane: LaneId): { supported: boolean; reason?: string } {
  const rule = LANE_MATRIX[lane].heal.lcov;
  return rule.kind === 'unsupported' ? { supported: false, reason: rule.note } : { supported: true };
}

/** Requirements the lane heals itself (no user action). */
export function laneAutoHeals(lane: LaneId): LaneRequirement[] {
  return LANE_REQUIREMENTS.filter((id) => LANE_MATRIX[lane].heal[id].kind === 'auto');
}

/** Requirements the lane can only ask the user for. */
export function laneGuides(lane: LaneId): LaneRequirement[] {
  return LANE_REQUIREMENTS.filter((id) => LANE_MATRIX[lane].heal[id].kind === 'guide');
}

export interface LaneGap {
  lane: LaneId;
  requirement: LaneRequirement;
  why: 'no-rule' | 'no-evidence';
}

/**
 * Structural holes in the matrix — `[]` for a healthy matrix. Used by the T21
 * parity test (which also asserts the split against `REQUIREMENT_IDS` is
 * total), and by the deliberate-deletion self-proof.
 */
export function laneMatrixGaps(matrix: Readonly<Record<LaneId, LaneDescriptor>> = LANE_MATRIX): LaneGap[] {
  const gaps: LaneGap[] = [];
  for (const lane of LANE_IDS) {
    for (const requirement of LANE_REQUIREMENTS) {
      const rule = matrix[lane]?.heal?.[requirement] as HealRule | undefined;
      if (!rule || !rule.kind || !rule.note) {
        gaps.push({ lane, requirement, why: 'no-rule' });
      } else if (rule.evidence.length === 0) {
        gaps.push({ lane, requirement, why: 'no-evidence' });
      }
    }
  }
  return gaps;
}

/** Compact one-line summary for logs/dumps: `lane · auto 7 · guide 2 · — 1`. */
export function laneMatrixLine(lane: LaneId): string {
  const kinds = LANE_REQUIREMENTS.map((id) => LANE_MATRIX[lane].heal[id].kind);
  const count = (k: HealKind): number => kinds.filter((x) => x === k).length;
  return `${lane} · auto ${count('auto')} · guide ${count('guide')} · unsupported ${count('unsupported')}`;
}
