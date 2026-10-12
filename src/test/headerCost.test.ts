/**
 * V3 · L6e 门禁：**编译期成本**（仅头文件库的对外成本）。
 *
 * 计划 §5.2 对 `is_header=true` 的原文：「编译期成本关注点；**隐藏** ABI 类检查」。
 * 这一条盯五件事：
 *   1. 报的是**差值**（`include 你` − 空 TU），不是绝对耗时 —— 进程启动那一份不算你的成本；
 *   2. **换编译器/标准/额外 include 以后不许跟旧基线比**（那是假对比 → 提示先重测）；
 *   3. 没量过 → 白，并如实说"不等于成本为零"（不许拿 0 冒充分数）；
 *   4. 涨幅超过设置里的阈值才变黄（阈值唯一来源 = 设置，不藏数字）；
 *   5. **探针头的选择只从产物事实推**（`<模块名>.hpp` → 唯一头 → 否则如实说"判不了"），
 *      并且这条卡只在仅头文件产物上出现（`header-only` 能力）。
 */
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  comparable,
  deltaPct,
  headerCostFact,
  makeHeaderCostRun,
  msText,
  pickPublicHeader,
  type HeaderCostRun,
} from '../core/headerCost';
import { singlePageModelFrom } from '../features/cockpit/singlepage/modelFrom';
import { allCards } from '../features/cockpit/singlepage/sections';
import { initialCockpitState } from '../features/cockpit/state';
import { PLANNED_CAPABILITY_CONSUMERS } from '../features/cockpit/singlepage/spine';
import { CAPABILITY_ORDER, CAPABILITY_LABELS } from '../core/capability';
import { BUSY_ACTIONS, CHANNELS } from '../core/outputChannels';
import { INTENTS } from '../core/intents';

const run = (over: Partial<HeaderCostRun> = {}): HeaderCostRun => ({
  at: '14:05',
  header: 'include/mylib.hpp',
  compiler: 'g++ 13.3.0',
  std: 'c++17',
  runs: 5,
  emptyMs: 90,
  includeMs: 400,
  deltaMs: 310,
  ...over,
});

