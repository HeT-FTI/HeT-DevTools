import * as assert from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import {
  TEMPLATE_REQUIRED_FILES,
  accelUrl,
  normalizeEntries,
  refKindOf,
  snapshotFallbackNotice,
  tarballPlanFor,
  tarballTopDir,
  templateCacheName,
  templateFetchNextStep,
  templateTarballCandidates,
  templateTarballUrl,
  verifyTemplateEntries,
} from '../core/templateTarball';
import {
  TEMPLATE_REF,
  TEMPLATE_SNAPSHOT_VERSION,
  TEMPLATE_TAG,
  TEMPLATE_TAG_COMMIT,
  TEMPLATE_TARBALL_BYTES,
  TEMPLATE_TARBALL_SHA256,
} from '../core/templateDefaults';
import { GH_ACCEL_PREFIXES } from '../core/netProfile';

/**
 * G17：模板的在线获取（策略层）门禁（2026-09-20 起 pin 是**纯哈希**）。
 *
 * 这一块的"实测"不是形容词：下面几条断言就是 2026-09-17 真跑出来的结论
 * （tag→提交、字节数、sha 稳定性、加速前缀的可用性）。
 */
describe('模板 tarball 策略（G17）', () => {
  const OWNER = 'HeT-FTI';
  const REPO = 'fcpp';

  it('pin 自洽：tag（可为空）→ 提交 → 字节数 → sha256（换 pin 时门禁会逼你一起改）', () => {
    // tag 允许为空：上游可能"修了但没发版"（2026-09-20 就是）。非空时必须是规范的 vX.Y.Z。
    assert.ok(
      TEMPLATE_TAG === '' || /^v\d+\.\d+\.\d+$/u.test(TEMPLATE_TAG),
      `TEMPLATE_TAG 要么是规范的 vX.Y.Z，要么是空串（现在：'${TEMPLATE_TAG}'）`,
    );
    assert.ok(
      TEMPLATE_TAG === '' || /^[0-9a-f]{40}$/u.test(TEMPLATE_TAG_COMMIT),
      '有 tag 就必须写清它指向哪个提交 —— tag 与 pin 同内容时才允许排链首',
    );
    assert.match(TEMPLATE_REF, /^[0-9a-f]{40}$/u, '固定哈希锚点必须是完整 sha1');
    assert.match(TEMPLATE_TARBALL_SHA256, /^[0-9a-f]{64}$/u);
    assert.ok(TEMPLATE_TARBALL_BYTES > 1_000_000, '模板 tarball 是 MB 级（约 3MB）');
    assert.strictEqual(refKindOf(TEMPLATE_REF), 'commit', 'pin 是一个提交（纯哈希机制）');
    assert.strictEqual(
      templateTarballUrl(OWNER, REPO, TEMPLATE_REF),
      `https://codeload.github.com/${OWNER}/${REPO}/tar.gz/${TEMPLATE_REF}`,
      '实测过的那个地址（commit 形态）',
    );
    assert.ok(TEMPLATE_SNAPSHOT_VERSION.length > 0, '内置快照版本要写出来（兜底话术要用）');
  });

  it('纯哈希 pin 能走 tarball（不需要 git、带 sha256 校验）', () => {
    const plan = tarballPlanFor(TEMPLATE_REF, {
      tag: TEMPLATE_TAG,
      commit: TEMPLATE_REF,
      sha256: TEMPLATE_TARBALL_SHA256,
    });
    assert.strictEqual(plan.useTarball, true, '钉过 sha 的提交必须走 tarball 而不是 git clone');
    assert.strictEqual(plan.markerRef, TEMPLATE_REF, '模板标记要写清就是 pin 的这个提交');
    assert.strictEqual(plan.sha256, TEMPLATE_TARBALL_SHA256);
    // 反面：main 是移动目标、手上没有它的 sha → 只能 clone（不提供"没有校验值的下载"）
    assert.strictEqual(
      tarballPlanFor('main', { tag: '', commit: TEMPLATE_REF, sha256: TEMPLATE_TARBALL_SHA256 }).useTarball,
      false,
    );
  });

  it('生产路径不会用空 ref 造 URL（空 tag 必须退到固定哈希）', () => {
    // 空 ref 会被 refKindOf 当成 tag → 造出 `…/refs/tags/` 这种没意义的地址。
    const ext = readFileSync(join('src', 'extension.ts'), 'utf8');
    assert.ok(
      ext.includes('TEMPLATE_TAG || TEMPLATE_REF'),
      '「在线获取模板」必须：没有 tag 时用固定哈希，不能把空串当 ref',
    );
    assert.ok(
      ext.includes('recommendedAnchors('),
      '建工程的默认链要走 recommendedAnchors（那里才会过滤掉"与 pin 不同内容"的 tag）',
    );
  });

  it('ref 形状决定 codeload 路径（写错是 404，不是"内容不对"）', () => {
    assert.strictEqual(refKindOf('main'), 'branch');
    assert.strictEqual(refKindOf('master'), 'branch');
    assert.strictEqual(refKindOf('v0.1.2'), 'tag');
    assert.strictEqual(refKindOf(TEMPLATE_REF.toUpperCase()), 'commit', '大写也给认出来');
    assert.strictEqual(
      templateTarballUrl(OWNER, REPO, 'main'),
      `https://codeload.github.com/${OWNER}/${REPO}/tar.gz/refs/heads/main`,
    );
    assert.strictEqual(
      templateTarballUrl(OWNER, REPO, TEMPLATE_REF),
      `https://codeload.github.com/${OWNER}/${REPO}/tar.gz/${TEMPLATE_REF}`,
    );
    assert.strictEqual(
      templateTarballUrl(OWNER, REPO, 'v1.2.3'),
      `https://codeload.github.com/${OWNER}/${REPO}/tar.gz/refs/tags/v1.2.3`,
      'tag 形态的地址形状（用字面量，不依赖当前有没有 tag）',
    );
  });

  it('候选链：CN 档前缀优先、官方档官方优先；**两个档都留了官方 codeload 兜底**', () => {
    const cn = templateTarballCandidates(OWNER, REPO, TEMPLATE_REF, { accel: GH_ACCEL_PREFIXES, accelFirst: true });
    assert.strictEqual(cn.length, GH_ACCEL_PREFIXES.length + 1);
    assert.ok(cn[0].via === 'accel' && cn[0].url.startsWith('https://ghfast.top/'), 'CN 档先试加速');
    assert.strictEqual(cn.at(-1)?.url, templateTarballUrl(OWNER, REPO, TEMPLATE_REF), '最后一定是官方直连');
    assert.ok(cn[0].url.endsWith(templateTarballUrl(OWNER, REPO, TEMPLATE_REF)), '前缀拼接格式（实测过的那种）');

    const gl = templateTarballCandidates(OWNER, REPO, TEMPLATE_REF, { accel: GH_ACCEL_PREFIXES, accelFirst: false });
    assert.strictEqual(gl[0].via, 'direct', '官方档直连在前');
    assert.strictEqual(gl[1].via, 'accel', '前缀只当备用');
    assert.deepStrictEqual(gl.map((c) => c.via).filter((v) => v === 'direct').length, 1);

    const noAccel = templateTarballCandidates(OWNER, REPO, TEMPLATE_REF, { accel: ['', '   '] });
    assert.strictEqual(noAccel.length, 1, '空前缀要被过滤，不能产生空 URL');
    assert.strictEqual(accelUrl('https://x.test', 'https://c/y'), 'https://x.test/https://c/y');
    assert.strictEqual(accelUrl('https://x.test/', 'https://c/y'), 'https://x.test/https://c/y', '不重复补斜杠');
  });

  it('解压前先校验形状：单一顶层目录 + 必备文件（不合格就不解压）', () => {
    const good = [
      'fcpp-0.1.2/',
      'fcpp-0.1.2/metadata.json',
      'fcpp-0.1.2/CMakeLists.txt',
      'fcpp-0.1.2/conanfile.py',
      'fcpp-0.1.2/src/main.cpp',
    ];
    const ok = verifyTemplateEntries(good);
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(ok.top, 'fcpp-0.1.2', 'tag tarball 的顶层目录是 tag 名（不是提交短哈希）');

    const missing = verifyTemplateEntries(good.filter((e) => !e.endsWith('conanfile.py')));
    assert.strictEqual(missing.ok, false);
    assert.deepStrictEqual(missing.missing, ['conanfile.py']);
    assert.ok(missing.reason?.includes('缺少必备文件'));

    assert.ok(verifyTemplateEntries([]).reason?.includes('压缩包是空的'));
    assert.ok(
      verifyTemplateEntries(['a/x.txt', 'b/y.txt']).reason?.includes('顶层目录'),
      '两个顶层目录 = 不是 codeload 的形状',
    );
    assert.deepStrictEqual(normalizeEntries(['./fcpp/x', 'pax_global_header', '', '  ']), ['fcpp/x']);
    assert.strictEqual(tarballTopDir(['pax_global_header', 'fcpp-0.1.2/a']).top, 'fcpp-0.1.2');
    assert.strictEqual(TEMPLATE_REQUIRED_FILES.length, 3);
  });

  it('缓存按 sha256 命名（换版本/重试不重复下载），失败话术给"下一步"和"内置快照"', () => {
    assert.strictEqual(templateCacheName(TEMPLATE_TARBALL_SHA256.toUpperCase()), `${TEMPLATE_TARBALL_SHA256}.tar.gz`);
    const step = templateFetchNextStep(OWNER, REPO, TEMPLATE_TAG);
    assert.ok(step.includes(`git clone --branch ${TEMPLATE_TAG}`), step);
    assert.ok(step.includes('het.net.profile=global'), '要给"直连"这条出路');
    const snap = snapshotFallbackNotice(TEMPLATE_SNAPSHOT_VERSION);
    assert.ok(snap.includes('内置快照') && snap.includes(TEMPLATE_SNAPSHOT_VERSION), snap);
    assert.ok(snap.includes('离线') && snap.includes('秒建'), '兜底不是残废模式，要说清它可用');
  });

  it('建工程时的取模板决定：只有钉过 sha256 的 ref 才走 tarball（main 走 clone）', () => {
    const pins = { tag: TEMPLATE_TAG, commit: TEMPLATE_REF, sha256: TEMPLATE_TARBALL_SHA256 };
    const release = tarballPlanFor(TEMPLATE_TAG, pins);
    assert.strictEqual(release.useTarball, true);
    assert.strictEqual(release.sha256, TEMPLATE_TARBALL_SHA256);
    assert.strictEqual(release.markerRef, TEMPLATE_REF, 'marker 要记具体提交（tag 只是入口）');
    assert.ok(release.note.includes('sha256'), release.note);

    const pinned = tarballPlanFor(TEMPLATE_REF, pins);
    assert.strictEqual(pinned.useTarball, true);
    assert.strictEqual(pinned.markerRef, TEMPLATE_REF);

    const main = tarballPlanFor('main', pins);
    assert.strictEqual(main.useTarball, false, '移动目标不能拿旧 sha 去校验');
    assert.ok(main.note.includes('移动目标') && main.note.includes('git clone'), main.note);

    assert.strictEqual(tarballPlanFor('v9.9.9', pins).useTarball, false);
    assert.strictEqual(tarballPlanFor(TEMPLATE_TAG, { ...pins, sha256: '' }).useTarball, false, '没有校验值就不提供下载路径');
    assert.strictEqual(tarballPlanFor(TEMPLATE_TAG, { ...pins, sha256: 'zzz' }).useTarball, false);
  });

  it('内置快照：版本常量必须等于快照里的版本，且结构完整（防“刷了一半就提交”）', () => {
    const snapDir = join('assets', 'template');
    const meta = JSON.parse(readFileSync(join(snapDir, 'metadata.json'), 'utf8')) as { version?: string };
    assert.strictEqual(
      TEMPLATE_SNAPSHOT_VERSION,
      String(meta.version ?? ''),
      '常量与快照不一致 = 兜底话术会说谎（“用的是内置快照 vX”）',
    );
    // 复用解压前的形状校验：把快照的文件列表当作 tarball 条目看
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          walk(p);
        } else {
          files.push(p.split(sep).join('/'));
        }
      }
    };
    walk(snapDir);
    // 快照根下就该直接是工程（不许多套一层目录：`tryLocal` 是按 metadata.json 判的）
    // ⚠️ 期望值也必须走同一次归一：`files` 是 POSIX 分隔符，而 `join()` 在 Windows 上给
    // `assets\template` —— 直接拼会变成 `assets\template/metadata.json`，永远比不相等
    // （本机 Linux 全绿、Windows CI 挂在这条上，已实测）。
    const snapRoot = snapDir.split(sep).join('/');
    for (const f of TEMPLATE_REQUIRED_FILES) {
      assert.ok(files.includes(`${snapRoot}/${f}`), `快照根下缺 ${f}（多套了一层？）`);
    }
    assert.ok(files.length > 100, `快照文件数异常（${files.length}）—— 刷坏的信号`);
    for (const junk of ['__pycache__', '.pyc', '/build/', '/out/']) {
      assert.ok(!files.some((f) => f.includes(junk)), `快照里不许有杂物：${junk}`);
    }
  });

  it('接线：建工程时 tarball 在 git 之前试（没 git 的机器也能建工程）', () => {
    const ext = readFileSync(join('src', 'extension.ts'), 'utf8');
    const fn = ext.slice(ext.indexOf('const tryRemote = async (ref'), ext.indexOf('let ok = false;'));
    assert.ok(fn.includes('tarballPlanFor('), '取模板要用这个决定函数');
    assert.ok(fn.includes('ensureTemplateTarball(') && fn.includes('extractTemplateTarball('), '要真的下载+解压+校验');
    const tarballAt = fn.indexOf('tplan.useTarball');
    const noGitAt = fn.indexOf("if (!git) {");
    assert.ok(tarballAt > 0 && noGitAt > 0, '两个分支都要在');
    assert.ok(tarballAt < noGitAt, '分支顺序：tarball 要排在"没 git 就放弃"**之前**，否则没 git 的机器永远拿不到在线模板');
    assert.ok(fn.includes('markerRef = tplan.markerRef'), 'tarball 路径也要写 template-ref 标记');
  });

  it('IO 层守纪律：`.part` + 原子改名 + 校验不可跳过 + 降级要说出来', () => {
    // 这一层现在跨两个文件：传输（`.part`/超时/流式 sha）收口在 `core/fetch.ts`，
    // 候选链与"降级要说出来"仍在 `core/templateFetch.ts` —— 所以门禁两处一起看，
    // 但**断言一条都不减**（纪律没变，只是搬家了）。
    const shared = readFileSync(join('src', 'core', 'fetch.ts'), 'utf8');
    const io = readFileSync(join('src', 'core', 'templateFetch.ts'), 'utf8') + '\n' + shared;
    assert.ok(io.includes('.part'), '先写 .part');
    assert.ok(
      io.includes('partPathFor(') && shared.includes("`${finalPath}.part`"),
      '.part 只能由公共层一处生成（不许两边各自拼字符串）',
    );
    assert.ok(io.includes('await rename(part, final)'), '校验通过才原子改名');
    assert.ok(io.includes('sha256 不一致'), 'sha 是判据');
    assert.ok(io.includes('不是 gzip'), '要拦"下到 HTML 错误页"');
    assert.ok(io.includes('缓存 sha256 不一致'), '不做"信任缓存"的假设');
    assert.ok(io.includes('degraded'), '降级必须能被说出来（不静默）');
    assert.ok(io.includes('AbortSignal.timeout'), '每个候选都有超时（无人值守不许无限等）');
    // 没有"跳过校验"的用法：sha256 是必填参数
    assert.ok(!/sha256\?:/.test(io), 'sha256 不能是可选的');
    assert.ok(!/skip.*verif|verif.*skip/iu.test(io), '不允许出现跳过校验的分支');
  });
});
