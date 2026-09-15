import * as assert from 'node:assert';
import { chooseDistroForLane, isOurDistroName } from '../core/wslDistro';
import { resolveProviderDecision, type HostCapabilities } from '../core/provisionPlan';

describe('T17c 接线：车道的发行版选择 + 计划层"自建"提议', () => {
  it('发行版选择：我们自建的优先，其次旧托管名，最后才轮到用户的', () => {
    // 用户只有自己的发行版 → 复用第一个（既有语义不变）
    assert.strictEqual(chooseDistroForLane(['Ubuntu-24.04', 'Debian']), 'Ubuntu-24.04');
    // 我们自建的 → 优先（即使排在后面）
    assert.strictEqual(chooseDistroForLane(['Ubuntu-24.04', 'het-lane-2404']), 'het-lane-2404');
    assert.strictEqual(chooseDistroForLane(['het-lane-2404-2']), 'het-lane-2404-2');
    // 历史托管名在"没有自建"时仍被认
    assert.strictEqual(chooseDistroForLane(['Ubuntu-24.04', 'het-fcpp']), 'het-fcpp');
    // 空列表 → undefined（调用方据此判"无发行版"）
    assert.strictEqual(chooseDistroForLane([]), undefined);
    assert.ok(isOurDistroName('het-lane-2604'));
  });

  const winPending: HostCapabilities = {
    platform: 'win32',
    arch: 'x64',
    wslAvailable: true,
    wslDefaultReady: false,
    virtualizationEnabled: true,
    isAdmin: false,
    msvcAvailable: false,
    linuxApt: false,
    linuxAptSudo: false,
  };

  it('win-wsl2-pending：计划里带"自建发行版"的提议（含代价），不再让用户自己装', () => {
    const d = resolveProviderDecision(winPending);
    assert.strictEqual(d.provider, 'win-wsl2-pending', 'provider 语义不变（CI 断言依赖它）');
    assert.strictEqual(d.setup?.kind, 'wsl-import');
    assert.strictEqual(d.setup?.distro, 'het-lane-2404');
    assert.match(d.setup!.costText, /约 340MB/u);
    assert.match(d.note, /一键自建私有发行版/u);
    assert.match(d.note, /不会改动你已有的发行版/u);
    assert.match(d.note, /wsl --install -d Ubuntu-24\.04/u, 'A 路线仍作为替代保留');
    assert.match(d.note, /toolchain=system/u, 'C 路线仍在');
  });

  it('其余平台不带自建提议（不引入新的隐式行为）', () => {
    const linux = resolveProviderDecision({
      platform: 'linux',
      arch: 'x64',
      wslAvailable: false,
      wslDefaultReady: false,
      virtualizationEnabled: true,
      isAdmin: false,
      msvcAvailable: false,
      linuxApt: true,
      linuxAptSudo: true,
    });
    assert.strictEqual(linux.setup, undefined);
  });
});
