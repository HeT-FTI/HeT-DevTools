import * as vscode from 'vscode';
import { esc, pageShell } from '../ui';
import { ChangeEntry, TriggerEmoji, TRIGGER_EMOJIS } from '../../core/commitAssistant';
import { showDetailPanel, type SlotPanel } from '../slots/host';

export interface CommitState {
  projectName: string;
  branch: string;
  changes: ChangeEntry[];
  /** workflow_triggers.* enabled flags for emoji cards. */
  triggers: Record<string, boolean>;
  buildType: string;
  triggerTests: boolean;
  suggestedType: string;
  suggestedEmojiId: string | null;
  initialSubject: string;
}

export interface CommitRequest {
  type: string;
  emoji: string | null;
  breaking: boolean;
  subject: string;
  push: boolean;
  paths: string[];
}

export interface CommitDeps {
  getState: () => Promise<CommitState>;
  commit: (request: CommitRequest) => Promise<{ ok: boolean; message: string }>;
}

export function showCommitPanel(context: vscode.ExtensionContext, deps: CommitDeps): SlotPanel {
  // §D：细节面板共用一个页签（切视图换内容）——实现原样搬进来，只把"谁来持有面板"交给 host。
  return showDetailPanel(context, { id: 'commit', title: 'HeT DevTools — 提交助手' }, (panel) => {

    const render = async (): Promise<void> => {
      const state = await deps.getState();
      panel.webview.html = buildHtml(state);
    };

    const sub = panel.webview.onDidReceiveMessage(async (message: { type: string; req?: CommitRequest }) => {
      if (message.type === 'refresh') {
        await render();
      } else if (message.type === 'commit' && message.req) {
        const r = await deps.commit(message.req);
        void vscode.window.showInformationMessage(r.message);
        await render();
      }
    });

    void render().catch((e) => console.error('[het] commit render failed', e));
    return sub;
  });
}

function emojiCardHtml(t: TriggerEmoji, enabled: boolean, selected: boolean): string {
  return `<button class="emoji ${selected ? 'sel' : ''} ${enabled ? '' : 'off'}" data-emoji="${esc(t.id)}" ${enabled ? '' : 'disabled'}
            title="${esc(t.label)} · ${enabled ? '已开启' : '开关关（开启后才触发对应 CI）'}">${esc(t.emoji.replace(/:/g, ''))}<span>${esc(t.label)}</span></button>`;
}

function buildHtml(state: CommitState): string {
  const noProject = state.projectName.length === 0;
  const fileRows = state.changes
    .map(
      (c) => `<label class="filerow">
        <input type="checkbox" class="filepick" value="${esc(c.path)}" checked />
        <span class="st ${c.staged ? 'ok' : ''}">${c.staged ? '已暂存' : c.status}</span>
        <span class="p">${esc(c.path)}</span>
      </label>`,
    )
    .join('');

  const cards = TRIGGER_EMOJIS.map((t) => {
    const key = t.switchKey;
    const enabled = key ? state.triggers[key] === true : true;
    const selected = state.suggestedEmojiId === t.id;
    return emojiCardHtml(t, enabled, selected);
  }).join('');

  const typeOptions = ['feat', 'fix', 'perf', 'docs', 'test', 'build', 'ci', 'refactor', 'style', 'chore']
    .map((t) => `<option value="${t}" ${t === state.suggestedType ? 'selected' : ''}>${t}</option>`)
    .join('');

  return pageShell(
    '提交助手',
    `
    <style>
      .filerow { display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 3px 0; cursor: pointer; }
      .filerow .p { flex: 1; }
      .filerow .st { font-size: 10px; opacity: .7; width: 52px; }
      .filerow .st.ok { color: #89d185; }
      .emoji { display: inline-flex; flex-direction: column; align-items: center; gap: 2px; min-width: 74px;
        background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border,#333);
        border-radius: 6px; padding: 6px 4px; margin: 2px 4px 2px 0; cursor: pointer; font-size: 20px; }
      .emoji span { font-size: 10px; }
      .emoji.sel { border-color: var(--vscode-focusBorder); }
      .emoji.off { opacity: .45; }
      .preview { font-family: var(--vscode-editor-font-family); font-size: 12px;
        background: var(--vscode-textCodeBlock-background,#111); padding: 8px; border-radius: 6px; margin: 6px 0; }
      .tag2 { font-size: 11px; opacity: .7; }
      select, input[type=text] { width: 100%; padding: 6px; margin: 4px 0;
        background: var(--vscode-input-background); color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border,#555); border-radius: 4px; }
      .warn { background: rgba(226,192,141,.12); border: 1px solid #e2c08d; border-radius: 6px;
        padding: 8px 10px; margin: 6px 0; font-size: 12px; }
    </style>
    <div class="card">
      <h1>提交助手</h1>
      <div class="sub">${state.branch ? `分支：${esc(state.branch)}` : ''} · 双通道：type 决定版本号，emoji 决定 CI 流水线</div>
      ${noProject ? '<div class="warn">未检测到 fcpp 项目。</div>' : ''}
      <h2>变更文件（勾选要提交的）</h2>
      <div id="files">${fileRows || '<div class="tag2">工作区无变更。</div>'}</div>
      <h2>提交类型与标签</h2>
      <select id="type">${typeOptions}</select>
      <div class="row" style="flex-wrap:wrap">${cards}</div>
      <div class="row"><label class="tag2"><input type="checkbox" id="breaking"> breaking（! 主版本 +1）</label></div>
      <input type="text" id="subject" placeholder="一句话描述（英文佳）" value="${esc(state.initialSubject)}" />
      <h2>预览</h2>
      <div class="preview" id="preview"></div>
      <div class="row">
        <button id="commitBtn" class="primary">✓ 提交</button>
        <button id="pushBtn" class="secondary">✓ 提交并推送</button>
      </div>
    </div>
    <script>
      (function () {
        const $ = (s) => document.querySelector(s);
        const EMOJI = ${JSON.stringify(TRIGGER_EMOJIS.map((t) => ({ id: t.id, emoji: t.emoji })))};
        let selEmoji = ${JSON.stringify(state.suggestedEmojiId)};
        const pickPaths = () => Array.from(document.querySelectorAll('.filepick:checked')).map((c) => c.value);
        const header = () => {
          const type = $('#type').value;
          const e = EMOJI.find((x) => x.id === selEmoji);
          const scope = e && e.emoji ? '(' + e.emoji + ')' : '';
          const bang = $('#breaking').checked ? '!' : '';
          const subject = $('#subject').value.trim();
          return type + scope + bang + ': ' + subject;
        };
        const update = () => { $('#preview').textContent = header() || '—'; };
        $('#type').addEventListener('change', update);
        $('#subject').addEventListener('input', update);
        $('#breaking').addEventListener('change', update);
        document.querySelectorAll('.emoji').forEach((b) =>
          b.addEventListener('click', () => {
            if (b.disabled) { return; }
            document.querySelectorAll('.emoji').forEach((x) => x.classList.remove('sel'));
            b.classList.add('sel');
            selEmoji = b.getAttribute('data-emoji');
            update();
          }));
        const collect = (push) => ({
          type: $('#type').value,
          emoji: selEmoji,
          breaking: $('#breaking').checked,
          subject: $('#subject').value.trim(),
          push,
          paths: pickPaths(),
        });
        $('#commitBtn').addEventListener('click', () => send({ type: 'commit', req: collect(false) }));
        $('#pushBtn').addEventListener('click', () => send({ type: 'commit', req: collect(true) }));
        update();
      })();
    </script>
    `,
  );
}
