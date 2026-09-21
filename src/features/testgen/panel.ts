import * as vscode from 'vscode';
import { esc } from '../ui';
import { showDetailPanel } from '../detail/host';

export interface DiscoveredModule {
  name: string;
  header: string;
  apiCount: number;
}

export interface ModeBInput {
  moduleName: string;
  blueprint: string;
  title: string;
}

export interface ModeBPreview {
  ok: boolean;
  issues: string[];
  testRelPath: string;
  planRelPath: string;
  testContent: string;
  planContent: string;
  contractCount: number;
}

export interface TestgenDeps {
  listModules: () => Promise<DiscoveredModule[]>;
  /** Mode A: render preview for one module. */
  preview: (moduleName: string) => Promise<{ ok: boolean; issues: string[]; relPath: string; content: string }>;
  /** Mode A: confirm + write the generated test file (add-only). */
  create: (moduleName: string) => Promise<{ ok: boolean; message: string }>;
  /** Mode B: parse blueprint → contract test + implementation plan (preview only). */
  planModeB: (input: ModeBInput) => Promise<ModeBPreview>;
  /** Mode B: confirm plan then write contract test + plan doc. */
  createModeB: (input: ModeBInput) => Promise<{ ok: boolean; message: string }>;
}

export function showTestgenPanel(context: vscode.ExtensionContext, deps: TestgenDeps): vscode.WebviewPanel {
  // §D：细节面板共用一个页签（切视图换内容）——实现原样搬进来，只把"谁来持有面板"交给 host。
  return showDetailPanel(context, { id: 'testgen', title: 'HeT DevTools — 生成测试' }, (panel) => {

    const render = async (): Promise<void> => {
      const modules = await deps.listModules();
      panel.webview.html = buildHtml(modules);
    };

    const sub = panel.webview.onDidReceiveMessage(async (message: { type: string; moduleName?: string; input?: ModeBInput }) => {
      if (message.type === 'preview' && message.moduleName) {
        const p = await deps.preview(message.moduleName);
        panel.webview.postMessage({
          type: 'previewResult',
          ok: p.ok,
          issues: p.issues,
          relPath: p.relPath,
          content: p.content,
        });
      } else if (message.type === 'create' && message.moduleName) {
        const r = await deps.create(message.moduleName);
        void vscode.window.showInformationMessage(r.message);
      } else if (message.type === 'planB' && message.input) {
        const p = await deps.planModeB(message.input);
        panel.webview.postMessage({ type: 'planBResult', preview: p });
      } else if (message.type === 'createB' && message.input) {
        const r = await deps.createModeB(message.input);
        void vscode.window.showInformationMessage(r.message);
      }
    });

    void render().catch((e) => console.error('[het] testgen render failed', e));
    return sub;
  });
}

