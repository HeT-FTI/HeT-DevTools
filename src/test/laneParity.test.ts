/**
 * T21: lane × requirement PARITY — the test that makes the heal matrix true.
 *
 * The plan's DoD for T21 is "delete a heal rule → the suite goes red". That is
 * only meaningful if the test checks two INDEPENDENT things:
 *   · the declarative matrix is structurally complete (every lane × every
 *     lane-owned requirement has a disposition + written note), and
 *   · every disposition is PROVEN by a marker that really exists in the
 *     artefact the lane runs (generated shell script or execution layer).
 * Deleting the rule fails the first, deleting the shell step fails the second.
 */
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REQUIRED_FOR_BUILD, REQUIREMENT_IDS } from '../core/envContract';
import { macLaneDocsEnsureCommand } from '../core/macLane';
import { settingsCompilerKey } from '../core/laneSettings';
import { LaneCompiler, laneProfileWith } from '../core/laneProfile';
import {
  HealRule,
  LANE_IDS,
  LANE_MATRIX,
  LANE_REQUIREMENTS,
  LaneArtifact,
  LaneDescriptor,
  LaneId,
  NON_LANE_REQUIREMENTS,
  laneAutoHeals,
  laneCoverage,
  laneForPlatform,
  laneGuides,
  laneLcovFacts,
  laneMatrixGaps,
  laneMatrixLine,
} from '../core/laneMatrix';
import {
  WSL_DOCS_PIP,
  managedLaneBuildCommand,
  managedLaneDocsEnsureCommand,
  managedLaneDocsRunCommand,
  managedLaneEnsureCommand,
} from '../core/wslLane';

const HOME = '/home/lane';
const CWD = '/work/proj';

/** Facts of the lane's chosen compiler (as the ladder would report them). */
const LINUX_CC: LaneCompiler = {
  name: 'gcc-13',
  cc: '/usr/bin/gcc-13',
  cxx: '/usr/bin/g++-13',
  version: '13',
  libcxx: 'libstdc++11',
  baseline: 'ci',
};
const MAC_CC: LaneCompiler = {
  name: 'Apple clang',
  cc: '/usr/bin/clang',
  cxx: '/usr/bin/clang++',
  version: '21.0',
  libcxx: 'libc++',
  baseline: 'native',
};

const lane = (id: LaneId): LaneDescriptor => LANE_MATRIX[id];
const isMac = (id: LaneId): boolean => id === 'macos-native';

/** Read a product source file (mocha runs from the repo root; see auditPins). */
function srcFile(rel: string): string {
  return readFileSync(join('src', rel), 'utf8');
}

/** The artefact a heal rule points at — scripts come from the pure builders. */
function resolveArtifact(id: LaneId, artifact: LaneArtifact): string {
  const mac = isMac(id);
  const compiler = mac ? MAC_CC : LINUX_CC;
  const os = mac ? 'Macos' : 'Linux';
  switch (artifact) {
    case 'ensure':
      return managedLaneEnsureCommand(HOME, laneProfileWith(os, compiler, mac ? 'armv8' : 'x86_64', 'Release'), {
        compiler,
        arch: mac ? 'armv8' : 'x86_64',
        // macOS never gets a gcov shim (no GNU gcov there) — that absence is
        // itself covered by the lcov rule of the macOS lane.
        gcov: mac ? undefined : '/usr/bin/gcov-13',
        settingsCompiler: settingsCompilerKey(compiler.name, os),
      });
    case 'build':
      return managedLaneBuildCommand(CWD, HOME, 'Debug', 'demo');
    case 'docs-ensure':
      return mac ? macLaneDocsEnsureCommand(HOME, WSL_DOCS_PIP) : managedLaneDocsEnsureCommand(HOME);
    case 'docs-run':
      return managedLaneDocsRunCommand(CWD, HOME);
    case 'core-profile':
      return srcFile('core/laneProfile.ts');
    case 'exec-linux':
      return srcFile('features/env/linuxLane.ts');
    case 'exec-wsl':
      return srcFile('features/env/wslLane.ts');
    case 'exec-mac':
      return srcFile('features/env/macLane.ts');
    case 'core-mac':
      return srcFile('core/macLane.ts');
  }
}

