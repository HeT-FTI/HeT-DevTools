import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  APT_MIRROR_BACKUP_SUFFIX,
  APT_SOURCES_CLASSIC,
  APT_SOURCES_DEB822,
  aptMirrorLines,
  isValidMirrorUrl,
  isUbuntuArchiveUrl,
  portsMirrorUrl,
} from '../core/laneAptMirror';
import { laneBootstrapScript } from '../core/wslDistro';

/**
 * G22 的最后一块：apt 换源。
 *
 * 它只在**我们自建的 WSL 发行版**里发生（我们是那里的 root），而且有两条硬要求：
 * **先备份后改**（且只备份一次）与**时序对**（必须在第一次 `apt-get update` 之前，
 * 否则"换了源"只是写在日志里好看）。
 */
describe('apt 换源（G22）', () => {
  const read = (p: string): string => readFileSync(join('src', p), 'utf8');
  const NJU = { url: 'https://mirror.nju.edu.cn/ubuntu', label: 'NJU' };

  it('没给镜像 / 给了脏 URL → 什么都不做（绝不把脏串拼进 sed）', () => {
    assert.deepStrictEqual(aptMirrorLines(undefined), []);
    for (const bad of [
      'https://x.test/ubuntu\nrm -rf /',
      "https://x.test/ubuntu'; rm -rf /",
      'https://x.test/ubuntu/',
      'ftp://x.test/ubuntu',
      '',
    ]) {
      assert.strictEqual(isValidMirrorUrl(bad), false, `应当拒绝：${JSON.stringify(bad)}`);
      assert.deepStrictEqual(aptMirrorLines({ url: bad, label: 'x' }), [], `脏 URL 不许生成片段：${bad}`);
    }
    assert.strictEqual(isValidMirrorUrl(NJU.url), true);
  });

  it('只认 Ubuntu 官方地址（第三方 deb 源一律不动）', () => {
    assert.strictEqual(isUbuntuArchiveUrl('http://archive.ubuntu.com/ubuntu'), true);
    assert.strictEqual(isUbuntuArchiveUrl('https://security.ubuntu.com/ubuntu'), true);
    assert.strictEqual(isUbuntuArchiveUrl('http://ports.ubuntu.com/ubuntu-ports'), true);
    assert.strictEqual(isUbuntuArchiveUrl('https://mirror.nju.edu.cn/ubuntu'), false, '已经是镜像了就别再改');
    assert.strictEqual(isUbuntuArchiveUrl('https://download.docker.com/linux/ubuntu'), false, '第三方源不碰');
    assert.strictEqual(portsMirrorUrl('https://mirror.nju.edu.cn/ubuntu'), 'https://mirror.nju.edu.cn/ubuntu-ports');
  });

  it('片段：两种格式都覆盖 · 只备份一次 · 失败不阻断 · 留证据且可撤销', () => {
    const lines = aptMirrorLines(NJU).join('\n');
    for (const file of [APT_SOURCES_DEB822, APT_SOURCES_CLASSIC]) {
      assert.ok(lines.includes(file), `要覆盖 ${file}`);
      assert.ok(
        lines.includes(`[ -f ${file}${APT_MIRROR_BACKUP_SUFFIX} ] || cp -a ${file} ${file}${APT_MIRROR_BACKUP_SUFFIX}`),
        `${file}：只备份一次（重复 bootstrap 不许把已改过的版本当原件）`,
      );
    }
    assert.ok(lines.includes('sed -i -E'), '用 sed 原地改');
    assert.ok(lines.includes(NJU.url), '换成我们的镜像');
    assert.ok(lines.includes('ubuntu-ports'), 'ports 也要映射');
    assert.ok(lines.includes('|| true'), '失败不阻断 bootstrap');
    assert.ok(lines.includes('echo lane_apt_mirror:NJU'), '要留证据行（可诊断）');
    assert.ok(lines.includes('lane_apt_mirror_restore:cp -a'), '要给出复原命令');
    assert.ok(!lines.includes('rm -rf'), '不许出现破坏性命令');
  });

  it('bootstrap 里的**时序**：换源必须在第一次 apt-get update 之前', () => {
    const script = laneBootstrapScript({
      name: 'het-lane-2404',
      sha256: 'a'.repeat(64),
      extensionVersion: '0.4.0',
      aptMirror: NJU,
    });
    const mirrorAt = script.indexOf('lane_apt_mirror');
    const aptUpdateAt = script.indexOf('apt-get update');
    assert.ok(mirrorAt > 0 && aptUpdateAt > 0, '两段都要在');
    assert.ok(mirrorAt < aptUpdateAt, '先换源再 update —— 否则装包还是慢慢走官方源');
    // 没给镜像时脚本里不该出现换源痕迹（现状不变）
    const plain = laneBootstrapScript({ name: 'het-lane-2404', sha256: 'a'.repeat(64), extensionVersion: '0.4.0' });
    assert.ok(!plain.includes('lane_apt_mirror'), '默认不动用户的源');
  });

  it('接线：只在我们自建的发行版里换；CN 档才带这个参数', () => {
    const imp = read(join('features', 'env', 'wslImport.ts'));
    assert.ok(imp.includes('...(opts.aptMirror ? { aptMirror: opts.aptMirror } : {})'), '要传到 bootstrap');
    assert.ok(imp.includes('aptMirror?: AptMirrorRef'), '选项要声明');
    const ext = read(join('extension.ts'));
    assert.ok(ext.includes('function wslAptMirror()'), '要有取值器');
    assert.ok(ext.includes("currentNetPlan().chains.apt[0]"), '取源策略里的 apt 主源');
    assert.ok(ext.includes('...(aptMirror ? { aptMirror } : {})'), '导入时传下去');
    const distro = read(join('core', 'wslDistro.ts'));
    assert.ok(distro.includes('aptMirrorLines(input.aptMirror)'), 'bootstrap 要拼接片段');
    // 换源只可能发生在 laneBootstrapScript 里（用户发行版 / 本机 system 车道一律不动）
    const others = ['features/env/linuxLane.ts', 'features/env/macLane.ts'];
    for (const f of others) {
      assert.ok(!read(join(f)).includes('sources.list'), `${f} 不许动 apt 源（没 root，也不该动）`);
    }
  });
});
