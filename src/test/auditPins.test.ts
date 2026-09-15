import * as assert from 'node:assert';
import { auditTree, formatReport, scanSource, stripComments } from '../core/auditPins';
import { STANDARD_TOOLS } from '../core/toolchainDetector';

describe('T22 audit:pins（CI 事实外泄门禁）', () => {
  it('剥注释：历史叙事不算事实，代码里的字面量才算', () => {
    assert.strictEqual(stripComments('const a = 1; // /usr/bin/gcc-13'), 'const a = 1; ');
    assert.strictEqual(stripComments('/*\n/usr/bin/gcc-13\n*/\nconst b = 2;'), '\n\n\nconst b = 2;');
    assert.strictEqual(stripComments('const c = 3; /* gcc-13 */'), 'const c = 3; ');
    // 行号保持不变（定位用）
    assert.strictEqual(stripComments('a\n/* x\ny\n*/\nb').split('\n').length, 5);
  });

  it('命中三类"钉"：CI 绝对路径、基线编译器字面量、被抄写的版本下限', () => {
    const hits = scanSource('src/core/somewhere.ts', [
      "const cc = '/usr/bin/gcc-13';",
      "const names = ['gcc-13', \"g++-13\"];",
      "const req = '>= 3.28';",
      "const py = '>= 3.10';",
      'const ok = 1;',
    ].join('\n'));
    assert.deepStrictEqual([...new Set(hits.map((h) => h.pattern))].sort(), [
      'baseline-compiler-literal',
      'ci-compiler-path',
      'duplicated-floor',
    ]);
    assert.strictEqual(hits.length, 4, '每个匹配各一条（便于逐个修）');
    assert.ok(hits.every((h) => h.why.length > 10), '每条都带"为什么要改"');
  });

  it('归属模块与测试目录豁免（pin 只能有一个归宿；测试写死期望值是它的职责）', () => {
    assert.deepStrictEqual(scanSource('src/core/laneProfile.ts', "export const X = ['gcc-13'];"), []);
    assert.deepStrictEqual(scanSource('src/test/wslLane.test.ts', "assert.ok(c.includes('/usr/bin/gcc-13'));"), []);
    // 注释里提到也豁免（先剥注释）
    assert.deepStrictEqual(scanSource('src/core/whatever.ts', '// 过去写死过 /usr/bin/gcc-13\nconst a = 1;'), []);
  });

  it('★ 真实仓库必须干净（这就是门禁本身）', () => {
    const { findings, scanned } = auditTree('src');
    assert.ok(scanned > 50, `应该扫到不少文件，实际 ${scanned}`);
    assert.strictEqual(findings.length, 0, '\n' + formatReport(findings));
  });

  it('工具清单的下限从归属模块派生（不是抄一遍）', () => {
    const cmake = STANDARD_TOOLS.find((t) => t.name === 'cmake');
    const python = STANDARD_TOOLS.find((t) => t.name === 'python');
    // 值仍是 3.28 / 3.10，但来源是 laneProfile / lanePython 的常量 → 改一处即同步
    assert.strictEqual(cmake?.required, '>= 3.28');
    assert.strictEqual(python?.required, '>= 3.10');
  });
});
