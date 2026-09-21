import * as vscode from 'vscode';
import { esc, pageShell } from '../ui';
import { LocalWorkflow } from '../../core/ciStatus';
import { showDetailPanel, type SlotPanel } from '../slots/host';

export interface CiRunInfo {
  name: string;
  branch: string;
  status: string;
  conclusion: string;
  createdAt: string;
  url: string;
}

export interface CiState {
  repoLabel: string;
  tier: 'vscode' | 'gh' | 'anonymous' | 'offline';
  tierLabel: string;
  hint: string;
  workflows: LocalWorkflow[];
  runs: CiRunInfo[];
  online: boolean;
  actionsUrl: string;
  /** 拿不到远端状态时的"为什么"（§F.43：不许只说"无法访问 GitHub"）。 */
  reason?: string;
  /** 拿不到远端状态时的"怎么办"。 */
  fix?: string[];
}

export interface CiDeps {
  getState: () => Promise<CiState>;
  openActions: () => Promise<void>;
}

export function showCiPanel(context: vscode.ExtensionContext, deps: CiDeps): SlotPanel {
  // §D：细节面板共用一个页签（切视图换内容）——实现原样搬进来，只把"谁来持有面板"交给 host。
  return showDetailPanel(context, { id: 'ci', title: 'HeT DevTools — CI 状态' }, (panel) => {

    const render = async (): Promise<void> => {
      const state = await deps.getState();
      panel.webview.html = buildHtml(state);
    };

    const sub = panel.webview.onDidReceiveMessage(async (message: { type: string }) => {
      if (message.type === 'refresh') {
        await render();
      } else if (message.type === 'openActions') {
        await deps.openActions();
      }
    });

    void render().catch((e) => console.error('[het] ci render failed', e));
      return sub;
  });
}

function buildHtml(s: CiState): string {
  const tierClass = s.tier === 'anonymous' || s.tier === 'offline' ? 'chip' : 'chip ok';
  const wf = s.workflows
    .map((w) => `<div class="row"><span class="chip">${esc(w.name)}</span><span class="tag">${esc(w.on.join(' / '))}</span><span class="fname">${esc(w.file)}</span></div>`)
    .join('');
  const runs =
    s.runs.length === 0
      ? '<div class="tag">暂无远端运行数据。</div>'
      : s.runs
          .map(
            (r) =>
              `<div class="row"><span class="chip ${r.conclusion === 'success' ? 'ok' : r.conclusion === 'failure' ? 'fail' : ''}">${esc(r.conclusion || r.status)}</span><span class="fname">${esc(r.name)} · ${esc(r.branch)}</span><span class="tag">${esc(r.createdAt)}</span></div>`,
          )
          .join('');
  // §F.43（实测反馈："无法访问 github" 看不出该怎么办）：给出**原因 + 可照做的下一步**。
  const fixList = (s.fix ?? [])
    .map((f) => `<li>${esc(f)}</li>`)
    .join('');
  const offlineNote = s.online
    ? ''
    : `<div class="warn">当前拿不到 GitHub Actions 的远端状态。
        ${s.reason ? `<div><b>为什么：</b>${esc(s.reason)}</div>` : ''}
        <div><b>界面里还能做什么：</b>本地工作流清单照常展示；「在 GitHub 打开 Actions」按钮不依赖登录。</div>
        ${fixList ? `<div><b>怎么办：</b><ul>${fixList}</ul></div>` : ''}
        <div class="tag">能力矩阵（D-9）：匿名=公开仓库只读 · 登录后=私有仓库可读 · gh 缺失=只能看本地清单。</div>
      </div>`;
  return pageShell(
    'CI 状态',
    `
    <style>
      .fname { flex:1; font-size:12px; }
      .warn { background: rgba(226,192,141,.12); border: 1px solid #e2c08d; border-radius: 6px;
        padding: 8px 10px; margin: 6px 0; font-size: 12px; }
    </style>
    <div class="card">
      <h1>CI 状态</h1>
      <div class="sub">仓库：${esc(s.repoLabel || '—')} <span class="${tierClass}">${esc(s.tierLabel)}</span></div>
      <div class="tag">${esc(s.hint)}</div>
      ${offlineNote}
      <div class="row">
        <button data-action="refresh">🔄 刷新</button>
        <button data-action="openActions" ${s.actionsUrl ? '' : 'disabled'}>在 GitHub 打开 Actions</button>
      </div>
      <h2>运行状态（最近）</h2>
      ${runs}
      <h2>本地工作流（.github/workflows）</h2>
      ${wf || '<div class="tag">无 .github/workflows（非模板项目或未同步）。</div>'}
    </div>
    <script>
      (function () {
        document.querySelectorAll('button[data-action]').forEach((b) =>
          b.addEventListener('click', () => send({ type: b.getAttribute('data-action') })));
      })();
    </script>
    `,
  );
}
