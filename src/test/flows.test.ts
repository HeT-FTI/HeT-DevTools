import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FcppMetadata } from '../types';
import { currentStatus, resetBusy, runWithBusy, type BusyHost } from '../core/busy';
import {
  addDependency,
  listDependencies,
  removeDependency,
} from '../core/dependencyService';
import { statusText } from '../core/status';
import { chipSpec } from '../features/statusChip';
import { SECTIONS, allCards } from '../features/cockpit/singlepage/sections';
import { initialCockpitState } from '../features/cockpit/state';
import { singlePageModelFrom } from '../features/cockpit/singlepage/modelFrom';
import { cockpitSinglePageHtml } from '../features/cockpit/singlepage/shell';
import { COPILOT_ENTRIES, copilotEntryFor, prefillText } from '../features/cockpit/singlepage/copilotEntry';
import {
  BUSY_ACTIONS,
  CHANNELS,
  channelDef,
  nextStepHint,
  type BusyAction,
} from '../core/outputChannels';
import { planModuleFiles } from '../core/moduleTemplate';
import {
  bucketOf,
  groupRows,
  searchCatalog,
  summarizeDeps,
  validateAddInput,
  versionsFor,
} from '../features/deps/model';
import { depsListHtml, depsPageHtml } from '../features/deps/html';
import { TOOL_MATRIX } from '../core/toolMatrix';
import { qualityResultHtml, qualityRowsHtml } from '../features/quality/qualityHtml';
import { preflightInnerHtml, verdictOf } from '../features/preflight/html';

/**
 * **用户串起来的整条路**（§F.46）：单点测试全绿、连起来却不能用，是这次实测反馈里
 * 最常见的翻车方式（"点了没反应"、"状态不对"、"数字不更新"）。
 *
 * 所以这里不重复测单个函数，而是把**用户的一次操作**从头走到尾：
 *   点击 → 忙语义 → 状态显示（吸顶/chip/HUD）→ 结果写回 → 卡片与清单更新。
 */

const read = (p: string): string => readFileSync(join('src', p), 'utf8');

function fakeHost(): BusyHost & { lines: string[]; busy: string[] } {
  const lines: string[] = [];
  const busy: string[] = [];
  return {
    lines,
    busy,
    now: () => 1_000,
    outputChannel: (name: string) => ({ appendLine: (l: string) => lines.push(`${name}| ${l}`) }),
    notifyBusy: (action, on) => busy.push(`${action}:${on}`),
    notifyDone: () => undefined,
  };
}

const chip = (running: string | null, runningAction: string | null, lastBuildOk: boolean | null) =>
  chipSpec({
    projectName: 'demo',
    health: 88,
    running,
    runningAction,
    lastBuildOk,
    test: { passed: 7, failed: 0, skipped: 1 },
    templateBehind: 0,
  })!;

