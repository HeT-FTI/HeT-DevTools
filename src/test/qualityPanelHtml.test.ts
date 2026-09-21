import * as assert from 'node:assert';
import { apiCalls } from './pageShellApi.test';
import {
  QUALITY_IDLE_HINT,
  qualityErrorHtml,
  qualityPageHtml,
  qualityResultHtml,
  qualityRowsHtml,
  type QualityRow,
  type QualityRunResult,
} from '../features/quality/qualityHtml';

/**
 * F.29 的回归测试：质量面板"点一次之后其它按钮全哑，关掉重开才好"。
 *
 * 根因是**同一个文档里 acquireVsCodeApi() 被调用了两次**：结果片段自带的 `<script>`
 * 先跑（拿到 API），随后页面里给按钮绑事件的 script 再调用一次 → 抛
 * "An instance of the VS Code API has already been acquired"，绑定代码整段没执行。
 * 首屏没有结果片段，所以第一次点击正常；出结果后按钮就成了摆设。
 *
 * 这几条断言把这个错法钉死：API 只能取一次、片段不许带 script、交互必须走事件委托。
 */
describe('质量面板 HTML（F.29 回归）', () => {
  const rows: QualityRow[] = [
    { id: 'format', label: '格式检查（clang-format）', status: 'idle', tool: 'clang-format · 双配置 C/C++' },
    { id: 'tidy', label: '静态检查（clang-tidy）', status: 'fail', tool: 'clang-tidy · WarningsAsErrors', detail: '最近一次：3 条诊断' },
  ];
  const result: QualityRunResult = {
    rowId: 'tidy',
    status: 'fail',
    summary: '静态检查失败：3 条诊断（WarningsAsErrors）',
    issues: [
      { file: 'test/src/etl.cpp', line: 2, message: "'etl/algorithm.h' file not found", check: 'clang-tidy' },
      { file: 'test/src/etl.cpp', line: 3, message: "'stddef.h' file not found", check: 'clang-tidy' },
    ],
    errors: [],
  };

  it('无论带不带结果片段，页面里 acquireVsCodeApi() 都只出现一次', () => {
    const bare = qualityPageHtml(rows);
    const withResult = qualityPageHtml(rows, qualityResultHtml(result));
    for (const [name, html] of [['首屏', bare], ['带结果', withResult]] as const) {
      assert.strictEqual(
        apiCalls(html),
        1,
        `${name}：必须恰好调用一次（第二次会抛错，把按钮绑定带走）`,
      );
    }
  });

  it('片段（结果 / 清单）一律不带 <script>（第二次取 API 的来源）', () => {
    assert.ok(!qualityResultHtml(result).includes('<script'), '结果片段不能自带脚本');
    assert.ok(!qualityRowsHtml(rows).includes('<script'), '清单片段不能自带脚本');
    assert.ok(!QUALITY_IDLE_HINT.includes('<script'), '占位提示不能自带脚本');
  });

  it('交互走事件委托：片段被局部替换后按钮照样有效', () => {
    const html = qualityPageHtml(rows, qualityResultHtml(result));
    assert.ok(html.includes(`document.addEventListener('click'`), '必须有委托监听');
    assert.ok(html.includes(`el.closest('[data-action]')`), '委托要按 data-action 分派');
    assert.ok(
      !/querySelectorAll\(\s*'button\[data-action\]'\s*\)/.test(html),
      '禁止"逐个按钮绑事件"（重渲染即失效的老错法）',
    );
  });

  it('两种事件协议都在：点击发消息，更新只动 #rows / #detail', () => {
    const html = qualityPageHtml(rows);
    assert.ok(html.includes(`window.addEventListener('message'`), '宿主 → 页面用 message 更新');
    assert.ok(html.includes(`id="rows"`) && html.includes(`id="detail"`), '两个局部刷新锚点');
    assert.ok(html.includes(`m.type !== 'update'`), '只认 update 消息（不整页重载）');
    assert.ok(html.includes(`send({ type: 'runRow', rowId: row })`), '点击"检查"发 runRow');
    assert.ok(html.includes(`btn.textContent = '检查中…'`), '点击后立刻给"运行中"反馈');
  });

  it('清单按钮带着 rowId；结果条目带 data-action=openIssue（靠委托才生效）', () => {
    const listHtml = qualityRowsHtml(rows);
    assert.ok(listHtml.includes('data-action="runRow" data-row="format"'), '每行按钮带 rowId');
    assert.ok(listHtml.includes('检查'), '未跑过 → 显示"检查"');

    const resultHtml = qualityResultHtml(result);
    assert.ok(resultHtml.includes('data-action="openIssue"'), '结果条目可点击跳转');
    assert.ok(resultHtml.includes('data-file="test/src/etl.cpp"'), '带文件路径');
    assert.ok(resultHtml.includes('data-line="2"'), '带行号');
    assert.ok(resultHtml.includes('✗ 失败'), '失败徽标');
  });

  it('运行中抛异常也必须回一次结果（否则按钮永久停在"检查中…"）', () => {
    const html = qualityErrorHtml('tidy', new Error('clang-tidy 未安装'));
    assert.ok(html.includes('检查未能运行'), '给出人话标题');
    assert.ok(html.includes('clang-tidy 未安装'), '原样带上错误原因');
    assert.ok(html.includes('✗ 失败'), '按失败渲染，不是静默');
    assert.ok(!html.includes('<script'), '仍然不许带脚本');
  });

  it('页面标题与门禁说明还在（别把页面改空）', () => {
    const html = qualityPageHtml(rows);
    assert.ok(html.includes('质量与安全'));
    assert.ok(html.includes('🔄 刷新状态'));
    assert.ok(html.includes('id="rows"') && html.includes('id="detail"'), '首屏就带两个容器');
  });
});