/** Evidence markers that are NOT backed by their artefact ([] = healthy). */
function markerViolations(
  text: (id: LaneId, a: LaneArtifact) => string,
  ids: readonly LaneId[] = LANE_IDS,
): string[] {
  const out: string[] = [];
  for (const id of ids) {
    for (const req of LANE_REQUIREMENTS) {
      for (const ev of lane(id).heal[req].evidence) {
        if (!text(id, ev.artifact).includes(ev.marker)) {
          out.push(`${id}/${req} → ${ev.artifact} 缺少「${ev.marker}」`);
        }
      }
    }
  }
  return out;
}

const clone = (): Record<LaneId, LaneDescriptor> =>
  JSON.parse(JSON.stringify(LANE_MATRIX)) as Record<LaneId, LaneDescriptor>;

describe('T21 lane × requirement parity (heal rules · script probes · ladder branches)', () => {
  it('the requirement split is total and the exemption is explicit (only git is host-owned)', () => {
    const covered = [...LANE_REQUIREMENTS, ...NON_LANE_REQUIREMENTS].sort();
    assert.deepStrictEqual(covered, [...REQUIREMENT_IDS].sort(), 'a new requirement must be either lane-owned or exempt');
    assert.deepStrictEqual([...NON_LANE_REQUIREMENTS], ['git'], 'git 由宿主/模板提供，车道不代装');
    assert.deepStrictEqual(
      [...LANE_REQUIREMENTS],
      REQUIREMENT_IDS.filter((r) => r !== 'git'),
      'lane-owned requirements keep the canonical order',
    );
  });

  it('every lane × every lane-owned requirement has a disposition WITH a written note (no gaps)', () => {
    assert.deepStrictEqual(laneMatrixGaps(), []);
    for (const id of LANE_IDS) {
      for (const req of LANE_REQUIREMENTS) {
        const rule = lane(id).heal[req];
        assert.ok(rule.evidence.length > 0, `${id}/${req} 必须有可核对的证据`);
        assert.ok(rule.note.trim().length > 10, `${id}/${req} 必须说明处置理由`);
      }
    }
  });

  it('every rule is PROVEN: all evidence markers exist in the artefact that lane runs', () => {
    assert.deepStrictEqual(markerViolations(resolveArtifact), []);
  });

  it('no build-critical requirement is ever "unsupported"; macOS is the only lane that refuses coverage — in writing', () => {
    for (const id of LANE_IDS) {
      for (const req of REQUIRED_FOR_BUILD) {
        assert.notStrictEqual(
          lane(id).heal[req as (typeof LANE_REQUIREMENTS)[number]].kind,
          'unsupported',
          `${id}/${req} 既是构建必需项，就不能是"平台不支持"`,
        );
      }
      // The coverage capability and the lcov disposition may never disagree.
      const rule = lane(id).heal.lcov;
      assert.strictEqual(laneCoverage(id) === 'none', rule.kind === 'unsupported', `${id}: 覆盖率承诺与 lcov 处置必须一致`);
      const facts = laneLcovFacts(id);
      assert.strictEqual(facts.supported, rule.kind !== 'unsupported');
      if (!facts.supported) {
        assert.match(facts.reason ?? '', /gcov/u, '拒绝的能力必须给出技术原因');
      }
    }
    assert.deepStrictEqual(LANE_IDS.filter((id) => laneCoverage(id) === 'none'), ['macos-native']);
    assert.deepStrictEqual(LANE_IDS.filter((id) => laneForPlatform(lane(id).platforms[0])?.id === id), [...LANE_IDS]);
    assert.strictEqual(laneForPlatform('freebsd'), undefined, '未知平台没有车道（调用方据此报错，不猜）');
  });

  it('the auto/guide split stays visible per lane (and adds up to the whole requirement set)', () => {
    for (const id of LANE_IDS) {
      const auto = laneAutoHeals(id);
      const guide = laneGuides(id);
      const refused = LANE_REQUIREMENTS.filter((r) => lane(id).heal[r].kind === 'unsupported');
      assert.strictEqual(auto.length + guide.length + refused.length, LANE_REQUIREMENTS.length, `${id}: 每个需求都要有处置`);
      assert.ok(laneMatrixLine(id).startsWith(id));
      if (isMac(id)) {
        assert.deepStrictEqual(guide, ['compiler', 'doxygen', 'graphviz', 'make'], 'macOS 的人工步骤必须只有 CLT 与 brew 两类');
        assert.deepStrictEqual(refused, ['lcov']);
      } else {
        assert.deepStrictEqual(guide, [], '托管车道不把自愈责任推给用户');
        assert.deepStrictEqual(refused, []);
      }
    }
  });

  it('ensure script: interpreter ladder → profile → settings.yml → gcov shim → report (in that ORDER)', () => {
    for (const id of LANE_IDS) {
      const ensure = resolveArtifact(id, 'ensure');
      const order = [
        'lane_python_candidates',
        'lane_make_venv floor',
        'HET_WSL_PROFILE',
        'lane_settings:added(',
        // Only the GNU lanes write a gcov shim (macOS has no GNU gcov at all).
        ...(isMac(id) ? [] : ['HET_GCOV_SHIM']),
        'echo lane_conan:',
        'echo lane_arch:',
        'echo lane_cc_selected:',
      ];
      let at = -1;
      for (const marker of order) {
        const i = ensure.indexOf(marker);
        assert.ok(i > at, `${id}: ensure 步骤顺序被破坏（${marker} @${i}，上一个 @${at}）`);
        at = i;
      }
      assert.ok(ensure.includes('lane_python_floor:'), `${id}: 必须报告解释器是否满足文档下限`);
      if (!isMac(id)) {
        // E5: the gcov shim must be a lane-local file, never a system write.
        assert.ok(ensure.includes(`cat > "${HOME}/.het-fti/managed-env/venv/bin/gcov"`), `${id}: gcov shim 必须是车道私有文件`);
        assert.ok(ensure.includes('echo lane_lcov:'), `${id}: 必须报告 lcov 事实`);
      }
    }
  });

  it('the status probe and the BUILD ask the same question (probe/requirement parity)', () => {
    for (const id of ['linux-managed', 'win-wsl2'] as LaneId[]) {
      const exec = resolveArtifact(id, id === 'linux-managed' ? 'exec-linux' : 'exec-wsl');
      assert.ok(exec.includes('laneFactsScript()'), `${id}: 车道必须用共享的 facts 探针`);
      // The build path must resolve through the SAME ladder (no second dialect).
      const resolver = id === 'linux-managed' ? 'resolveLinuxLaneFacts' : 'resolveLaneFacts';
      assert.ok(exec.includes(resolver), `${id}: 构建路径必须复用同一解析（不得另写一套）`);
    }
    const mac = resolveArtifact('macos-native', 'exec-mac');
    assert.ok(mac.includes('macFactsScript()'), 'macOS: 探针必须来自 core/macLane');
    assert.ok(resolveArtifact('macos-native', 'core-mac').includes('xcode-select -p'), 'macOS: CLT 事实靠 xcode-select 探测');
  });

  it('build script: isolation + cmake branch + canonical conan create + user profiles', () => {
    for (const id of LANE_IDS) {
      const build = resolveArtifact(id, 'build');
      assert.ok(build.includes(`export PATH="${HOME}/.het-fti/managed-env/venv/bin:$PATH"`), `${id}: venv 必须在 PATH 最前`);
      assert.ok(build.includes(`export CONAN_HOME="${HOME}/.het-fti/managed-env/.conan2"`), `${id}: 私有 CONAN_HOME`);
      assert.ok(build.includes('unset CONDA_PREFIX'), `${id}: 必须隔离用户的 conda`);
      assert.ok(build.includes('HET_CMAKE_BUILD_REQUIRE=none'), `${id}: 车道自带 cmake 时不再拉第二份`);
      assert.ok(build.includes('conan remove "demo/*" --confirm'), `${id}: 覆盖率运行要强制重建自己的包`);
      assert.ok(build.includes('conan create . -s build_type=Debug'), `${id}: 规范命令`);
    }
  });

  it('docs scripts: the Python floor is checked BEFORE pip; every tool is reported', () => {
    for (const id of LANE_IDS) {
      const docs = resolveArtifact(id, 'docs-ensure');
      const guard = docs.indexOf('docs_python:below');
      const pip = docs.indexOf('"sphinx>=8,<9"');
      assert.ok(guard > -1, `${id}: 文档前置必须检查解释器下限`);
      assert.ok(pip > -1, `${id}: 文档栈必须是 sphinx 8 系`);
      assert.ok(guard < pip, `${id}: 下限检查必须在 pip 之前（否则用户只看到 pip 的天书）`);
      assert.ok(docs.includes('exit 4'), `${id}: 低于下限必须提前失败，而不是继续装`);
      for (const marker of ['echo docs_sphinx:', 'echo docs_doxygen:', 'echo docs_dot:', 'echo docs_make:']) {
        assert.ok(docs.includes(marker), `${id}: 缺少事实报告 ${marker}`);
      }
      const run = resolveArtifact(id, 'docs-run');
      assert.ok(run.indexOf('venv/bin') < run.indexOf('python docs/build.py'), `${id}: 文档必须用车道 venv 的 python`);
    }
  });

  it('macOS lane never uses root/apt: missing docs tools become a brew guide instead', () => {
    // A MENTION of `sudo apt` inside the actionable message is fine; a line that
    // actually runs root/apt on macOS is not.
    const runsRoot = (text: string): string[] =>
      text
        .split(/\r?\n/u)
        .map((l) => l.trim())
        .filter((l) => /^(sudo|apt-get|apt)\b/u.test(l));
    const docs = resolveArtifact('macos-native', 'docs-ensure');
    assert.deepStrictEqual(runsRoot(docs), [], 'macOS 车道不得执行 root/apt');
    const exec = resolveArtifact('macos-native', 'exec-mac');
    assert.deepStrictEqual(runsRoot(exec), [], 'macOS 执行层不得执行 apt');
    assert.ok(exec.includes('macDocsGuide'), 'macOS 缺文档工具 → 给 brew 指引');
    assert.ok(exec.includes("macGuide('clt')"), 'macOS 缺 CLT → 给 xcode-select 指引');
  });

  it('T21 DoD: 删掉一条规则 / 一处证据 / 一个 shell 步骤 → 立刻变红', () => {
    // (a) a rule deleted → structural gap (the matrix is no longer total)
    const noLcov = clone();
    delete (noLcov['linux-managed'].heal as Record<string, HealRule>).lcov;
    assert.deepStrictEqual(
      laneMatrixGaps(noLcov).map((g) => `${g.lane}/${g.requirement}:${g.why}`),
      ['linux-managed/lcov:no-rule'],
      '删掉处置必须被抓到',
    );

    // (b) evidence stripped → the rule is a declarative lie
    const noProof = clone();
    (noProof['win-wsl2'].heal.compiler as unknown as { evidence: unknown[] }).evidence = [];
    assert.deepStrictEqual(
      laneMatrixGaps(noProof).map((g) => `${g.lane}/${g.requirement}:${g.why}`),
      ['win-wsl2/compiler:no-evidence'],
    );

    // (c) the SHELL STEP deleted → the marker check fails (rule ↔ implementation)
    const breakMarkers = (marker: string) => (id: LaneId, a: LaneArtifact): string =>
      resolveArtifact(id, a).split(marker).join('【REMOVED】');
    assert.ok(
      markerViolations(breakMarkers('GCC_APT_ATTEMPTS')).length > 0,
      '删掉编译器的 apt 阶梯分支必须被证据检查抓到',
    );
    assert.ok(
      markerViolations(breakMarkers('lane_python_candidates')).length > 0,
      '删掉解释器阶梯探测必须被证据检查抓到',
    );
    assert.ok(
      markerViolations(breakMarkers('HET_GCOV_SHIM')).length > 0,
      '删掉 gcov shim 步骤必须被证据检查抓到',
    );
  });
});