describe('§F.46 用户流 ①：点"构建" → 忙语义 → 状态栏/吸顶/chip 一致 → 完成后回到结果', () => {
  it('从点击到收尾，整条链上的每一站都说得清"现在在干什么"', async () => {
    resetBusy();
    const host = fakeHost();
    const state = initialCockpitState();

    // ① 用户点了「构建」→ 统一 helper 记账
    const promise = runWithBusy(host, 'build', channelDef('build')!.label, async () => {
      // ② 此刻：单一状态源能答出来"在构建"，而且是用户能看懂的话
      const st = currentStatus();
      assert.strictEqual(st?.action, 'build');
      assert.strictEqual(st?.text, '构建中');

      // ③ 状态栏 chip：图标 + 进行中文字，**不许**显示上一次的失败、也不许红
      const busyChip = chip(st!.text, st!.action, false);
      assert.strictEqual(busyChip.text, '$(sync~spin) HeT 构建中');
      assert.strictEqual(busyChip.color, undefined, '构建中不飘红');
      assert.ok(busyChip.tooltip.includes('$(sync~spin) 构建 进行中'), '悬停里那一格说"进行中"');
      assert.ok(busyChip.tooltip.includes('$(error) 测试'), '别的格仍显示真实历史结果');

      // ④ 驾驶舱吸顶右侧：同一句话出现在忙位上
      const model = singlePageModelFrom(state, { status: { action: st!.action, text: st!.text } });
      const html = cockpitSinglePageHtml(model);
      assert.ok(html.includes('data-busy'), '吸顶右侧有忙位');
      assert.ok(html.includes('>构建中<') || html.includes('构建中</span>'), '忙位要带文字');
      return true;
    });
    await promise;

    // ⑤ 收尾：忙注册表排空 → 状态回到"历史结果"（红色只在"跑完且失败"时出现）
    assert.strictEqual(currentStatus(), null);
    assert.deepStrictEqual(host.busy, ['build:true', 'build:false']);
    const idle = chip(null, null, false);
    assert.strictEqual(idle.text, '$(pulse) HeT 88', '闲时 chip 回到健康分');
    assert.strictEqual(idle.color, 'statusBarItem.errorBackground', '失败结论才配红底');
    const idleModel = singlePageModelFrom(state, { status: null });
    assert.ok(!cockpitSinglePageHtml(idleModel).includes('>构建中<'), '收尾后吸顶不残留"构建中"');
  });

  it('没有单一来源时（另一处 running 有值）也不会互相清空', () => {
    const state = initialCockpitState();
    const withLog = { ...state, top: { ...state.top, running: '正在编译文档' } };
    assert.strictEqual(singlePageModelFrom(withLog, { status: null }).busy, '正在编译文档');
    assert.strictEqual(
      singlePageModelFrom(withLog, { status: { action: 'build', text: '构建中' } }).busy,
      '构建中',
      '仓库级状态优先',
    );
  });
});

describe('§F.46 用户流 ②：加依赖 → 双写 → 面板与回显一致', () => {
  const CONANDATA = '# managed\nrequirements:\n  - "gtest/1.15.2"\n';

  function meta(): FcppMetadata {
    return {
      name: 'demo',
      version: '0.1.0',
      build_type: 'Release',
      build_cppstd: '17',
      dependencies: { common: {}, c: {}, cpp: {}, infra: { GTest: ['gtest::gtest'] } },
      workflow_triggers: { build: true },
    } as FcppMetadata;
  }

  it('搜索 → 版本联动 → 校验 → 写入两个文件 → 清单/回显跟着变', () => {
    // ① 用户在搜索框输入"日志"
    const hits = searchCatalog('日志');
    assert.ok(hits.some((h) => h.conan === 'spdlog'), '按用途能搜到');

    // ② 选中 spdlog → 版本候选与归属桶由同一份索引给出
    const name = 'spdlog';
    const versions = versionsFor(name);
    assert.ok(versions.length >= 2 && versions[0] !== '__custom__', '版本联动有真实候选');
    const bucket = bucketOf(name);
    assert.strictEqual(bucket, 'cpp');

    // ③ 提交前的校验（空输入也要有人话）
    assert.ok(validateAddInput({ conanName: '', version: '', bucket })!.includes('包名'));
    const version = versions[0];
    assert.strictEqual(validateAddInput({ conanName: name, version, bucket }), null);

    // ④ 落盘：conandata.yml 与 metadata.json 同时写
    const res = addDependency(meta(), CONANDATA, { conanName: name, version, bucket });
    assert.strictEqual(res.ok, true, res.issues.join('；'));
    assert.strictEqual(res.appliedBucket, 'cpp');
    assert.strictEqual(res.coerced, false);
    assert.ok(res.nextConandataText!.includes(`${name}/${version}`), 'conandata 里有它');
    assert.ok(JSON.stringify(res.nextMetadata).includes('spdlog'), 'metadata 里有它');

    // ⑤ 面板清单（局部刷新注入的那块 HTML）与回显
    const views = listDependencies(res.nextMetadata!, res.nextConandataText!);
    const listHtml = depsListHtml({ views, issues: [] });
    assert.ok(listHtml.includes('spdlog'), '清单里能看到新依赖');
    assert.ok(listHtml.includes('移除'), '每行要能移除');
    assert.ok(summarizeDeps(views).includes(`${views.length} 个`));
    const groups = groupRows(views);
    assert.strictEqual(groups.find((g) => g.bucket === 'cpp')!.rows.length, 1, '落在 cpp 桶');

    // ⑥ 首帧页面必须能承载上面那块局部刷新（锚点存在）
    const page = depsPageHtml({ views, issues: [] });
    assert.ok(page.includes('id="list"') && page.includes('id="note"'));

    // ⑦ 规则固定桶：gtest 选 common 也会落到 infra，并且**如实回执**
    //   （注意用"还没装 gtest"的 metadata：同一个包重复加会失败 —— 这也是用户会遇到的下一站，
    //   顺手断言它的报错是人话）
    const fresh = meta();
    fresh.dependencies = { common: {}, c: {}, cpp: {}, infra: {} };
    const g = addDependency(fresh, CONANDATA, { conanName: 'gtest', version: '1.16.0', bucket: 'common' });
    assert.strictEqual(g.ok, true, g.issues.join('；'));
    assert.strictEqual(g.appliedBucket, 'infra');
    assert.strictEqual(g.coerced, true, '要标记"被规则改桶"，UI 才能如实说');
    // 用**第一次写入后的**两个文件再提交一次 —— 这才是用户重复点击时的真实输入
    const dup = addDependency(g.nextMetadata!, g.nextConandataText!, {
      conanName: 'gtest',
      version: '1.16.0',
      bucket: 'infra',
    });
    assert.strictEqual(dup.ok, false);
    assert.ok(/已存在/.test(dup.issues.join('；')), `重复添加要给可读原因，实际：${dup.issues.join('；')}`);

    // ⑧ 移除后清单真的空（用户点"移除"的第二半条路）
    const rm = removeDependency(res.nextMetadata!, res.nextConandataText!, {
      bucket: 'cpp',
      displayKey: 'spdlog',
    });
    assert.strictEqual(rm.ok, true, rm.issues.join('；'));
    assert.ok(!depsListHtml({
      views: listDependencies(rm.nextMetadata!, rm.nextConandataText!),
      issues: [],
    }).includes('spdlog'), '移除后清单里不该还有它');
  });
});

