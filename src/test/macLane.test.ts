import * as assert from 'node:assert';
import { macCompiler, macFactsScript, macGuide, macDocsGuide, macLaneDocsEnsureCommand, parseMacFacts } from '../core/macLane';
import { laneProfileWith } from '../core/laneProfile';

describe('T07 macLane (macOS managed lane pure helpers)', () => {
  const cltReady = [
    'lane_arch_raw:arm64',
    'mac_dev_dir:/Library/Developer/CommandLineTools',
    'lane_cc:/Library/Developer/CommandLineTools/usr/bin/clang',
    'lane_cxx:/Library/Developer/CommandLineTools/usr/bin/clang++',
    'lane_cc_name:Apple clang',
    'lane_cc_version:16.0.0',
    'lane_cc_baseline:native',
    'lane_python:/usr/bin/python3',
    'lane_doxygen:/opt/homebrew/bin/doxygen',
    'lane_dot:/opt/homebrew/bin/dot',
    'lane_make:/usr/bin/make',
  ].join('\n');

  it('parses CLT/clang/python/docs facts (and keeps the native baseline)', () => {
    const f = parseMacFacts(cltReady);
    assert.strictEqual(f.devDir, '/Library/Developer/CommandLineTools');
    assert.strictEqual(f.python, '/usr/bin/python3');
    assert.strictEqual(f.arch, 'armv8', 'Apple Silicon maps to the conan armv8 arch');
    assert.strictEqual(f.compiler?.baseline, 'native');
    assert.strictEqual(f.compiler?.version, '16.0.0');
    assert.strictEqual(f.doxygen, '/opt/homebrew/bin/doxygen');
  });

  it('a bare mac (no CLT) reports honestly instead of guessing a compiler', () => {
    const f = parseMacFacts('lane_arch_raw:arm64\nmac_dev_dir:-\nlane_python:-\n');
    assert.strictEqual(f.devDir, '');
    assert.strictEqual(f.compiler, undefined);
    assert.strictEqual(macCompiler(f), undefined);
    assert.ok(macGuide('clt').includes('xcode-select --install'));
    assert.ok(macGuide('python').includes('xcode-select --install'));
  });

  it('profile pins apple-clang + libc++ + the host arch (never x86_64 by default)', () => {
    const f = parseMacFacts(cltReady);
    const c = macCompiler(f)!;
    assert.strictEqual(c.libcxx, 'libc++');
    const p = laneProfileWith('Macos', c, f.arch, 'Release');
    assert.ok(p.includes('os=Macos'));
    assert.ok(p.includes('arch=armv8'));
    assert.ok(p.includes('compiler=apple-clang'));
    assert.ok(p.includes('compiler.version=16'));
    assert.ok(p.includes('compiler.libcxx=libc++'));
    assert.ok(p.includes(c.cc) && p.includes(c.cxx));
  });

  it('probe script asks for CLT/clang ONLY (no gcc/gcov assumptions)', () => {
    const s = macFactsScript();
    assert.ok(s.includes('xcode-select -p'));
    assert.ok(s.includes('xcrun --find clang'));
    assert.ok(s.includes('lane_cc_baseline:native'));
    assert.ok(!s.includes('gcc'), 'macOS has no gcc requirement');
    assert.ok(!s.includes('gcov'), 'coverage is unsupported by design (limited support)');
  });

  it('docs bootstrap installs sphinx into the venv and only REPORTS brew tools', () => {
    const c = macLaneDocsEnsureCommand('/Users/dev', ['"numpy>=1.26"', '"sphinx>=8,<9"']);
    assert.ok(c.includes('/Users/dev/.het-fti/managed-env/venv/bin'));
    assert.ok(c.includes('"sphinx>=8,<9"'));
    assert.ok(c.includes('command -v doxygen'));
    assert.ok(c.includes('command -v dot'));
    assert.ok(!c.includes('brew install'), 'we never install brew packages for the user');
    assert.ok(!c.includes('apt-get'), 'no apt on macOS');
    const guide = macDocsGuide(['doxygen', 'graphviz']);
    assert.ok(guide.includes('brew install doxygen graphviz'));
    assert.ok(guide.includes('不影响构建'));
  });
});
