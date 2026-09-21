import * as vscode from 'vscode';
import { esc, pageShell } from '../ui';
import { onStateChange } from '../live';
import { showDetailPanel } from '../detail/host';

export interface CoverageState {
  /** Current project name ('' when none). */
  projectName: string;
  /** metadata.json activate_code_coverage flag. */
  enabled: boolean;
  /** Absolute path of a located coverage_report/index.html ('' when none). */
  reportPath: string;
}

export interface CoverageDeps {
  getState: () => Promise<CoverageState>;
  /** Persist activate_code_coverage, then refresh. */
  toggle: (enabled: boolean) => Promise<{ ok: boolean; message: string }>;
  /** Run the coverage build+test then report the located report path. */
  runCoverage: () => Promise<{ ok: boolean; message: string }>;
}

export function showCoveragePanel(context: vscode.ExtensionContext, deps: CoverageDeps): vscode.WebviewPanel {
  // §D：细节面板共用一个页签（切视图换内容）——实现原样搬进来，只把"谁来持有面板"交给 host。
  return showDetailPanel(context, { id: 'coverage', title: 'HeT DevTools — 覆盖率' }, (panel) => {

    const render = async (): Promise<void> => {
      if (panelIsDisposed) {
        return;
      }
      const state = await deps.getState();
      if (!panelIsDisposed) {
        panel.webview.html = buildHtml(state);
      }
    };

    // V5-6 (issue-3): stay byte-synced with the chip — any state change
    // (build/test/coverage elsewhere) repaints this panel too.
    let panelIsDisposed = false;
    const unsubscribe = onStateChange(() => void render());
    panel.onDidDispose(() => {
      panelIsDisposed = true;
      unsubscribe();
    });

    const sub = panel.webview.onDidReceiveMessage(async (message: { type: string; enabled?: boolean }) => {
      if (message.type === 'toggle' && typeof message.enabled === 'boolean') {
        const r = await deps.toggle(message.enabled);
        void vscode.window.showInformationMessage(r.message);
        await render();
      } else if (message.type === 'runCoverage') {
        const r = await deps.runCoverage();
        void vscode.window.showInformationMessage(r.message);
        await render();
      } else if (message.type === 'openReport') {
        const state = await deps.getState();
        if (state.reportPath) {
          void vscode.env.openExternal(vscode.Uri.file(state.reportPath));
        }
      }
    });

    void render().catch((e) => console.error('[het] coverage render failed', e));
    return sub;
  });
}

function buildHtml(state: CoverageState): string {
  const noProject = state.projectName.length === 0;
  const banner = noProject
    ? '<div class="card fail">未检测到 fcpp 项目：请先打开含 metadata.json 的库文件夹。</div>'
    : !state.enabled
      ? '<div class="card warn">覆盖率开关未开启（<code>activate_code_coverage=false</code>）。开启后“构建并测覆盖率”走 g++/gcov 车道（Linux CI 同源），MSVC 本机请改用 WSL/CI 生成。</div>'
      : '<div class="card ok">activate_code_coverage=true — 覆盖率构建已启用。</div>';

  const toggleBtn = noProject
    ? ''
    : `<button data-action="toggle" data-value="${state.enabled ? 'false' : 'true'}" class="${state.enabled ? 'secondary' : ''}">${state.enabled ? '关闭 activate_code_coverage' : '一键开启 activate_code_coverage'}</button>`;

  const report = state.reportPath
    ? `<div class="card ok">报告就绪：<code>${esc(state.reportPath)}</code>
       <div class="row"><button data-action="openReport">在浏览器打开报告</button></div></div>`
    : '<div class="tag">尚未找到 coverage_report/index.html。点击下方按钮构建并测量覆盖率。</div>';

  return pageShell(
    '覆盖率',
    `<h1>覆盖率</h1>
     <div class="sub">项目：${esc(state.projectName || '—')}</div>
     ${banner}
     <div class="card">
       <div class="row">${toggleBtn}
         <button data-action="runCoverage">🔄 构建并测覆盖率</button>
       </div>
       ${report}
     </div>
     <script>
       (function () {
         document.querySelectorAll('[data-action]').forEach((b) =>
           b.addEventListener('click', () => {
             const act = b.getAttribute('data-action');
             if (act === 'toggle') {
               send({ type: 'toggle', enabled: b.getAttribute('data-value') === 'true' });
             } else {
               send({ type: act });
             }
           }));
       })();
     </script>`,
  );
}

