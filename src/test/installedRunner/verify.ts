/**
 * Zero-manual verification of the INSTALLED het-devtools vsix (GUI v3).
 *
 * Runs inside a downloaded, isolated VS Code whose extensions dir contains the
 * packaged vsix. No dialogs, no manual clicking. Each key step pauses ~1 s
 * (HET_VERIFY_HOLD_MS) so a human watching the window can follow along.
 *
 * Phase "empty": no project → chip must be HIDDEN (monitoring-only, V3-1);
 *   Explorer right-click channel `het.newProjectHere` creates a project in a
 *   folder with ZERO dialogs (auto-openFolder skipped inside the test host).
 * Phase "proj":  project workspace → chip (het.chipOverview, icon tooltip,
 *   no new-project link); dashboard deps section focus.
 * Phase "scrub": plain PowerShell PATH (no conda) → conan env sniffed,
 *   python not a false negative, gtest conan-managed, real `conan create`.
 */
import * as assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';

import { EXTENSION_ID as HET } from '../hostExtension';
const phase = process.env.HET_VERIFY_PHASE ?? 'empty';
const PROJ = process.env.HET_VERIFY_DEST ?? '';

/** Pause so a human watching the window can follow (~1 s). */
async function hold(): Promise<void> {
  const ms = Number(process.env.HET_VERIFY_HOLD_MS ?? 1000);
  if (ms > 0) {
    await new Promise((r) => setTimeout(r, ms));
  }
}

// Heartbeat watchdog: if the host makes no progress for `watchdogMs` the run
// is stuck (a stray notification/focus trap/etc.) — force-exit so the outer
// harness can retry instead of leaving a window open forever.
let lastBeat = Date.now();
function beat(): void {
  lastBeat = Date.now();
}
function log(m: string): void {
  console.log(m);
  beat();
}
const watchdogMs = Number(process.env.HET_VERIFY_WATCHDOG_MS ?? 60_000);
// A real `conan create` in the scrub phase legitimately takes minutes; widen
// the kill threshold while a build is in flight.
let longOpUntil = 0;
setInterval(() => {
  const now = Date.now();
  const limit = now < longOpUntil ? 10 * 60_000 : watchdogMs;
  if (now - lastBeat > limit) {
    console.error(`[verify-installed] WATCHDOG: no progress for ${Math.round(limit / 1000)}s — force exiting host`);
    process.exit(1);
  }
}, 5000).unref();

interface RowShape {
  key: string;
  source: string;
  managed?: boolean;
  exe?: string;
}

