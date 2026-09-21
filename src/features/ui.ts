import { HealthReport } from '../core/healthCheck';
import { FcppProject, ToolStatus } from '../types';

/** Everything the dashboard/welcome panels need to render a snapshot. */
export interface DashboardSnapshot {
  project?: FcppProject;
  tools: Record<string, ToolStatus>;
  health?: HealthReport;
}

/** HTML-escape arbitrary values for safe interpolation into webviews. */
export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

/** Theme-aware base stylesheet for all HeT webviews. */
export const BASE_CSS = `
<style>
  :root {
    color-scheme: light dark;
  }
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 16px 20px;
    margin: 0;
  }
  h1 { font-size: 18px; margin: 0 0 4px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .5px; opacity: .8; margin: 18px 0 8px; }
  .sub { opacity: .75; margin-bottom: 10px; font-size: 12px; }
  .card {
    background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-widget-border, #333);
    border-radius: 8px;
    padding: 12px 14px;
    margin: 8px 0;
  }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px; }
  .score-big { font-size: 44px; font-weight: 700; line-height: 1; }
  .ok   { color: #89d185; }
  .warn { color: #e2c08d; }
  .fail { color: #f14c4c; }
  .chip {
    display: inline-block; padding: 2px 8px; margin: 2px 4px 2px 0;
    border-radius: 10px; font-size: 11px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  }
  .chip.ok { background: #388a34; color: #fff; }
  .chip.fail { background: #a1260d; color: #fff; }
  .row { display: flex; align-items: center; gap: 8px; padding: 3px 0; }
  .row .title { flex: 1; }
  .detail { font-size: 11px; opacity: .8; padding-left: 18px; }
  .suggest { font-size: 11px; opacity: .7; font-style: italic; padding-left: 18px; }
  button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none; border-radius: 4px;
    padding: 5px 12px; margin: 4px 6px 4px 0; cursor: pointer;
    font-size: var(--vscode-font-size);
  }
  button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  button:hover { opacity: .9; }
  .switch-row { display: flex; align-items: center; gap: 6px; }
  .tag { font-size: 11px; opacity: .7; }
</style>`;

export function pageShell(title: string, inner: string): string {
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
${BASE_CSS}
<script>
  // 本页**唯一**获取 VS Code API 的地方。同一文档里 acquireVsCodeApi() 只能调用一次，
  // 第二次会抛 "An instance of the VS Code API has already been acquired"，把该 script
  // 里后面的代码整段带走（页面按钮全部变哑 —— 见 F.29 质量面板那次）。
  // 两条配套规则：
  // · **片段 HTML 禁止自带 <script>**，要发消息就调用这里的全局 send()；
  // · 这段放在 <head> 里，保证它在任何页面片段脚本**之前**就绪（不靠"谁先跑"）。
  const vscode = acquireVsCodeApi();
  function send(msg) { vscode.postMessage(msg); }
  function post(cmd) { vscode.postMessage({ type: 'command', command: cmd }); }
  function refresh() { vscode.postMessage({ type: 'refresh' }); }
</script>
</head>
<body>
${inner}
</body>
</html>`;
}