function buildHtml(modules: DiscoveredModule[]): string {
  const options = modules
    .map(
      (m) =>
        `<option value="${esc(m.name)}">${esc(m.name)} — ${esc(m.header)}（公开 API ${m.apiCount} 个）</option>`,
    )
    .join('');

  const hint =
    modules.length === 0
      ? `<div class="warn">include/ 下未发现带 @exporter 公开 API 的头文件。可先用「新增模块」向导创建模块。</div>`
      : '';

  return `
    <style>
      .fld { display: block; margin: 8px 0 12px; font-size: 12px; }
      select, textarea, input { width: 100%; margin-top: 4px; padding: 6px;
        background: var(--vscode-input-background); color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, #555); border-radius: 4px; }
      textarea { font-family: var(--vscode-editor-font-family); }
      pre { background: var(--vscode-textCodeBlock-background,#111); padding: 10px;
        border-radius: 6px; overflow-x: auto; font-size: 11px; line-height: 1.5; white-space: pre-wrap; }
      .warn { background: rgba(226,192,141,.12); border: 1px solid #e2c08d; border-radius: 6px;
        padding: 8px 10px; margin: 8px 0; font-size: 12px; white-space: pre-wrap; }
      .ok-note { color:#89d185; font-size: 12px; }
      code { background: var(--vscode-textCodeBlock-background,#111); padding: 1px 5px; border-radius: 4px; }
      .modebar { display: flex; gap: 8px; margin: 4px 0 10px; }
      .modebar label { display: inline-flex; align-items: center; gap: 5px; font-size: 12px;
        background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border,#333);
        border-radius: 6px; padding: 5px 10px; cursor: pointer; }
      .modebar label.on { border-color: var(--vscode-focusBorder); }
      .panel { display: none; }
      .panel.on { display: block; }
    </style>
    <div class="modebar">
      <label class="mode on"><input type="radio" name="mode" value="A" checked> A · 从现有代码生成</label>
      <label class="mode"><input type="radio" name="mode" value="B"> B · 从设计蓝图生成（测试先行）</label>
    </div>

    <!-- Mode A -->
    <div class="panel on" id="panelA">
      <div class="card">
        <div class="fld">选择模块（按 include/ 自动发现，扫描 @exporter 公开 API）
          <select id="mod">${options}</select>
        </div>
        <div class="fld">生成策略：正向 + 边界 + 负向（默认，每个公开 API）</div>
        <div class="fld">输出位置：test_package/test/unit/&lt;module&gt;_test.cpp（main.cpp 由系统维护，不手改）</div>
        ${hint}
        <div class="row">
          <button id="previewBtn">预览生成的文件</button>
          <button id="createBtn" class="primary">创建测试文件</button>
        </div>
      </div>
      <div id="outA"></div>
    </div>

    <!-- Mode B -->
    <div class="panel" id="panelB">
      <div class="card">
        <div class="fld">模块名（小写标识符，契约测试与头文件同名）
          <input id="modB" value="mymod" />
        </div>
        <div class="fld">粘贴设计蓝图 / PRD 文本（支持 func/API 行或 PlantUML class）
          <textarea id="bp" rows="10" placeholder="例：
class ETL {
  + int vec_add(const float* a, const float* b, float* out, int n)
  + void reset()
}
要求：vec_add 返回 0 表示成功、-1 表示参数为空；reset 后内部计数清零。"></textarea>
        </div>
        <div class="fld">蓝图标题（写入实现计划文档）
          <input id="titleB" value="mymod 数值模块 PRD" />
        </div>
        <div class="fld">输出：契约测试 <code>test_package/test/unit/&lt;module&gt;_contract_test.cpp</code> ＋ 实现计划 <code>workspace/&lt;module&gt;-blueprint-plan.md</code></div>
        <div class="row">
          <button id="planBBtn">解析并预览（计划+契约）</button>
          <button id="createBBtn" class="primary">确认并生成文件</button>
        </div>
      </div>
      <div id="outB"></div>
    </div>

    <script>
      (function () {
        const $ = (s) => document.querySelector(s);
        const escH = (s) => String(s).replace(/[&<>"']/g, function (c) {
          return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });

        document.querySelectorAll('.mode input').forEach((r) =>
          r.addEventListener('change', () => {
            const onB = document.querySelector('input[name="mode"]:checked').value === 'B';
            document.querySelectorAll('.mode').forEach((l, i) => l.classList.toggle('on', i === (onB ? 1 : 0)));
            $('#panelA').classList.toggle('on', !onB);
            $('#panelB').classList.toggle('on', onB);
          }));

        $('#previewBtn').addEventListener('click', () => send({ type: 'preview', moduleName: $('#mod').value }));
        $('#createBtn').addEventListener('click', () => send({ type: 'create', moduleName: $('#mod').value }));
        const collectB = () => ({
          moduleName: $('#modB').value.trim(),
          blueprint: $('#bp').value,
          title: $('#titleB').value.trim(),
        });
        $('#planBBtn').addEventListener('click', () => send({ type: 'planB', input: collectB() }));
        $('#createBBtn').addEventListener('click', () => send({ type: 'createB', input: collectB() }));

        window.addEventListener('message', (e) => {
          const m = e.data;
          if (m.type === 'previewResult') {
            if (!m.ok) { $('#outA').innerHTML = '<div class="warn">' + m.issues.map(escH).join('<br/>') + '</div>'; return; }
            $('#outA').innerHTML = '<h2>预览：' + escH(m.relPath) + '</h2><pre>' + escH(m.content) + '</pre>' +
              '<div class="ok-note">仅新增文件，不改 include/ 与 src/。确认后点击「创建测试文件」。</div>';
          } else if (m.type === 'planBResult') {
            const p = m.preview;
            if (!p.ok) {
              $('#outB').innerHTML = '<div class="warn">无法生成：' + p.issues.map(escH).join('<br/>') + '</div>';
              return;
            }
            $('#outB').innerHTML =
              '<div class="ok-note">解析到 ' + p.contractCount + ' 个契约函数。</div>' +
              '<h2>契约测试：' + escH(p.testRelPath) + '</h2><pre>' + escH(p.testContent) + '</pre>' +
              '<h2>实现计划：' + escH(p.planRelPath) + '</h2><pre>' + escH(p.planContent) + '</pre>' +
              '<div class="ok-note">Mode B 只写测试契约与计划文档；include/src 需按计划实现后契约才转绿。确认后点「确认并生成文件」。</div>';
          }
        });
      })();
    </script>`;
}

