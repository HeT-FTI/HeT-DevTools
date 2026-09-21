/**
 * 「新增模块向导」的**纯 HTML 生成**（不 import vscode，可直接单测）。
 *
 * 页面只生成一次、表单只生成一次：点「生成预览」/「创建文件」时宿主**只回一段
 * HTML 片段**替换 `#preview`，绝不再重设 `panel.webview.html`。
 *
 * 为什么（F.30）：向导原来在每次 `plan` 之后整页重渲染，表单是**用默认值现拼的**，
 * 于是用户填的内容被"复原"（`mymod` 回来了、一句话说明变空），紧接着点「创建文件」
 * 收集到的就是空值 → 校验失败 → 一个文件都没建出来。用户的观感是"按引导操作，项目里
 * 并没有新增模块"。
 *
 * 配套规则（与 F.29 一致）：片段不带 `<script>`；交互走事件委托；API 只在 `pageShell` 取。
 */
import { ModulePlan } from '../../core/moduleTemplate';
import { esc, pageShell } from '../ui';

export const WIZARD_FIELD_IDS = [
  'moduleName',
  'description',
  'language',
  'since',
  'extraDeclarations',
] as const;

function field(name: string, label: string, value: string, hint = ''): string {
  return `
    <label class="fld">${label}${hint ? `<span class="hint">${hint}</span>` : ''}
      <input data-field="${name}" value="${esc(value)}" />
    </label>`;
}

/** 表单本体：**只渲染一次**（重渲染 = 把用户填的东西冲掉）。 */
export function wizardFormHtml(): string {
  return `
    <div class="sub">这是**单模块微调**入口：只生成 <code>include/</code> + <code>src/</code> 骨架
      （额外公开声明会同时在源文件生成实现桩）。要按 PRD 做一整套（接口设计 + 测试衔接），
      用 Copilot 的 <code>/het-module</code>。</div>
    ${field('moduleName', '模块名（小写标识符）', 'mymod', '如 mymod；将生成 include/mymod.hpp + src/mymod.cpp')}
    ${field('description', '一句话说明（写入双语注释）', '', '英文会用于 @brief [en]，中文用于 @brief [zh]')}
    <label class="fld">语言
      <select data-field="language">
        <option value="cpp">C++（.hpp / .cpp）</option>
        <option value="c">C（.h / .c）</option>
      </select>
    </label>
    ${field('since', '起始版本 @since', '1.0')}
    <label class="fld">额外公开声明（可选，逐行粘贴函数/宏声明，将置于 Export 注释块内）
      <textarea data-field="extraDeclarations" rows="5" placeholder="int mymod_sum(const int* a, int n);"></textarea>
      <span class="tag">函数声明会在源文件里生成同名实现桩（带 TODO）；宏/变量声明只进头文件。</span>
    </label>`;
}

/** 预览片段（**不含表单、不含 script** —— 所以它替换不了用户填的内容）。 */
export function wizardPreviewHtml(plan: ModulePlan, conflicts: string[]): string {
  const warn = conflicts.length
    ? `<div class="warn">⚠ 以下文件已存在，创建将覆盖：<br/>${conflicts.map((c) => esc(c)).join('<br/>')}</div>`
    : '';
  const files = plan.files
    .map(
      (f) => `
      <div class="file">
        <div class="fname">${esc(f.relPath)}</div>
        <pre>${esc(f.content)}</pre>
      </div>`,
    )
    .join('');
  return `${warn}<h2>预览</h2>${files}`;
}

/** 校验不通过 / 执行失败时的片段。 */
export function wizardIssueHtml(issues: readonly string[]): string {
  return `<h2>无法生成</h2><div class="warn">${issues.map((i) => esc(i)).join('<br/>')}</div>`;
}

/** 创建完成（或其它单行提示）的片段。 */
export function wizardNoticeHtml(message: string, ok = true): string {
  const cls = ok ? 'warn ok' : 'warn';
  return `<h2>${ok ? '已创建' : '未创建'}</h2><div class="${cls}">${esc(message)}</div>`;
}

export function wizardPageHtml(previewHtml = ''): string {
  return pageShell(
    '新增模块向导',
    `<style>
      .fld { display: block; margin: 8px 0 12px; font-size: 12px; opacity: .95; }
      .fld .hint { display: block; font-size: 11px; opacity: .6; margin-top: 2px; }
      input, select, textarea {
        width: 100%; margin-top: 4px; padding: 6px;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, #555);
        border-radius: 4px;
        font-family: var(--vscode-font-family);
      }
      textarea { font-family: var(--vscode-editor-font-family); }
      .file { margin: 6px 0 14px; }
      .fname { font-weight: 600; font-size: 12px; margin-bottom: 4px; }
      pre {
        background: var(--vscode-textCodeBlock-background, #111);
        padding: 10px; border-radius: 6px; overflow-x: auto;
        font-size: 11px; line-height: 1.5;
      }
      .warn { background: rgba(226,192,141,.12); border: 1px solid #e2c08d; border-radius: 6px; padding: 8px 10px; margin: 8px 0; font-size: 12px; }
      .warn.ok { background: rgba(137,209,133,.12); border-color: #89d185; }
      button[disabled] { opacity: .6; }
    </style>
    <div class="card">
      <div class="sub">生成 fcpp 成对文件骨架（include/ + src/），随后可一键构建。</div>
      ${wizardFormHtml()}
      <div class="row">
        <button data-action="plan">生成预览</button>
        <button data-action="create" class="primary">创建文件</button>
      </div>
    </div>
    <div id="preview">${previewHtml}</div>
    <script>
      // 事件委托 + pageShell 的全局 send()（本页不取 API，见 F.29/F.30）。
      // 表单只生成一次，因此 collect() 拿到的永远是用户当前填的内容。
      var __busy = false;
      function collect() {
        var f = function (name) {
          var el = document.querySelector('[data-field="' + name + '"]');
          return (el && el.value) || '';
        };
        return {
          moduleName: f('moduleName').trim(),
          description: f('description').trim(),
          language: f('language'),
          since: f('since').trim(),
          extraDeclarations: f('extraDeclarations'),
        };
      }
      function setBusy(busy) {
        __busy = busy;
        var btns = document.querySelectorAll('button[data-action]');
        for (var i = 0; i < btns.length; i++) {
          btns[i].disabled = busy;
        }
      }
      document.addEventListener('click', function (ev) {
        var el = ev.target instanceof Element ? ev.target : null;
        var btn = el && el.closest('button[data-action]');
        if (!btn || __busy) { return; }
        var act = btn.getAttribute('data-action');
        setBusy(true);
        send({ type: act, input: collect() });
      });
      window.addEventListener('message', function (ev) {
        var m = ev.data || {};
        if (m.type !== 'update') { return; }
        var box = document.getElementById('preview');
        if (box && typeof m.html === 'string') { box.innerHTML = m.html; }
        setBusy(false);
      });
    </script>
    `,
  );
}