describe('§F.46 用户流 ⑤：编译文档（含"缺工具"这条最常见的半路）', () => {
  function docsHost(): BusyHost & { lines: string[]; busy: string[] } {
    const lines: string[] = [];
    const busy: string[] = [];
    return {
      lines,
      busy,
      now: () => 2_000,
      outputChannel: (n: string) => ({ appendLine: (l: string) => lines.push(`${n}| ${l}`) }),
      notifyBusy: (a, on) => busy.push(`${a}:${on}`),
      notifyDone: () => undefined,
    };
  }

  it('跑起来 → chip 文档格说"构建中" → 成功给 ✓/耗时、失败给可执行原因与下一步', async () => {
    resetBusy();
    const ok = docsHost();
    await runWithBusy(ok, 'docsBuild', '编译文档', async () => true);
    assert.ok(ok.lines.some((l) => l.includes('▶') && l.includes('编译文档')), '开始要有回显');
    assert.ok(ok.lines.some((l) => l.includes('✓')), '结束要有 ✓ 与耗时');
    assert.ok(ok.lines.some((l) => l.includes('完成（')), '耗时是可读的秒数');
    // 成功**不**硬塞"下一步"（产品口径：下一步提示只在失败时给 —— 断言这个边界，
    // 免得以后有人把两头都塞满，输出通道变成噪声）
    assert.ok(!ok.lines.some((l) => l.includes('下一步')), '成功路径不该有"下一步"行');

    // 文档在跑的那一刻：chip 的文档行说"进行中"，而不是上一次的失败
    const html = chipSpec({
      projectName: 'demo',
      health: 90,
      running: '编译文档',
      runningAction: 'docsBuild',
      lastBuildOk: true,
      test: null,
      templateBehind: 0,
      docs: 'fail',
    })!;
    assert.ok(html.tooltip.includes('$(sync~spin) 构建中'), '正在编译 → 该行显示进行中');
    assert.ok(!html.tooltip.includes('技术文档 | ✗'), '不许把上一次失败当结论');

    // 缺 doxygen 这条半路：错误里要是**可执行**的说明，不是"检查失败"
    resetBusy();
    const bad = docsHost();
    const res = await runWithBusy(bad, 'docsBuild', '编译文档', async () => {
      throw new Error("doxygen is not recognized as an internal or external command");
    });
    assert.strictEqual(res.status, 'failed');
    assert.ok(bad.lines.join('\n').includes('doxygen'), '原始错误要留在输出里');
    assert.ok(bad.lines.join('\n').includes('下一步'), '失败必须给下一步');
    assert.ok(bad.lines.join('\n').includes('文档注释补全'), '这条"下一步"要指向真实可做的动作');
    assert.strictEqual(currentStatus(), null, '失败也要把忙状态清掉（不卡死）');
  });
});

