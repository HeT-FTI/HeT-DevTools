import * as assert from 'node:assert';
import {
  managedLaneBuildCommand,
  managedLaneDocsEnsureCommand,
  managedLaneDocsRunCommand,
  managedLaneEnsureCommand,
  managedLaneLayout,
  managedLaneProfile,
  wslLaneBuildCommand,
  wslLaneDocsEnsureCommand,
  wslLaneDocsRunCommand,
  wslLaneEnsureCommand,
  wslLaneLayout,
  wslOutToWin,
} from '../core/wslLane';
import { LaneCompiler, laneProfileFor } from '../core/laneProfile';

const BASELINE: LaneCompiler = {
  name: 'gcc-13',
  cc: '/usr/bin/gcc-13',
  cxx: '/usr/bin/g++-13',
  version: '13',
  libcxx: 'libstdc++11',
  baseline: 'ci',
};

const COMPAT: LaneCompiler = { ...BASELINE, name: 'gcc-14', cc: '/usr/bin/gcc-14', cxx: '/usr/bin/g++-14', version: '14', baseline: 'compatible' };

describe('V5-1 wslLane (WSL2 managed build lane pure helpers)', () => {
  it('A3: platform-neutral aliases are the very same pure builders (Linux lane reuse)', () => {
    assert.strictEqual(managedLaneLayout, wslLaneLayout);
    assert.strictEqual(managedLaneProfile, laneProfileFor);
    assert.strictEqual(managedLaneEnsureCommand, wslLaneEnsureCommand);
    assert.strictEqual(managedLaneBuildCommand, wslLaneBuildCommand);
    assert.strictEqual(managedLaneDocsEnsureCommand, wslLaneDocsEnsureCommand);
    assert.strictEqual(managedLaneDocsRunCommand, wslLaneDocsRunCommand);
  });

  it('keeps everything under ~/.het-fti/managed-env; conan home is .conan2 (CI parity)', () => {
    const l = wslLaneLayout('/home/chen');
    assert.strictEqual(l.root, '/home/chen/.het-fti/managed-env');
    assert.strictEqual(l.venv, '/home/chen/.het-fti/managed-env/venv');
    // V5-6: named .conan2 so the template's hard-coded `*/.conan2/p/b/…`
    // coverage glob matches exactly like GitHub CI (CONAN_HOME=~/.conan2).
    assert.strictEqual(l.conanHome, '/home/chen/.het-fti/managed-env/.conan2');
    assert.strictEqual(l.profilesDir, '/home/chen/.het-fti/managed-env/.conan2/profiles');
    assert.strictEqual(l.profile, '/home/chen/.het-fti/managed-env/.conan2/profiles/default');
  });

  it('T01: profile is generated from the CHOSEN compiler + host arch (never pinned)', () => {
    const p = laneProfileFor(BASELINE, 'x86_64', 'Release');
    assert.ok(p.includes('[settings]'));
    assert.ok(p.includes('os=Linux'));
    assert.ok(p.includes('arch=x86_64'));
    assert.ok(p.includes('compiler=gcc'));
    assert.ok(p.includes('compiler.version=13'));
    assert.ok(p.includes('compiler.libcxx=libstdc++11'));
    assert.ok(p.includes('tools.build:compiler_executables'));
    assert.ok(p.includes(`"c": "${BASELINE.cc}"`));
    assert.ok(p.includes(`"cpp": "${BASELINE.cxx}"`));
  });

  it('T01/T08: a compatible compiler/arch writes ITS OWN version and arch (no CI lie)', () => {
    const p = laneProfileFor(COMPAT, 'armv8', 'Release');
    assert.ok(p.includes('compiler.version=14'), 'profile must not claim gcc 13');
    assert.ok(p.includes('arch=armv8'), 'profile must not claim x86_64');
    assert.ok(p.includes(`"c": "${COMPAT.cc}"`));
  });

  it('ensure command is idempotent: venv + pip pin + profile heredoc + CONAN_HOME marker', () => {
    const c = wslLaneEnsureCommand('/home/chen', laneProfileFor(BASELINE, 'x86_64', 'Release'), {
      compiler: BASELINE,
      arch: 'x86_64',
      gcov: '/usr/bin/gcov-13',
    });
    assert.ok(c.includes('/home/chen/.het-fti/managed-env/.conan2/profiles'));
    // V5-6: one-time migration of the pre-.conan2 cache layout (keeps it warm)
    assert.ok(c.includes('mv '), 'migrates an existing legacy conan2 cache');
    assert.ok(c.includes('conan2"') && c.includes('.conan2'), 'migration src→dst present');
    assert.ok(c.includes('"conan>=2.0,<3"'));
    assert.ok(c.includes('"cmake>=4.0,<5"'));
    assert.ok(c.includes('"ninja>=1.11"'));
    assert.ok(c.includes('HET_WSL_PROFILE'));
    assert.ok(c.includes('.conan_home_marker'));
    // T01: the lane report names the SELECTED compiler + arch + baseline …
    assert.ok(c.includes('lane_cc_selected:/usr/bin/gcc-13'));
    assert.ok(c.includes('lane_cc_baseline:ci'));
    assert.ok(c.includes('lane_arch:x86_64'));
    assert.ok(!c.includes('lane_gcc:'), 'the hard-coded gcc-13 probe line is gone');
    // … and E5: a venv-local gcov shim keeps coverage on the chosen compiler.
    assert.ok(c.includes('HET_GCOV_SHIM'));
    assert.ok(c.includes('exec "/usr/bin/gcov-13" "$@"'));
    assert.ok(c.includes('CONDA_PY'), 'conda python is a fallback candidate');
    // venv bootstrap only runs when conan is missing
    assert.ok(c.includes('[ ! -x '));
    // never touches the user's conda envs
    assert.ok(!c.includes('conda activate'));
    assert.ok(!c.includes('pip install --user'));
  });

  it('T18: mirror/proxy settings are exported and the lane conan remote is pinned', () => {
    const c = wslLaneEnsureCommand('/home/chen', laneProfileFor(BASELINE, 'x86_64'), {
      compiler: BASELINE,
      arch: 'x86_64',
      mirror: { pipIndexUrl: 'http://intra/simple', conanRemote: 'https://mirror/conan', httpProxy: 'http://proxy:8080' },
    });
    assert.ok(c.includes('export PIP_INDEX_URL="http://intra/simple"'));
    assert.ok(c.includes('export https_proxy="http://proxy:8080"'));
    assert.ok(c.includes('remote update conancenter --url "https://mirror/conan" --force'));
    const plain = wslLaneEnsureCommand('/home/chen', laneProfileFor(BASELINE, 'x86_64'));
    assert.ok(!plain.includes('PIP_INDEX_URL'), 'no mirror → no exports (defaults untouched)');
    assert.ok(!plain.includes('remote update'), 'no mirror → the conancenter remote stays intact');
  });

  it('build command isolates PATH + CONAN_HOME and runs the canonical conan create', () => {
    const c = wslLaneBuildCommand('/mnt/c/proj/src', '/home/chen', 'Debug');
    assert.ok(c.includes('export PATH="/home/chen/.het-fti/managed-env/venv/bin:$PATH"'));
    assert.ok(c.includes('export CONAN_HOME="/home/chen/.het-fti/managed-env/.conan2"'));
    assert.ok(c.includes('unset CONDA_PREFIX CONDA_DEFAULT_ENV'));
    assert.ok(c.includes('cd "/mnt/c/proj/src"'));
    assert.ok(c.includes('conan create . -s build_type=Debug --build=missing'));
  });

  it('forceSelf removes the cached package first (coverage CI parity), plain builds stay untouched', () => {
    const plain = wslLaneBuildCommand('/mnt/c/proj', '/home/chen', 'Debug');
    assert.ok(plain.includes('conan create . -s build_type=Debug --build=missing'));
    assert.ok(!plain.includes('conan remove'), 'plain build must not remove the cache');
    const forced = wslLaneBuildCommand('/mnt/c/proj', '/home/chen', 'Debug', 'verify1');
    assert.ok(forced.includes('conan remove "verify1/*" --confirm || true'), 'coverage run removes its own package first');
    assert.ok(forced.indexOf('conan remove') < forced.indexOf('conan create .'), 'remove runs before create');
    assert.ok(forced.includes('conan create . -s build_type=Debug --build=missing'));
  });

  it('T11: user profiles are appended inside the lane (and empty entries ignored)', () => {
    const none = wslLaneBuildCommand('/mnt/c/proj', '/home/chen', 'Release');
    assert.ok(!none.includes('-pr '), 'no profile flags by default');
    const withProfiles = wslLaneBuildCommand('/mnt/c/proj', '/home/chen', 'Release', undefined, ['/mnt/d/ci', '  ']);
    assert.ok(withProfiles.includes('-s build_type=Release --build=missing -pr "/mnt/d/ci"'), withProfiles);
    assert.ok(!withProfiles.includes('-pr "  "'), 'blank entries are dropped');
  });

  it('wslOutToWin maps /mnt/<drive>/ back to Windows drive paths and leaves others', () => {
    assert.strictEqual(
      wslOutToWin('/mnt/c/Users/me/src/a.cpp:12:5: error: boom'),
      'C:/Users/me/src/a.cpp:12:5: error: boom',
    );
    assert.strictEqual(
      wslOutToWin('  /mnt/d/x.cc(3,1) : error C2065'),
      '  D:/x.cc(3,1) : error C2065',
    );
    assert.strictEqual(wslOutToWin('/home/chen/.conan2/p/x'), '/home/chen/.conan2/p/x');
    assert.strictEqual(wslOutToWin('src/etl.cpp:5: error: y'), 'src/etl.cpp:5: error: y');
  });

  it('V5-4 docs ensure installs the sphinx stack into the venv only', () => {
    const c = wslLaneDocsEnsureCommand('/home/chen');
    assert.ok(c.includes('"numpy>=1.26"'));
    assert.ok(c.includes('"sphinx>=8,<9"'));
    assert.ok(c.includes('sphinx-intl'));
    assert.ok(c.includes('"sphinx-rtd-theme>=2,<4"'));
    assert.ok(c.includes('sphinx-build'));
    assert.ok(c.includes('docs_doxygen'));
    assert.ok(c.includes('docs_dot'));
    assert.ok(!c.includes('conda activate'), 'never touches conda envs');
    assert.ok(!c.includes('pip install --user'));
  });

  it('V5-4 docs run executes python docs/build.py inside the lane', () => {
    const c = wslLaneDocsRunCommand('/mnt/c/proj', '/home/chen');
    assert.ok(c.includes('/home/chen/.het-fti/managed-env/venv/bin:/usr/bin:/bin'));
    assert.ok(c.includes('cd "/mnt/c/proj"'));
    assert.ok(c.includes('python docs/build.py'));
    assert.ok(c.includes('unset CONDA_PREFIX CONDA_DEFAULT_ENV'));
  });
});
