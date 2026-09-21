import * as assert from 'node:assert';
import { pathKeyOf, prependPath } from '../core/envPath';

describe('child-process PATH helpers (Windows-safe)', () => {
  it('mutates the key Windows actually uses (Path) instead of adding a second PATH', () => {
    const win: NodeJS.ProcessEnv = { Path: 'C:\\Windows\\System32;C:\\Program Files\\CMake\\bin' };
    const out = prependPath(win, 'C:\\Users\\x\\het-conan\\Scripts', ';');
    assert.strictEqual(pathKeyOf(out), 'Path', 'must keep the existing key casing');
    assert.strictEqual(Object.keys(out).filter((k) => k.toUpperCase() === 'PATH').length, 1, 'exactly one PATH-like key');
    assert.strictEqual(out.Path, 'C:\\Users\\x\\het-conan\\Scripts;C:\\Windows\\System32;C:\\Program Files\\CMake\\bin');
    assert.ok(out.Path!.includes('System32'), 'System32 must survive (chcp/cmake live there)');
  });

  it('prepends on POSIX and keeps the rest of PATH', () => {
    const posix: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' };
    assert.strictEqual(prependPath(posix, '/opt/venv/bin', ':').PATH, '/opt/venv/bin:/usr/bin:/bin');
  });

  it('is idempotent and tolerant of a missing PATH', () => {
    const posix: NodeJS.ProcessEnv = { PATH: '/opt/venv/bin:/usr/bin' };
    assert.strictEqual(prependPath(posix, '/opt/venv/bin', ':'), posix, 'already present → unchanged');
    assert.strictEqual(prependPath({}, '/opt/venv/bin', ':').PATH, '/opt/venv/bin', 'no PATH yet');
    const noDir: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    assert.strictEqual(prependPath(noDir, '', ':'), noDir);
  });
});
