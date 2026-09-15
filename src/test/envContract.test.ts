import * as assert from 'node:assert';
import { REQUIRED_FOR_BUILD, buildEnvContract, contractGaps, contractLine } from '../core/envContract';
import { envCardHtml } from '../features/cockpit/webview/render';

const base = {
  platform: 'linux/x64',
  lane: 'Linux · 派生 managed（隔离 gcc-13 + lcov 全语义）',
  coverage: 'full' as const,
  summary: 'Linux 派生 managed · conan 2.32.0',
};

describe('T06 envContract (single source of truth)', () => {
  it('ready requires every build-critical row; compatible compilers keep the baseline visible', () => {
    const c = buildEnvContract({
      ...base,
      compiler: 'gcc-13 (13)',
      compilerBaseline: 'ci',
      conan: 'Conan version 2.32.0',
      cmake: 'cmake version 4.4.3',
      ninja: '1.13.1',
      lcov: 'LCOV version 2.0',
      git: '已安装',
    });
    assert.strictEqual(c.ready, true);
    assert.strictEqual(c.next, undefined, 'a ready contract offers no prepare button');
    const compiler = c.rows.find((r) => r.id === 'compiler')!;
    assert.strictEqual(compiler.disposition, 'present');
    assert.strictEqual(compiler.baseline, 'ci');
    assert.ok(REQUIRED_FOR_BUILD.every((id) => c.rows.some((r) => r.id === id)), 'every required id is a row');
  });

  it('missing build tools are healable with a prepare action; missing lcov does not block', () => {
    const c = buildEnvContract({ ...base, conan: 'Conan version 2.32.0', cmake: 'cmake version 4.4.3' });
    assert.strictEqual(c.ready, false);
    assert.strictEqual(c.rows.find((r) => r.id === 'ninja')?.disposition, 'healable');
    assert.strictEqual(c.rows.find((r) => r.id === 'lcov')?.disposition, 'healable');
    assert.strictEqual(c.rows.find((r) => r.id === 'lcov')?.required, false, 'coverage tool is optional');
    assert.deepStrictEqual(contractGaps(c), ['编译器待准备', 'Ninja待准备']);
    assert.strictEqual(c.next?.action, 'env:prepare');
  });

  it('a blocked lane (guide text) is presented as healable with copy-paste guidance', () => {
    const c = buildEnvContract({ ...base, laneGuide: '① sudo apt-get install -y gcc-13 g++-13\n② …' });
    const compiler = c.rows.find((r) => r.id === 'compiler')!;
    assert.strictEqual(compiler.disposition, 'healable');
    assert.ok(compiler.fix?.copy?.includes('gcc-13'), 'the guide text is carried as copy-paste data');
    assert.strictEqual(c.ready, false);
  });

  it('a blocked lane also offers the EXPLICIT system fallback (never silent)', () => {
    const c = buildEnvContract({ ...base, laneGuide: 'wsl --install -d Ubuntu-24.04' });
    const compiler = c.rows.find((r) => r.id === 'compiler')!;
    assert.strictEqual(compiler.altFix?.action, 'env:use-system');
    assert.ok(compiler.altFix?.text.includes('本机工具链'));
    const html = envCardHtml(c);
    assert.ok(html.includes('data-page-action="env:use-system"'), 'the card renders the switch button');
    // Once the compiler is present the escape hatch disappears (nothing to fix).
    const ok = buildEnvContract({ ...base, compiler: 'gcc-13 (13)', conan: 'x', cmake: 'y', ninja: 'z' });
    assert.strictEqual(ok.rows.find((r) => r.id === 'compiler')?.altFix, undefined);
  });

  it('macOS-style limited support reports lcov as unsupported (never as a failure)', () => {
    const c = buildEnvContract({
      platform: 'darwin/arm64',
      lane: 'macOS 原生（clang；覆盖率暂不支持）',
      coverage: 'none',
      summary: 'macOS · CLT · clang 16',
      compiler: 'Apple clang 16.0.0',
      compilerBaseline: 'native',
      conan: 'Conan version 2.32.0',
      cmake: 'cmake version 4.4.3',
      ninja: '1.13.1',
      lcovSupported: false,
      lcovUnsupportedReason: 'macOS/Apple clang 无 GNU gcov（有限支持）',
    });
    assert.strictEqual(c.rows.find((r) => r.id === 'lcov')?.disposition, 'unsupported');
    assert.strictEqual(c.rows.find((r) => r.id === 'lcov')?.required, false);
    assert.strictEqual(c.ready, true, 'unsupported optional rows must not block the build');
    assert.ok(contractLine(c).includes('—lcov'));
  });

  it('the card renders every row, the baseline badge and the single next action', () => {
    const c = buildEnvContract({
      ...base,
      compiler: 'gcc-14 (14)',
      compilerBaseline: 'compatible',
      conan: 'Conan version 2.32.0',
      cmake: 'cmake version 4.4.3',
    });
    const html = envCardHtml(c);
    assert.ok(html.includes('构建环境'), 'card header');
    assert.ok(html.includes('覆盖率（lcov）'), 'lcov row label');
    assert.ok(html.includes('[兼容模式]'), 'compatible baseline is visible');
    assert.ok(html.includes('data-page-action="env:prepare"'), 'prepare action wired');
    assert.strictEqual(envCardHtml(null), '', 'no contract → no card (legacy blocks take over)');
  });
});
