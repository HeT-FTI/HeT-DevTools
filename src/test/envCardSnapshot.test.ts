/**
 * T19: the three platforms' environment cards — one renderer, three truths.
 *
 * Rendered from the SAME pure functions the extension uses
 * (`buildEnvContract` → `envCardHtml` + `envPhaseHtml`), with the facts each
 * lane really reports (see `collectEnvContract`). The snapshot is structural —
 * `row id: disposition` plus badges/buttons/phase — instead of a wall of raw
 * HTML, so a meaningful change is readable in a diff while a silent drift still
 * fails: a lost row, a button the user can no longer press, macOS suddenly
 * claiming coverage, or a Windows card that forgets the self-provision path.
 */
import * as assert from 'node:assert';
import { EnvContract, buildEnvContract } from '../core/envContract';
import { envPhaseView } from '../core/envPhase';
import { envCardHtml } from '../features/cockpit/webview/render';

/** Compact, stable view of a contract: `id:disposition[·opt][·baseline]`. */
function rows(c: EnvContract): string[] {
  return c.rows.map((r) => `${r.id}:${r.disposition}${r.required ? '' : '(可选)'}${r.baseline ? `[${r.baseline}]` : ''}`);
}

/** Buttons the user can actually press (fix + explicit fallback). */
function buttons(html: string): string[] {
  return [...html.matchAll(/data-page-action="([^"]+)"/gu)].map((m) => m[1]);
}

describe('T19 三平台卡片（envCardHtml 快照）', () => {
  it('Ubuntu 托管车道：全绿 · 覆盖率 full · 无按钮（重复准备没有意义）', () => {
    const contract = buildEnvContract({
      platform: 'linux/x64',
      lane: 'Linux 派生 managed（隔离 gcc-13 + lcov 全语义）',
      coverage: 'full',
      summary: 'Linux 派生 managed · conan 2.32.0',
      compiler: 'gcc-13 (13)',
      compilerBaseline: 'ci',
      conan: 'Conan version 2.32.0',
      cmake: 'cmake version 4.4.3',
      ninja: '1.13.1',
      lcov: 'LCOV version 2.0',
      git: '已安装',
      python: '已安装',
      doxygen: '已安装',
      graphviz: '已安装',
      make: '已安装',
      arch: 'x86_64',
      laneHealable: true,
    });
    assert.strictEqual(contract.ready, true);
    assert.deepStrictEqual(rows(contract), [
      'compiler:present[ci]',
      'conan:present',
      'cmake:present',
      'ninja:present',
      'lcov:present(可选)',
      'git:present(可选)',
      'python:present(可选)',
      'doxygen:present(可选)',
      'graphviz:present(可选)',
      'make:present(可选)',
    ]);
    const html = envCardHtml(contract);
    assert.ok(html.includes('✓ 构建环境 · Linux 派生 managed'), '头部：就绪标记 + 车道名');
    assert.ok(html.includes('linux/x64 · x86_64 · 覆盖率 full'), '头部：平台/架构/覆盖率必须可核');
    assert.ok(html.includes('[CI 同基线]'), '编译器口径如实展示（与 CI 同基线）');
    assert.deepStrictEqual(buttons(html), [], '就绪时不给任何修复按钮');
    const phase = envPhaseView({ laneAvailable: true, laneReady: true, consented: true, probed: true });
    assert.strictEqual(phase.label, '已就绪');
  });

  it('Windows 无发行版：自建提议作为唯一主按钮 · 覆盖率 limited · 不谎报就绪', () => {
    const contract = buildEnvContract({
      platform: 'win32/x64',
      lane: 'Windows · WSL2 已装但无发行版（需创建托管 distro）',
      coverage: 'limited',
      summary: 'Windows · 等待自建私有发行版',
      git: '已安装',
      python: '已安装',
      laneHealable: true,
    });
    assert.strictEqual(contract.ready, false, '没有工具链就不能显示就绪');
    assert.deepStrictEqual(rows(contract), [
      'compiler:healable',
      'conan:healable',
      'cmake:healable',
      'ninja:healable',
      'lcov:healable(可选)',
      'git:present(可选)',
      'python:present(可选)',
    ]);
    const html = envCardHtml(contract);
    assert.ok(html.includes('覆盖率 limited'), 'limited 必须如实写出（不是 full、也不是 none）');
    assert.deepStrictEqual([...new Set(buttons(html))], ['env:prepare'], '一键准备是唯一出口');
    assert.strictEqual(contract.next?.action, 'env:prepare');
    // 未同意 → 卡片请用户"同意并准备"（绝不静默开始下载 340MB）。
    assert.strictEqual(envPhaseView({ laneAvailable: true, laneReady: false, consented: false, probed: true }).label, '待你确认');
  });

  it('macOS 有限支持：lcov 是"—"而不是"✗" · 覆盖率 none 且给出原因', () => {
    const contract = buildEnvContract({
      platform: 'darwin/arm64',
      lane: 'macOS 原生（clang；覆盖率暂不支持）',
      coverage: 'none',
      summary: 'macOS · CLT · Apple clang 21.0',
      compiler: 'Apple clang 21.0',
      compilerBaseline: 'native',
      conan: 'Conan version 2.32.0',
      cmake: 'cmake version 4.4.3',
      ninja: '1.13.1',
      git: '已安装',
      python: '已安装',
      arch: 'arm64',
      lcovSupported: false,
      lcovUnsupportedReason: 'Apple clang 不产生 GNU gcov 数据（模板产出的是 profraw）→ 覆盖率不在 macOS 承诺内；llvm-cov→gcov 路线见 T20。',
      laneHealable: true,
    });
    assert.strictEqual(contract.ready, true, '平台不支持覆盖率不得阻塞构建/文档');
    assert.deepStrictEqual(rows(contract), [
      'compiler:present[native]',
      'conan:present',
      'cmake:present',
      'ninja:present',
      'lcov:unsupported(可选)',
      'git:present(可选)',
      'python:present(可选)',
    ]);
    const html = envCardHtml(contract);
    assert.ok(html.includes('darwin/arm64 · arm64 · 覆盖率 none'));
    assert.ok(html.includes('— 覆盖率（lcov）'), 'unsupported 用 — 表达"平台没有"，而不是 ✗（像是用户没装）');
    assert.ok(html.includes('Apple clang 不产生 GNU gcov 数据'), '拒绝能力必须写清技术原因');
    assert.deepStrictEqual(buttons(html), [], 'macOS 就绪时同样没有按钮');
    assert.ok(!html.includes('[CI 同基线]'), 'macOS 是 native 口径，不得冒充 CI 基线');
  });
});
