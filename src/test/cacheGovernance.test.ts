/**
 * **K 块门禁：目标矩阵 / 交叉 profile / 缓存报表 / 清理四档**（G23 / G24 / G25）。
 *
 * 这一组断言盯的是"交叉编译与缓存治理"的四件容易静默出错的事：
 *   1. 目标**只能**来自 `.hetai/build-matrix.yml`（硬编码目标名 = 矩阵一变就静默失配）；
 *   2. 交叉命令**必须**带 `-pr:b=default` 与 `-tf=`（漏了前者 → 工具包被编成 arm → `exec format error`）；
 *   3. 缓存报表"数不出东西"必须能看出来（而不是显示 0 字节让人以为缓存是空的）；
 *   4. 清理四档的风险分级与确认：危险档不确认就执行 = 手滑删包。
 *
 * 另外用**真实模板文件**（`assets/template/.hetai/build-matrix.yml`）解析一遍 ——
 * 门禁不能只对自造夹具成立。
 */
import * as assert from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUILD_MATRIX_REL,
  BuildMatrixError,
  crossCreateArgs,
  crossProfileFor,
  enabledTargets,
  parseBuildMatrix,
  pickTarget,
  profileFileName,
  profileHash,
  toolchainVersionFor,
} from '../core/buildMatrix';
import {
  checkTargetSwitch,
  emptyLedger,
  ledgerPath,
  parseLedger,
  recordBuild,
} from '../core/buildLedger';
import { archOfConaninfo, cacheReportText, cacheVerdict, formatBytes, scanCache } from '../core/cacheUsage';
import {
  CLEAN_SCOPES,
  CleanPlanError,
  assertCleanConfirmed,
  cleanResultText,
  planClean,
} from '../core/cacheClean';

const TEMPLATE_MATRIX = 'assets/template/.hetai/build-matrix.yml';

