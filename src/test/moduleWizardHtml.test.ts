import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { planModuleFiles } from '../core/moduleTemplate';
import {
  wizardFormHtml,
  wizardIssueHtml,
  wizardNoticeHtml,
  wizardPageHtml,
  wizardPreviewHtml,
} from '../features/moduleWizard/wizardHtml';
import { apiCalls } from './pageShellApi.test';

/**
 * F.30 的回归测试：「新增模块向导」按引导操作却什么都没建出来。
 *
 * 根因：向导每次 `plan`/`create` 都**整页重渲染**，而表单是用默认值现拼的 —— 用户填的
 * 内容被"复原"（`mymod` 回来了、一句话说明变空），紧接着点「创建文件」收集到空值 →
 * 校验失败 → 项目里一个文件都没新增。
 *
 * 所以断言的核心是：**预览/结果必须是纯片段**（不含表单字段、不含 script），页面里表单
 * 只有一份，且宿主侧不再有任何"整页重设"的路径。
 */
describe('新增模块向导 HTML（F.30 回归）', () => {
  const plan = planModuleFiles({
    moduleName: 'mymod',
    description: '食材体积测量',
    language: 'cpp',
    since: '1.0',
    extraDeclarations: [],
  });
  assert.ok(plan.ok, '示例计划应当可用');

  it('页面里表单一处、API 一次（片段不可能冲掉用户输入）', () => {
    const html = wizardPageHtml();
    assert.strictEqual(apiCalls(html), 1, '整页只能取一次 API（F.29 同源规则）');
    assert.strictEqual(
      html.split('data-field="description"').length - 1,
      1,
      '一句话说明只应出现一处（即表单本身）',
    );
    assert.ok(html.includes('id="preview"'), '预览区有独立锚点，局部替换用');
  });

  it('预览片段是"纯内容"：没有表单字段、没有 script', () => {
    const preview = wizardPreviewHtml(plan, []);
    assert.ok(preview.includes('include/mymod.hpp'), '显示将要生成的文件');
    for (const bad of ['data-field=', '<input', '<textarea', '<select', '<script']) {
      assert.ok(!preview.includes(bad), `预览片段不能包含 ${bad}（否则替换时会重置表单）`);
    }
    const withConflict = wizardPreviewHtml(plan, ['include/mymod.hpp']);
    assert.ok(withConflict.includes('已存在'), '冲突要如实提示');
    for (const bad of ['data-field=', '<script']) {
      assert.ok(!withConflict.includes(bad), `带冲突的预览也不能包含 ${bad}`);
    }
  });

  it('失败/成功提示也走同一个片段通道（失败不再只弹 toast）', () => {
    const issue = wizardIssueHtml(['请填写一句话说明（将写入双语注释）']);
    assert.ok(issue.includes('无法生成') && issue.includes('一句话说明'));
    assert.ok(!issue.includes('<script') && !issue.includes('data-field='));

    const notice = wizardNoticeHtml('已创建 include/mymod.hpp 与 src/mymod.cpp。');
    assert.ok(notice.includes('已创建'));
    assert.ok(!notice.includes('<script') && !notice.includes('data-field='));
  });

  it('交互是委托 + send()，并且带"进行中"防重入', () => {
    const html = wizardPageHtml();
    assert.ok(html.includes(`document.addEventListener('click'`), '委托监听');
    assert.ok(html.includes(`el.closest('button[data-action]')`), '按 data-action 分派');
    assert.ok(html.includes(`send({ type: act, input: collect() })`), '提交时现场收集表单值');
    assert.ok(html.includes('__busy'), '有防重入标记');
    assert.ok(html.includes(`window.addEventListener('message'`), '宿主 → 页面片段更新');
    assert.ok(
      !/querySelectorAll\('button\[data-action\]'\)\.forEach/.test(html),
      '禁止逐个按钮绑事件（重渲染即失效）',
    );
  });

  it('宿主侧不再有"整页重设"路径：webview.html 只赋值一次且无 render 循环', () => {
    const src = readFileSync(join('src', 'features', 'moduleWizard', 'panel.ts'), 'utf8');
    assert.strictEqual(
      src.split('panel.webview.html').length - 1,
      1,
      'panel.ts 里只允许一处设置整页 HTML（首屏）',
    );
    assert.ok(!src.includes('await render()'), '不允许在消息处理里重渲染整页');
    assert.ok(src.includes('wizardPageHtml()'), '首屏用纯函数生成的页面');
  });

  it('表单默认值与字段名与宿主侧收集保持一致', () => {
    const form = wizardFormHtml();
    for (const f of ['moduleName', 'description', 'language', 'since', 'extraDeclarations']) {
      assert.ok(form.includes(`data-field="${f}"`), `字段 ${f} 要在表单里`);
    }
    assert.ok(form.includes('value="mymod"'), '模块名默认值提示 mymod');
    assert.ok(form.includes('<option value="cpp">') && form.includes('<option value="c">'));
  });
});
