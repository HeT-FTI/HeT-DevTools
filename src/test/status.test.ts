import * as assert from 'node:assert';
import {
  busyDomainOf,
  chipStatusText,
  pickActiveStatus,
  statusText,
} from '../core/status';

describe('core/status — 仓库级语义状态（§F.35 单一来源）', () => {
  it('进行时文案覆盖所有会被 runWithBusy 包住的显式动作', () => {
    for (const a of ['build', 'clean', 'test', 'envCheck', 'envPrepare', 'envRemove', 'wslImport', 'docsBuild']) {
      const t = statusText(a);
      assert.ok(t && t !== a, `${a} 必须有进行时文案，得到 ${t}`);
    }
    assert.strictEqual(statusText('build'), '构建中');
    assert.strictEqual(statusText('test'), '测试中');
    assert.strictEqual(statusText('docsBuild'), '编译文档');
  });

  it('未知动作退回频道 label，再退回 id（不许显示 undefined）', () => {
    const copilot = statusText('commitCopilot');
    assert.ok(copilot.includes('提交'), copilot);
    assert.strictEqual(statusText('never-heard-of-it'), 'never-heard-of-it');
  });

  it('动作 → 域：只有会影响某张卡的才给出域', () => {
    assert.strictEqual(busyDomainOf('build'), 'build');
    assert.strictEqual(busyDomainOf('clean'), 'build');
    assert.strictEqual(busyDomainOf('test'), 'test');
    assert.strictEqual(busyDomainOf('docsBuild'), 'docs');
    assert.strictEqual(busyDomainOf('envPrepare'), 'env');
    // 上板/质量门禁不影响"构建结果/测试中心"这两格，别乱标进行中
    assert.strictEqual(busyDomainOf('board'), undefined);
    assert.strictEqual(busyDomainOf('quality'), undefined);
    assert.strictEqual(busyDomainOf(null), undefined);
  });

  it('多件事同时在跑 → 取最早开始的那件（先动起来的先被看到）', () => {
    const st = pickActiveStatus([
      { action: 'test', startedAt: 200 },
      { action: 'build', startedAt: 100 },
      { action: 'envCheck', startedAt: 300 },
    ]);
    assert.deepStrictEqual(st, { action: 'build', text: '构建中', startedAt: 100 });
  });

  it('空闲 → null（调用方负责渲染历史结果，而不是把"空闲"渲染成"在跑"）', () => {
    assert.strictEqual(pickActiveStatus([]), null);
  });

  it('chip 文字：忙说"正在做什么"，闲说分数', () => {
    assert.strictEqual(chipStatusText(null, 87), '87');
    assert.strictEqual(chipStatusText(null, null), '·');
    assert.strictEqual(
      chipStatusText({ action: 'build', text: '构建中', startedAt: 1 }, 87),
      '构建中',
    );
  });
});
