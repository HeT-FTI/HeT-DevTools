/**
 * 「质量与安全」页面的**纯 HTML 生成**（不 import vscode，可直接单测）。
 *
 * 两条硬规则（F.29 —— 质量面板"点一次之后就不响应"那次）：
 *
 * 1. **一个文档里只能 `acquireVsCodeApi()` 一次**（第二次会抛
 *    "An instance of the VS Code API has already been acquired"，且把该 script 里
 *    后面的绑定代码整段带走 → 页面按钮全部变哑）。所以：API 只在 `pageShell` 里取；
 *    本模块产出的**任何片段都不带 `<script>`**。
 * 2. 交互一律**事件委托**（`document.addEventListener('click', …)` + `closest()`），
 *    页面用 `#rows` / `#detail` 两个锚点做**局部刷新**，不整页重载 ——
 *    这样"重渲染一次之后按钮失效"的错法从根上不可能发生。
 */
import { QualityIssue } from '../../core/qualityGates';
import { esc, pageShell } from '../ui';

export type GateRowStatus = 'pass' | 'fail' | 'na' | 'idle';

export interface QualityRow {
  id: string;
  label: string;
  status: GateRowStatus;
  tool: string;
  detail?: string;
}

export interface QualityRunResult {
  rowId: string;
  status: GateRowStatus;
  summary: string;
  issues: QualityIssue[];
  errors: string[];
}

const STATUS_ICON: Record<GateRowStatus, string> = {
  pass: '✓',
  fail: '✗',
  na: '–',
  idle: '·',
};

/** 结果区在"还没跑过任何检查"时的默认内容。 */
export const QUALITY_IDLE_HINT =
  '<div class="tag">点任一「检查」即可运行；结果里的文件条目可直接点击跳转。</div>';

/**
 * 「刷新状态」的结果提示（材料第 3 条后半条：用户点了刷新"没作用"）。
 *
 * 刷新会**真的重新探测**（`which` 每次实扫 PATH，无缓存）；但探测结果常常与上次相同，
 * 界面上看不出变化 —— 所以必须给一行**可见反馈**（时间戳），否则用户会以为按钮坏了。
 */
