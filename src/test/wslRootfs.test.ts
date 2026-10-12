import * as assert from 'node:assert';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureRootfs,
  isGzipMagic,
  localSourcePath,
  rootfsCacheFilePath,
  rootfsPartFilePath,
  sha256File,
} from '../core/wslRootfs';

const GZIP_STUB = Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08, 0x00]), Buffer.alloc(64, 7)]);
const shaOf = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'het-rootfs-'));
}

/** 用一个"本地文件当远端"的 fetch 替身：零网络、可控制响应。 */
function fetchServing(buf: Buffer, init: { ok?: boolean; status?: number; contentType?: string } = {}): typeof fetch {
  return (async () =>
    ({
      ok: init.ok ?? true,
      status: init.status ?? 200,
      statusText: init.status === 404 ? 'Not Found' : 'OK',
      headers: new Headers({ 'content-length': String(buf.length), 'content-type': init.contentType ?? 'application/gzip' }),
      body: (async function* () {
        for (let i = 0; i < buf.length; i += 16) {
          yield buf.subarray(i, i + 16);
        }
      })(),
    }) as unknown as Response) as unknown as typeof fetch;
}

describe('T17b wslRootfs (rootfs 获取：下载 → 校验 → 缓存)', () => {
  it('路径与形状助手：缓存按 sha 命名、.part 后缀、gzip magic 与本地源识别', () => {
    assert.strictEqual(rootfsCacheFilePath('/c', 'a'.repeat(64)), join('/c', `${'a'.repeat(64)}.tar.gz`));
    assert.strictEqual(rootfsPartFilePath('/c/x.tar.gz'), '/c/x.tar.gz.part');

    assert.strictEqual(isGzipMagic(Buffer.from([0x1f, 0x8b])), true);
    assert.strictEqual(isGzipMagic(Buffer.from([0x3c, 0x21])), false, 'HTML 错误页（<!）不是 gzip');
    assert.strictEqual(isGzipMagic(Buffer.from([0x1f])), false);

    assert.strictEqual(localSourcePath('file:///tmp/a.tar.gz'), '/tmp/a.tar.gz');
    assert.strictEqual(localSourcePath('/tmp/a.tar.gz'), '/tmp/a.tar.gz');
    assert.strictEqual(localSourcePath('C:\\x\\a.tar.gz'), 'C:\\x\\a.tar.gz');
    assert.strictEqual(localSourcePath('\\\\fileserver\\share\\a.tar.gz'), '\\\\fileserver\\share\\a.tar.gz', 'UNC 共享（内网）');
    assert.strictEqual(localSourcePath('https://example.com/a.tar.gz'), undefined);
  });

  it('sha256File 与 Node 自算一致（大文件走流式读）', async () => {
    const dir = tmp();
    try {
      const f = join(dir, 'x.bin');
      writeFileSync(f, GZIP_STUB);
      assert.strictEqual(await sha256File(f), shaOf(GZIP_STUB));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('下载路径：写 .part → 校验 → 原子改名；第二次命中缓存不再下载', async () => {
    const dir = tmp();
    try {
      const sha = shaOf(GZIP_STUB);
      let calls = 0;
      const logs: string[] = [];
      const fetchImpl = ((...args: Parameters<typeof fetch>) => {
        calls += 1;
        return fetchServing(GZIP_STUB)(...args);
      }) as unknown as typeof fetch;

      const first = await ensureRootfs({ url: 'https://x/a.tar.gz', sha256: sha, cacheDir: dir, fetchImpl, onLog: (domain, l) => logs.push(`[${domain}] ${l}`) });
      assert.strictEqual(first.ok, true);
      assert.strictEqual(first.cached, false);
      assert.strictEqual(first.bytes, GZIP_STUB.length);
      assert.strictEqual(calls, 1);
      assert.ok(existsSync(join(dir, `${sha}.tar.gz`)));
      assert.ok(!existsSync(join(dir, `${sha}.tar.gz.part`)), '不留下 .part');
      assert.match(logs.join('\n'), /rootfs_cache:stored/u);

      const second = await ensureRootfs({ url: 'https://x/a.tar.gz', sha256: sha, cacheDir: dir, fetchImpl });
      assert.strictEqual(second.cached, true);
      assert.strictEqual(calls, 1, '缓存命中不得再下载');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sha256 不匹配：拒绝落缓存、清掉 .part，并给出"镜像内容与官方不一致"的可执行原因', async () => {
    const dir = tmp();
    try {
      const wrong = 'b'.repeat(64);
      const res = await ensureRootfs({ url: 'https://x/a.tar.gz', sha256: wrong, cacheDir: dir, fetchImpl: fetchServing(GZIP_STUB) });
      assert.strictEqual(res.ok, false);
      assert.match(res.reason!, /sha256 不匹配/u);
      assert.match(res.reason!, /内网镜像请让管理员核对|wslRootfsSha256/u);
      assert.deepStrictEqual(readdirSync(dir), [], '失败不得留下任何文件');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('下到 HTML 错误页（HTTP 200 但非 gzip）：拒绝并清掉 .part', async () => {
    const dir = tmp();
    try {
      const html = Buffer.from('<!DOCTYPE html><html>error</html>');
      const res = await ensureRootfs({ url: 'https://x/a.tar.gz', sha256: shaOf(html), cacheDir: dir, fetchImpl: fetchServing(html, { contentType: 'text/html' }) });
      assert.strictEqual(res.ok, false);
      assert.match(res.reason!, /gzip/u);
      assert.deepStrictEqual(readdirSync(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('HTTP 错误：不吞掉状态码（区分"网络不通"与"404 路径写错"）', async () => {
    const dir = tmp();
    try {
      const res = await ensureRootfs({ url: 'https://x/missing.tar.gz', sha256: shaOf(GZIP_STUB), cacheDir: dir, fetchImpl: fetchServing(GZIP_STUB, { ok: false, status: 404 }) });
      assert.strictEqual(res.ok, false);
      assert.match(res.reason!, /HTTP 404/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('缓存里的文件被改坏 → 检测到 stale，丢弃并重下（不做"信任缓存"的假设）', async () => {
    const dir = tmp();
    try {
      const sha = shaOf(GZIP_STUB);
      writeFileSync(join(dir, `${sha}.tar.gz`), Buffer.from('corrupted'));
      const logs: string[] = [];
      const res = await ensureRootfs({ url: 'https://x/a.tar.gz', sha256: sha, cacheDir: dir, fetchImpl: fetchServing(GZIP_STUB), onLog: (domain, l) => logs.push(`[${domain}] ${l}`) });
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.cached, false);
      assert.match(logs.join('\n'), /rootfs_cache:stale/u);
      assert.strictEqual(await sha256File(res.path!), sha, '最终缓存内容是校验通过的');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('本地源（空气隔离/内网共享盘）：file:// 与绝对路径都能走同一条校验路径', async () => {
    const dir = tmp();
    try {
      const src = join(dir, 'local.tar.gz');
      writeFileSync(src, GZIP_STUB);
      const cache = join(dir, 'cache');
      const res = await ensureRootfs({ url: `file://${src}`, sha256: shaOf(GZIP_STUB), cacheDir: cache });
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.cached, false);
      assert.strictEqual(await sha256File(res.path!), shaOf(GZIP_STUB));

      const again = await ensureRootfs({ url: src, sha256: shaOf(GZIP_STUB), cacheDir: cache });
      assert.strictEqual(again.cached, true, '第二次无论用 file:// 还是裸路径都命中同一份缓存');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
