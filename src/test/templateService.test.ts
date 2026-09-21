import * as assert from 'node:assert';
import { TEMPLATE_REF, TEMPLATE_REPO } from '../core/templateDefaults';
import {
  RemoteVersionData,
  recommendedAnchors,
  resolveCloneRef,
  resolveTemplateSource,
} from '../core/templateService';

describe('templateService.resolveTemplateSource', () => {
  it('defaults to the maintainer-locked remote ref', () => {
    const src = resolveTemplateSource('');
    assert.strictEqual(src.mode, 'remote');
    assert.strictEqual(src.repo, TEMPLATE_REPO);
    assert.strictEqual(src.ref, TEMPLATE_REF);
  });

  it('local override switches to local mode (dev/offline only)', () => {
    const src = resolveTemplateSource('C:/dev/fcpp');
    assert.strictEqual(src.mode, 'local');
    assert.strictEqual(src.localPath, 'C:/dev/fcpp');
  });
});

describe('templateService.recommendedAnchors (D-E3 default chain)', () => {
  const remoteSrc = { mode: 'remote' as const, repo: TEMPLATE_REPO, ref: TEMPLATE_REF };

  it('tag 与 pin 同内容 → [release tag, fixed hash]（tag 先试）', () => {
    const a = recommendedAnchors(remoteSrc, 'v0.3.0', TEMPLATE_REF);
    assert.strictEqual(a.length, 2);
    assert.strictEqual(a[0].ref, 'v0.3.0');
    assert.strictEqual(a[1].ref, TEMPLATE_REF);
  });

  it('tag 与 pin **不同内容** → 只有固定哈希（拿旧 tag 会白下一轮才退到 pin）', () => {
    const a = recommendedAnchors(remoteSrc, 'v0.1.2', 'cae2f5a7cdbf8493cb771e5e2c50d799c672b9c9');
    assert.deepStrictEqual(a.map((x) => x.ref), [TEMPLATE_REF]);
  });

  it('tag 指向哪个提交未知（没写 tagCommit）→ 保守只走固定哈希', () => {
    assert.deepStrictEqual(recommendedAnchors(remoteSrc, 'v0.1.2', '').map((x) => x.ref), [TEMPLATE_REF]);
  });

  it('no tag (upstream not yet released) → [fixed hash] only', () => {
    const a = recommendedAnchors(remoteSrc, '');
    assert.deepStrictEqual(a.map((x) => x.ref), [TEMPLATE_REF]);
  });

  it('默认实参（当前 pin）的链首必须就是 pin —— 不许把"旧 tag"排在最前', () => {
    const a = recommendedAnchors(remoteSrc);
    assert.ok(a.length >= 1);
    assert.strictEqual(a[0].ref, TEMPLATE_REF, '链首就是链上那条 sha256 对应的内容');
  });

  it('ref already equals the tag → not duplicated', () => {
    const a = recommendedAnchors({ mode: 'remote', repo: TEMPLATE_REPO, ref: 'v0.3.0' }, 'v0.3.0');
    assert.strictEqual(a.length, 1);
    assert.strictEqual(a[0].ref, 'v0.3.0');
  });

  it('local mode → no remote anchors (it IS the template)', () => {
    assert.deepStrictEqual(recommendedAnchors({ mode: 'local', localPath: 'C:/dev/fcpp' }), []);
  });
});

describe('templateService.resolveCloneRef', () => {
  const remoteSrc = { mode: 'remote' as const, repo: TEMPLATE_REPO, ref: TEMPLATE_REF };
  const localSrc = { mode: 'local' as const, localPath: 'C:/dev/fcpp' };

  const remote: RemoteVersionData = {
    releases: [
      { tag: 'v0.2.0', prerelease: true },
      { tag: 'v0.1.0', prerelease: false },
    ],
    tags: ['v0.2.0', 'v0.1.0', 'v0.0.1'],
  };

  it('recommended → maintainer pin (tag or hash form)', () => {
    const d = resolveCloneRef(remoteSrc, 'recommended', remote);
    assert.strictEqual(d.cloneRef, TEMPLATE_REF);
    assert.strictEqual(d.isMain, false);
    assert.strictEqual(d.isLocal, false);
  });

  it('recommended with no pin → main (unpinned)', () => {
    const d = resolveCloneRef({ mode: 'remote', repo: TEMPLATE_REPO }, 'recommended', remote);
    assert.strictEqual(d.cloneRef, 'main');
    assert.strictEqual(d.isMain, true);
  });

  it('latest-release → newest stable release, prereleases skipped', () => {
    const d = resolveCloneRef(remoteSrc, 'latest-release', remote);
    assert.strictEqual(d.cloneRef, 'v0.1.0');
    assert.strictEqual(d.isMain, false);
  });

  it('latest-release without releases → newest tag', () => {
    const d = resolveCloneRef(remoteSrc, 'latest-release', { releases: [], tags: ['a', 'b'] });
    assert.strictEqual(d.cloneRef, 'a');
  });

  it('latest-release without any remote data → main fallback', () => {
    const d = resolveCloneRef(remoteSrc, 'latest-release');
    assert.strictEqual(d.cloneRef, 'main');
    assert.strictEqual(d.isMain, true);
  });

  it('main → track upstream main', () => {
    const d = resolveCloneRef(remoteSrc, 'main', remote);
    assert.strictEqual(d.cloneRef, 'main');
    assert.strictEqual(d.isMain, true);
  });

  it('local source → HEAD, flagged isLocal', () => {
    const d = resolveCloneRef(localSrc, 'recommended');
    assert.strictEqual(d.cloneRef, 'HEAD');
    assert.strictEqual(d.isLocal, true);
  });
});