export function qualityRefreshedHtml(at: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${p(at.getHours())}:${p(at.getMinutes())}:${p(at.getSeconds())}`;
  return (
    `<div class="tag">已刷新 · ${esc(stamp)} · 工具探测已重跑（PATH 实时扫描，结果与上次相同时也不会变）</div>` +
    QUALITY_IDLE_HINT
  );
}

function chipClass(status: GateRowStatus): string {
  return status === 'pass' ? 'ok' : status === 'fail' ? 'fail' : '';
}

function badge(status: GateRowStatus): string {
  if (status === 'pass') {
    return '<span class="chip ok">✓ 通过</span>';
  }
  if (status === 'fail') {
    return '<span class="chip fail">✗ 失败</span>';
  }
  if (status === 'na') {
    // §F.41：`–` 必须说清"本机没跑成"（而不是含糊的"不可用"）—— 行下方还有原因与下一步。
    return '<span class="chip">– 本机不可用</span>';
  }
  return '<span class="chip">· 未运行</span>';
}

/** 门禁清单（`#rows` 的内容）——局部刷新时也复用这一份。 */
export function qualityRowsHtml(rows: QualityRow[]): string {
  return rows
    .map(
      (r) => `<div class="row gate">
        <span class="chip ${chipClass(r.status)}">${STATUS_ICON[r.status]} ${esc(r.label)}</span>
        <span class="tag">${esc(r.tool)}</span>
        <span class="title" style="flex:1"></span>
        <button data-action="runRow" data-row="${esc(r.id)}">${r.status === 'pass' ? '复查' : '检查'}</button>
      </div>${r.detail ? `<div class="detail">${esc(r.detail)}</div>` : ''}`,
    )
    .join('');
}

/** 运行结果（`#detail` 的内容）。**不带 `<script>`**：交互走委托。 */
export function qualityResultHtml(result: QualityRunResult): string {
  const issues =
    result.issues.length === 0
      ? ''
      : `<div class="issue-list">${result.issues
          .map(
            (i) =>
              `<div class="issue" data-action="openIssue" data-file="${esc(i.file)}" data-line="${i.line ?? ''}" title="点击打开">
                 <span class="tag">${esc(i.file)}${i.line ? `:${i.line}` : ''}</span>
                 <span>${esc(i.message)}</span>
               </div>`,
          )
          .join('')}</div>`;
  const errors = result.errors.map((e) => `<div class="warn">${esc(e)}</div>`).join('');
  const fixBtn =
    result.rowId === 'format' && result.status === 'fail'
      ? '<button data-action="fixFormat">🧹 自动修复格式</button>'
      : '';
  return `
    <div class="row"><h2 style="flex:1">结果：${esc(result.summary)}</h2>${badge(result.status)}</div>
    ${errors}
    ${issues}
    ${fixBtn}`;
}

/**
 * 检查过程本身抛异常时的结果块。
 *
 * 必要性：界面在点击后会把按钮置成「检查中…」并禁用；如果宿主侧异常而**没有任何**
 * 回信，那个按钮就永久停在那里（还是"点了没反应"）。所以任何失败路径都必须回一次
 * 结果（这里把它也做成可单测的纯函数）。
 */
export function qualityErrorHtml(rowId: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return qualityResultHtml({
    rowId,
    status: 'fail',
    summary: '检查未能运行',
    issues: [],
    errors: [msg],
  });
}

export function qualityPageHtml(rows: QualityRow[], detailHtml = QUALITY_IDLE_HINT): string {
  return pageShell(
    '质量与安全',
    `
    <style>
      .gate { border-bottom: 1px solid var(--vscode-widget-border,#333); padding: 6px 0; }
      .issue-list { margin: 6px 0; }
      .issue { display: flex; gap: 10px; padding: 3px 6px; border-radius: 4px; cursor: pointer; font-size: 12px; }
      .issue:hover { background: var(--vscode-list-hoverBackground); }
      .warn { background: rgba(226,192,141,.12); border: 1px solid #e2c08d; border-radius: 6px; padding: 6px 8px; margin: 4px 0; font-size: 12px; white-space: pre-wrap; }
    </style>
    <div class="card">
      <h1>质量与安全</h1>
      <div class="sub">本地门禁与 CI 一致（clang-format / clang-tidy / schema / commitlint）。本地绿 = 推送后 CI 绿。</div>
      <div id="rows">${qualityRowsHtml(rows)}</div>
      <div class="row"><button data-action="refresh" class="secondary">🔄 刷新状态</button></div>
    </div>
    <div id="detail">${detailHtml}</div>
    <script>
      // 交互全部走**事件委托**：即使 #rows / #detail 被局部替换，按钮依然有反应。
      // 注意：这里**不能**再 acquireVsCodeApi()，用 pageShell 提供的全局 send()。
      document.addEventListener('click', function (ev) {
        var el = ev.target instanceof Element ? ev.target : null;
        if (!el) { return; }
        var issue = el.closest('.issue');
        if (issue) {
          send({
            type: 'openIssue',
            file: issue.getAttribute('data-file'),
            line: Number(issue.getAttribute('data-line') || 0) || undefined,
          });
          return;
        }
        var btn = el.closest('[data-action]');
        if (!btn) { return; }
        var act = btn.getAttribute('data-action');
        if (act === 'runRow') {
          var row = btn.getAttribute('data-row');
          if (!row || btn.dataset.busy === '1') { return; }
          btn.dataset.busy = '1';
          btn.setAttribute('disabled', '');
          btn.textContent = '检查中…';
          send({ type: 'runRow', rowId: row });
          return;
        }
        if (act === 'refresh') {
          if (btn.dataset.busy === '1') { return; }
          btn.dataset.busy = '1';
          btn.setAttribute('disabled', '');
          btn.textContent = '刷新中…';
          send({ type: 'refresh' });
          return;
        }
        if (act) { send({ type: act }); }
      });
      window.addEventListener('message', function (ev) {
        var m = ev.data || {};
        if (m.type !== 'update') { return; }
        var rows = document.getElementById('rows');
        var detail = document.getElementById('detail');
        if (rows && typeof m.rows === 'string') { rows.innerHTML = m.rows; }
        if (detail && typeof m.detail === 'string') { detail.innerHTML = m.detail; }
      });
    </script>
    `,
  );
}
