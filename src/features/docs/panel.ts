import * as vscode from 'vscode';
import { esc, pageShell } from '../ui';
import { showDetailPanel, type SlotPanel } from '../slots/host';

export interface DocToolStatus {
  name: string;
  ok: boolean;
  note?: string;
}

export interface DocArtifact {
  rel: string;
  abs: string;
}

export interface DocsState {
  projectName: string;
  languages: string[];
  versions: string[];
  tools: DocToolStatus[];
  graphvizMismatch: boolean;
  graphvizCurrent: string;
  graphvizExpected: string;
  artifacts: DocArtifact[];
}

export interface DocsDeps {
  getState: () => Promise<DocsState>;
  runDocs: () => Promise<{ ok: boolean; message: string }>;
  fixGraphviz: () => Promise<{ ok: boolean; message: string }>;
  openArtifact: (rel: string) => Promise<void>;
}

export function showDocsPanel(context: vscode.ExtensionContext, deps: DocsDeps): SlotPanel {
  // §D：细节面板共用一个页签（切视图换内容）——实现原样搬进来，只把"谁来持有面板"交给 host。
  return showDetailPanel(context, { id: 'docs', title: 'HeT DevTools — 文档中心' }, (panel) => {

    // V5-6: visible busy state while docs build (spinner in-panel, like chip).
    let busy = false;
    const render = async (): Promise<void> => {
      const state = await deps.getState();
      panel.webview.html = buildHtml(state, busy);
    };

    const sub = panel.webview.onDidReceiveMessage(async (message: { type: string; rel?: string; family?: string }) => {
      if (message.type === 'refresh') {
        await render();
      } else if (message.type === 'runDocs') {
        busy = true;
        await render();
        const r = await deps.runDocs();
        busy = false;
        const st = await deps.getState();
        const hasSph = st.artifacts.some((a) => a.rel.startsWith('docs/sphinx/'));
        const hasDox = st.artifacts.some((a) => a.rel.startsWith('docs/doxygen/'));
        const buttons: string[] = [];
        if (hasSph) {
          buttons.push('打开 Sphinx 文档');
        }
        if (hasDox) {
          buttons.push('打开 Doxygen 文档');
        }
        if (r.ok && buttons.length > 0) {
          const pick = await vscode.window.showInformationMessage(r.message, ...buttons);
          if (pick === '打开 Sphinx 文档') {
            void vscode.commands.executeCommand('het.openDocsArtifact', 'sphinx');
          } else if (pick === '打开 Doxygen 文档') {
            void vscode.commands.executeCommand('het.openDocsArtifact', 'doxygen');
          }
        } else {
          void vscode.window.showInformationMessage(r.message);
        }
        await render();
      } else if (message.type === 'fixGraphviz') {
        const r = await deps.fixGraphviz();
        void vscode.window.showInformationMessage(r.message);
        await render();
      } else if (message.type === 'openArtifact' && message.rel) {
        await deps.openArtifact(message.rel);
      } else if (message.type === 'openFamily' && message.family) {
        await vscode.commands.executeCommand('het.openDocsArtifact', message.family);
      }
    });

    void render().catch((e) => console.error('[het] docs render failed', e));
    return sub;
  });
}

