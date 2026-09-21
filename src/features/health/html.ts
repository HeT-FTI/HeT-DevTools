/**
 * 工程健康明细页的**纯 HTML**（不 import vscode，可单测）。
 *
 * 从 `extension.ts` 里搬出来的原因（§F.45 / 方案 D 收尾）：
 * 1. **细节页签**要能持有它 —— 面板实现必须能被 `showDetailPanel` 包起来，
 *    而原来它内嵌在扩展主文件里、自己 `createWebviewPanel`、自己写 `<script>`；
 * 2. 原实现每次重渲染都整页重写（`webview.html = …`），滚动位置会跳、页面会闪 ——
 *    这里改成"首帧整页 + 之后局部替换 `#body`"；
 * 3. 交互一律事件委托（F.29/F.30），不再用 `onclick=`。
 */
import { esc, pageShell } from '../ui';
import { verdictZh, type HealthReport } from '../../core/healthCheck';

/** 体检进行中时的提示（终态之间要有可见的"正在做"）。 */
export function healthBusyHtml(): string {
  return '<div class="card warn">⏳ 体检中…（完成后自动刷新）</div>';
}

function rowsHtml(r: HealthReport): string {
  return r.checks
    .map((c) => {
      const cls = c.kind === 'ok' ? 'ok' : c.kind === 'warn' ? 'warn' : 'fail';
      const mark = c.kind === 'ok' ? '✓' : c.kind === 'warn' ? '!' : '✗';
      const part =
        c.grade !== undefined
          ? Math.round(c.weight * c.grade)
          : c.kind === 'ok'
            ? c.weight
            : c.kind === 'warn'
              ? Math.round(c.weight * 0.5)
              : 0;
      return `<div class="row">
          <span class="title"><span class="${cls}">${mark}</span> <b>${esc(c.title)}</b> <span class="tag">${part}/${c.weight}</span></span>
        </div>
        <div class="detail">${esc(c.detail)}</div>
        ${c.suggestion ? `<div class="suggest">建议：${esc(c.suggestion)}</div>` : ''}`;
    })
    .join('');
}

/** 明细主体（健康分 + 逐项 + 建议）。没有报告时给出"还没体检"与入口。 */
export function healthBodyHtml(report: HealthReport | null, busy = false): string {
  const busyNote = busy ? healthBusyHtml() : '';
  if (!report) {
    return `<h1>工程健康</h1>
      <div class="sub">尚未体检 — 点「重新体检」，或先在项目里构建/测试（构建与测试结果会计入）。</div>
      ${busyNote}
      <div class="row"><button data-action="rerun" class="primary">🩺 重新体检</button></div>`;
  }
  const toneCls = report.verdict === 'PASS' ? 'ok' : report.verdict === 'WARN' ? 'warn' : 'fail';
  return `<h1>工程健康：<span class="${toneCls}">${report.score}/100 · ${esc(verdictZh(report.verdict))}</span></h1>
    <div class="sub">${report.checks.length} 项规则 · 绿≥80% · 黄≥50% · 红不达标（细粒度分级打分）</div>
    ${busyNote}
    <div class="card">${rowsHtml(report)}</div>
    <div class="row"><button data-action="rerun" class="primary">🩺 重新体检</button></div>`;
}

/** 首帧页面（之后 `#body` 由宿主消息局部替换）。 */
export function healthPageHtml(report: HealthReport | null, busy = false): string {
  return pageShell(
    '工程健康明细',
    `
    <style>
      .ok { color: var(--vscode-testing-iconPassed,#3fb950); }
      .warn { color: var(--vscode-editorWarning-foreground,#d29922); }
      .fail { color: var(--vscode-testing-iconFailed,#f85149); }
      .suggest { opacity: .85; font-size: 12px; margin: 2px 0 8px; }
      .detail { opacity: .8; font-size: 12px; }
    </style>
    <div id="body">${healthBodyHtml(report, busy)}</div>
    <script>
      // 唯一一段脚本（pageShell 已在 <head> 取过 API）：委托 + 局部替换。
      document.addEventListener('click', function (ev) {
        var el = ev.target instanceof Element ? ev.target : null;
        var btn = el && el.closest('[data-action]');
        if (btn && !btn.disabled) { send({ type: btn.getAttribute('data-action') }); }
      });
      window.addEventListener('message', function (ev) {
        var m = ev.data || {};
        if (m.type !== 'health' || typeof m.html !== 'string') { return; }
        var body = document.getElementById('body');
        if (body) { body.innerHTML = m.html; }
      });
    </script>
    `,
  );
}
