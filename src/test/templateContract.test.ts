/**
 * Snapshot-contract guards for `assets/template` (the packaged fcpp snapshot).
 *
 * These are cheap, file-level assertions for the downstream contract
 * (`workspace/develope/fcpp-upstream-sync-plan.md`, U1–U4): if a snapshot refresh
 * ever drops one of them, the corresponding compatibility promise silently
 * regresses — exactly what happened when `test_package` kept pulling a 45 MB
 * ConanCenter CMake while the main recipe already honoured the opt-out.
 */
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(__dirname, '..', '..');
const tpl = join(repoRoot, 'assets', 'template');

const read = (rel: string): string => readFileSync(join(tpl, rel), 'utf8');

/**
 * Drop Python `#` comments before scanning: the template DOCUMENTS the old,
 * broken patterns on purpose (so the next reader does not reintroduce them), and
 * only code occurrences should fail the guard. `(^|\s)#` keeps `'#include …'`
 * inside string literals intact; a false negative here is harmless.
 */
const py = (rel: string): string => read(rel).replace(/(^|\s)#[^\n]*/gu, '$1');

describe('template snapshot contract (U1–U4)', () => {
  it('U1: CMakeLists lowers the floor only when HET_CMAKE_MIN is explicitly set', () => {
    const cmake = read('CMakeLists.txt');
    assert.match(cmake, /if\(DEFINED HET_CMAKE_MIN\)/u, 'HET_CMAKE_MIN branch missing');
    assert.match(cmake, /cmake_minimum_required\(VERSION 3\.28\)/u, 'the CI baseline default must stay 3.28');
  });

  it('U2: BOTH recipes honour HET_CMAKE_BUILD_REQUIRE (otherwise the second CMake comes back)', () => {
    for (const rel of ['conanfile.py', join('test_package', 'conanfile.py')]) {
      const src = py(rel);
      assert.match(src, /HET_CMAKE_BUILD_REQUIRE/u, `${rel} ignores the opt-out → 45 MB ConanCenter cmake is fetched again`);
      assert.match(src, /==\s*'none'/u, `${rel} must treat 'none' as "use the cmake already on PATH"`);
    }
  });

  it('U3: the coverage filter is derived from `conan cache path`, never guessed', () => {
    const src = py(join('test_package', 'conanfile.py'));
    assert.match(src, /conan", "cache", "path"/u, 'must ask conan for the real cache path');
    assert.doesNotMatch(src, /\.conan2\/p\/b/u, 'must not hard-code the CONAN_HOME directory name');
    assert.doesNotMatch(src, /p\/b\/\{_pkg_uid\}/u, 'must not use the package_id as a folder name (matches nothing)');
  });

  it('U4: graphviz_bin is machine-independent (default absent → dot from PATH)', () => {
    const meta = JSON.parse(read('metadata.json')) as Record<string, unknown>;
    assert.strictEqual(meta.graphviz_bin, undefined, 'graphviz_bin is machine-specific and must not be baked into the template');
    assert.match(py(join('docs', 'build.py')), /graphviz_bin'\) or ''/u, 'docs/build.py must tolerate an absent graphviz_bin');
  });
});
