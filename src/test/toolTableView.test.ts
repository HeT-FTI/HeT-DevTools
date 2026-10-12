/**
 * L2d 门禁：工具链一览（§4.5 / G13）。
 *
 * 三条铁律的**可测形式**：
 * 1. **只渲染真实拿到的路径** —— 没拿到就"未找到"，绝不显示推测路径；
 * 2. **未知 ≠ 没有** —— conan 托管（gtest/benchmark）与可选工具（lcov/gcovr）没找到**不算缺**；
 * 3. 顺序与文案都要"能直接用" —— 缺失项排最前；全绿时一行摘要不啰嗦。
 */
import * as assert from 'assert';
import {
  chainOf,
  installHintOf,
  toolFactsOf,
  toolSummaryState,
  toolSummaryText,
  toolTableHtml,
  toolViewRows,
  toolsPageHtml,
  type ToolFact,
} from '../features/env/toolTableView';

function fact(over: Partial<ToolFact> & { key: string }): ToolFact {
  return {
    label: over.key,
    exe: `/usr/bin/${over.key}`,
    source: 'path',
    sourceDetail: 'PATH',
    ...over,
  };
}

const MISSING = (key: string, over: Partial<ToolFact> = {}): ToolFact =>
  fact({ label: key, key, exe: '', source: 'missing', sourceDetail: '', ...over });

const ALL_OK: ToolFact[] = [
  fact({ key: 'conan', label: 'Conan', exe: '/home/zc/miniforge3/envs/build/bin/conan', source: 'conda', sourceDetail: 'conda 环境 build' }),
  fact({ key: 'cmake', label: 'CMake', exe: '/usr/bin/cmake' }),
  fact({ key: 'ninja', label: 'Ninja', exe: '/usr/bin/ninja' }),
  fact({ key: 'doxygen', label: 'Doxygen', exe: '/usr/bin/doxygen' }),
];

