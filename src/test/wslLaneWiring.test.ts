import * as assert from 'node:assert';
import { chooseDistroForLane, isOurDistroName } from '../core/wslDistro';
import { resolveProviderDecision, type HostCapabilities } from '../core/provisionPlan';

describe('T17c 接线：车道的发行版选择 + 计划层"自建"提议', () => {
  it('发行版选择：只有**双标记确认的**才是我们的；占着我们名字的绝不接管', () => {
    // 用户只有自己的发行版 → 复用第一个（既有语义不变）
    assert.strictEqual(chooseDistroForLane(['Ubuntu-24.04', 'Debian']), 'Ubuntu-24.04');
    // 我们自建的（调用方用双标记算出的 ourDistros）→ 优先（即使排在后面）
    assert.strictEqual(
      chooseDistroForLane(['Ubuntu-24.04', 'het-lane-2404'], { ourDistros: ['het-lane-2404'] }),
      'het-lane-2404',
    );
    assert.strictEqual(chooseDistroForLane(['het-lane-2404-2'], { ourDistros: ['het-lane-2404-2'] }), 'het-lane-2404-2');
    // 2026-09-15 CI 实测（run 34944081639）：夹具放了一个同名但**没有双标记**的
    // `het-lane-2404`，旧实现按名字把它选成车道 → 仪表盘显示它的空状态、车道被装进
    // 它里面（而导入层同一时刻把它当外人）。现在：名字再像也不认，改用别处的发行版；
    // 一个都没有时返回 undefined（调用方据此走"换名自建"）。
    assert.strictEqual(chooseDistroForLane(['Ubuntu-24.04', 'het-lane-2404']), 'Ubuntu-24.04');
    assert.strictEqual(chooseDistroForLane(['het-lane-2404']), undefined);
    assert.strictEqual(chooseDistroForLane(['het-lane-2404', 'het-lane-2404-2']), undefined);
    // 历史托管名（het-fcpp）不属于当前命名空间 → 仍是候选（老版本用户的迁移路径）
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
    linuxVenv: false,
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
      linuxVenv: true,
    });
    assert.strictEqual(linux.setup, undefined);
  });
});
