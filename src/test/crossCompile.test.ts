/**
 * K 块门禁：**交叉编译 = 一等动作**（计划 §6-K / G23 / G24 / G16 的一部分）。
 *
 * 这块最怕的两件事都不是"代码写错"，而是**知识分叉**：
 *   1. 目标清单在别处又抄一份（矩阵改了、UI 还列着旧目标）→ 门禁 G23：目标只从
 *      `.hetai/build-matrix.yml` 来；
 *   2. "交叉编译"偷偷跑起了测试，或者 build context 用了目标架构（protoc/cmake 全被编成 arm，
 *      之后本机构建 `exec format error`）→ 门禁 G24 + 语义断言：`-pr:b=default` 与
 *      `-tf=` 必须在命令行里，`--test-folder=`/`test_package` 不许出现。
 *
 * 还有一条**真见证**：生成的 conan profile 交给**真的 conan** 校验（`conan profile show`）。
 * 没有 conan 的环境自动跳过（CI 上装了 conan，会真的跑）。
 */
import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  archExpectation,
  archReport,
  compilerFor,
  crossPlanFor,
  matchesExpectation,
  missingHints,
  missingMatrixHint,
  missingTools,
  packageFolderFromCachePath,
  packageUidFromList,
  parseReadelf,
  type ArchFact,
} from '../core/crossCompile';
import { parseBuildMatrix, pickTarget, type BuildMatrix } from '../core/buildMatrix';

const MATRIX_TEXT = readFileSync('assets/template/.hetai/build-matrix.yml', 'utf8');
/** 模板里 CI 真正用的交叉检查脚本 —— 我们的"期望架构"知识必须与它一致。 */
const CI_SCRIPT = readFileSync('assets/template/.github/misc/cross_compile_check.py', 'utf8');
const CI_WORKFLOW = readFileSync('assets/template/.github/workflows/cross-compile.yml', 'utf8');

const matrix = (): BuildMatrix => parseBuildMatrix(MATRIX_TEXT, 'assets/template/.hetai/build-matrix.yml');

describe('§K 目标清单只有一个来源（G23）', () => {
  it('目标与 arch 全部来自矩阵（这里不维护第二份清单）', () => {
    const m = matrix();
    assert.deepStrictEqual(
      m.targets.map((t) => t.id),
      ['linux-armv7'],
      '模板矩阵里的目标（改模板就要改这条断言 —— 而不是在代码里再抄一份）',
    );
    assert.strictEqual(m.targets[0].arch, 'armv7');
    assert.strictEqual(m.targets[0].os, 'Linux');
  });

  it('矩阵文件不在 → 显式说明 + 给同步入口（不许静默空下拉）', () => {
    const hint = missingMatrixHint();
    assert.match(hint.message, /build-matrix\.yml/u);
    assert.ok(hint.fix.length >= 2, '至少要有两条可照做的下一步');
    assert.match(hint.fix.join('\n'), /templateUpdate|同步/u, '要指出从模板同步的入口');
  });

  it('目标不在矩阵里 → 报错并列出可选目标（不静默回退到默认目标）', () => {
    const m = matrix();
    assert.throws(() => pickTarget(m, 'nope'), /不在/u, '矩阵里没有的目标必须报错，而不是回退到默认目标');
    assert.strictEqual(pickTarget(m, undefined).id, 'linux-armv7', '不传就是矩阵里的默认目标');
    // 矩阵里的目标缺 arch → 拒绝生成计划（交叉编译必须知道目标架构）
    assert.throws(
      () => crossPlanFor({ ...m, targets: [{ ...m.targets[0], arch: undefined }] }, { ...m.targets[0], arch: undefined }, '/tmp/p.profile'),
      /没有 arch/u,
    );
  });
});

