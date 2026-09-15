/**
 * T06 (E8/E15/E13 收敛): the ONE environment contract.
 *
 * Before this module every surface had its own facts and wording: `envSample`
 * built a summary string, `envTopHtml`/`envWslHtml`/`envLinuxHtml`/`envOsxHtml`
 * rendered four different blocks, the health check sniffed tools again, and the
 * dashboard showed a "managed env" that no build lane consumed. The contract is
 * the single, platform-neutral shape derived from the SAME lane facts:
 *
 *   facts (lane probe / tool rows) → EnvContract → card + chip + HUD + health
 *
 * Pure (no vscode/fs): the impure collection stays in the command layer.
 */

import { CMAKE_MIN_DEFAULT, compareVersions, parseVersion } from './laneProfile';

export type RequirementId = 'git' | 'python' | 'compiler' | 'conan' | 'cmake' | 'ninja' | 'lcov' | 'doxygen' | 'graphviz' | 'make';

/** Every requirement must resolve to exactly one of these (parity-tested). */
export type Disposition = 'present' | 'healable' | 'guide' | 'unsupported';

/** Where the value comes from: CI baseline / compatible fallback / plain native. */
export type EnvBaseline = 'ci' | 'compatible' | 'native';

export interface EnvFix {
  kind: 'cmd' | 'doc' | 'setting';
  text: string;
  /** Copy-paste command when kind === 'cmd'. */
  copy?: string;
  /** Page action id (e.g. 'env:prepare') when kind === 'doc'. */
  action?: string;
}

export interface EnvRow {
  id: RequirementId;
  label: string;
  required: boolean;
  found?: { version: string; path: string };
  disposition: Disposition;
  baseline?: EnvBaseline;
  fix?: EnvFix;
  /** Second, explicit escape hatch (e.g. switch the project to toolchain=system). */
  altFix?: EnvFix;
  note?: string;
}

export interface EnvContract {
  platform: string;
  lane: string;
  coverage: 'full' | 'limited' | 'none';
  arch?: string;
  rows: EnvRow[];
  /** All REQUIRED rows are 'present' (lcov is only required by coverage runs). */
  ready: boolean;
  summary: string;
  next?: { label: string; action: string };
}

/** The explicit, user-consented fallback offered whenever a lane is blocked. */
export const FIX_USE_SYSTEM: EnvFix = {
  kind: 'setting',
  text: '改用本机工具链（兼容模式）',
  action: 'env:use-system',
};

export const ROW_LABELS: Record<RequirementId, string> = {
  git: 'Git',
  python: 'Python',
  compiler: '编译器',
  conan: 'Conan',
  cmake: 'CMake',
  ninja: 'Ninja',
  lcov: '覆盖率（lcov）',
  doxygen: 'Doxygen',
  graphviz: 'Graphviz (dot)',
  make: 'Make',
};

/** Requirements a lane must satisfy before a build can be attempted. */
export const REQUIRED_FOR_BUILD: readonly RequirementId[] = ['compiler', 'conan', 'cmake', 'ninja'];

/** Facts the command layer collected (display strings, no probing here). */
export interface ContractFacts {
  platform: string;
  lane: string;
  coverage: EnvContract['coverage'];
  arch?: string;
  summary: string;
  compiler?: string;
  compilerBaseline?: EnvBaseline;
  conan?: string;
  cmake?: string;
  /** Effective CMake floor (`HET_CMAKE_MIN` or the template default). */
  cmakeFloor?: string;
  ninja?: string;
  lcov?: string;
  git?: string;
  python?: string;
  doxygen?: string;
  graphviz?: string;
  make?: string;
  /** The lane can be prepared automatically (consent → heal) vs needs the user. */
  laneHealable?: boolean;
  /** Copy-paste/guidance text when the lane cannot self-provision. */
  laneGuide?: string;
  /** Coverage is a platform capability? (macOS: no GNU gcov) */
  lcovSupported?: boolean;
  /** Coverage reason shown on the macOS-style unsupported row. */
  lcovUnsupportedReason?: string;
}

function present(version: string | undefined, baseline?: EnvBaseline): Pick<EnvRow, 'disposition' | 'found' | 'baseline'> {
  if (version) {
    return { disposition: 'present', found: { version, path: '' }, baseline };
  }
  return { disposition: 'healable' };
}

