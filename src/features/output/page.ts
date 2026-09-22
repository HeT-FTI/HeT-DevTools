/**
 * 页内「输出」视图的整页 HTML（`pageShell` + **仅一段脚本**）。
 *
 * 遵守 F.29：一个文档只 `acquireVsCodeApi()` 一次 —— 这里用 pageShell 暴露的 `send()`。
 * 交互走事件委托（三个控件 + 清空按钮），所以 host 重新渲染整页时不会留下"死按钮"。
 */
import { pageShell } from '../ui';
import type { LogEntry } from '../../core/outputChannels';
import { outputViewHtml, type OutputFilterState } from './html';

const CSS = `
  .out-bar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 8px 0; }
  .out-sel, .out-kw { background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, #3c3c3c); border-radius: 4px; padding: 4px 6px; font-size: .85em; }
  .out-kw { flex: 1; min-width: 160px; }
  .out-count { font-size: .8em; opacity: .7; }
  .out-list { max-height: min(60vh, 520px); overflow: auto; border-top: 1px solid var(--vscode-widget-border, #333); }
  .out-row { display: flex; gap: 8px; padding: 2px 0; font-family: var(--vscode-editor-font-family, monospace); font-size: .82em; }
  .out-t { opacity: .6; }
  .out-d { min-width: 5.5em; opacity: .85; }
  .out-l { min-width: 3.5em; }
  .out-x { overflow-wrap: anywhere; }
  .lv-fail .out-l, .lv-fail .out-x { color: var(--vscode-errorForeground); }
  .lv-timeout .out-l, .lv-cancel .out-l { opacity: .8; }
  .lv-ok .out-l { color: var(--vscode-testing-iconPassed, #73c991); }
  .out-empty { padding: 10px 2px; opacity: .7; font-size: .85em; }
`;

/** 整页（纯函数，可单测）。 */
export function outputViewPageHtml(entries: readonly LogEntry[], filter: OutputFilterState): string {
  return pageShell(
    '输出：HeT DevTools',
    `<style>${CSS}</style>
    <div class="card">
      <h1>输出：HeT DevTools</h1>
      <div class="sub">只有一个输出通道；域的区分在行首（域/级别/关键字是本页面的过滤条件）。</div>
      <div id="out-root">${outputViewHtml(entries, filter)}</div>
      <div class="row"><button class="secondary" data-act="outputReveal">在输出面板里打开</button></div>
    </div>
    <script>
      // 交互全部走事件委托（F.29/F.30）；用 pageShell 提供的 send()，**不要**再取 API。
      function currentFilter() {
        var d = document.querySelector('[data-out="domain"]');
        var l = document.querySelector('[data-out="level"]');
        var k = document.querySelector('[data-out="keyword"]');
        return {
          type: 'output:filter',
          domain: d ? d.value : '',
          level: l ? l.value : '',
          keyword: k ? k.value : ''
        };
      }
      document.addEventListener('change', function (ev) {
        var el = ev.target instanceof Element ? ev.target : null;
        if (el && el.hasAttribute('data-out')) { send(currentFilter()); }
      });
      var kwTimer = null;
      document.addEventListener('input', function (ev) {
        var el = ev.target instanceof Element ? ev.target : null;
        if (!el || el.getAttribute('data-out') !== 'keyword') { return; }
        // 输入防抖：每敲一个字就整页重渲染会把焦点抖掉
        if (kwTimer) { clearTimeout(kwTimer); }
        kwTimer = setTimeout(function () { kwTimer = null; send(currentFilter()); }, 250);
      });
      document.addEventListener('click', function (ev) {
        var el = ev.target instanceof Element ? ev.target : null;
        if (!el) { return; }
        var btn = el.closest('[data-act]');
        if (!btn) { return; }
        var act = btn.getAttribute('data-act');
        if (act === 'outputClear') {
          var d = document.querySelector('[data-out="domain"]');
          var l = document.querySelector('[data-out="level"]');
          var k = document.querySelector('[data-out="keyword"]');
          if (d) { d.value = ''; }
          if (l) { l.value = ''; }
          if (k) { k.value = ''; }
          send(currentFilter());
        } else if (act === 'outputReveal') {
          send({ type: 'output:reveal' });
        }
      });
    </script>`,
  );
}
