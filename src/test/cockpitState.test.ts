/**
 * cockpit reducer 的契约（G18 裁剪后）。
 *
 * 旧版测试（含 `page` / `navigate` / 向导切片）已归档：
 * `_archive/src/test/cockpitState.test.ts`。这里只测**现役**契约：
 * L1 四个数字（项目名 / 健康分 / 忙点 / 模板落后）+ 抽屉 + 构建结果 + 问题计数。
 *
 * 这些断言的意义：单页 UI 是唯一 UI 之后，L1 上的每个数字都只有这一个来源，
 * reducer 一旦丢了某个事件，界面上就是"永远停在 —"。
 */
import * as assert from 'node:assert';
import { initialCockpitState, reduceCockpit, type CockpitState } from '../features/cockpit/state';

const s0 = initialCockpitState();

describe('cockpit.state（单页时代）', () => {
  it('初始状态：没有编造的数字（健康分 null、忙点 null、项目名为空）', () => {
    assert.strictEqual(s0.top.projectName, '');
    assert.strictEqual(s0.top.health, null, '健康分没测出来就该是 null → 界面显示 —');
    assert.strictEqual(s0.top.running, null, '没在忙就别显示忙点');
    assert.strictEqual(s0.top.templateBehind, 0);
    assert.strictEqual(s0.lastBuildOk, null, '还没构建过 ≠ 构建失败');
    assert.strictEqual(s0.issueCount, 0);
    assert.deepStrictEqual(s0.drawer, { kind: 'none', expanded: false, title: '', lines: [] });
  });

  it('project 事件填 L1 项目名', () => {
    const s = reduceCockpit(s0, { type: 'project', name: 'fcpp' });
    assert.strictEqual(s.top.projectName, 'fcpp');
  });

  it('health 事件填健康分（不要动别的字段）', () => {
    const s = reduceCockpit(s0, { type: 'health', score: 87 });
    assert.strictEqual(s.top.health, 87);
    assert.strictEqual(s.top.projectName, s0.top.projectName);
    assert.strictEqual(s.drawer.expanded, s0.drawer.expanded);
  });

  it('template:update 只改"落后多少"（0 = 不落后）', () => {
    assert.strictEqual(reduceCockpit(s0, { type: 'template:update', behind: 3 }).top.templateBehind, 3);
    const behind = reduceCockpit(s0, { type: 'template:update', behind: 3 });
    assert.strictEqual(reduceCockpit(behind, { type: 'template:update', behind: 0 }).top.templateBehind, 0);
  });

  it('drawer:toggle 只动 expanded，不丢抽屉里已有的内容', () => {
    const open = reduceCockpit(s0, { type: 'log:start', title: '构建' });
    const withLine = reduceCockpit(open, { type: 'log:append', line: 'a' });
    const collapsed = reduceCockpit(withLine, { type: 'drawer:toggle', expand: false });
    assert.strictEqual(collapsed.drawer.expanded, false);
    assert.deepStrictEqual(collapsed.drawer.lines, ['a'], '折叠不是清空');
    assert.strictEqual(reduceCockpit(collapsed, { type: 'drawer:toggle', expand: true }).drawer.expanded, true);
  });

  it('log:start 打开抽屉并记下忙点；log:done 清掉忙点但**不自动收起**（尾部要留给人看）', () => {
    const started = reduceCockpit(s0, { type: 'log:start', title: '构建并测试' });
    assert.strictEqual(started.top.running, '构建并测试');
    assert.strictEqual(started.drawer.kind, 'log');
    assert.strictEqual(started.drawer.expanded, true);

    const done = reduceCockpit(started, { type: 'log:done', ok: true });
    assert.strictEqual(done.top.running, null);
    assert.strictEqual(done.drawer.expanded, true);
    assert.strictEqual(done.lastBuildOk, true);
    assert.strictEqual(reduceCockpit(started, { type: 'log:done', ok: false }).lastBuildOk, false);
  });

  it('log:append 累积到 200 行上限（只留尾部，内存不会随长构建无限涨）', () => {
    let s = reduceCockpit(s0, { type: 'log:start', title: 'x' });
    for (let i = 0; i < 250; i++) {
      s = reduceCockpit(s, { type: 'log:append', line: `L${i}` });
    }
    assert.strictEqual(s.drawer.lines.length, 200);
    assert.strictEqual(s.drawer.lines[0], 'L50', '砍掉的是最老的，不是最新的');
    assert.strictEqual(s.drawer.lines[199], 'L249');
  });

  it('log:append 在非 log 抽屉里被忽略（不许把日志串到"问题"抽屉里）', () => {
    const issues = reduceCockpit(s0, { type: 'issue:summary', count: 2 });
    assert.strictEqual(issues.drawer.kind, 'issues');
    assert.strictEqual(reduceCockpit(issues, { type: 'log:append', line: 'x' }), issues, '同一引用 = 没动');
  });

  it('issue:summary 有错就开抽屉；同一抽屉里减到 0 就收起（不用手点）', () => {
    const two = reduceCockpit(s0, { type: 'issue:summary', count: 2 });
    assert.strictEqual(two.issueCount, 2);
    assert.strictEqual(two.drawer.kind, 'issues');
    assert.strictEqual(two.drawer.expanded, true);

    const zero = reduceCockpit(reduceCockpit(two, { type: 'issue:summary', count: 1 }), {
      type: 'issue:summary',
      count: 0,
    });
    assert.strictEqual(zero.issueCount, 0);
    assert.strictEqual(zero.drawer.expanded, false, '问题没了就不该继续占着屏幕');
  });

  it('issue:summary 为 0 且当前是日志抽屉时：不动日志抽屉（别抢用户的输出通道）', () => {
    const log = reduceCockpit(s0, { type: 'log:start', title: '构建' });
    const cleared = reduceCockpit(log, { type: 'issue:summary', count: 0 });
    assert.strictEqual(cleared.issueCount, 0);
    assert.strictEqual(cleared.drawer.kind, 'log');
    assert.strictEqual(cleared.drawer.expanded, true);
  });

  it('reducer 是纯函数：不就地改传入的 state', () => {
    const before = JSON.stringify(s0);
    reduceCockpit(s0, { type: 'log:start', title: 'x' });
    reduceCockpit(s0, { type: 'project', name: 'y' });
    assert.strictEqual(JSON.stringify(s0), before, '入参被改了 → 并发刷新时会丢更新');
    const frozen: CockpitState = Object.freeze({ ...s0, top: Object.freeze({ ...s0.top }) }) as CockpitState;
    assert.doesNotThrow(() => reduceCockpit(frozen, { type: 'health', score: 1 }));
  });
});
