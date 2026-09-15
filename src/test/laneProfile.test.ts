import * as assert from 'node:assert';
import {
  CMAKE_MIN_DEFAULT,
  COMPILER_LADDER,
  GCC_APT_ATTEMPTS,
  LaneCompiler,
  baselineNote,
  compareVersions,
  effectiveCmakeFloor,
  laneCompilerGuide,
  laneFactsScript,
  laneProfileFor,
  mapLaneArch,
  nativeCmakePlan,
  parseLaneFacts,
  parseVersion,
  unsupportedArchMessage,
} from '../core/laneProfile';

describe('T01/T02 laneProfile (compiler & arch ladder — the ONLY place CI facts live)', () => {
  it('ladder prefers the CI baseline (gcc-13) and accepts 14/15/12 as compatible', () => {
    assert.strictEqual(COMPILER_LADDER[0].name, 'gcc-13');
    assert.strictEqual(COMPILER_LADDER[0].baseline, 'ci');
    const compat = COMPILER_LADDER.slice(1);
    assert.deepStrictEqual(
      compat.map((c) => c.name),
      ['gcc-14', 'gcc-15', 'gcc-12'],
    );
    assert.ok(compat.every((c) => c.baseline === 'compatible'));
  });

  it('apt attempts include the CI baseline AND jammy’s gcc-12 (jammy has no gcc-13)', () => {
    assert.deepStrictEqual(GCC_APT_ATTEMPTS[0], ['gcc-13', 'g++-13']);
    assert.ok(GCC_APT_ATTEMPTS.some((p) => p[0] === 'gcc-12'), 'jammy fallback (E1: verified no gcc-13 in jammy)');
    assert.ok(GCC_APT_ATTEMPTS.every((p) => p[1] === `g++-${p[0].split('-')[1]}`));
  });

  it('maps uname -m to the conan arch setting; unsupported arch returns empty', () => {
    assert.strictEqual(mapLaneArch('x86_64'), 'x86_64');
    assert.strictEqual(mapLaneArch('amd64'), 'x86_64');
    assert.strictEqual(mapLaneArch('aarch64'), 'armv8');
    assert.strictEqual(mapLaneArch('arm64'), 'armv8');
    assert.strictEqual(mapLaneArch('riscv64'), '');
    assert.strictEqual(mapLaneArch(''), '');
  });

  it('parses the facts script output, including the generic-gcc compatible fallback', () => {
    const baseline = parseLaneFacts(
      [
        'lane_arch_raw:x86_64',
        'lane_cc:/usr/bin/gcc-13',
        'lane_cxx:/usr/bin/g++-13',
        'lane_cc_name:gcc-13',
        'lane_cc_version:13',
        'lane_cc_baseline:ci',
        'lane_cc_hit:1',
        'lane_gcov:/usr/bin/gcov-13',
        'lane_lcov:LCOV version 2.0',
      ].join('\n'),
    );
    assert.strictEqual(baseline.arch, 'x86_64');
    assert.strictEqual(baseline.compiler?.version, '13');
    assert.strictEqual(baseline.compiler?.baseline, 'ci');
    assert.strictEqual(baseline.gcov, '/usr/bin/gcov-13');
    assert.strictEqual(baseline.lcov, 'LCOV version 2.0');

    const generic = parseLaneFacts(
      ['lane_arch_raw:aarch64', 'lane_cc:/usr/bin/gcc', 'lane_cxx:/usr/bin/g++', 'lane_cc_name:gcc', 'lane_cc_version:14', 'lane_cc_baseline:compatible', 'lane_cc_hit:1'].join('\n'),
    );
    assert.strictEqual(generic.arch, 'armv8');
    assert.strictEqual(generic.compiler?.name, 'gcc');
    assert.strictEqual(generic.compiler?.baseline, 'compatible');
    assert.strictEqual(generic.gcov, undefined);
  });

  it('missing compiler / missing arch stay undefined (caller must guide, not guess)', () => {
    const none = parseLaneFacts('lane_arch_raw:x86_64\nlane_cc_hit:0\nlane_gcov:-\nlane_lcov:-');
    assert.strictEqual(none.compiler, undefined);
    assert.strictEqual(none.gcov, undefined);
    assert.strictEqual(none.arch, 'x86_64');

    const weird = parseLaneFacts('lane_arch_raw:riscv64');
    assert.strictEqual(weird.arch, '');
  });

  it('the probe script asks for the WHOLE ladder (never for one pinned binary)', () => {
    const s = laneFactsScript();
    assert.ok(s.includes('for spec in gcc-13:13:ci'), 'ladder loop present');
    assert.ok(s.includes('gcc-14:14:compatible') && s.includes('gcc-15:15:compatible') && s.includes('gcc-12:12:compatible'));
    assert.ok(s.includes('lane_cc_baseline:'), 'reports which rung was used');
    assert.ok(s.includes('lane_arch_raw:'), 'arch comes from the host');
    assert.ok(s.includes('lane_gcov:'), 'gcov is resolved for the chosen compiler');
    assert.ok(s.includes('gcc -dumpversion'), 'generic gcc fallback (Fedora/Arch-like hosts)');
    assert.ok(!s.includes('/usr/bin/gcc-13 --version'), 'no pinned-binary probe remains');
  });

  it('profile writes the ACTUAL version/arch; notes keep the baseline honest', () => {
    const compat: LaneCompiler = {
      name: 'gcc-14',
      cc: '/usr/bin/gcc-14',
      cxx: '/usr/bin/g++-14',
      version: '14',
      libcxx: 'libstdc++11',
      baseline: 'compatible',
    };
    const p = laneProfileFor(compat, 'armv8');
    assert.ok(p.includes('compiler.version=14') && p.includes('arch=armv8'));
    assert.ok(baselineNote(compat).includes('兼容模式'));
    assert.ok(baselineNote(compat).includes('覆盖率'), 'compat mode admits the coverage-semantics difference');
    assert.ok(baselineNote({ ...compat, baseline: 'ci', name: 'gcc-13' }).includes('CI 同基线'));
  });

  it('guidance is actionable: three options + the jammy/PPA fact; unsupported arch points to system', () => {
    const g = laneCompilerGuide();
    assert.ok(g.includes('gcc-13'), 'option ① installs the CI baseline');
    assert.ok(g.includes('apt-get install -y gcc g++'), 'option ② uses the distro compiler');
    assert.ok(g.includes('"toolchain": "system"'), 'option ③ escapes to the native lane');
    assert.ok(g.includes('22.04'), 'states that jammy has no gcc-13');
    assert.ok(g.includes('ppa:ubuntu-toolchain-r/test'), 'offers the PPA route');

    const u = unsupportedArchMessage('riscv64');
    assert.ok(u.includes('riscv64') && u.includes('x86_64'));
    assert.ok(u.includes('"toolchain": "system"'));
  });

  // F1 (2026-09-15): "toolchain=system" must mean the HOST tools — the native
  // path used to let the template pull cmake/<pinned> from ConanCenter even when
  // the host cmake was perfectly good (intranets paid a ~40 MB download).
  it('version parsing/comparison never blocks on unknown, and ignores patch noise in policy terms', () => {
    assert.deepStrictEqual(parseVersion('cmake version 3.31.6'), [3, 31, 6]);
    assert.strictEqual(parseVersion('(none)'), undefined);
    assert.strictEqual(compareVersions('cmake version 3.31.8', '3.28'), 1, '3.31.8 meets a 3.28 floor');
    assert.strictEqual(compareVersions('3.31.8', '3.31.6'), 1);
    assert.strictEqual(compareVersions('3.22.1', '3.28'), -1, '22.04 cmake is below the floor');
    assert.strictEqual(compareVersions(undefined, '3.28'), 0, 'unknown never blocks');
    assert.strictEqual(effectiveCmakeFloor(''), CMAKE_MIN_DEFAULT);
    assert.strictEqual(effectiveCmakeFloor('3.22'), '3.22', 'HET_CMAKE_MIN wins');
  });

  it('native cmake plan: host cmake ≥ floor → use it (no ConanCenter download)', () => {
    const plan = nativeCmakePlan('cmake version 3.31.6', '3.28', '4.0.1');
    assert.strictEqual(plan.useHost, true);
    assert.strictEqual(plan.buildRequire, 'none');
    assert.strictEqual(plan.guide, '', 'no guidance needed when the host tool is usable');
    assert.ok(plan.reason.includes('3.31.6') && plan.reason.includes('3.28'));
    // patch-level differences must not change the decision (the user's example)
    assert.strictEqual(nativeCmakePlan('cmake version 3.31.8', '3.28').useHost, true);
  });

  it('native cmake plan: below floor → pinned ConanCenter cmake, said out loud with three ways out', () => {
    const plan = nativeCmakePlan('cmake version 3.22.1', '3.28', '4.0.1');
    assert.strictEqual(plan.useHost, false);
    assert.ok(plan.reason.includes('3.22.1'), 'states the host version');
    assert.ok(plan.reason.includes('cmake/4.0.1'), 'states what will actually be fetched');
    assert.ok(plan.reason.includes('需联网'), 'states the network dependency');
    assert.ok(plan.guide.includes('apt-get install -y cmake'), 'option ① install a newer cmake');
    assert.ok(plan.guide.includes('HET_CMAKE_MIN=3.22.1'), 'option ② lower the floor');
    assert.ok(plan.guide.includes('"toolchain": "managed"'), 'option ③ use the lane');
  });

  it('native cmake plan: no cmake at all is also below the floor (never silently fine)', () => {
    const plan = nativeCmakePlan(undefined, '3.28', '');
    assert.strictEqual(plan.useHost, false);
    assert.ok(plan.reason.includes('未找到'));
    assert.ok(plan.guide.includes('metadata.cmake_version'), 'names the pinned fallback');
  });
});