/** 造一个"像 conan 2 的"缓存目录：两个包 × (p/b) + 一份只有构建目录的包。 */
function fixtureCache(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'het-cache-'));
  const pkg = (name: string, arch: string | undefined, payload: number, build: number): void => {
    const dir = join(root, 'p', name);
    mkdirSync(join(dir, 'p'), { recursive: true });
    if (arch !== undefined) {
      writeFileSync(join(dir, 'p', 'conaninfo.txt'), `[settings]\narch=${arch}\nbuild_type=Release\n[options]\n`, 'utf8');
    }
    writeFileSync(join(dir, 'p', 'lib.a'), 'x'.repeat(payload), 'utf8');
    if (build > 0) {
      mkdirSync(join(dir, 'b'), { recursive: true });
      writeFileSync(join(dir, 'b', 'build.bin'), 'y'.repeat(build), 'utf8');
    }
  };
  pkg('zlib76e00a316e585', 'x86_64', 1000, 2000);
  pkg('fmt11223344556677', 'armv7', 500, 3000);
  pkg('cmakeaabbccddeeff00', undefined, 100, 400); // 没有 conaninfo → 架构未知
  mkdirSync(join(root, 'p', 't'), { recursive: true });
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('K.1 目标矩阵（G23：目标只能来自 .hetai/build-matrix.yml）', () => {
  it('真实模板能解析出目标与默认工具链（门禁不能只对自造夹具成立）', () => {
    const matrix = parseBuildMatrix(readFileSync(TEMPLATE_MATRIX, 'utf8'), TEMPLATE_MATRIX);
    assert.strictEqual(matrix.packageRef, 'fcpp/1.0.0');
    assert.strictEqual(matrix.defaultToolchain, '11.3.rel1');
    assert.ok(matrix.createExtraArgs?.includes('--build=missing'), '把 create_extra_args 读出来（否则本地与 CI 参数不一致）');
    const enabled = enabledTargets(matrix);
    assert.ok(enabled.length >= 1, '至少要有一个启用目标');
    for (const t of enabled) {
      assert.ok(t.id, '目标必须有 id');
      assert.ok(t.arch, `${t.id} 必须有 arch（否则生成不了交叉 profile）`);
      assert.ok(toolchainVersionFor(matrix, t), `${t.id} 必须有工具链版本`);
    }
    assert.strictEqual(pickTarget(matrix).id, enabled.find((t) => t.isDefault)?.id ?? enabled[0].id);
  });

  it('形状不对就**显式抛错**（空列表会让目标下拉静默变空 —— 那是最难查的一类）', () => {
    assert.throws(() => parseBuildMatrix('', 'x.yml'), BuildMatrixError);
    assert.throws(() => parseBuildMatrix('targets:\n  - id: a\n', 'x.yml'), /package_ref/u);
    assert.throws(() => parseBuildMatrix('package_ref: a/1.0\n', 'x.yml'), /没有任何 target/u);
    assert.throws(
      () => parseBuildMatrix('package_ref: a/1.0\ntargets:\n  - id: t1\n    unknown_key: 1\n', 'x.yml'),
      /不认识/u,
    );
    assert.throws(() => parseBuildMatrix(`package_ref: a/1.0\nmystery: 2\ntargets:\n  - id: t\n`, 'x.yml'), /顶层键/u);
  });

  it('选目标：给定 id 必须存在（不静默回退到默认目标）', () => {
    const matrix = parseBuildMatrix(
      [
        'package_ref: a/1.0',
        'defaults:',
        '  toolchain_version: 11.3.rel1',
        'targets:',
        '  - id: t1',
        '    default: true',
        '    arch: armv7',
        '  - id: t2',
        '    arch: armv8',
        '    enabled: false',
        '  - id: t3',
        '    arch: armv8',
      ].join('\n'),
      'x.yml',
    );
    assert.strictEqual(pickTarget(matrix).id, 't1');
    assert.strictEqual(pickTarget(matrix, 't3').id, 't3');
    assert.throws(() => pickTarget(matrix, 't2'), /不在/u, '禁用的目标也要拒绝（并说清原因）');
    assert.throws(() => pickTarget(matrix, 'nope'), /不在/u);
  });

  it('交叉 profile：arch/os 来自矩阵、编译器主版本来自工具链版本（工具链版本缺失就抛错）', () => {
    const matrix = parseBuildMatrix(
      [
        'package_ref: a/1.0',
        'defaults:',
        '  toolchain_version: 11.3.rel1',
        'targets:',
        '  - id: t1',
        '    arch: armv7',
        '    os: Linux',
      ].join('\n'),
      'x.yml',
    );
    const profile = crossProfileFor(matrix, pickTarget(matrix));
    assert.match(profile, /arch=armv7/u);
    assert.match(profile, /os=Linux/u);
    assert.match(profile, /compiler\.version=11/u, '11.3.rel1 → 主版本 11');
    assert.match(profile, new RegExp(BUILD_MATRIX_REL, 'u'), 'profile 里要写明来源（可追溯）');
    assert.strictEqual(profileHash(profile), profileHash(`${profile}`), 'hash 稳定');
    assert.strictEqual(profileFileName(pickTarget(matrix), matrix), 'het-t1-11.3.rel1.profile');

    const broken = parseBuildMatrix('package_ref: a/1.0\ntargets:\n  - id: t9\n', 'x.yml');
    assert.throws(() => crossProfileFor(broken, pickTarget(broken)), /没有 arch/u);
  });

  it('G24：交叉命令**必须**带 `-pr:b=default` 与 `-tf=`（漏了前者 = exec format error）', () => {
    const matrix = parseBuildMatrix(
      'package_ref: a/1.0\ndefaults:\n  toolchain_version: 11.3.rel1\n  create_extra_args: --build=missing --test-folder=\ntargets:\n  - id: t1\n    arch: armv7\n',
      'x.yml',
    );
    const args = crossCreateArgs(matrix, pickTarget(matrix), '/tmp/p.profile');
    assert.ok(args.includes('-pr:b=default'), 'build context 必须钉住本机 profile');
    assert.ok(args.includes('-pr:h=/tmp/p.profile'), 'host profile 用生成的交叉 profile');
    assert.ok(args.includes('-tf='), '跳过 test folder（交叉编译 ≠ 跑测试）');
    assert.ok(args.includes('--build=missing'), '矩阵里的 create_extra_args 要带上（本地与 CI 一致）');
    assert.ok(
      !args.some((a) => a.startsWith('--test-folder')),
      '--test-folder= 与 -tf= 是同一件事，不许出现两次（两次会被 conan 当成冲突参数）',
    );
  });
});