describe('§F.46 用户流 ⑥：质量门禁遇到"本机没有的工具"', () => {
  it('行状态 → 徽标 → 结果块：一路都说得清"为什么、怎么办、还能干什么"', () => {
    const mega = TOOL_MATRIX.find((t) => t.id === 'megalinter')!;
    // ① 跑之前：行里就有"要什么/多大/不装怎么办"
    assert.match(mega.install, /Docker/u);
    assert.match(mega.install, /GB/u);
    assert.match(mega.install, /CI/u);
    // ② 跑之后：na 终态 + 原因 + 下一步（面板渲染的是同一批字符串）
    const html = qualityResultHtml({
      rowId: 'megalinter',
      status: 'na',
      summary: 'MegaLinter 未跑完（超时）',
      issues: [],
      errors: ['已等待 15 分钟仍无结果（command timed out after 900000ms）。', '下一步：本地不装/不跑时走在线 CI。'],
    });
    assert.ok(html.includes('– 本机不可用'), 'na 徽标要说清是本机不可用');
    assert.ok(html.includes('超时'), '结果标题带原因');
    assert.ok(html.includes('走在线 CI'), '给下一步');
    // ③ 清单行的徽标与按钮：na 行也必须有可点的"检查"（不能是死行）
    const rows = qualityRowsHtml([
      { id: 'megalinter', label: '深度扫描 (MegaLinter / SAST)', status: 'na', tool: '需要 Docker' },
    ]);
    assert.ok(rows.includes('data-action="runRow"') && rows.includes('data-row="megalinter"'), '要有检查按钮与行 id');
    assert.ok(rows.includes('需要 Docker'), '行里要带依赖提示');
  });
});

describe('§F.46 用户流 ⑦：预检 → 发布中心（同一份判决）', () => {
  const items = [
    { label: '构建通过', ok: false, detail: '先修构建错误（见问题面板）', required: true },
    { label: '测试通过', ok: undefined, detail: '会话里还没跑过测试', required: true },
    { label: 'CHANGELOG.md 就绪', ok: true, detail: undefined, required: true },
  ];

  it('预检面板这块与发布中心那块用的是同一个判决对象', () => {
    const verdict = verdictOf(items);
    assert.strictEqual(verdict.allowRelease, false);
    // ① 预检页：事实 + 未就绪原因 + 首个红项 + 按钮禁用
    const page = preflightInnerHtml({ projectName: 'demo', items, passed: 1, total: 3, allowRelease: false });
    assert.ok(page.includes('✗ 1'), `要有三态事实，实际：${page.slice(0, 200)}`);
    assert.ok(page.includes('未就绪'), '要说明为什么不能发布');
    assert.ok(page.includes('disabled'), '未就绪时"去发布中心"要禁用');
    assert.ok(page.includes('构建通过'), '要说清第一个红项是谁');
    // ② 全绿时按钮可用、且不再有未就绪提示
    const okItems = items.map((i) => ({ ...i, ok: true }));
    const okPage = preflightInnerHtml({
      projectName: 'demo',
      items: okItems,
      passed: 3,
      total: 3,
      allowRelease: verdictOf(okItems).allowRelease,
    });
    assert.ok(!okPage.includes('disabled'), '全绿时按钮可用');
    assert.ok(okPage.includes('✓ 3'), '事实行要显示三项通过');
    // ③ 发布中心的渲染必须**读同一份字段**（verdict.fact / firstFail / next）
    const rel = read('extension.ts');
    assert.ok(rel.includes('verdict,'), '发布中心要拿到判决');
    assert.ok(read('features/release/panel.ts').includes('s.verdict.fact'), '发布中心显示同一句事实');
  });
});

