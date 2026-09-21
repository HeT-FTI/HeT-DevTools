import * as assert from 'node:assert';
import {
  HostCapabilities,
  ProviderDecision,
  MIN_FREE_MB,
  parseFakeHost,
  providerLabel,
  resolveProviderDecision,
  TOOLCHAIN_MANIFEST,
} from '../core/provisionPlan';

function caps(over: Partial<HostCapabilities>): HostCapabilities {
  return {
    platform: 'linux',
    arch: 'x64',
    wslAvailable: false,
    wslDefaultReady: false,
    virtualizationEnabled: false,
    isAdmin: false,
    msvcAvailable: false,
    linuxApt: false,
    linuxAptSudo: false,
    linuxVenv: false,
    ...over,
  };
}

describe('V4-1 provisionPlan', () => {
  it('manifest pins canonical versions', () => {
    assert.strictEqual(typeof TOOLCHAIN_MANIFEST.gcc, 'string');
    assert.ok(TOOLCHAIN_MANIFEST.gcc.length > 0);
    assert.ok(TOOLCHAIN_MANIFEST.conan.startsWith('2'));
    assert.ok(TOOLCHAIN_MANIFEST.python.startsWith('3.1'));
  });

  it('linux → linux-native with full coverage', () => {
    const d = resolveProviderDecision(caps({ platform: 'linux' }));
    assert.strictEqual(d.provider, 'linux-native');
    assert.strictEqual(d.coverage, 'full');
    assert.ok(providerLabel('linux-native').includes('Linux'));
  });

  it('linux + apt + python3 → linux-managed (derived-first, isolated)', () => {
    const d = resolveProviderDecision(caps({ platform: 'linux', linuxApt: true, linuxVenv: true, linuxAptSudo: true }));
    assert.strictEqual(d.provider, 'linux-managed');
    assert.strictEqual(d.coverage, 'full');
    assert.ok(d.reason.includes('派生'), 'reason names derived-first');
    assert.ok(d.note.includes('managed-env'), 'note names the isolated lane path');
    assert.ok(providerLabel('linux-managed').includes('派生'), 'label shows derived managed');
    assert.ok(providerLabel('linux-managed').includes('隔离'), 'label shows isolation');
  });

  it('ADR-8: linux + apt + python3，但无免密 root → 仍是 linux-managed（root 只影响自愈）', () => {
    const d = resolveProviderDecision(caps({ platform: 'linux', linuxApt: true, linuxVenv: true, linuxAptSudo: false }));
    assert.strictEqual(d.provider, 'linux-managed', '车道本体是用户级的，不该因 sudo 要密码而放弃隔离');
    assert.strictEqual(d.coverage, 'full');
    assert.strictEqual(d.selfHeal?.ok, false, '如实标注自愈不可用');
    assert.ok(d.selfHeal?.reason?.includes('免密 root'), 'reason 说明为什么不能自动装包');
    assert.ok(d.note.includes('免密 root'), 'note 也把原因带给卡片/契约');
    assert.ok(!d.note.includes('MinGW'), 'no degradation channel wording');

    const full = resolveProviderDecision(caps({ platform: 'linux', linuxApt: true, linuxVenv: true, linuxAptSudo: true }));
    assert.strictEqual(full.selfHeal?.ok, true);
    assert.strictEqual(full.selfHeal?.reason, undefined, '能自愈就不该有负面原因');
  });

  it('ADR-8: linux 缺 python3 → linux-native（建不出用户级车道）', () => {
    const d = resolveProviderDecision(caps({ platform: 'linux', linuxApt: true, linuxVenv: false, linuxAptSudo: true }));
    assert.strictEqual(d.provider, 'linux-native');
    assert.ok(d.note.includes('python3'), 'note 说明缺的是 python3');
  });

  it('ADR-8 偏好：het.env.mode=native 显式回本机；managed 不因无 root 而漂移', () => {
    const capsBoth = caps({ platform: 'linux', linuxApt: true, linuxVenv: true, linuxAptSudo: true });
    assert.strictEqual(resolveProviderDecision(capsBoth, { mode: 'native' }).provider, 'linux-native');
    assert.strictEqual(resolveProviderDecision(capsBoth, { mode: 'managed' }).provider, 'linux-managed');
    assert.strictEqual(resolveProviderDecision(capsBoth, { mode: 'auto' }).provider, 'linux-managed', 'auto 倾向隔离');

    // native 偏好不能把"建不出车道"变成 managed；managed 偏好也不能凭空造出车道
    const noVenv = caps({ platform: 'linux', linuxApt: true, linuxVenv: false });
    assert.strictEqual(resolveProviderDecision(noVenv, { mode: 'managed' }).provider, 'linux-native');
    assert.strictEqual(resolveProviderDecision(noVenv, { mode: 'native' }).provider, 'linux-native');
  });

  it('ADR-8：Windows 判定不读 linuxApt/linuxVenv（跨平台不串味）', () => {
    const win = caps({ platform: 'win32', wslAvailable: true, wslDefaultReady: true, linuxApt: true, linuxVenv: true });
    assert.strictEqual(resolveProviderDecision(win).provider, 'win-wsl2');
    const winNoApt = caps({ platform: 'win32', wslAvailable: true, wslDefaultReady: true, linuxApt: false, linuxVenv: false });
    assert.strictEqual(resolveProviderDecision(winNoApt).provider, 'win-wsl2', 'Linux 能力字段不该影响 Windows');
    const winPref = caps({ platform: 'win32', wslAvailable: true, wslDefaultReady: true });
    assert.strictEqual(resolveProviderDecision(winPref, { mode: 'managed' }).provider, 'win-wsl2');
    assert.strictEqual(resolveProviderDecision(winPref, { mode: 'native' }).provider, 'win-wsl2', 'Linux 偏好不该改 Windows 判定');
  });

  it('linux + no apt → linux-native (managed lane needs Debian/Ubuntu apt)', () => {
    const d = resolveProviderDecision(caps({ platform: 'linux', linuxApt: false }));
    assert.strictEqual(d.provider, 'linux-native');
    assert.ok(d.note.includes('apt'), 'note explains the apt requirement');
  });

  it('darwin → macos-native, coverage none (Apple clang has no GNU gcov/lcov)', () => {
    const d = resolveProviderDecision(caps({ platform: 'darwin' }));
    assert.strictEqual(d.provider, 'macos-native');
    assert.strictEqual(d.coverage, 'none');
    assert.ok(d.note.includes('Linux/WSL'), 'note points coverage to Linux/WSL lane');
  });

  it('win32 + wsl ready → win-wsl2 (Linux-identical, full)', () => {
    const d = resolveProviderDecision(caps({ platform: 'win32', wslAvailable: true, wslDefaultReady: true, virtualizationEnabled: true }));
    assert.strictEqual(d.provider, 'win-wsl2');
    assert.strictEqual(d.coverage, 'full');
  });

  it('win32 + wsl present but no ready distro → win-wsl2-pending (guide, never silent mingw)', () => {
    const d = resolveProviderDecision(caps({ platform: 'win32', wslAvailable: true, wslDefaultReady: false }));
    assert.strictEqual(d.provider, 'win-wsl2-pending');
    assert.strictEqual(d.coverage, 'partial');
    assert.ok(d.note.includes('wsl --install'), 'note must guide creating the distro');
    assert.ok(d.note.includes('toolchain=system'), 'note must mention explicit system-compat opt-in');
    assert.ok(!d.note.includes('MinGW'), 'no silent MinGW degradation when WSL exists');
  });

  it('win32 + no wsl → win-wsl-required (explicit guidance, never auto-msvc)', () => {
    const plain = resolveProviderDecision(caps({ platform: 'win32' }));
    assert.strictEqual(plain.provider, 'win-wsl-required');
    assert.strictEqual(plain.coverage, 'none');
    assert.ok(plain.note.includes('wsl --install'), 'guide to enable WSL');
    // MSVC present must NOT switch provider — only an explicit override does.
    const withMsvc = resolveProviderDecision(caps({ platform: 'win32', msvcAvailable: true }));
    assert.strictEqual(withMsvc.provider, 'win-wsl-required');
    assert.ok(withMsvc.note.includes('MSVC'), 'note should mention the explicit compat mode');
    assert.ok(!withMsvc.note.includes('MinGW'), 'no MinGW degradation wording remains');
  });

  it('unsupported platform reported honestly', () => {
    const d = resolveProviderDecision(caps({ platform: 'freebsd' }));
    assert.strictEqual(d.provider, 'unsupported');
    assert.strictEqual(d.coverage, 'none');
  });

  it('low disk adds a provisioning warning note', () => {
    const low = resolveProviderDecision(caps({ platform: 'linux', diskFreeBytes: (MIN_FREE_MB - 1) * 1024 * 1024 }));
    assert.ok(low.note.includes('磁盘'), 'low-disk note expected');
    const ok = resolveProviderDecision(caps({ platform: 'linux', diskFreeBytes: MIN_FREE_MB * 1024 * 1024 }));
    assert.ok(!ok.note.includes('磁盘'), 'enough disk → no warning');
  });

  it('parseFakeHost accepts booleans/platform and ignores junk', () => {
    const f = parseFakeHost('{"platform":"win32","wslAvailable":true,"wslDefaultReady":true,"diskFreeBytes":1,"isAdmin":true,"junk":1}');
    assert.strictEqual(f.platform, 'win32');
    assert.strictEqual(f.wslAvailable, true);
    assert.strictEqual(f.diskFreeBytes, 1);
    assert.strictEqual((f as Record<string, unknown>).junk, undefined);
    assert.deepStrictEqual(parseFakeHost('not json'), {});
    assert.deepStrictEqual(parseFakeHost(''), {});
    assert.deepStrictEqual(parseFakeHost(undefined), {});
  });

  it('fake host drives the full matrix (win-noWSL / win-WSL2 / linux / linux-managed / macos)', () => {
    const mk = (json: string): ProviderDecision => resolveProviderDecision({
      ...caps({}),
      ...parseFakeHost(json),
    } as HostCapabilities);
    assert.strictEqual(mk('{"platform":"win32"}').provider, 'win-wsl-required');
    assert.strictEqual(mk('{"platform":"win32","wslAvailable":true,"wslDefaultReady":true}').provider, 'win-wsl2');
    assert.strictEqual(mk('{"platform":"linux"}').provider, 'linux-native');
    // ADR-8：车道判定看"能不能建用户级车道"（apt + python3），不看 sudo 时间戳；
    // 无免密 root 只把自愈能力标成不可用。
    assert.strictEqual(
      mk('{"platform":"linux","linuxApt":true,"linuxVenv":true,"linuxAptSudo":true}').provider,
      'linux-managed',
    );
    const noSudo = mk('{"platform":"linux","linuxApt":true,"linuxVenv":true,"linuxAptSudo":false}');
    assert.strictEqual(noSudo.provider, 'linux-managed', '常规 sudo 要密码的机器也能拿到隔离车道');
    assert.strictEqual(noSudo.selfHeal?.ok, false);
    assert.strictEqual(mk('{"platform":"linux","linuxApt":true,"linuxAptSudo":true}').provider, 'linux-native', '缺 python3 → 建不出用户级车道');
    assert.strictEqual(mk('{"platform":"darwin"}').provider, 'macos-native');
  });
});