export async function run(): Promise<void> {
  log(`[verify-installed] phase=${phase}`);
  const ext = vscode.extensions.getExtension(HET);
  assert.ok(ext, 'installed het-devtools must be discovered');
  log('[verify-installed] activating installed het extension…');
  await ext.activate();
  log('[verify-installed] installed extension activated');
  await new Promise((r) => setTimeout(r, 400));

  if (phase === 'empty') {
    assert.ok(PROJ.length > 0, 'HET_VERIFY_DEST required');
    // V3-1: monitoring chip must be invisible without a project.
    const chip = (await vscode.commands.executeCommand('het.getChipState')) as unknown;
    assert.strictEqual(chip, null, 'chip must be hidden when no fcpp project is open');
    log('[verify-installed] empty-phase: chip hidden (monitoring only)');
    await hold();

    // V3-1/V3-2: Explorer right-click channel → zero-dialog init in the folder.
    await vscode.commands.executeCommand('het.newProjectHere', PROJ);
    await hold();
    const meta = JSON.parse(readFileSync(join(PROJ, 'metadata.json'), 'utf8')) as Record<string, unknown>;
    assert.strictEqual(meta.name, 'verify_proj', 'folder basename should become the project name');
    // T13 (E8): the coverage default follows the PROVIDER capability, not the OS
    // name — Windows+WSL2 (coverage=full) keeps it on; MSVC / macOS default off.
    const plan = (await vscode.commands.executeCommand('het.getProvisionPlan')) as { provider?: string; coverage?: string } | null;
    assert.strictEqual(
      meta.activate_code_coverage === true,
      plan?.coverage === 'full',
      `coverage default must follow the provider (provider=${plan?.provider ?? '?'} coverage=${plan?.coverage ?? '?'})`,
    );
    assert.ok(existsSync(join(PROJ, '.het', 'template-ref.json')), 'marker written');
    assert.ok(existsSync(join(PROJ, 'include', 'cpptest.hpp')), 'template tree copied');
    log('[verify-installed] empty-phase OK — Explorer zero-op init on disk (no auto-open in host)');
  } else if (phase === 'proj') {
    assert.ok(PROJ.length > 0, 'HET_VERIFY_DEST required');
    const name = await vscode.commands.executeCommand<string | null>('het.getCurrentProject');
    assert.strictEqual(name, 'verify_proj', 'project workspace must detect verify_proj');
    const chip = (await vscode.commands.executeCommand('het.getChipState')) as { text: string; tooltip: string; command?: string } | null;
    assert.ok(chip, 'chip queryable');
    assert.strictEqual(chip.command, 'het.chipOverview', 'project chip opens the monitor overview');
    assert.ok(chip.tooltip.includes('$('), 'tooltip must carry $(icon) tokens');
    assert.ok(!chip.tooltip.includes('het.newProject'), 'monitoring chip must not offer new project');
    // V5-2 hover console
    assert.ok(chip.tooltip.includes('| 项目 | 状态 |'), 'hover console table');
    assert.ok(chip.tooltip.includes('工程健康'), 'health row present');
    assert.ok(chip.tooltip.includes('command:het.healthCheck'), 'health rescore link');
    await vscode.commands.executeCommand('het.dashboard', ['deps']);
    await hold();
    // 新 UI 没有“当前页”（旧 `state.page` 已归档）→ 验收点改成“深链定位到的那一段是展开可见的”。
    const view = (await vscode.commands.executeCommand('het.getCockpitView')) as {
      focus: string | null;
      folded: string[];
      opened: string[];
    };
    assert.ok(view.focus, '旧 tab id `deps` 必须解析成一个真实存在的段');
    assert.ok(view.opened.includes(view.focus), `深链目标段必须已加载：${JSON.stringify(view)}`);
    assert.ok(!view.folded.includes(view.focus), `深链目标段必须展开可见：${JSON.stringify(view)}`);
    const all = (await vscode.commands.getCommands(true)) as string[];
    for (const c of ['het.envCheck', 'het.openDocsArtifact', 'het.openBuildOutput', 'het.healthReport']) {
      assert.ok(all.includes(c), `${c} must be registered`);
    }
    log('[verify-installed] proj-phase OK — hover console + detect + dashboard deps focus');
  } else if (phase === 'scrub') {
    assert.ok(PROJ.length > 0, 'HET_VERIFY_DEST required');
    assert.ok(!(process.env.PATH ?? '').toLowerCase().includes('miniforge'), 'test PATH must be scrubbed first');
    assert.ok(!(process.env.PATH ?? '').toLowerCase().includes('miniconda'), 'test PATH must be scrubbed first');
    const rt = (await vscode.commands.executeCommand('het.getConanRuntime')) as { exe?: string; envName?: string; version?: string } | null;
    assert.ok(rt && rt.exe && rt.envName, 'runtime must be sniffed with no conda on PATH: ' + JSON.stringify(rt));
    log('[verify-installed] sniffed conan: ' + rt.exe + ' (env ' + rt.envName + ', ' + (rt.version ?? '?') + ')');

    // V3-5: python must be found (no root-dir false negative); gtest conan-managed.
    const rows = (await vscode.commands.executeCommand('het.getEnvRows')) as RowShape[];
    const py = rows.find((r) => r.key === 'python');
    assert.ok(py && py.source !== 'missing', 'python must be found inside the sniffed env: ' + JSON.stringify(py));
    const gtest = rows.find((r) => r.key === 'gtest');
    assert.ok(gtest && (gtest.source !== 'missing' || gtest.managed), 'gtest must be found or conan-managed: ' + JSON.stringify(gtest));
    log('[verify-installed] env rows: python=' + (py?.source ?? '?') + ', gtest=' + (gtest?.source ?? '?'));

    // A real build legitimately takes minutes — widen the watchdog during it.
    longOpUntil = Date.now() + 10 * 60_000;
    await vscode.commands.executeCommand('het.build');
    await hold();
    const buildOk = await vscode.commands.executeCommand<boolean | null>('het.getBuildOk');
    longOpUntil = 0;
    if (buildOk !== true) {
      const tail = (await vscode.commands.executeCommand<string>('het.getLastConanOutput')) ?? '';
      log('[verify-installed] build output tail:\n' + tail.slice(-2000));
    }
    assert.strictEqual(buildOk, true, 'real conan build must succeed from a scrubbed PATH (conda sniffed)');
    log('[verify-installed] scrub-phase OK — sniffed conda env + real conan build green');
  } else if (phase === 'matrix') {
    // V4-7/A3: virtual hosts simulated inside one host via HET_FAKE_HOST —
    // the extension must pick the right Provider with zero manual interaction.
    const cases: { name: string; caps: Record<string, unknown>; provider: string; coverage: string }[] = [
      { name: 'win-noWSL', caps: { platform: 'win32', arch: 'x64', wslAvailable: false, wslDefaultReady: false, virtualizationEnabled: false, isAdmin: false, msvcAvailable: false }, provider: 'win-wsl-required', coverage: 'none' },
      { name: 'win-WSL2', caps: { platform: 'win32', arch: 'x64', wslAvailable: true, wslDefaultReady: true, virtualizationEnabled: true, isAdmin: true, msvcAvailable: true }, provider: 'win-wsl2', coverage: 'full' },
      { name: 'linux-managed', caps: { platform: 'linux', arch: 'x64', isAdmin: true, linuxApt: true, linuxAptSudo: true, linuxVenv: true }, provider: 'linux-managed', coverage: 'full' },
      // ADR-8：判定看"能不能建用户级车道"，不看 sudo 时间戳 —— 常规机器（sudo 要密码）
      // 仍然是 linux-managed，只是缺包自愈不可用。
      { name: 'linux-managed-no-root', caps: { platform: 'linux', arch: 'x64', isAdmin: false, linuxApt: true, linuxAptSudo: false, linuxVenv: true }, provider: 'linux-managed', coverage: 'full' },
      { name: 'linux-native', caps: { platform: 'linux', arch: 'x64', isAdmin: true, linuxApt: true, linuxAptSudo: true, linuxVenv: false }, provider: 'linux-native', coverage: 'full' },
      { name: 'macos-native', caps: { platform: 'darwin', arch: 'arm64' }, provider: 'macos-native', coverage: 'none' },
    ];
    for (const c of cases) {
      process.env.HET_FAKE_HOST = JSON.stringify(c.caps);
      const plan = (await vscode.commands.executeCommand('het.getProvisionPlan', true)) as { provider: string; coverage: string } | null;
      assert.ok(plan, `provision plan must resolve for ${c.name}`);
      assert.strictEqual(plan!.provider, c.provider, `${c.name} must pick ${c.provider}, got ${plan!.provider}`);
      assert.strictEqual(plan!.coverage, c.coverage, `${c.name} coverage semantic`);
      log(`[verify-installed] matrix ${c.name} → ${plan!.provider} (${plan!.coverage})`);
    }
    delete process.env.HET_FAKE_HOST;
    const st = (await vscode.commands.executeCommand('het.envStatus')) as { state: string; tools: Record<string, string> } | null;
    assert.ok(st && typeof st.state === 'string' && st.tools, 'het.envStatus must be queryable in the installed host');
    log('[verify-installed] matrix OK — 6 virtual hosts + envStatus queryable');
  } else {
    assert.fail('unknown phase ' + phase);
  }
  log('[verify-installed] OK');
}