describe('§F.46 用户流 ③：段 1 摘要 → 跳去执行段 → 那里的按钮是真命令', () => {
  it('每个 jump 链接都落在"真的有这个动作"的段上', () => {
    const now = SECTIONS.find((s) => s.id === 'now')!;
    const jumps = now.cards.flatMap((c) =>
      (c.extra ?? []).filter((a) => a.kind === 'jump').map((a) => ({ from: c.id, to: a.id })),
    );
    assert.ok(jumps.length >= 4, `摘要卡至少要给出四条去路，实际 ${jumps.length}`);
    for (const { from, to } of jumps) {
      const target = SECTIONS.find((s) => s.id === to);
      assert.ok(target, `跳转目标 ${to} 不存在`);
      const acts = target!.cards.flatMap((c) => [c.action, c.secondary, ...(c.extra ?? [])]);
      assert.ok(
        acts.some((a) => a?.kind === 'action'),
        `${from} 跳到「${target!.label}」但那段没有任何可执行按钮 —— 用户到了也是死路`,
      );
    }
    // 页面里真的渲染出了这些链接（不只是数据里写了）
    const html = cockpitSinglePageHtml(singlePageModelFrom(initialCockpitState(), {}));
    assert.ok(html.includes('data-action="jump"'), '要渲染成跳转链接');
    assert.ok(html.includes('去构建'), '文案要说清是去干什么');
  });
});

describe('§F.46 用户流 ④：模块主路径（/het-module → 卡片 → 忙语义 → 骨架含实现桩）', () => {
  it('入口 → 卡片 → 忙语义 → 生成的骨架能编译（声明有实现）', () => {
    // ① 卡片上有这个入口
    const card = allCards().find((c) => c.id === 'moduleAgent');
    assert.ok(card, '要有项目级模块卡');
    assert.strictEqual(card!.action?.kind, 'copilot');
    assert.strictEqual(card!.action?.id, '/het-module');

    // ② 入口表认得它，且预填正文以命令开头（否则斜杠命令不生效）
    const entry = copilotEntryFor('/het-module');
    assert.ok(entry, '/het-module 必须在入口表里');
    assert.ok(prefillText(entry!).startsWith('/het-module '), '命令必须在最前');
    assert.ok(COPILOT_ENTRIES.some((e) => e.card === 'moduleAgent'));

    // ③ 忙语义与输出去处都登记了（点下去要能看见"在忙"与"去哪儿看"）
    assert.ok((BUSY_ACTIONS as readonly string[]).includes(entry!.action));
    assert.strictEqual(CHANNELS[entry!.action as BusyAction].kind, 'chat');
    assert.ok(nextStepHint(entry!.action).includes('/het-module'), '失败时能指回命令');

    // ④ 向导这条路（降级后的"单模块微调"）产出的骨架：头里有声明，源里有实现
    const plan = planModuleFiles({
      moduleName: 'mymod',
      description: 'demo',
      language: 'cpp',
      since: '1.0',
      extraDeclarations: ['int mymod_sum(const int* a, int n);'],
    });
    assert.strictEqual(plan.ok, true);
    assert.ok(plan.files[0].content.includes('int mymod_sum(const int* a, int n);'), '头里声明');
    assert.ok(plan.files[1].content.includes('int mymod_sum(const int* a, int n) {'), '源里实现');
    assert.ok(plan.files[1].content.includes('#include <mymod.hpp>'), '源里包含头');
  });

  it('状态文案表覆盖所有会在界面上"正在跑"的动作（没有一串英文 id 漏到 UI 上）', () => {
    for (const a of BUSY_ACTIONS) {
      const t = statusText(a);
      assert.ok(t.length > 0 && t !== a, `${a} 没有中文进行时文案，界面上会露出 id`);
    }
  });
});
