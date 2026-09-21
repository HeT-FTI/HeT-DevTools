/**
 * G17 的**真联网**验收（默认跳过）：`HET_TEMPLATE_LIVE=1 npm test` 时才跑。
 *
 * 为什么值得留一个联网用例：这一块的 correctness 全在"网络上真的拿得到、字节真的对、
 * 解压出来真的是工程"这三点上；纯函数测不出来。日常 CI 不跑（网络不可靠 = 假红），
 * 但维护者换 tag 时必须跑一次。
 */
import * as assert from 'node:assert';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TEMPLATE_REQUIRED_FILES,
  templateTarballCandidates,
  templateTarballUrl,
} from '../core/templateTarball';
import { ensureTemplateTarball, extractTemplateTarball } from '../core/templateFetch';
import { TEMPLATE_REF, TEMPLATE_TARBALL_SHA256 } from '../core/templateDefaults';
import { GH_ACCEL_PREFIXES } from '../core/netProfile';

const LIVE = process.env.HET_TEMPLATE_LIVE === '1';

describe('模板 tarball 实网验收（G17 live）', function () {
  this.timeout(600_000);

  it('真的下载 → sha256 一致 → 解压 → 必备文件都在', async function () {
    if (!LIVE) {
      this.skip();
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), 'het-template-live-'));
    try {
      const lines: string[] = [];
      const candidates = templateTarballCandidates('HeT-FTI', 'fcpp', TEMPLATE_REF, {
        accel: GH_ACCEL_PREFIXES,
        accelFirst: true,
      });
      const got = await ensureTemplateTarball({
        candidates,
        sha256: TEMPLATE_TARBALL_SHA256,
        cacheDir: join(dir, 'downloads'),
        onLog: (l) => lines.push(l),
      });
      assert.strictEqual(got.ok, true, `下载失败：${got.reason}\n${lines.join('\n')}`);
      const top = await extractTemplateTarball({ tarPath: got.path!, destDir: join(dir, 'ref'), onLog: (l) => lines.push(l) });
      assert.strictEqual(top.ok, true, `解压失败：${top.reason}`);
      for (const f of TEMPLATE_REQUIRED_FILES) {
        assert.ok(existsSync(join(dir, 'ref', f)), `解压后缺 ${f}`);
      }
      const meta = JSON.parse(readFileSync(join(dir, 'ref', 'metadata.json'), 'utf8')) as { url?: string };
      assert.ok(String(meta.url ?? '').includes('fcpp'), 'metadata.json 指向 fcpp');
      // 第二次调用必须命中缓存（同一个 sha → 不再下载）
      const again = await ensureTemplateTarball({
        candidates,
        sha256: TEMPLATE_TARBALL_SHA256,
        cacheDir: join(dir, 'downloads'),
        onLog: (l) => lines.push(l),
      });
      assert.strictEqual(again.cached, true, '第二次要命中缓存');
      // 直连地址与 tag 一致（把实测写死在这里，换 tag 时会立刻发现）
      assert.ok(templateTarballUrl('HeT-FTI', 'fcpp', TEMPLATE_REF).endsWith(TEMPLATE_REF));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
