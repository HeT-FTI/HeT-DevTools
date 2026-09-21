import * as vscode from 'vscode';
import { esc, pageShell } from '../ui';
import { showDetailPanel, type SlotPanel } from '../slots/host';

export interface ReleaseState {
  projectName: string;
  version: string;
  buildType: string;
  releaseOn: boolean;
  docsOn: boolean;
  changelogExists: boolean;
  changelogHead: string;
  hasRemote: boolean;
  /**
   * 发布就绪判决（§F.41）：与 Preflight 面板 / L2 卡片**同一份** `summarizePreflight`
   * 的结果。以前这里只看"开关开没开"，于是出现"预检说不能发、发布中心说能发"。
   */
  verdict?: { allowRelease: boolean; fact: string; next?: string; firstFail?: string };
}

export interface ReleaseDeps {
  getState: () => Promise<ReleaseState>;
  toggleRelease: () => Promise<{ ok: boolean; message: string }>;
  openCommitRelease: () => Promise<void>;
  openChangelog: () => Promise<void>;
}

export function showReleasePanel(context: vscode.ExtensionContext, deps: ReleaseDeps): SlotPanel {
  // §D：细节面板共用一个页签（切视图换内容）——实现原样搬进来，只把"谁来持有面板"交给 host。
  return showDetailPanel(context, { id: 'release', title: 'HeT DevTools — 发布中心' }, (panel) => {

    const render = async (): Promise<void> => {
      const state = await deps.getState();
      panel.webview.html = buildHtml(state);
    };

    const sub = panel.webview.onDidReceiveMessage(async (message: { type: string }) => {
      if (message.type === 'refresh') {
        await render();
      } else if (message.type === 'toggleRelease') {
        const r = await deps.toggleRelease();
        void vscode.window.showInformationMessage(r.message);
        await render();
      } else if (message.type === 'openCommitRelease') {
        await deps.openCommitRelease();
      } else if (message.type === 'openChangelog') {
        await deps.openChangelog();
      }
    });

    void render().catch((e) => console.error('[het] release render failed', e));
    return sub;
  });
}

function buildHtml(s: ReleaseState): string {
  const noProject = s.projectName.length === 0;
  const releaseOff = !s.releaseOn;
  return pageShell(
    '发布中心',
    `
    <style>
      .warn { background: rgba(226,192,141,.12); border: 1px solid #e2c08d; border-radius: 6px;
        padding: 8px 10px; margin: 6px 0; font-size: 12px; }
      .ok-note { color:#89d185; font-size: 12px; margin: 6px 0; }
      pre { background: var(--vscode-textCodeBlock-background,#111); padding: 8px; border-radius: 6px;
        font-size: 11px; max-height: 220px; overflow:auto; }
      .step { display:flex; gap:8px; align-items:flex-start; margin: 6px 0; font-size: 12px; }
      .num { font-weight:700; opacity:.8; }
    </style>
    <div class="card">
      <h1>发布中心</h1>
      <div class="sub">项目：${esc(s.projectName || '—')} · v${esc(s.version || '?')} · ${esc(s.buildType || '?')}</div>
      ${noProject ? '<div class="warn">未检测到 fcpp 项目。</div>' : ''}
      <h2>发布就绪（与预检同源）</h2>
      ${s.verdict
        ? s.verdict.allowRelease
          ? `<div class="ok-note">✓ 可以发布 · ${esc(s.verdict.fact)}</div>`
          : `<div class="warn">✗ 还不能发布 · ${esc(s.verdict.fact)}
              ${s.verdict.next ? `<div class="tag">${esc(s.verdict.next)}</div>` : ''}
              ${s.verdict.firstFail ? `<div class="tag">首个红项：${esc(s.verdict.firstFail)}</div>` : ''}</div>`
        : '<div class="tag">尚未取到预检结果（打开「发布前检查」跑一遍）。</div>'}
      <h2>发布开关</h2>
      ${releaseOff
        ? `<div class="warn">发布开关未开启（workflow_triggers.release=false）。开启后带 📦 的提交才会触发 semantic-release。
            <div class="row"><button data-action="toggleRelease">⚙ 一键开启（含 build_type=Release）</button></div></div>`
        : `<div class="ok-note">✓ release 已开启 · build_type=Release（semantic-release 自动：定版本→CHANGELOG→metadata version→tag→GitHub Release）</div>`}
      ${!s.hasRemote ? '<div class="warn">未检测到 git 远程（origin）。发布依赖推送 GitHub。</div>' : ''}
      <h2>发布流程（全自动，你只需做第 2 步）</h2>
      <div class="step"><span class="num">①</span><span>开启发布开关 ───── ${s.releaseOn ? '✓ 已完成' : '待开启'}</span></div>
      <div class="step"><span class="num">②</span><span>提交带 📦 标签的消息（示例：chore(:package:): bump version）
        <div class="row"><button data-action="openCommitRelease">打开提交助手并预填 📦</button></div></span></div>
      <div class="step"><span class="num">③</span><span>推送到 GitHub → CI 自动执行（semantic-release）
        ${s.verdict && !s.verdict.allowRelease ? '<div class="tag">注意：发布前检查未就绪，CI 可能拦下（详见「发布前检查」）</div>' : ''}</span></div>
      <h2>版本规则（由提交前缀驱动）</h2>
      <div class="tag">feat → minor · fix/perf → patch · BREAKING CHANGE(!) → major · chore 不触发发版</div>
      <h2>CHANGELOG 预览</h2>
      ${s.changelogExists
        ? `<button data-action="openChangelog">打开 CHANGELOG.md</button>
           <pre>${esc(s.changelogHead || '（空）')}</pre>`
        : '<div class="tag">本地尚无 CHANGELOG.md（由 semantic-release 在发布时自动生成）。</div>'}
    </div>
    <script>
      // 事件委托 + pageShell 提供的全局 send()（本页不取 API，见 F.29）。
      document.addEventListener('click', function (ev) {
        var el = ev.target instanceof Element ? ev.target : null;
        var btn = el && el.closest('[data-action]');
        if (btn) { send({ type: btn.getAttribute('data-action') }); }
      });
    </script>
    `,
  );
}

