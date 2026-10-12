/**
 * 任务中心的 HTML（J 块，纯函数）。
 *
 * 三条纪律（都由 `src/test/taskCenter.test.ts` 钉住）：
 *   1. **唯一的动作是取消**（`data-act="taskCancel"`）—— 要构建/测试/发布，去对应段；
 *      这里放按钮就等于把"观测面板"变成第二个操作面板（计划 §6-J 明确不做）；
 *   2. 所有数字/结论都来自模型（模型来自 Task/CI 事实）—— HTML 里不许出现硬编码的
 *      百分比、耗时或结论文案；
 *   3. 拿不到 CI 状态时**显式说明**（原因 + 怎么办），不留空白（§F.43 的口径）。
 */
import { esc } from '../ui';
import type { TaskCenterModel, TaskCenterRow } from '../../core/taskCenter';

function artifactButtons(row: TaskCenterRow): string {
  if (row.artifacts.length === 0) {
    return '';
  }
  return row.artifacts
    .map(
      (a, i) =>
        `<button class="link" data-task="${esc(row.id)}" data-art="${i}">${esc(a.label)}</button>`,
    )
    .join('');
}

function runningRow(row: TaskCenterRow): string {
  const bits = [
    `<span class="tc-g">${esc(row.glyph)}</span>`,
    `<span class="nm">${esc(row.label)}</span>`,
    `<span class="tag">${esc(row.stateText)} · ${esc(row.durationText)} · ${esc(row.ownerText)}</span>`,
    row.progressText ? `<span class="tag">${esc(row.progressText)}</span>` : '',
    // 唯一动作：取消（正在运行的才有）
    `<button class="secondary" data-act="taskCancel" data-task="${esc(row.id)}">取消</button>`,
  ]
    .filter(Boolean)
    .join('');
  const why = row.reasonText ? `<div class="next">${esc(row.reasonText)}</div>` : '';
  const next = row.nextStep ? `<div class="next">下一步：${esc(row.nextStep)}</div>` : '';
  return `<div class="row tc-row" data-task="${esc(row.id)}">${bits}</div>${why}${next}`;
}

function recentRow(row: TaskCenterRow): string {
  const bits = [
    `<span class="tc-g st-${esc(row.state)}">${esc(row.glyph)}</span>`,
    `<span class="nm">${esc(row.label)}</span>`,
    `<span class="tag">${esc(row.stateText)} · ${esc(row.durationText)}${row.whenText ? ` · ${esc(row.whenText)}` : ''}</span>`,
    artifactButtons(row),
  ]
    .filter(Boolean)
    .join('');
  const why = row.reasonText ? `<div class="next">${esc(row.reasonText)}</div>` : '';
  const next = row.nextStep ? `<div class="next">下一步：${esc(row.nextStep)}</div>` : '';
  return `<div class="row tc-row st-${esc(row.state)}" data-task="${esc(row.id)}">${bits}</div>${why}${next}`;
}

export function taskCenterHtml(m: TaskCenterModel): string {
  const running = m.running.length
    ? m.running.map(runningRow).join('')
    : `<div class="tc-empty">${esc(m.emptyRunningText)}</div>`;
  const recent = m.recent.length
    ? m.recent.map(recentRow).join('')
    : `<div class="tc-empty">${esc(m.emptyRecentText)}</div>`;
  const ci = m.ci
    ? `<div class="row"><span class="tc-g">${esc(m.ci.glyph)}</span>` +
      `<span class="nm">${esc(m.ci.label)}</span>` +
      `<span class="tag">${esc(m.ci.conclusion)} · ${esc(m.ci.whenText)}</span>` +
      `<button class="link" data-ci="open">在 GitHub 打开</button></div>`
    : `<div class="tc-empty">${esc(m.ciNote?.reason ?? '没有 CI 状态。')}` +
      (m.ciNote?.fix?.length ? `<div class="next">怎么办：${m.ciNote.fix.map((f) => esc(f)).join('；')}</div>` : '') +
      `</div>`;
  return (
    `<section class="tc" data-tc>` +
    `<h2>正在运行</h2><div class="tc-list">${running}</div>` +
    `<h2>最近完成</h2><div class="tc-list">${recent}</div>` +
    `<h2>外部（CI）</h2><div class="tc-list">${ci}</div>` +
    `</section>`
  );
}

/** 面板用的那一小段 CSS（只读列表：不引入新的交互控件）。 */
export const TASK_CENTER_CSS = `
  .tc h2 { font-size: .9em; font-weight: 600; margin: 10px 0 4px; opacity: .9; }
  .tc-list { border-top: 1px solid var(--vscode-widget-border, #333); padding-top: 4px; }
  .tc-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 3px 0; }
  .tc-g { width: 1.2em; text-align: center; }
  .tc-row.st-failed .tc-g, .tc-row.st-failed .nm { color: var(--vscode-errorForeground); }
  .tc-row.st-timedOut .tc-g, .tc-row.st-cancelled .tc-g { opacity: .8; }
  .tc-row.st-succeeded .tc-g { color: var(--vscode-testing-iconPassed, #73c991); }
  .tc-empty { padding: 6px 2px; opacity: .7; font-size: .85em; }
`;
