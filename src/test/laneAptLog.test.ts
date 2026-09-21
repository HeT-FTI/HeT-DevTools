import * as assert from 'node:assert';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { APT_LOG_FILE, aptUninstallHint, readAptLog, recordAptInstall } from '../core/laneAptLog';

/**
 * ADR-8：车道为**系统包**动的 root apt 要如实记账，移除时只提示、不自动卸载。
 * 台账的失败模式必须全部是"安全方向"：读不出 = 没有记录，写不进 = 不影响准备。
 */
describe('laneAptLog（ADR-8 台账）', () => {
  const root = join(tmpdir(), 'het-laneaptlog-test');

  function fresh(): string {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    return root;
  }

  it('没有台账 → 空清单（不是错误）', () => {
    const lane = fresh();
    assert.deepStrictEqual(readAptLog(lane), []);
    assert.strictEqual(aptUninstallHint([]), '', '空清单不该产出提示');
  });

  it('记账幂等：只报新增，且包名去重排序', () => {
    const lane = fresh();
    assert.deepStrictEqual(recordAptInstall(lane, ['lcov', 'make']), ['lcov', 'make']);
    assert.deepStrictEqual(readAptLog(lane), ['lcov', 'make'], '按名排序读出');
    assert.deepStrictEqual(recordAptInstall(lane, ['make', 'python3-venv']), ['python3-venv'], '已有包不重复计新增');
    assert.deepStrictEqual(readAptLog(lane), ['lcov', 'make', 'python3-venv']);
    assert.deepStrictEqual(recordAptInstall(lane, ['lcov']), [], '全是旧的 → 无新增');
    assert.ok(existsSync(join(lane, APT_LOG_FILE)), '台账写在车道 home 内（随车道一起删除）');
    assert.deepStrictEqual(recordAptInstall(lane, ['', '  ']), [], '空包名忽略');
  });

  it('台账损坏/不是 JSON → 当作没有记录（移除流程不能因此失败）', () => {
    const lane = fresh();
    writeFileSync(join(lane, APT_LOG_FILE), '{ not json', 'utf8');
    assert.deepStrictEqual(readAptLog(lane), []);
    assert.deepStrictEqual(recordAptInstall(lane, ['make']), ['make'], '损坏后重记不抛错');
    assert.deepStrictEqual(readAptLog(lane), ['make']);
  });

  it('写不进（路径被文件占位）→ 静默降级，不打断环境准备', () => {
    const lane = fresh();
    writeFileSync(join(lane, 'blocked'), 'x', 'utf8');
    assert.deepStrictEqual(recordAptInstall(join(lane, 'blocked'), ['make']), []);
  });

  it('卸载提示：给命令但绝不自动执行；包名进命令', () => {
    const hint = aptUninstallHint(['lcov', 'make']);
    assert.ok(hint.includes('sudo apt-get remove --auto-remove lcov make'), '给出可复制的卸载命令');
    assert.ok(hint.includes('不会'), '明确说明不会自动卸载');
  });
});