describe('L2d · 工具链一览（只渲染真实事实）', () => {
  it('路径来自输入：没有 exe 就是"未找到"，**不许**出现推测路径', () => {
    const rows = toolViewRows([...ALL_OK, MISSING('gcovr', { optional: true })]);
    const gcovr = rows.find((r) => r.key === 'gcovr')!;
    assert.strictEqual(gcovr.path, undefined, '没探到就没有路径');
    assert.strictEqual(gcovr.sourceLabel, '未找到');
    const html = toolTableHtml(rows);
    assert.ok(html.includes('未找到'), '表格里要写"未找到"');
    assert.ok(!/\/usr\/bin\/gcovr|\/usr\/local/u.test(html), '不许编造任何路径');
    // 每一条渲染出来的路径都必须来自输入
    for (const p of html.matchAll(/data-tool-path="([^"]+)"/gu)) {
      assert.ok(
        ALL_OK.some((t) => t.exe === p[1]),
        `渲染了输入里没有的路径：${p[1]}`,
      );
    }
  });

  it('未知 ≠ 没有：conan 托管 / 可选工具没找到**不算缺**；真缺的排最前', () => {
    const rows = toolViewRows([
      ...ALL_OK,
      MISSING('gtest', { managed: true }),
      MISSING('lcov', { optional: true }),
      MISSING('sphinx'),
    ]);
    assert.strictEqual(rows[0].key, 'sphinx', '真缺的排最前（有事要做的先看见）');
    assert.deepStrictEqual(
      rows.filter((r) => r.missing).map((r) => r.key),
      ['sphinx'],
      '托管与可选不算缺失',
    );
    assert.strictEqual(toolSummaryState([...ALL_OK, MISSING('gtest', { managed: true })]), 'ok');
    assert.strictEqual(toolSummaryState([...ALL_OK, MISSING('sphinx')]), 'warn');
    assert.strictEqual(toolSummaryState([]), 'idle', '一个都没探测 → idle，不谎报');
  });

  it('摘要：全绿不啰嗦；有缺时缺谁在前、关键三件带来源', () => {
    assert.strictEqual(toolSummaryText(ALL_OK), '配套工具 4/4 就绪');
    const text = toolSummaryText([...ALL_OK.slice(0, 3), MISSING('doxygen', { label: 'Doxygen' })]);
    assert.ok(text.startsWith('配套工具 3/4 就绪'), text);
    assert.ok(text.includes('缺 Doxygen'), text);
    assert.ok(text.includes('Conan (conda 环境)'), `关键三件要带来源：${text}`);
    assert.strictEqual(toolSummaryText([]), '', '没探测过就没有摘要（不编造）');
  });

  it('来源与链：手动覆盖要显眼；链来自 TOOL_MATRIX（不在表里就不显示链）', () => {
    const rows = toolViewRows([
      fact({ key: 'conan', label: 'Conan', source: 'override', overridden: true, exe: '/opt/my/conan' }),
      fact({ key: 'python', label: 'Python' }),
      fact({ key: 'gcc', label: 'GCC (gcc)' }),
    ]);
    const conan = rows.find((r) => r.key === 'conan')!;
    assert.strictEqual(conan.sourceLabel, '手动覆盖');
    assert.strictEqual(conan.overridden, true);
    assert.ok(toolTableHtml(rows).includes('row-override'), '覆盖行要有样式标记（最容易看错的一套）');
    assert.strictEqual(conan.chain, chainOf('conan'), '链取自矩阵');
    assert.strictEqual(chainOf('doxygen'), 'docs');
    assert.strictEqual(rows.find((r) => r.key === 'python')!.chain, undefined, '矩阵里没有 → 不编造链');
    const html = toolTableHtml(rows);
    assert.ok(html.includes('复制路径') && html.includes('在哪配置'), '每行要有可用动作');
  });

  it('缺失行带"怎么装"，且那句话来自 TOOL_MATRIX（全库只写一次）', () => {
    const hint = installHintOf('clang-tidy');
    assert.ok(hint && hint.includes('需要你执行'), '矩阵里有人话装法');
    const html = toolTableHtml(toolViewRows([MISSING('clang-tidy')]));
    assert.ok(html.includes(hint!.slice(0, 8)), '缺失行要带上装法');
    assert.strictEqual(installHintOf('不存在的工具'), undefined, '不在矩阵里就没有装法（不编造）');
  });

  it('**弄红自证**：路径只可能来自输入；缺失项必须排最前', () => {
    // ① 伪造路径：把不存在的工具标成有 exe，摘要就不该说"缺"
    const faked = toolViewRows([{ ...MISSING('sphinx'), exe: '/usr/bin/sphinx-build' }]);
    assert.strictEqual(faked[0].missing, false, '这条只是用来证明"有 exe 就不算缺"的口径');
    // 真正的不变量：path 只可能来自输入
    const html = toolTableHtml(faked);
    assert.ok(html.includes('/usr/bin/sphinx-build'), '输入里给的路径才允许出现');

    // ② 顺序：把缺失项插到中间，排序必须把它提到最前
    const rows = toolViewRows([
      fact({ key: 'cmake' }),
      MISSING('doxygen'),
      fact({ key: 'ninja' }),
    ]);
    assert.strictEqual(rows[0].key, 'doxygen');
    assert.notStrictEqual(rows[0].key, 'cmake', '缺失项不允许排在就绪项后面');
  });

  it('页面片段：用 pageShell（唯一一段脚本）+ 两条视图消息 + 清空态', () => {
    const page = toolsPageHtml(toolViewRows(ALL_OK));
    assert.ok(page.includes('acquireVsCodeApi'), '走 pageShell（一个文档只取一次 API）');
    assert.ok(page.includes("type: 'tools:copy'") && page.includes("type: 'tools:config'"), '两条消息');
    assert.ok(page.includes('就绪：工具链与环境'), '标题与 SLOT_TITLES 同源');
    assert.ok(toolTableHtml([]).includes('还没探测到工具'), '空态要说人话（不是一张空表）');
  });

  it('fact 打包：缺谁要说得出来，且摘要与表格同源', () => {
    const rows = [...ALL_OK, MISSING('sphinx', { label: 'Sphinx (sphinx-build)' })];
    const f = toolFactsOf(rows);
    assert.strictEqual(f.total, 5);
    assert.strictEqual(f.ready, 4);
    assert.deepStrictEqual(f.missing, ['Sphinx (sphinx-build)']);
    assert.ok(f.summary.includes('4/5 就绪'), f.summary);
    assert.strictEqual(f.summary, toolSummaryText(rows));
  });
});