describe('§K 命令行形状（G24 + "不跑测试"的语义断言）', () => {
  it('必须带 `-pr:b=default`（否则 build context 被目标架构污染 → exec format error）', () => {
    const plan = crossPlanFor(matrix(), matrix().targets[0], '/tmp/het.profile');
    assert.ok(plan.args.includes('-pr:b=default'), `args=${plan.args.join(' ')}`);
  });

  it('必须带 `-tf=`（跳过 test folder），且不许出现 test 相关参数', () => {
    const plan = crossPlanFor(matrix(), matrix().targets[0], '/tmp/het.profile');
    assert.ok(plan.args.includes('-tf='), `args=${plan.args.join(' ')}`);
    const joined = plan.args.join(' ');
    assert.ok(!joined.includes('--test-folder'), '矩阵里写了 --test-folder= 也要被规范化掉（否则两条流水线混成一条）');
    assert.ok(!joined.includes('test_package'), '交叉编译不碰 test_package');
  });

  it('矩阵里的 create_extra_args 会带上（--build=missing 这类必须保留）', () => {
    const plan = crossPlanFor(matrix(), matrix().targets[0], '/tmp/het.profile');
    assert.ok(plan.args.includes('--build=missing'), `args=${plan.args.join(' ')}`);
  });

  it('profile 路径进命令行（不是空串），且 profile 文本按矩阵生成', () => {
    const plan = crossPlanFor(matrix(), matrix().targets[0], '/tmp/het-x.profile');
    assert.ok(plan.args.includes('-pr:h=/tmp/het-x.profile'));
    assert.match(plan.profileText, /^\[settings\]/mu);
    assert.match(plan.profileText, /^arch=armv7$/mu);
    assert.match(plan.profileText, /^os=Linux$/mu);
    assert.match(plan.profileText, /^compiler\.version=11$/mu, '工具链 11.3.rel1 → 主版本 11');
  });

  it('真 conan 接受生成的 profile（本机没 conan 就跳过）', () => {
    let conan = '';
    try {
      conan = execFileSync('which', ['conan'], { encoding: 'utf8' }).trim();
    } catch {
      conan = '';
    }
    if (!conan) {
      console.log('[k] 本机没有 conan：跳过 profile 实测（CI 上会跑）');
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), 'het-k-'));
    try {
      const plan = crossPlanFor(matrix(), matrix().targets[0], join(dir, 'het.profile'));
      writeFileSync(plan.profilePath, plan.profileText, 'utf8');
      const out = execFileSync(conan, ['profile', 'show', `-pr:h=${plan.profilePath}`], { encoding: 'utf8' });
      assert.match(out, /arch=armv7/u, `conan 应当回显我们写的 arch：\n${out}`);
      assert.match(out, /os=Linux/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('§K 与模板里 CI 脚本的知识对账（改了脚本没改这里 → 红）', () => {
  /** 从 cross_compile_check.py 里抠出它每个目标的工具链与期望 ELF 形态。 */
  function ciTargets(): Array<{ cc: string; arch: string; elfClass: string; machine: string; thumb: boolean }> {
    const conanArch = /CONAN_ARCH = \{([^}]+)\}/u.exec(CI_SCRIPT)?.[1] ?? '';
    assert.ok(conanArch.includes('cortex-a53'), 'CONAN_ARCH 解析失败（脚本结构变了？）');
    const cpuToArch = new Map(
      [...conanArch.matchAll(/'([^']+)':\s*'([^']+)'/gu)].map((m) => [m[1], m[2]] as const),
    );
    const entries = [...CI_SCRIPT.matchAll(/'(-?[a-z0-9-]+)':\s*\{\s*'desc'[\s\S]*?'cc':\s*'([^']+)'[\s\S]*?'mcpu':\s*'([^']+)'[\s\S]*?'expect_class':\s*'([^']+)'[\s\S]*?'expect_machine':\s*'([^']+)'[\s\S]*?'expect_thumb':\s*(True|False)/gu)];
    assert.ok(entries.length >= 2, `应当解析出 ≥2 个 CI 目标，实际 ${entries.length}`);
    return entries.map((m) => ({
      cc: m[2],
      arch: cpuToArch.get(m[3]) ?? '?',
      elfClass: m[4],
      machine: m[5],
      thumb: m[6] === 'True',
    }));
  }

  it('工具链映射（arch/os → gcc）与 CI 脚本一致', () => {
    for (const t of ciTargets()) {
      const os = t.cc.startsWith('arm-none-eabi') ? 'baremetal' : 'Linux';
      const ours = compilerFor(t.arch, os);
      assert.ok(ours, `arch=${t.arch} os=${os} 在我们的映射表里没有（别再各写一套）`);
      assert.strictEqual(ours?.cc, t.cc, `arch=${t.arch} os=${os} 的 C 编译器与 CI 脚本不一致`);
    }
  });

  it('期望的 ELF 形态与 CI 脚本一致（含 M-core 必须 Thumb）', () => {
    for (const t of ciTargets()) {
      const os = t.cc.startsWith('arm-none-eabi') ? 'baremetal' : 'Linux';
      const ours = archExpectation(t.arch, os);
      assert.ok(ours, `arch=${t.arch} 的期望值缺失`);
      assert.strictEqual(ours?.elfClass, t.elfClass, `${t.arch}: Class 不一致`);
      assert.strictEqual(ours?.machine, t.machine, `${t.arch}: Machine 不一致`);
      assert.strictEqual(ours?.thumb, t.thumb, `${t.arch}: Thumb 期望不一致`);
    }
  });

  it('CI 流水线名字与 job 名对得上（Intent 的 ci 映射指向真身）', () => {
    assert.match(CI_WORKFLOW, /^name: Cross Compile$/mu);
    assert.match(CI_WORKFLOW, /^\s+cross-compile:$/mu, 'job 名必须是 cross-compile（Intent 里写的就是它）');
    assert.match(CI_WORKFLOW, /cross_compile_check\.py/u, 'CI 走的是那个脚本');
  });
});

describe('§K 缺工具链时给定向提示（不是一句 not found）', () => {
  const plan = crossPlanFor(matrix(), matrix().targets[0], '/tmp/het.profile');

  it('缺哪个可执行就报哪个（用注入的 which，不碰真机）', () => {
    assert.deepStrictEqual(missingTools(plan, (e) => e === plan.toolchain?.cc), [plan.toolchain?.cxx, plan.toolchain?.ar]);
    assert.deepStrictEqual(missingTools(plan, () => true), []);
  });

  it('提示里有：目标/缺什么 + apt 包名 + 或者去 CI + 不跑测试', () => {
    const hint = missingHints(plan, [plan.toolchain!.cc]);
    const all = [...hint.lines, ...hint.fix].join('\n');
    assert.match(all, /arm-linux-gnueabihf-gcc/u, '要点名缺的可执行');
    assert.match(all, /apt-get install -y gcc-arm-linux-gnueabihf g\+\+-arm-linux-gnueabihf/u, '要给可复制的安装命令');
    assert.match(all, /cross-compile\.yml/u, '要给"交给 CI"这条路');
    assert.match(all, /不跑测试/u, '要说清交叉编译不跑测试（避免与全量测试混淆）');
    assert.ok(!/not found|ENOENT/u.test(all), '不要把原始 not found 丢给用户');
  });

  it('baremetal 目标额外说清"烧板是另一条流水线"', () => {
    const bare = { ...plan, os: 'baremetal', arch: 'armv7', toolchain: compilerFor('armv7', 'baremetal') };
    const hint = missingHints(bare, [bare.toolchain!.cc]);
    assert.match([...hint.lines, ...hint.fix].join('\n'), /上板验证/u);
    assert.match(hint.fix.join('\n'), /gcc-arm-none-eabi/u);
  });
});

describe('§K readelf 报告（判"是不是编成了目标架构"）', () => {
  const HEADER = '  Class:                             ELF64\n  Machine:                           AArch64\n';
  const ATTRS = '  Tag_CPU_arch: v8\n  Tag_THUMB_ISA_use: -\n';

  it('解析 readelf 输出（缺字段给 ?，不猜）', () => {
    assert.deepStrictEqual(parseReadelf(HEADER, ATTRS), {
      elfClass: 'ELF64',
      machine: 'AArch64',
      cpuArch: 'v8',
      thumb: '-',
    });
    assert.deepStrictEqual(parseReadelf('', ''), { elfClass: '?', machine: '?', cpuArch: '?', thumb: '?' });
  });

  it('匹配判定：Class + Machine（+ M-core 的 Thumb）', () => {
    const a53: ArchFact = { archive: 'liba.a', member: 'a.o', ...parseReadelf(HEADER, ATTRS) };
    assert.strictEqual(matchesExpectation(a53, archExpectation('armv8', 'Linux')), true);
    assert.strictEqual(matchesExpectation(a53, archExpectation('armv7', 'Linux')), false, 'armv7 的包不该是 ELF64');

    const m4: ArchFact = {
      archive: 'libm.a',
      member: 'm.o',
      ...parseReadelf('  Class:                             ELF32\n  Machine:                           ARM\n', '  Tag_CPU_arch: v7E-M\n  Tag_THUMB_ISA_use: Thumb-2\n'),
    };
    assert.strictEqual(matchesExpectation(m4, archExpectation('armv7', 'baremetal')), true);
    assert.strictEqual(
      matchesExpectation({ ...m4, thumb: '?' }, archExpectation('armv7', 'baremetal')),
      false,
      'M-core 没有 Thumb 标记就是错的（链接期才发现太晚）',
    );
    // 不认识的架构：只报告，不下结论（别把"不知道"说成"通过"）
    assert.strictEqual(matchesExpectation(a53, undefined), true);
  });

  it('报告写清结论；空档案不算通过', () => {
    const plan = crossPlanFor(matrix(), matrix().targets[0], '/tmp/het.profile');
    const good = archReport(plan, [{ archive: 'liba.a', member: 'a.o', ...parseReadelf(HEADER, ATTRS) }]);
    assert.match(good, /目标：linux-armv7 · arch=armv7/u);
    assert.match(good, /期望：ELF32 · ARM/u, 'armv7 的期望值与矩阵一致');
    assert.match(good, /✗ liba\.a/u, '不匹配的档案要标出来');
    assert.match(good, /有档案不符合目标架构/u, '不匹配时必须给否定结论');
    const empty = archReport(plan, []);
    assert.match(empty, /不算通过/u, '没有档案时不许显示"通过"');
  });

  it('包目录解析：抄 CI 脚本的推导（`conan list` + `conan cache path`）', () => {
    const listed = [
      'Local Cache',
      '  fcpp/1.0.0',
      '    revisions',
      '      1a2b...',
      '        packages',
      '          9f8e7d...',
      '            info',
    ].join('\n');
    assert.strictEqual(packageUidFromList(listed), '9f8e7d...');
    assert.strictEqual(packageUidFromList('Local Cache\n'), undefined, '没有 packages 段就是没产出包');
    assert.strictEqual(packageFolderFromCachePath('/home/u/.conan2/p/b/fcpp9f8e7d/p\n'), '/home/u/.conan2/p/b/fcpp9f8e7d/p');
    assert.strictEqual(packageFolderFromCachePath('  \n'), undefined);
  });
});
