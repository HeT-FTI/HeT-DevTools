/**
 * 「新库自检」的页内视图（V3 计划 §7.1 · L5 / G4）。
 *
 * 只做渲染，**不自己算任何事实**：输入是 `core/newLibAudit.ts` 的判定结果
 * （`auditNewLib()` 的输出），它同时喂卡片那一行 —— 两处同一份，不会各说一套。
 *
 * 三条硬规矩（延续工具链一览那一版）：
 * 1. **红项排最前**（有事要做的先看见），再 `–`（要人判的），最后才是通过项；
 * 2. **每行都写清"为什么"**：红项给 detail（哪里不对）、`–` 给 why（为什么机器判不了）；
 * 3. 判据来自**读到的文件**，读不到就是 `–`，不许假装绿。
 */
import { pageShell } from '../ui';
import { fixOf, type NewLibResult } from '../../core/newLibAudit';

function esc(s: string): string {
  return s
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}

export interface NewLibAuditView {
  phrase: string;
  results: readonly NewLibResult[];
  /** 合同文件在不在（不在的话说明这不是模板生成的库）。 */
  contractPresent: boolean;
  /** 合同文件路径（面板里标出来，用户能自己去读原条款）。 */
  contractPath: string;
}

function rowHtml(r: NewLibResult): string {
  const glyph = r.ok === true ? '✓' : r.ok === false ? '✗' : '–';
  const cls = r.ok === true ? 'row-ok' : r.ok === false ? 'row-fail' : 'row-na';
  const reason = r.ok === false ? r.detail : r.ok === undefined ? (r.why ?? r.detail) : '';
  const fix = r.ok === false ? fixOf(r.id, '') : undefined;
  return `<tr class="${cls}">
    <td class="g">${glyph}</td>
    <td>
      <div>${esc(r.title)}</div>
      ${reason ? `<div class="sub">${esc(reason)}</div>` : ''}
      ${fix ? `<div class="sub">怎么补：${esc(fix)}</div>` : ''}
    </td>
  </tr>`;
}

export function newLibAuditTableHtml(results: readonly NewLibResult[]): string {
  if (results.length === 0) {
    return '<div class="empty">还没跑过自检 —— 打开这一页会自动读一遍工程。</div>';
  }
  const fails = results.filter((r) => r.ok === false);
  const nas = results.filter((r) => r.ok === undefined);
  const oks = results.filter((r) => r.ok === true);
  const body = [...fails, ...nas, ...oks].map(rowHtml).join('\n');
  return `<style>${AUDIT_CSS}</style>
  <table class="audit"><tbody>${body}</tbody></table>`;
}

/** 整页 HTML（Slot 正文；全文档只有 `pageShell` 那一段脚本）。 */
export function newLibAuditPageHtml(v: NewLibAuditView): string {
  const ok = v.results.filter((r) => r.ok === true).length;
  const fail = v.results.filter((r) => r.ok === false).length;
  const na = v.results.filter((r) => r.ok === undefined).length;
  const notTemplate = v.contractPresent
    ? ''
    : `<div class="warn">没读到合同文件 <code>${esc(v.contractPath)}</code> —— 这不是从模板生成的项目，
        下面这些条款是按**模板自带的合同**判的（判定依据仍然是你工程里的真实文件）。</div>`;
  return pageShell(
    '交付：新库自检',
    `<div class="card">
      <h1>新库自检</h1>
      <div class="sub">${esc(`合约 ${v.results.length} 条，逐条读你工程里的真实文件判定：${ok} 条通过 · ${fail} 条不通过 · ${na} 条要人看`)}</div>
      ${notTemplate}
      <div id="audit-root">${newLibAuditTableHtml(v.results)}</div>
      <div class="row"><button class="secondary" data-action="audit:refresh">重新检查</button></div>
      <div class="sub">条款原文在 <code>${esc(v.contractPath)}</code> 的 SECTION 7。要人看的那几条不是"没做"，
        而是机器判不了（比如"精炼"、"覆盖了全部 API"）—— 点开文件自己过一遍。</div>
    </div>
    <script>
      document.addEventListener('click', function (ev) {
        var el = ev.target instanceof Element ? ev.target : null;
        if (!el) { return; }
        var btn = el.closest('[data-action]');
        if (!btn) { return; }
        if (btn.getAttribute('data-action') === 'audit:refresh') {
          send({ type: 'audit:refresh' });
        }
      });
    </script>`,
  );
}

const AUDIT_CSS = `
  table.audit { width: 100%; border-collapse: collapse; font-size: .9em; }
  table.audit td { border-bottom: 1px solid var(--het-border); padding: 5px 8px; text-align: left; vertical-align: top; }
  table.audit td.g { width: 1.4em; font-weight: 700; }
  table.audit tr.row-fail td.g { color: var(--het-error); }
  table.audit tr.row-na td.g { color: var(--het-fg-dim); }
  table.audit tr.row-ok td.g { color: var(--het-ok); }
  table.audit tr.row-ok td { opacity: .72; }
  .empty { padding: 10px 2px; opacity: .75; }
  .warn { background: rgba(226,192,141,.12); border: 1px solid var(--het-warn); border-radius: 6px;
    padding: 8px 10px; margin: 6px 0; font-size: .92em; }
`;
