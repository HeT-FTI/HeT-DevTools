import * as assert from 'node:assert';
import { laneSettingsEnsureSteps, normalizeAppleClangVersion, profileCompilerVersion, settingsCompilerKey } from '../core/laneSettings';

describe('lane settings.yml adapter (conan version vocabulary)', () => {
  // env-fresh · macos run 34926785628: the lane wrote `21.0.0` while conan's
  // settings.yml only lists `21` / `21.0` → every build failed with
  // "Invalid setting '21.0.0' is not a valid 'settings.compiler.version' value".
  it('normalises Apple clang versions to the two components conan knows', () => {
    assert.strictEqual(normalizeAppleClangVersion('21.0.0'), '21.0');
    assert.strictEqual(normalizeAppleClangVersion('16.0.0 (clang-1600.0.26.6)'), '16.0');
    assert.strictEqual(normalizeAppleClangVersion('17'), '17');
    assert.strictEqual(normalizeAppleClangVersion(' 15.0.0 '), '15.0');
    assert.strictEqual(normalizeAppleClangVersion(''), '');
  });

  it('maps a lane compiler name to the settings.yml key', () => {
    assert.strictEqual(settingsCompilerKey('Apple clang', 'Macos'), 'apple-clang');
    assert.strictEqual(settingsCompilerKey('gcc-13', 'Linux'), 'gcc');
    assert.strictEqual(settingsCompilerKey('gcc', 'Linux'), 'gcc');
  });

  it('reads the version straight out of the generated profile (single source of truth)', () => {
    const profile = ['[settings]', 'os=Macos', 'arch=armv8', 'compiler=apple-clang', 'compiler.version=21.0', 'compiler.libcxx=libc++'].join('\n');
    assert.strictEqual(profileCompilerVersion(profile), '21.0');
    assert.strictEqual(profileCompilerVersion('[settings]\nos=Linux'), '');
  });

  it('emits a NON-FATAL step that teaches the lane settings.yml and says so', () => {
    const steps = laneSettingsEnsureSteps('apple-clang', '21.0', '/lane/venv/bin', '/lane/.conan2').join('\n');
    assert.match(steps, /CONAN_HOME="\/lane\/\.conan2" "\/lane\/venv\/bin\/conan" --version/u, 'bootstraps the lane cache first (settings.yml only exists after the first conan run)');
    assert.match(steps, /CONAN_HOME="\/lane\/\.conan2" "\/lane\/venv\/bin\/python" - <<'HET_SETTINGS'/u, 'runs the lane venv python with the lane CONAN_HOME');
    assert.match(steps, /name, ver = "apple-clang", "21\.0"/u, 'carries the compiler + version');
    assert.match(steps, /lane_settings:added/u, 'logs when it had to add the version');
    assert.match(steps, /lane_settings:ok/u, 'logs when conan already knew it');
    assert.match(steps, /lane_settings:skip/u, 'logs (instead of throwing) on unexpected failures');
    assert.ok(steps.trimEnd().endsWith('HET_SETTINGS'), 'heredoc is closed');
    assert.doesNotMatch(steps, /exit 1/u, 'must never abort the ensure script (set -e)');
    // No compiler/version → no step at all.
    assert.deepStrictEqual(laneSettingsEnsureSteps('', '21.0', '/v', '/c'), []);
    assert.deepStrictEqual(laneSettingsEnsureSteps('gcc', '', '/v', '/c'), []);
  });
});
