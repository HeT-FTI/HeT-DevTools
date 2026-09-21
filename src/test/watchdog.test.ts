import * as assert from 'node:assert';
import { WATCHDOG_EXIT_CODE, WatchdogError, withWatchdog } from '../utils/watchdog';

/**
 * 看门狗自测：**本项目要求测试 0 人工参与**（无人值守 agentic 编码），
 * 所以"可能卡住的任务"必须自己退出。这里锁住三件事：
 * 1. 正常结束 → 原样返回，且计时器被清掉（不会拖住进程退出）；
 * 2. 超时 → 抛 `WatchdogError`（可断言、可分类），并调用 `onTimeout`（脚本用它 `process.exit`）；
 * 3. 超时后不再等待原 promise（无人值守时"卡住"必须变成"失败"）。
 */
describe('watchdog（无人值守：卡住必须变失败）', () => {
  it('正常结束：原样返回结果', async () => {
    const out = await withWatchdog(500, 'fast', async () => 42);
    assert.strictEqual(out, 42);
  });

  it('超时：抛 WatchdogError，且调用 onTimeout 一次', async () => {
    let hits = 0;
    await assert.rejects(
      () =>
        withWatchdog(
          20,
          'slow',
          () => new Promise<never>(() => {}),
          () => {
            hits += 1;
          },
        ),
      (err: unknown) => {
        assert.ok(err instanceof WatchdogError, '必须是 WatchdogError（便于分类）');
        assert.strictEqual((err as WatchdogError).label, 'slow');
        assert.strictEqual((err as WatchdogError).ms, 20);
        assert.match((err as Error).message, /看门狗触发/);
        return true;
      },
    );
    assert.strictEqual(hits, 1, 'onTimeout 只调一次');
  });

  it('失败会原样抛出（看门狗不吞错误）', async () => {
    await assert.rejects(
      () => withWatchdog(500, 'boom', async () => Promise.reject(new Error('inner'))),
      /inner/,
    );
  });

  it('约定的退出码是 97（区分"卡住"与普通失败 1）', () => {
    assert.strictEqual(WATCHDOG_EXIT_CODE, 97);
  });
});