describe('K.1 构建账本（目标切换守卫）', () => {
  it('首次构建/目标未变/目标变了 三种说法都要有人话（含"上个目标占多少盘"）', () => {
    let ledger = emptyLedger('/p/demo');
    const first = checkTargetSwitch(ledger, { target: 'host', profileHash: 'h1' });
    assert.strictEqual(first.changed, false);
    assert.match(first.text, /第一次/u);

    ledger = recordBuild(ledger, { target: 'host', arch: 'x86_64', profileHash: 'h1', at: 1000 });
    const same = checkTargetSwitch(ledger, { target: 'host', arch: 'x86_64', profileHash: 'h1' });
    assert.strictEqual(same.changed, false);
    assert.match(same.text, /目标未变/u);

    const moved = checkTargetSwitch(ledger, { target: 'linux-armv7', arch: 'armv7', profileHash: 'h2' }, 1_800_000_000);
    assert.strictEqual(moved.changed, true);
    assert.match(moved.text, /host → linux-armv7/u);
    assert.match(moved.text, /1\.7 GB|1\.8 GB|1717|1\.6/u, '要报"上个目标占多少盘"（用户据此决定清不清）');
    assert.strictEqual(moved.previous?.target, 'host');
  });

  it('profile 变了也算切换（工具链升级后旧构建上下文不能复用）', () => {
    let ledger = recordBuild(emptyLedger('/p'), { target: 't1', arch: 'armv7', profileHash: 'old', at: 1 });
    const bumped = checkTargetSwitch(ledger, { target: 't1', arch: 'armv7', profileHash: 'new' });
    assert.strictEqual(bumped.changed, true);
    assert.match(bumped.text, /profile 变了/u);
    ledger = recordBuild(ledger, { target: 't1', arch: 'armv7', profileHash: 'new', at: 2 });
    assert.strictEqual(ledger.lastTarget, 't1');
  });

  it('账本落扩展存储（按工程哈希分文件），坏文件不炸但要如实说', () => {
    const path = ledgerPath('/storage', '/p/demo');
    assert.match(path, /\/storage\/ledger\/[0-9a-f]{16}\.json$/u);
    assert.notStrictEqual(ledgerPath('/storage', '/p/demo2'), path, '不同工程不许串账本');
    const bad = parseLedger('{ not json', '/p/demo');
    assert.ok(bad.issue, '坏文件要报出来（静默当首次构建会让人以为"我记得构建过"）');
    assert.deepStrictEqual(bad.ledger.byTarget, {});
    const ok = parseLedger(JSON.stringify(recordBuild(emptyLedger('/p/demo'), { target: 't', profileHash: 'h', at: 1 })), '/p/demo');
    assert.strictEqual(ok.ledger.byTarget.t.profileHash, 'h');
    assert.strictEqual(ok.issue, undefined);
  });
});

