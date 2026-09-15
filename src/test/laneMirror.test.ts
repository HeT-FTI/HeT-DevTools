import * as assert from 'node:assert';
import { conanRemoteUpdateLine, laneMirrorOf, mirrorCacheKey, mirrorEnv, mirrorShellExports, mirrorSummary } from '../core/laneMirror';

describe('T18 laneMirror (corporate mirror/proxy for the managed lanes)', () => {
  it('normalises settings and drops empty values', () => {
    assert.strictEqual(laneMirrorOf({}), undefined);
    assert.strictEqual(laneMirrorOf({ pipIndexUrl: '   ', conanRemote: '' }), undefined);
    assert.deepStrictEqual(laneMirrorOf({ pipIndexUrl: ' https://mirror/simple ', conanRemote: 'https://c/m' }), {
      pipIndexUrl: 'https://mirror/simple',
      conanRemote: 'https://c/m',
    });
  });

  it('exports pip index (with trusted host) and proxy for the lane shells', () => {
    const lines = mirrorShellExports({ pipIndexUrl: 'http://intra/simple', httpProxy: 'http://proxy.corp:8080' });
    assert.ok(lines.some((l) => l.includes('export PIP_INDEX_URL="http://intra/simple"')));
    assert.ok(lines.some((l) => l.includes('PIP_TRUSTED_HOST=') && l.includes('sed')), 'plain-http intranet index needs the trusted host');
    assert.ok(lines.some((l) => l.includes('export https_proxy="http://proxy.corp:8080"')));
    assert.ok(lines.some((l) => l.includes('export HTTPS_PROXY=')), 'upper-case variants for tools that ignore lowercase');
    assert.deepStrictEqual(mirrorShellExports(undefined), []);
  });

  it('only updates the LANE private conan remote and never fails the script', () => {
    const line = conanRemoteUpdateLine({ conanRemote: 'https://mirror/conan' }, '/home/u/.het-fti/managed-env/venv/bin');
    assert.ok(line?.includes('"/home/u/.het-fti/managed-env/venv/bin/conan" remote update conancenter --url "https://mirror/conan" --force'));
    assert.ok(line?.includes('|| true'), 'a mirror hiccup must not abort the bootstrap');
    assert.strictEqual(conanRemoteUpdateLine({}, '/x/bin'), undefined);
    assert.strictEqual(conanRemoteUpdateLine(undefined, '/x/bin'), undefined);
  });

  it('cache key changes with the mirror (so lane caches are invalidated)', () => {
    assert.strictEqual(mirrorCacheKey(undefined), '');
    assert.strictEqual(mirrorCacheKey({ pipIndexUrl: 'a' }), 'a||');
    assert.notStrictEqual(mirrorCacheKey({ pipIndexUrl: 'a' }), mirrorCacheKey({ pipIndexUrl: 'b' }));
  });

  it('summary is short and honest; env overrides are shell-compatible', () => {
    assert.strictEqual(mirrorSummary(undefined), '');
    const s = mirrorSummary({ pipIndexUrl: 'p', conanRemote: 'c', httpProxy: 'x' });
    assert.strictEqual(s, 'pip p · conan c · proxy x');
    assert.deepStrictEqual(mirrorEnv({ pipIndexUrl: 'p', httpProxy: 'x' }), {
      PIP_INDEX_URL: 'p',
      http_proxy: 'x',
      https_proxy: 'x',
      HTTP_PROXY: 'x',
      HTTPS_PROXY: 'x',
    });
  });
});