describe('L6e · 编译期成本（仅头文件库）', () => {
  it('数字形状：`msText` 秒级换单位；**头条数字是差值**（扣掉空 TU 那一份）', () => {
    assert.strictEqual(msText(312), '312ms');
    assert.strictEqual(msText(1420), '1.42s');
    assert.strictEqual(msText(0), '0ms');
    const snap = makeHeaderCostRun({
      header: 'include/mylib.hpp',
      compiler: 'g++ 13.3.0',
      std: 'c++17',
      runs: 5,
      emptyMs: 90,
      includeMs: 400,
    });
    assert.strictEqual(snap.deltaMs, 310, '报的是"include 你"比"什么都不 include"多花的（不是绝对耗时）');
    // 抖动（差为负）不编"负成本"
    assert.strictEqual(makeHeaderCostRun({ header: 'include/a.hpp', compiler: 'g++', std: 'c++17', runs: 5, emptyMs: 120, includeMs: 110 }).deltaMs, 0);
    assert.ok(Math.abs((deltaPct(310, 400) ?? 0) - 29.03) < 0.01);
    assert.strictEqual(deltaPct(0, 400), undefined, '基线为 0 时算不出百分比 → 不给假数字');
  });

  it('可比性：编译器 / 标准 / 额外 include 目录换一个就不算同一套', () => {
    const base = run();
    assert.strictEqual(comparable(base, run({ deltaMs: 999 })), true, '只有耗时不同 = 同一套参数');
    assert.strictEqual(comparable(base, run({ compiler: 'clang++ 18.1.0' })), false);
    assert.strictEqual(comparable(base, run({ std: 'c++20' })), false);
    assert.strictEqual(comparable(base, run({ extraIncludes: ['/opt/eigen'] })), false);
    assert.strictEqual(comparable(run({ extraIncludes: ['/opt/eigen'] }), run({ extraIncludes: ['/opt/eigen'] })), true);
  });

  it('三态文案：没量过 → 白（不是"成本为零"）；量了没基线 → 绿但写明；涨过阈值 → 黄', () => {
    const none = headerCostFact({ costPct: 20 });
    assert.strictEqual(none.state, 'idle');
    assert.match(none.fact, /还没实测过/u);
    assert.match(none.fact, /不等于"成本为零"/u, '必须点破这个误读');
    assert.match(none.next ?? '', /^需要你执行：/u);

    const first = headerCostFact({ now: run(), costPct: 20 });
    assert.strictEqual(first.state, 'ok');
    assert.match(first.fact, /^include mylib\.hpp 额外 310ms（中位 5 次） · 还没有基线$/u);
    assert.strictEqual(first.next, undefined, '绿的时候不啰嗦"下一步"');

    const worse = headerCostFact({ baseline: run({ deltaMs: 250 }), now: run({ deltaMs: 400 }), costPct: 20 });
    assert.strictEqual(worse.state, 'warn');
    assert.match(worse.fact, /比基线 \+60%（超过 20%）/u);
    assert.match(worse.next ?? '', /看看 include\/mylib\.hpp 最近改了什么/u);

    const slight = headerCostFact({ baseline: run({ deltaMs: 300 }), now: run({ deltaMs: 320 }), costPct: 20 });
    assert.strictEqual(slight.state, 'ok', '涨了 6.7% 不到阈值 → 只报数字，不催人');
    assert.match(slight.fact, /比基线 \+7%/u);
  });

  it('换了编译器/标准 → **不跟旧基线比**（拿两套参数对比是假数字）', () => {
    const view = headerCostFact({
      baseline: run({ compiler: 'g++ 12.2.0' }),
      now: run({ deltaMs: 900 }),
      costPct: 20,
    });
    assert.strictEqual(view.state, 'warn');
    assert.match(view.fact, /与基线不可比/u);
    assert.match(view.next ?? '', /基线是「g\+\+ 12\.2\.0 · c\+\+17」测的/u, '要说清是拿哪套测的');
    assert.match(view.next ?? '', /重测一次再比/u);
  });

  it('探针头的选择只从产物事实推：`<模块名>.hpp` → 唯一头 → 判不了就说判不了', () => {
    const files = ['include/mylib.hpp', 'include/other.hpp', 'src/x.cpp'];
    assert.deepStrictEqual(pickPublicHeader(files, 'mylib'), { header: 'include/mylib.hpp' });
    assert.deepStrictEqual(pickPublicHeader(['include/mylib.h'], 'mylib'), { header: 'include/mylib.h' });
    assert.deepStrictEqual(pickPublicHeader(['include/solo.hxx'], 'mylib'), { header: 'include/solo.hxx' }, '只有一个头 → 用它');
    const ambiguous = pickPublicHeader(files, 'nope');
    assert.strictEqual(ambiguous.header, undefined, '多候选且名字对不上 → **不猜**');
    assert.match(ambiguous.issue ?? '', /判不了哪个是入口头/u);
    assert.match(pickPublicHeader(['src/x.cpp'], 'mylib').issue ?? '', /include\/ 下没有头文件/u);
  });

  it('**卡片映射**：只在仅头文件产物上出现；三态与事实都对得上', () => {
    const view = headerCostFact({ baseline: run({ deltaMs: 250 }), now: run({ deltaMs: 900 }), costPct: 20 });
    const model = singlePageModelFrom(initialCockpitState(), {
      metadata: { name: 'mylib', is_header: true },
      headerCost: { baseline: run({ deltaMs: 250 }), now: run({ deltaMs: 900 }), costPct: 20 },
    });
    const card = model.cards.find((c) => c.id === 'headerCost');
    assert.ok(card, '仅头文件产物必须有这张卡');
    assert.strictEqual(card?.state, view.state);
    assert.match(card?.fact ?? '', /额外 900ms/u);
    assert.match(card?.next ?? '', /^需要你执行：/u);
    assert.strictEqual(model.spine?.find((s) => s.id === 'quality')?.cards.includes('headerCost'), true);

    // 共享库：ABI 卡在、编译期成本卡不在（两种产物两种对外承诺）
    const shared = singlePageModelFrom(initialCockpitState(), { metadata: { name: 'mylib', is_shared: true } });
    assert.ok(!shared.cards.some((c) => c.id === 'headerCost'), '共享库不该看到"include 成本"这种说法');
    assert.ok(shared.cards.some((c) => c.id === 'abiSymbols'), '共享库看的是符号表');
  });

  it('**挂账清零**：8 条能力全部有卡片消费（PLANNED 表空，且表只许变短）', () => {
    assert.deepStrictEqual(Object.keys(PLANNED_CAPABILITY_CONSUMERS), [], 'L6e 后不该再有挂账');
    // 看**卡片注册表**（不是渲染出来的模型 —— 模型里只有可见卡，被隐藏的卡看不见）
    const shown = new Set(allCards().flatMap((c) => (Array.isArray(c.show) ? c.show : [])));
    for (const id of CAPABILITY_ORDER) {
      assert.ok(shown.has(id), `${CAPABILITY_LABELS[id]}（${id}）必须有卡片消费它`);
    }
  });

  it('**接线门禁**：探针真编译（不是估）、参数一起记、事实真的喂进单页模型', () => {
    const ext = readFileSync(join('src', 'extension.ts'), 'utf8');
    const start = ext.indexOf('async function probeHeaderCost');
    assert.ok(start > 0, '探针函数得在');
    const fn = ext.slice(start, ext.indexOf('\nasync function', start + 10));
    assert.ok(fn.includes("'-fsyntax-only'"), '用 -fsyntax-only 量解析成本（不编代码/不链接）');
    assert.ok(fn.includes('pickPublicHeader('), '探针头要走纯核心的选择规则（不取第一个）');
    assert.ok(fn.includes('is_header !== true'), '不是仅头文件产物就别量（这张卡只对它的承诺有意义）');
    assert.ok(fn.includes('makeHeaderCostRun('), '**差值**要走纯函数算（报绝对耗时 = 把进程启动算成你的成本）');
    assert.ok(fn.includes("update('het.header.last'"), '实测结果要落盘');
    assert.ok(fn.includes("globalStorageUri.fsPath, 'header-cost'"), '探针写进 globalStorage（不往用户工程丢文件）');
    assert.ok(fn.includes('compiler,') && fn.includes('std,') && fn.includes('extraIncludes'), '参数要一起记（否则以后是假对比）');
    assert.ok(fn.includes('res.code !== 0') || fn.includes('throw new Error'), '编不过要抛（不许把失败当 0ms）');
    assert.ok(ext.includes('facts.headerCost = {'), '事实要真的喂进单页模型');
    assert.ok(ext.includes("update('het.header.baseline'"), '基线要真的落盘');
    // 忙语义：探针是长动作，必须挂自己的 busy id（状态栏/chip 才能说清在忙什么）
    assert.ok((BUSY_ACTIONS as readonly string[]).includes('headerCost'), 'headerCost 要在忙动作清单里');
    assert.ok(CHANNELS.headerCost.label.includes('编译期成本'), '通道标签要说人话');
    for (const cmd of ['het.probeHeaderCost', 'het.pinHeaderCostBaseline']) {
      assert.ok(
        INTENTS.some((i) => i.command === cmd),
        `${cmd} 必须在 Intent 表里（否则卡片按钮点了没反应）`,
      );
    }
    assert.ok(ext.includes("runWithBusy(busyHost(), 'headerCost'"), '探针要走统一忙语义 helper');
  });
});