describe('K.1 缓存报表（G25 的"可见"部分）', () => {
  it('分区与按架构统计都数得出来，架构读不到就**标未知**（不猜）', () => {
    const fx = fixtureCache();
    try {
      const report = scanCache(fx.root, join(fx.root, 'build'), { now: () => 42 });
      assert.strictEqual(report.exists, true);
      assert.ok(report.totalBytes > 0, '不许数出 0 字节（那会让用户以为缓存是空的）');
      const area = (name: string): number => report.areas.find((a) => a.area === name)?.bytes ?? 0;
      /** 只算"确实存在"的文件（第三个包故意没有 conaninfo）。 */
      const bytesIfExists = (p: string): number => {
        try {
          return statSync(p).size;
        } catch {
          return 0;
        }
      };
      const payloads =
        1000 +
        500 +
        100 +
        bytesIfExists(join(fx.root, 'p', 'zlib76e00a316e585', 'p', 'conaninfo.txt')) +
        bytesIfExists(join(fx.root, 'p', 'fmt11223344556677', 'p', 'conaninfo.txt')) +
        bytesIfExists(join(fx.root, 'p', 'cmakeaabbccddeeff00', 'p', 'conaninfo.txt'));
      assert.strictEqual(area('package'), payloads, '包体积 = 三个包的 payload + 它们的 conaninfo');
      assert.strictEqual(area('build'), 2000 + 3000 + 400, '构建目录（膨胀主因）要单独可见');
      assert.deepStrictEqual(
        report.byArch.map((a) => a.arch),
        ['x86_64', 'armv7'],
        '两个架构并存时都要列出来（这正是"今天 armv7、明天 v8"要看的）',
      );
      assert.strictEqual(
        report.unknownArchBytes,
        100,
        '第三个包没有 conaninfo.txt → 它的 100 字节如实计入"架构未知"（不猜）',
      );
      assert.ok(cacheReportText(report).includes('构建目录'), '报表要能人读');
      assert.match(cacheVerdict(report), /缓存/u);
      assert.strictEqual(report.scannedAt, 42, '扫描时间可注入（报表要能说"什么时候看的"）');
    } finally {
      fx.cleanup();
    }
  });

  it('缓存不存在时给明确说法（不是静默 0 字节）', () => {
    const report = scanCache('/definitely/not/here');
    assert.strictEqual(report.exists, false);
    assert.match(cacheReportText(report), /不存在|还没跑过/u);
    assert.match(cacheVerdict(report), /还没有/u);
  });

  it('本工程构建目录按目标分列（"哪个目标在吃盘"要能一眼看出）', () => {
    const root = mkdtempSync(join(tmpdir(), 'het-build-'));
    try {
      mkdirSync(join(root, 'host'), { recursive: true });
      mkdirSync(join(root, 'linux-armv7'), { recursive: true });
      writeFileSync(join(root, 'host', 'a.o'), 'z'.repeat(100), 'utf8');
      writeFileSync(join(root, 'linux-armv7', 'b.o'), 'z'.repeat(300), 'utf8');
      const report = scanCache(join(root, 'nope'), root);
      assert.deepStrictEqual(report.localBuilds.map((b) => b.target), ['linux-armv7', 'host'], '按体积降序');
      assert.strictEqual(report.localBuilds[0].bytes, 300);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('conaninfo 解析只认 `[settings]` 段（options 里的同名键不算，没有该段就不猜）', () => {
    assert.strictEqual(archOfConaninfo('[settings]\narch=armv7\n[options]\n'), 'armv7');
    assert.strictEqual(archOfConaninfo('[settings]\narch=armv7\n[options]\narch=wrong\n'), 'armv7');
    assert.strictEqual(archOfConaninfo('[options]\narch=wrong\n'), undefined, '没有 [settings] 段 → 不猜');
    assert.strictEqual(archOfConaninfo('arch=none\n'), undefined);
  });

  it('体积格式化：GB/MB/KB 边界（报表要可读，不能一串数字）', () => {
    assert.strictEqual(formatBytes(0), '0 B');
    assert.strictEqual(formatBytes(2048), '2 KB');
    assert.match(formatBytes(5 * 1024 ** 2), /5\.0 MB/u);
    assert.match(formatBytes(3 * 1024 ** 3), /3\.00 GB/u);
  });
});

describe('K.1 清理四档（G25：预览 / 二次确认 / 回报实际释放 / 不自动删）', () => {
  it('四档的默认顺序 = 安全 → 危险（默认选中第一项，往下走要刻意选）', () => {
    assert.deepStrictEqual([...CLEAN_SCOPES], ['conan-build', 'build-dir', 'conan-temp', 'conan-pkgs']);
  });

  it('命令与 conan 2.25 的真实接口一致（短开关；危险档 pattern 必须 `<ref>:*`）', () => {
    const build = planClean('conan-build', {});
    assert.deepStrictEqual(build.commands[0].args, ['cache', 'clean', '-b'], '实测只有短开关 -b，没有 --build');
    assert.strictEqual(build.danger, false);
    assert.match(build.effect, /构建目录/u);

    const temp = planClean('conan-temp', {});
    assert.deepStrictEqual(temp.commands[0].args, ['cache', 'clean', '-t', '-d']);

    const danger = planClean('conan-pkgs', { pattern: 'fmt/*:*', arch: 'armv7' });
    assert.strictEqual(danger.danger, true);
    assert.deepStrictEqual(danger.commands[0].args, ['remove', '-c', '-p', 'arch=armv7', 'fmt/*:*']);
    assert.ok(danger.previewCommand, '危险档必须先能预览（用 conan 自己的 --dry-run，而不是我们猜）');
    assert.deepStrictEqual(danger.previewCommand!.args, ['remove', '--dry-run', '-c', '-p', 'arch=armv7', 'fmt/*:*']);
  });

  it('危险档不确认就执行 → 抛错；参数缺失也抛错（不许"猜一个全删"）', () => {
    const danger = planClean('conan-pkgs', { pattern: 'fmt/*:*' });
    assert.throws(() => assertCleanConfirmed(danger, false), CleanPlanError);
    assert.doesNotThrow(() => assertCleanConfirmed(danger, true));
    assert.doesNotThrow(() => assertCleanConfirmed(planClean('conan-build', {}), false), '安全档不需要确认');

    assert.throws(() => planClean('conan-pkgs', {}), /必须给出 ref 模式/u);
    assert.throws(() => planClean('conan-pkgs', { pattern: '*' }), /形状不对/u);
    assert.throws(() => planClean('build-dir', {}), /工程根路径/u);
  });

  it('档① 明确列出要删的目录（按目标分区），不猜', () => {
    const all = planClean('build-dir', { projectRoot: '/p/demo' });
    assert.deepStrictEqual(all.dirs, ['build'], '没给目标就只删工程级 build/（保守）');
    const scoped = planClean('build-dir', { projectRoot: '/p/demo', targets: ['host', 'linux-armv7'] });
    assert.deepStrictEqual(scoped.dirs, ['build/host', 'build/linux-armv7']);
    assert.match(scoped.effect, /build\/host/u);
  });

  it('回报的是**实际释放量**（不是"已完成"三个字）', () => {
    const text = cleanResultText(4 * 1024 ** 3, 800 * 1024 ** 2);
    assert.match(text, /释放/u);
    assert.match(text, /%$/u.test(text) ? /%/u : /%/u);
    assert.match(text, /3\.22 GB|3\.2 GB/u, '要给出具体释放量');
    assert.match(cleanResultText(1000, 1000), /释放 0 B/u, '没释放也要如实说 0，不许吹');
  });
});

describe('K.1 门禁自证：探测器能失败（注入式验证的机器化版本）', () => {
  it('夹具确实"像 conan 2"（分片形态也数得出来，不会因为布局变化静默数成 0）', () => {
    const root = mkdtempSync(join(tmpdir(), 'het-cache2-'));
    try {
      // 只有构建目录的形态：p/b/<name><hash>/b/...
      const shard = join(root, 'p', 'b', 'arm-t1123899f5793b');
      mkdirSync(join(shard, 'b'), { recursive: true });
      writeFileSync(join(shard, 'b', 'x.bin'), 'q'.repeat(777), 'utf8');
      const report = scanCache(root);
      assert.ok(report.totalBytes >= 777, `分片形态也要数出来（实际 ${report.totalBytes}）`);
      const build = report.areas.find((a) => a.area === 'build')?.bytes ?? 0;
      assert.strictEqual(build, 777, '构建目录要归到 build 区（不是 other）');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('真实 conan 缓存（若本机有）能扫出 >0 字节 —— 防止"自造夹具通过、真机数 0"', () => {
    const home = process.env.CONAN_HOME ?? join(process.env.HOME ?? '', '.conan2');
    let exists = false;
    try {
      exists = statSync(join(home, 'p')).isDirectory();
    } catch {
      exists = false;
    }
    if (!exists) {
      return; // 本机没有 conan 缓存：跳过（CI 上通常也没有）
    }
    const report = scanCache(home);
    assert.ok(report.exists, '缓存存在时 exists 必须为 true');
    assert.ok(report.totalBytes > 0, '有真实缓存却数出 0 字节 → 扫描假设了错误的布局');
  });
});
