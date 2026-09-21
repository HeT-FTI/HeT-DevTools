/**
 * rootfs 获取的**真联网**验收（默认跳过）：`HET_ROOTFS_LIVE=1 npm test` 时才跑。
 *
 * 为什么要留这个（而且只在 opt-in 时跑）：
 *   · `ensureRootfs` 是**唯一会往用户机器写 340MB** 的地方，它是"下载 → 校验 → 原子改名"
 *     这条纪律的现场；而它的实现刚刚被抽到 `core/fetch.ts`（与模板共用），**越是共用越要
 *     有真实链路证明**：注入的假 fetch 证明不了背压、`content-length`、真流式 sha256。
 *   · 340MB / 分钟级的下载不能进日常 CI（网络不可靠 = 假红），所以与模板实网验收同一约定：
 *     **换 rootfs 版本 / 动这条链路时，维护者手动跑一次**。
 *
 * 跑法：`HET_ROOTFS_LIVE=1 npx mocha "out/test/wslRootfsLive.test.js"`（需要能访问
 * `cloud-images.ubuntu.com`；NJU 镜像与它**字节相同**，实测 `content-length`/`last-modified` 一致）。
 */
import * as assert from 'node:assert';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureRootfs, rootfsCacheFilePath, sha256File } from '../core/wslRootfs';
import { LANE_ROOTFS } from '../core/wslDistro';

const LIVE = process.env.HET_ROOTFS_LIVE === '1';

describe('rootfs 实网验收（340MB，默认跳过）', function () {
  this.timeout(1_800_000);

  it('真的下载 340MB → sha256 与 pin 一致 → .part 清干净 → 第二次命中缓存', async function () {
    if (!LIVE) {
      this.skip();
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), 'het-rootfs-live-'));
    const cacheDir = join(dir, 'cache');
    try {
      const logs: string[] = [];
      let lastReceived = 0;
      const first = await ensureRootfs({
        url: LANE_ROOTFS.url,
        sha256: LANE_ROOTFS.sha256,
        cacheDir,
        bytes: LANE_ROOTFS.bytes,
        onLog: (l) => logs.push(l),
        onProgress: (p) => {
          lastReceived = p.received;
        },
      });
      assert.strictEqual(first.ok, true, `下载失败：${first.reason}\n${logs.join('\n')}`);

      // 形状：字节数与我们 pin 的一致（不是"下到一半也算成功"）
      assert.strictEqual(
        statSync(first.path!).size,
        LANE_ROOTFS.bytes,
        '落地字节数必须等于 pin 的 bytes（否则就是半截文件被当成缓存）',
      );
      assert.ok(lastReceived > 0, '进度回调要走（340MB 不能"黑着"下完）');
      assert.match(logs.join('\n'), /rootfs_cache:stored/u);
      // 纪律：缓存目录里只该有最终文件，绝不留 `.part`
      assert.deepStrictEqual(
        readdirSync(cacheDir),
        [`${LANE_ROOTFS.sha256}.tar.gz`],
        '缓存目录里只许有一个最终文件（没有 .part 残留）',
      );

      // 真实 sha256（独立再算一遍，不信返回值）
      assert.strictEqual(await sha256File(first.path!), LANE_ROOTFS.sha256);

      // 第二次：命中缓存，不再下载（路径必须与第一次一致）
      const again = await ensureRootfs({
        url: LANE_ROOTFS.url,
        sha256: LANE_ROOTFS.sha256,
        cacheDir,
        onLog: (l) => logs.push(l),
      });
      assert.strictEqual(again.cached, true, '第二次要命中缓存');
      assert.strictEqual(again.path, rootfsCacheFilePath(cacheDir, LANE_ROOTFS.sha256));
      assert.ok(!existsSync(`${again.path!}.part`), '命中缓存时也不该出现 .part');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
