/**
 * 发布前检查页面的**纯 HTML + 判决**（不 import vscode，可单测）。
 *
 * 从 panel.ts 里搬出来的原因（§F.46）：`verdictOf` / `itemsHtml` / `verdictHtml` 是
 * "用户看到的那两块内容"，必须能被单测直接喂数据跑一遍 —— 否则"预检说不能发、发布中心
 * 说能发"这类**跨面板不一致**只能靠人眼发现。
 */
import { esc } from '../ui';
import { summarizePreflight, type PreflightSummary } from '../../core/preflightSummary';

export interface PreflightItem {
  label: string;
  ok: boolean | undefined; // undefined = 未运行/不可判定
  detail?: string;
  required: boolean;
}

export interface PreflightState {
  projectName: string;
  items: PreflightItem[];
  passed: number;
  total: number;
  allowRelease: boolean;
}

/**
 * 三态 + 结论：**复用 `core/preflightSummary.ts` 这一份**（同一批 item 的同一套判定）。
 *
 * 面板、卡片、发布中心三处都必须走它 —— 以前 `allowRelease` 在扩展里另算了一遍，
 * 两处口径一旦漂移就会出现"预检说能发、发布中心说不能"。
 */
export function verdictOf(items: readonly PreflightItem[]): PreflightSummary {
  return summarizePreflight(items);
}

export function itemsHtml(items: readonly PreflightItem[]): string {
  if (items.length === 0) {
    return '<div class="warn">未检测到 fcpp 项目。</div>';
  }
  return items
    .map((it) => {
      const mark =
        it.ok === true
          ? '<span class="chip ok">✓</span>'
          : it.ok === false
            ? '<span class="chip fail">✗</span>'
            : '<span class="chip">–</span>';
      return `<div class="row item">
        ${mark}<span class="title">${esc(it.label)}</span>
        ${it.required ? '' : '<span class="tag">建议项</span>'}
        ${it.detail ? `<div class="detail">${esc(it.detail)}</div>` : ''}
      </div>`;
    })
    .join('');
}

export function verdictHtml(s: PreflightState): string {
  const v = verdictOf(s.items);
  return `${esc(v.fact)}
      <div class="row"><button data-action="openRelease" ${v.allowRelease ? '' : 'disabled'} class="primary">🚀 去发布中心</button>
      ${v.allowRelease ? '' : `<span class="tag">未就绪：${esc(v.next ?? '有必检项未通过')}</span>`}</div>`;
}

/**
 * 首帧页面的**主体**（`#items` / `#verdict` / `#note` 三个锚点，之后由消息局部刷新）。
 */
export function preflightInnerHtml(s: PreflightState, note = ''): string {
  return `
    <div class="card">
      <h1>发布前检查（Preflight）</h1>
      <div class="sub">项目：${esc(s.projectName || '—')} · 与 CI 门禁一致：本地绿 = 推送后绿</div>
      <div class="note" id="note">${esc(note)}</div>
      <div id="items">${itemsHtml(s.items)}</div>
      <div class="row">
        <button data-action="refresh">🔄 重新检查</button>
        <button data-action="runTests" class="secondary">▶ 运行构建并测试</button>
        <button data-action="openQuality" class="secondary">质量门禁</button>
      </div>
      <h2>结果</h2>
      <div id="verdict">${verdictHtml(s)}</div>
    </div>`;
}

export const PREFLIGHT_STYLE = `
    <style>
      .item { border-bottom: 1px solid var(--vscode-widget-border,#333); padding: 4px 0; flex-wrap: wrap; }
      .warn { background: rgba(226,192,141,.12); border: 1px solid #e2c08d; border-radius: 6px;
        padding: 8px 10px; margin: 6px 0; font-size: 12px; }
      .note { font-size: 12px; opacity: .8; margin: 6px 0; }
    </style>`;
