/**
 * V3 · L6a / G7 门禁：**性能基线**。
 *
 * 计划 §7.1 的验收原文：「每项：**基线缺失显式说明**；…」。所以这里盯四件事：
 *   1. 没有基线 → 卡片**直说"基线未设"**（而不是一张空表 / 一个 `—`）；
 *   2. 对比只认**同名用例**：新增/缺失分开报，不混进"回归"；
 *   3. 阈值只有一个来源（设置 `het.bench.regressPct`），且**卡片文案里写出来**；
 *   4. 只报**数值方向**（原始值语义由人判 —— 吞吐类用例变大是好事）。
 */
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareToBaseline, perfFact, type BenchRun } from '../core/perfBaseline';
import { EMPTY_FACTS, singlePageModelFrom } from '../features/cockpit/singlepage/modelFrom';
import { initialCockpitState } from '../features/cockpit/state';
import { baremetalCapabilityConsumers } from './support/sanity';

const run = (values: [string, number][], at = '14:05'): BenchRun => ({
  at,
  values: values.map(([name, value]) => ({ name, value })),
});

describe('L6a · 性能基线（G7）', () => {
  it('**没有基线**：直说"基线未设"+ 怎么设（G7：不许给空表）', () => {
    const none = perfFact({ regressPct: 20 });
    assert.strictEqual(none.state, 'idle');
    assert.match(none.fact, /基线未设/u);
    assert.match(none.next ?? '', /存为基线/u);
    assert.strictEqual(none.compare, undefined);

    // 跑过但没钉基线 → 说出"最近跑了多少例"（也是真事实）
    const ran = perfFact({ run: run([['a', 10]]), regressPct: 20 });
    assert.match(ran.fact, /基线未设（最近一次跑了 1 例）/u);
  });

  it('**有基线、还没跑**：说明白"还没有新结果可比"（不拿基线冒充结果）', () => {
    const v = perfFact({ baseline: run([['a', 10], ['b', 20]], '昨天'), regressPct: 20 });
    assert.strictEqual(v.state, 'idle');
    assert.strictEqual(v.fact, '基线 2 例 · 存于 昨天（还没有新结果可比）');
    assert.match(v.next ?? '', /跑一次 bench/u);
  });

  it('对比：只认同名用例 —— 新增/缺失分开报，幅度降序，阈值以内不喊', () => {
    const base = run([['a', 100], ['b', 200], ['gone', 50]]);
    const now = run([['a', 105], ['b', 260], ['fresh', 1]]);
    const cmp = compareToBaseline(base.values, now.values, 20);
    assert.deepStrictEqual(cmp.changed.map((c) => c.name), ['b', 'a'], '按幅度降序（b +30% 在 a +5% 前）');
    assert.deepStrictEqual(cmp.added, ['fresh'], '新增的用例不算回归');
    assert.deepStrictEqual(cmp.missing, ['gone'], '基线里有、这次没跑 → 缺了要说');
    assert.deepStrictEqual(cmp.beyond, ['b'], '超过 20% 的只有 b');
  });

  it('卡片那行：阈值是**设置里的那个数**，且写出来（不藏魔法数字）', () => {
    const base = run([['a', 100], ['b', 100]]);
    const ok = perfFact({ baseline: base, run: run([['a', 103], ['b', 104]]), regressPct: 20 });
    assert.strictEqual(ok.state, 'ok', '都在阈值内 → 不喊（但也不装作没变）');
    assert.match(ok.fact, /2 例变化 · 最大 b \+4%（都在设置的 20% 内）/u);

    const warn = perfFact({ baseline: base, run: run([['a', 103], ['b', 160]]), regressPct: 20 });
    assert.strictEqual(warn.state, 'warn');
    assert.match(warn.fact, /最大 b \+60%（超过设置的 20%）/u);
    assert.match(warn.next ?? '', /原始值/u, '要提醒：原始值变大不一定是坏事（吞吐类正好相反）');

    // 阈值可调：同一份数据在 5% 下就该喊
    const tight = perfFact({ baseline: base, run: run([['a', 103], ['b', 108]]), regressPct: 5 });
    assert.strictEqual(tight.state, 'warn');
    assert.match(tight.fact, /超过设置的 5%/u);
  });

  it('变化很小（<0.05%）不当成"变了"（噪声不打扰）', () => {
    const cmp = compareToBaseline([{ name: 'a', value: 1000 }], [{ name: 'a', value: 1000 }], 20);
    assert.deepStrictEqual(cmp.changed, []);
    assert.strictEqual(perfFact({ baseline: run([['a', 1000]]), run: run([['a', 1000]]), regressPct: 20 }).state, 'ok');
  });

  it('**卡片映射**：三态与下一步真的上到 ③ 测试站的「性能基线」卡', () => {
    const model = singlePageModelFrom(initialCockpitState(), {
      metadata: { name: 'mylib' },
      artifacts: { benchmark: true },
      perf: { baseline: run([['a', 100]]), run: run([['a', 180]]), regressPct: 20 },
    });
    const card = model.cards.find((c) => c.id === 'perfBaseline');
    assert.ok(card, '有 bench 入口时这张卡必须在');
    assert.strictEqual(card?.state, 'warn');
    assert.match(card?.fact ?? '', /最大 a \+80%/u);
    assert.match(card?.next ?? '', /^需要你执行：/u);

    // 没给 perf 事实 → 停在默认（不编造）
    const none = singlePageModelFrom(initialCockpitState(), EMPTY_FACTS).cards.find((c) => c.id === 'perfBaseline');
    assert.strictEqual(none?.fact, '—');
  });

  it('**接线门禁**：阈值来自**设置**（不是写死的数字），且设置真的声明了', () => {
    const ext = readFileSync(join('src', 'extension.ts'), 'utf8');
    assert.ok(ext.includes("get<number>('bench.regressPct'"), '阈值必须从设置里读');
    assert.ok(ext.includes('regressPct: benchRegressPct()'), '事实里必须用读出来的那个值（写死 20 会让设置失效）');
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      contributes: { configuration: { properties: Record<string, unknown> } };
    };
    assert.ok('het.bench.regressPct' in pkg.contributes.configuration.properties, '设置要在清单里声明');
    for (const nls of ['package.nls.json', 'package.nls.zh-cn.json']) {
      const dict = JSON.parse(readFileSync(nls, 'utf8')) as Record<string, string>;
      assert.ok(dict['config.benchRegressPct'], `${nls} 缺该设置的文案（界面上会显示原始 %key%）`);
    }
  });

  it('能力消费登记表：`perf-baseline` 已落地 → 必须从"待消费"名单里删掉', () => {
    // 这张表**只许变短**：留着一个已落地的条目 = 门禁在骗人。
    // L6e（编译期成本）之后**表空** —— 8 条能力全部有卡片消费（这就是"清零"的样子）。
    assert.deepStrictEqual(baremetalCapabilityConsumers(), [], 'L6e 后不该再有挂账');
  });
});
