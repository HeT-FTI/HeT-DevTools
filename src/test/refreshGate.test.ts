import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IDLE_GATE, beginRefresh, endRefresh, type RefreshGate } from '../core/refreshGate';

/**
 * G18 的前置件：单页的事实刷新必须**不并发、不丢最新**。
 *
 * 为什么值得单测：这个闸门管的是"动作刚跑完时正好在刷"这种时序 —— 写错了不会报错，
 * 只会让用户看到旧数字（最难排查的一类 bug）。所以把语义写成纯函数 + 把时序都摆出来。
 */
describe('刷新闸门（G18）', () => {
  it('空闲时请求 → 立刻开跑', () => {
    const g = beginRefresh(IDLE_GATE);
    assert.strictEqual(g.start, true);
    assert.deepStrictEqual(g.next, { inFlight: true, queued: false });
  });

  it('刷的时候再来请求 → 不开第二遍，但记下来', () => {
    const first = beginRefresh(IDLE_GATE).next;
    const second = beginRefresh(first);
    assert.strictEqual(second.start, false, '不能并发取数');
    assert.deepStrictEqual(second.next, { inFlight: true, queued: true }, '但要记住"有人等"');
    // 记重了也只补一轮（不是补 N 轮）
    const third = beginRefresh(second.next);
    assert.strictEqual(third.start, false);
    assert.deepStrictEqual(third.next, { inFlight: true, queued: true });
  });

  it('有等待者 → 跑完补一轮；没有 → 回到空闲', () => {
    const queued = endRefresh({ inFlight: true, queued: true });
    assert.strictEqual(queued.rerun, true);
    assert.deepStrictEqual(queued.next, { inFlight: true, queued: false }, '补的这一轮自己又占着闸门');
    const done = endRefresh(queued.next);
    assert.strictEqual(done.rerun, false);
    assert.deepStrictEqual(done.next, IDLE_GATE);
  });

  it('时序演练：请求(进行中) → 连来 3 次 → 最终恰好再跑 1 轮', () => {
    let gate: RefreshGate = IDLE_GATE;
    let runs = 0;
    const request = (): void => {
      const b = beginRefresh(gate);
      gate = b.next;
      if (b.start) {
        runs += 1; // 模拟"开跑"
      }
    };
    request(); // 第 1 轮
    assert.strictEqual(runs, 1);
    request(); // 等
    request(); // 再等（合并）
    request(); // 还在等
    assert.strictEqual(runs, 1, '并发期间不许加跑');
    // 第 1 轮结束 → 补第 2 轮
    const e1 = endRefresh(gate);
    gate = e1.next;
    if (e1.rerun) {
      runs += 1;
    }
    assert.strictEqual(runs, 2, '恰好补一轮');
    const e2 = endRefresh(gate);
    gate = e2.next;
    assert.strictEqual(e2.rerun, false);
    assert.deepStrictEqual(gate, IDLE_GATE, '收尾干净');
  });

  it('接线：单页自己触发事实刷新（不再依赖旧概览适配器被调用）', () => {
    const ctl = readFileSync(join('src', 'features', 'cockpit', 'controller.ts'), 'utf8');
    assert.ok(ctl.includes('export function setFactsCollector('), '要能注册 host 的事实收集器');
    assert.ok(ctl.includes('export function requestFacts('), '要能请求刷新（懒加载入口调它）');
    assert.ok(ctl.includes('beginRefresh(refreshGate)') && ctl.includes('endRefresh(refreshGate)'), '要用闸门');
    assert.ok(
      ctl.includes("openedSections.add('env');") && /openedSections\.add\('env'\);[\s\S]{0,200}requestFacts\(\)/.test(ctl),
      '打开面板时就要取事实',
    );
    assert.ok(
      /message\.type === 'section:open'[\s\S]{0,160}requestFacts\(\)/.test(ctl),
      '展开某段时要取事实',
    );
    assert.ok(
      /executeCommand\(cmd\)\.then\([\s\S]{0,120}requestFacts\(\)/.test(ctl),
      '动作跑完要刷新（成功、失败都要）',
    );
    assert.ok(
      /event\.type === 'log:done'[\s\S]{0,400}requestFacts\(\)/.test(ctl),
      'host 事件（构建/测试/体检）也要刷新 —— 数字要跟得上刚发生的事',
    );

    const ext = readFileSync(join('src', 'extension.ts'), 'utf8');
    assert.ok(ext.includes('setFactsCollector(async () => {'), '收集器要注册给单页');
    assert.ok(ext.includes('feedSinglePageFacts({'), '收集器要真的喂事实');
    assert.ok(ext.includes('void feedExtraSinglePageFacts();'), '额外事实也要一起刷');
    assert.ok(!ext.includes('isSinglePageMode'), '旧 UI 已归档，不再有模式判断');
  });
});