function buildHtml(state: DocsState, busy = false): string {
  const noProject = state.projectName.length === 0;
  const busyNote = busy
    ? '<div class="warn">⏳ 正在生成文档（Doxygen + Sphinx）… 完成后自动刷新，产物入口点 “刷新”。</div>'
    : '';
  const toolChips = state.tools
    .map((t) => `<span class="chip ${t.ok ? 'ok' : 'fail'}">${esc(t.name)} ${t.ok ? '✓' : '✗'}</span>`)
    .join(' ');

  const graphviz = state.graphvizMismatch
    ? `<div class="warn">⚠ Graphviz 路径与当前系统不匹配（配置为 <code>${esc(state.graphvizCurrent)}</code>，本机为 <code>${esc(state.graphvizExpected)}</code>）。机器相关值提交前请还原。
        <br/><button data-action="fixGraphviz">🔧 本机修正</button></div>`
    : '';

  const missing = state.tools.filter((t) => !t.ok);
  const missingBanner =
    missing.length > 0
      ? `<div class="warn">缺少工具：${missing.map((t) => `${esc(t.name)} ✗`).join(' ')}
          <div class="tag">文档功能仅在使用时才需要。安装指引（复制到终端）：
          <pre># Windows (conda-forge build 环境示例)
conda install -n build -c conda-forge doxygen graphviz sphinx sphinx-intl sphinx_rtd_theme make python
# Linux
sudo apt install doxygen graphviz make python3-sphinx</pre></div></div>`
      : '';

  const chips =
    state.languages.length === 0 && state.versions.length === 0
      ? '<div class="tag">metadata.json 未配置 doc_languages / doc_versions（默认 en/zh、1.0）。</div>'
      : `<div class="row">
           <span class="tag">语言：</span>${state.languages.map((l) => `<span class="chip">${esc(l)}</span>`).join(' ')}
           <span class="tag" style="margin-left:14px">版本：</span>${state.versions.map((v) => `<span class="chip">${esc(v)}</span>`).join(' ')}
         </div>`;

  const artifacts =
    state.artifacts.length === 0
      ? '<div class="tag">尚未找到文档产物。点击「一键生成文档」。</div>'
      : state.artifacts
          .map(
            (a) =>
              `<div class="row"><span class="fname">📄 ${esc(a.rel)}</span>
               <button data-action="openArtifact" data-rel="${esc(a.rel)}">在浏览器打开</button></div>`,
          )
          .join('');

  const hasDox = state.artifacts.some((a) => a.rel.startsWith('docs/doxygen/'));
  const hasSph = state.artifacts.some((a) => a.rel.startsWith('docs/sphinx/'));
  const entryRow = `<div class="row">
      <button data-action="openFamily" data-family="doxygen" ${hasDox ? '' : 'disabled'}>打开 Doxygen 文档</button>
      <button data-action="openFamily" data-family="sphinx" ${hasSph ? '' : 'disabled'}>打开 Sphinx 文档</button>
      <span class="tag">${hasDox || hasSph ? '构建成功即可点击（默认浏览器打开）' : '未发现产物（构建成功后点亮）'}</span>
    </div>`;

  return pageShell(
    '文档中心',
    `
    <style>
      .warn { background: rgba(226,192,141,.12); border: 1px solid #e2c08d; border-radius: 6px;
        padding: 8px 10px; margin: 8px 0; font-size: 12px; }
      .tag { font-size: 11px; opacity: .75; }
      .fname { flex: 1; font-size: 12px; }
      button[disabled] { opacity: .4; pointer-events: none; }
      pre { background: var(--vscode-textCodeBlock-background,#111); padding: 8px; border-radius: 6px; font-size: 11px; }
      code { background: var(--vscode-textCodeBlock-background,#111); padding: 1px 5px; border-radius: 4px; }
    </style>
    <div class="card">
      <h1>文档中心</h1>
      <div class="sub">项目：${esc(state.projectName || '—')} · 一键生成 Doxygen + Sphinx 双语多版本文档</div>
      ${noProject ? '<div class="warn">未检测到 fcpp 项目：请先打开含 metadata.json 的库文件夹。</div>' : ''}
      ${busyNote}
      ${graphviz}
      ${missingBanner}
      <h2>语言与版本（来自 metadata.json）</h2>
      ${chips}
      <h2>工具</h2>
      <div class="row">${toolChips}</div>
      <div class="row">
        <button data-action="runDocs">📖 一键生成文档</button>
        <button data-action="refresh" class="secondary">🔄 刷新</button>
      </div>
      <h2>快捷入口</h2>
      ${entryRow}
      <h2>产物</h2>
      ${artifacts}
    </div>
    <script>
      (function () {
        document.querySelectorAll('button[data-action]').forEach((b) =>
          b.addEventListener('click', () => {
            const act = b.getAttribute('data-action');
            if (act === 'openArtifact') {
              send({ type: 'openArtifact', rel: b.getAttribute('data-rel') });
            } else if (act === 'openFamily') {
              send({ type: 'openFamily', family: b.getAttribute('data-family') });
            } else {
              send({ type: act });
            }
          }));
      })();
    </script>
    `,
  );
}

