import * as vscode from 'vscode';
import { pageShell } from '../ui';
import { showDetailPanel } from '../detail/host';
import {
  PREFLIGHT_STYLE,
  itemsHtml,
  preflightInnerHtml,
  verdictHtml,
  verdictOf,
  type PreflightItem,
  type PreflightState,
} from './html';

export type { PreflightItem, PreflightState };

const EMPTY_STATE: PreflightState = { projectName: '', items: [], passed: 0, total: 0, allowRelease: false };

function stamp(at: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(at.getHours())}:${p(at.getMinutes())}:${p(at.getSeconds())}`;
}
export { verdictOf };

export interface PreflightDeps {
  getState: () => Promise<PreflightState>;
  runTests: () => Promise<{ ok: boolean; message: string }>;
  openQuality: () => Promise<void>;
  openRelease: () => Promise<void>;
}

/**
 * 发布前检查（L3）。
 *
 * §F.40（实测反馈：「按了重新检查，并不重新检查」）—— 三条硬规矩：
 *
 * 1. **整页只渲染一次**。刷新不再整页重写 HTML，而是发消息**局部替换**
 *    `#items` / `#verdict`（整页重载会丢滚动位置、闪一下，还会让人以为「点空了」）。
 * 2. **必须有可见反馈**：刷完在 `#note` 写一行带时间戳的结果 —— 结论与上次相同
 *    （很常见）时，否则用户只能靠「界面有没有变」猜按钮是否工作。
 * 3. **错误不许吞**：取数失败要把原因写回页面，而不是只留在 console。
 */
export function showPreflightPanel(context: vscode.ExtensionContext, deps: PreflightDeps): vscode.WebviewPanel {
  // §D：细节面板共用一个页签（切视图换内容）——实现原样搬进来，只把"谁来持有面板"交给 host。
  return showDetailPanel(context, { id: 'preflight', title: 'HeT DevTools — 发布前检查' }, (panel) => {
    /** 只回"可变部分"（列表 + 结论 + 提示），页面脚本按锚点替换。 */
    const push = async (note?: string): Promise<void> => {
      try {
        const state = await deps.getState();
        void panel.webview.postMessage({
          type: 'render',
          itemsHtml: itemsHtml(state.items),
          verdictHtml: verdictHtml(state),
          note: note ?? '',
        });
      } catch (err) {
        void panel.webview.postMessage({
          type: 'render',
          itemsHtml: '',
          verdictHtml: '',
          note: `检查失败：${err instanceof Error ? err.message : String(err)}`,
        });
      }
    };

    const sub = panel.webview.onDidReceiveMessage(async (message: { type: string }) => {
      if (message.type === 'refresh') {
        await push(`已重新检查 · ${stamp()} · 逐项重跑（结论与上次相同也不代表按钮没生效）`);
      } else if (message.type === 'runTests') {
        const r = await deps.runTests();
        void vscode.window.showInformationMessage(r.message);
        await push(`已重跑构建并测试 · ${stamp()} · ${r.message}`);
      } else if (message.type === 'openQuality') {
        await deps.openQuality();
      } else if (message.type === 'openRelease') {
        await deps.openRelease();
      }
    });

    // 首帧：整页一次（之后只走 push）。
    void (async (): Promise<void> => {
      try {
        const state = await deps.getState();
        panel.webview.html = buildHtml(state);
      } catch (err) {
        panel.webview.html = buildHtml(
          EMPTY_STATE,
          `检查失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();
    return sub;
  });
}

/** 首帧页面（之后 `#items` / `#verdict` / `#note` 由消息局部刷新）。 */
export function buildHtml(s: PreflightState, note = ''): string {
  return pageShell(
    '发布前检查',
    `${PREFLIGHT_STYLE}
    ${preflightInnerHtml(s, note)}
    <script>
      // §F.29/F.30：本页只有这一段脚本（pageShell 已在 <head> 取过 API）；交互走委托，
      // 刷新走**局部锚点替换**，不再整页重载。
      document.addEventListener('click', function (ev) {
        var el = ev.target instanceof Element ? ev.target : null;
        var btn = el && el.closest('[data-action]');
        if (btn && !btn.disabled) { send({ type: btn.getAttribute('data-action') }); }
      });
      window.addEventListener('message', function (ev) {
        var m = ev.data || {};
        if (m.type !== 'render') { return; }
        var note = document.getElementById('note');
        if (note) { note.textContent = m.note || ''; }
        var items = document.getElementById('items');
        if (items && typeof m.itemsHtml === 'string' && m.itemsHtml) { items.innerHTML = m.itemsHtml; }
        var verdict = document.getElementById('verdict');
        if (verdict && typeof m.verdictHtml === 'string' && m.verdictHtml) { verdict.innerHTML = m.verdictHtml; }
      });
    </script>
    `,
  );
}
