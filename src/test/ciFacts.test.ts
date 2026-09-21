import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ciFactOf, ciFactsFromRuns, ciStateFromRun } from '../core/ciFacts';
import { EMPTY_FACTS, singlePageModelFrom } from '../features/cockpit/singlepage/modelFrom';
import { initialCockpitState } from '../features/cockpit/state';

/**
 * 块 2d：CI 卡片的事实的门禁。
 *
 * 最要紧的一条是**不许编造**：拉不到最新运行结果时，卡片只能说本地层（有几个 workflow、
 * 什么事件触发），**绝不能**显示"上次绿"。绿/红只在真的拿到运行结果时才出现。
 */
describe('CI 卡片事实（块 2d）', () => {
  const read = (p: string): string => readFileSync(join('src', p), 'utf8');

  it('运行结果 → 三态：认得出才算，认不出返回 undefined（不猜）', () => {
    assert.strictEqual(ciStateFromRun('completed', 'success'), 'ok');
    assert.strictEqual(ciStateFromRun('completed', 'skipped'), 'ok', '跳过/中性不是失败');
    assert.strictEqual(ciStateFromRun('completed', 'neutral'), 'ok');
    for (const c of ['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale']) {
      assert.strictEqual(ciStateFromRun('completed', c), 'fail', `${c} 要算失败`);
    }
    for (const s of ['in_progress', 'queued', 'requested', 'waiting', 'pending']) {
      assert.strictEqual(ciStateFromRun(s, ''), 'running', `${s} 要算在跑`);
    }
    assert.strictEqual(ciStateFromRun('completed', 'something_new'), undefined, '认不出就别猜');
    assert.strictEqual(ciStateFromRun(undefined, undefined), undefined);
    assert.strictEqual(ciStateFromRun('weird_status', 'success'), undefined);
  });

  it('从运行列表取最近一次：字段映射齐，且**不许**把认不出的状态当成功', () => {
    const runs = [
      { name: 'ci', branch: 'main', status: 'completed', conclusion: 'success', createdAt: '2026-09-18T02:00:00Z', url: 'https://x/1' },
      { name: 'old', branch: 'dev', status: 'completed', conclusion: 'failure', createdAt: '2026-09-17T02:00:00Z', url: 'https://x/2' },
    ];
    const f = ciFactsFromRuns(runs, { workflows: 3, triggers: ['push', 'pull_request'] });
    assert.strictEqual(f.lastRun, 'ok');
    assert.strictEqual(f.branch, 'main');
    assert.strictEqual(f.workflow, 'ci');
    assert.strictEqual(f.url, 'https://x/1');
    assert.strictEqual(f.createdAt, '2026-09-18T02:00:00Z');
    assert.strictEqual(f.workflows, 3);
    assert.deepStrictEqual(f.triggers, ['push', 'pull_request']);

    const unknown = ciFactsFromRuns([{ name: 'x', branch: 'main', status: 'brand_new', conclusion: 'unknown', createdAt: 'now' }]);
    assert.strictEqual(unknown.lastRun, undefined, '认不出 → 没有三态');
    assert.strictEqual(unknown.branch, 'main', '但分支/时间照给');

    const empty = ciFactsFromRuns([], { workflows: 2 });
    assert.strictEqual(empty.lastRun, undefined);
    assert.strictEqual(empty.workflows, 2);
  });

  it('一行文案：在线三态 > 本地层；失败给日志入口，在跑就别重复触发', () => {
    const ok = ciFactOf({ lastRun: 'ok', branch: 'main', atText: '3 小时前' });
    assert.strictEqual(ok.state, 'ok');
    assert.strictEqual(ok.fact, '上次 ✓ main · 3 小时前');
    assert.strictEqual(ok.next, undefined, '绿了就别再让人动手');

    const fail = ciFactOf({ lastRun: 'fail', branch: 'main', url: 'https://x/9' });
    assert.strictEqual(fail.state, 'fail');
    assert.ok(fail.next?.startsWith('需要你执行：'));
    assert.ok(fail.next?.includes('https://x/9'), '失败要带得上日志入口');

    const running = ciFactOf({ lastRun: 'running', workflow: 'ci' });
    assert.strictEqual(running.state, 'running');
    assert.ok(running.next?.includes('正在跑'), running.next);

    const local = ciFactOf({ workflows: 3, triggers: ['push', 'pull_request'] });
    assert.strictEqual(local.state, 'idle');
    assert.strictEqual(local.fact, '3 个 workflow · push/pull_request');
    assert.ok(!local.fact.includes('✓'), '**不许**在没拿到运行结果时说绿');
    assert.ok(!local.fact.includes('✗'));
    assert.ok(local.next?.includes('打开 CI'), '要说清怎么把在线层拿回来');

    const nothing = ciFactOf({});
    assert.strictEqual(nothing.fact, '—');
    assert.strictEqual(nothing.state, 'idle');
  });

  it('卡片映射：三态进 state、本地层不显示绿红、下一步真的显示', () => {
    const failFact = ciFactOf({ lastRun: 'fail', branch: 'main', url: 'https://x/9' });
    const fail = singlePageModelFrom(initialCockpitState(), {
      ci: { lastRun: 'fail', fact: failFact.fact, next: failFact.next },
    }).cards.find((c) => c.id === 'ci')!;
    assert.strictEqual(fail.state, 'fail');
    assert.ok(fail.fact.includes('✗'));
    assert.ok(fail.next?.startsWith('需要你执行：'));

    const localFact = ciFactOf({ workflows: 2, triggers: ['push'] });
    const local = singlePageModelFrom(initialCockpitState(), {
      ci: { fact: localFact.fact, next: localFact.next },
    }).cards.find((c) => c.id === 'ci')!;
    assert.strictEqual(local.state, 'idle', '只有本地层就是 idle（不是 ok）');
    assert.ok(!local.fact.includes('✓'));

    const running = singlePageModelFrom(initialCockpitState(), { ci: { lastRun: 'running', fact: '上次 ⟳ main' } }).cards.find((c) => c.id === 'ci')!;
    assert.strictEqual(running.state, 'running');

    // 没事实时仍然是 `—`（不编造）
    assert.strictEqual(singlePageModelFrom(initialCockpitState(), EMPTY_FACTS).cards.find((c) => c.id === 'ci')!.fact, '—');
  });

  it('接线：本地层随时有、在线层只从缓存来（刷新不打网络）', () => {
    const ext = read(join('extension.ts'));
    assert.ok(ext.includes('ciFactsFromRuns('), '在线层要用事实模块组装');
    assert.ok(ext.includes('ciFactOf('), '卡片文案要用事实模块');
    assert.ok(ext.includes("'het.ci.lastRun'"), '在线层要落缓存（刷新时不再打网络）');
    assert.ok(ext.includes('async function ciState('), 'CI 面板的取值器也要提成模块函数（卡片与面板同一份）');
    const mod = read(join('core', 'ciFacts.ts'));
    assert.ok(!/from 'vscode'/.test(mod), 'ciFacts 必须是纯模块');
    assert.ok(mod.includes('拿不到就不编'), '把"不编造"写在模块头（纪律可见）');
  });
});