/** Build the contract from collected facts (deterministic row order). */
export function buildEnvContract(f: ContractFacts): EnvContract {
  const rows: EnvRow[] = [];
  const laneFix: EnvFix | undefined = f.laneGuide ? { kind: 'cmd', text: '需要你完成前置步骤', copy: f.laneGuide } : undefined;
  const errFix: EnvFix = { kind: 'doc', text: '一键准备环境', action: 'env:prepare' };

  rows.push({
    id: 'compiler',
    label: ROW_LABELS.compiler,
    required: true,
    ...present(f.compiler, f.compilerBaseline),
    ...(f.compiler ? {} : f.laneGuide ? { fix: laneFix, altFix: FIX_USE_SYSTEM, note: '车道要求' } : { fix: errFix }),
  });
  rows.push({ id: 'conan', label: ROW_LABELS.conan, required: true, ...present(f.conan), ...(f.conan ? {} : { fix: errFix }) });
  // F2 (2026-09-15): the cmake row used to be presence-only, while a host cmake
  // BELOW the template floor silently made the build pull `cmake/<pinned>` from
  // ConanCenter. Say which cmake will actually be used (and how to avoid the
  // download) instead of a green tick that hides a network dependency.
  const cmakeFloor = f.cmakeFloor ?? CMAKE_MIN_DEFAULT;
  const cmakeNative = parseVersion(f.cmake);
  const cmakeBelowFloor = !!cmakeNative && compareVersions(f.cmake, cmakeFloor) < 0;
  rows.push({
    id: 'cmake',
    label: ROW_LABELS.cmake,
    required: true,
    ...present(f.cmake),
    ...(f.cmake
      ? cmakeBelowFloor
        ? {
            note: `宿主 cmake ${cmakeNative.join('.')} < 模板下限 ${cmakeFloor}：本次构建会从 ConanCenter 拉取模板钉死的 cmake（需联网）`,
            altFix: { kind: 'cmd' as const, text: `装 cmake ≥ ${cmakeFloor}，或自降底线`, copy: `# 三选一：\n# ① 装新 cmake：sudo apt-get install -y cmake   (macOS: brew install cmake)\n# ② 自降模板底线：cmake -DHET_CMAKE_MIN=${cmakeNative.join('.')} ..   （或设环境变量 HET_CMAKE_MIN）\n# ③ 改回 "toolchain": "managed"（车道自带 cmake）` },
          }
        : {}
      : { fix: errFix }),
  });
  rows.push({ id: 'ninja', label: ROW_LABELS.ninja, required: true, ...present(f.ninja), ...(f.ninja ? {} : { fix: errFix }) });

  if (f.lcovSupported === false) {
    rows.push({
      id: 'lcov',
      label: ROW_LABELS.lcov,
      required: false,
      disposition: 'unsupported',
      note: f.lcovUnsupportedReason ?? '该平台不支持 GNU gcov/lcov（有限支持）',
    });
  } else {
    rows.push({
      id: 'lcov',
      label: ROW_LABELS.lcov,
      required: false,
      ...present(f.lcov),
      ...(f.lcov ? {} : { fix: errFix, note: '仅覆盖率运行需要（按需自愈）' }),
    });
  }

  const optional: Array<[RequirementId, string | undefined]> = [
    ['git', f.git],
    ['python', f.python],
    ['doxygen', f.doxygen],
    ['graphviz', f.graphviz],
    ['make', f.make],
  ];
  for (const [id, value] of optional) {
    if (value === undefined) {
      continue;
    }
    rows.push({ id, label: ROW_LABELS[id], required: false, ...present(value) });
  }

  const ready = rows.filter((r) => r.required).every((r) => r.disposition === 'present');
  const needsAction = rows.some((r) => r.required && r.disposition !== 'present');
  const contract: EnvContract = {
    platform: f.platform,
    lane: f.lane,
    coverage: f.coverage,
    arch: f.arch,
    rows,
    ready,
    summary: f.summary,
  };
  if (needsAction) {
    const blocked = rows.some((r) => r.required && (r.disposition === 'guide' || (r.disposition === 'healable' && r.fix?.kind === 'cmd')));
    contract.next = blocked
      ? { label: '按指引完成前置', action: 'env:prepare' }
      : { label: f.laneHealable === false ? '重新检测' : '一键准备环境', action: 'env:prepare' };
  }
  return contract;
}

/** ≤3 short gaps for the chip/HUD hover (fail-first, stable order). */
export function contractGaps(c: EnvContract): string[] {
  const rank = (r: EnvRow): number => (r.disposition === 'guide' ? 0 : r.disposition === 'healable' ? 1 : 2);
  return c.rows
    .filter((r) => r.required && r.disposition !== 'present')
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, 3)
    .map((r) => `${r.label}${r.disposition === 'healable' ? '待准备' : r.disposition === 'guide' ? '需处理' : ''}`);
}

/** Compact one-line status for logs/dumps: `lane · compiler ✓/✗ · conan ✓/✗ …`. */
export function contractLine(c: EnvContract): string {
  const mark = (id: RequirementId): string => {
    const row = c.rows.find((r) => r.id === id);
    if (!row) {
      return '·';
    }
    return row.disposition === 'present' ? '✓' : row.disposition === 'unsupported' ? '—' : '✗';
  };
  return `${c.lane} ${mark('compiler')}gcc ${mark('conan')}conan ${mark('cmake')}cmake ${mark('ninja')}ninja ${mark('lcov')}lcov`;
}
