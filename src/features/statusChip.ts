/**
 * HeT status-bar chip (GUI rework — V5-2 "hover console").
 *
 * PURE module (no VS Code imports). The chip appears ONLY while an fcpp
 * project is open. V5-2 turns the hover into an interactive "small console":
 * a 项目/状态 table whose rows carry `command:` links (Copilot-style: hover
 * persists, click executes, the host refreshes the model afterwards).
 * Clicking the chip itself still opens the Level-2 HUD.
 *
 * Row order & labels are locked by the V5 plan (all four chars, health last):
 *   🔧 开发环境 · 🏗️ 构建结果 · 🍺 测试中心 · 📚 技术文档 · 📊 代码覆盖
 *   · 📖 模板同步 · 💚 工程健康 (total row, LAST)
 */

export interface ChipTest {
  passed: number;
  failed: number;
  skipped: number;
}

export type DocsRowState = 'none' | 'running' | 'ok' | 'fail';

export interface ChipModel {
  /** '' when no fcpp project is open. */
  projectName: string;
  health: number | null;
  running: string | null;
  /**
   * 正在跑的动作 id（§F.35）：悬停卡据此把所属域的"上一次结果"换成"进行中"，
   * 否则构建中会看到 `$(error) 构建 失败` —— 观感上等于"还没跑完就报失败"。
   */
  runningAction?: string | null;
  lastBuildOk: boolean | null;
  test: ChipTest | null;
  templateBehind: number;
  /** V4-6 rich rows (optional). */
  buildAgo?: string | null;
  buildType?: string | null;
  /** V5-2: 开发环境 row — single env sample line (envSample.summary). */
  envSummary?: string | null;
  /** V5-2: 技术文档 row outcome. */
  docs?: DocsRowState | null;
  docsDoxygen?: boolean;
  docsSphinx?: boolean;
  /** V5-2: 代码覆盖 row — metadata switch state. */
  coverageEnabled?: boolean | null;
  /** V5-6: 代码覆盖 row — report presence + parsed line/function % (result). */
  coverageFound?: boolean;
  coverageLine?: number | null;
  coverageFunc?: number | null;
  /** V5-2: 💚 工程健康 row (score + verdict + ≤3 short gaps). */
  healthVerdict?: string | null;
  healthGaps?: string[] | null;
}

export interface ChipSpec {
  text: string;
  /** Markdown with `$(codicon)` + `command:` links (host wraps & trusts). */
  tooltip: string;
  command?: string;
  color?: string;
}

import { busyDomainOf, chipStatusText } from '../core/status';

/** Visual glyphs (pure-visual never collide with fcpp trigger semantics). */
const G_BUILD = '🏗️';
const G_TEST = '🍺';
const G_DOCS = '📚';
const G_COV = '📊';
const G_TPL = '📖';
const G_ENV = '🔧';
const G_HEALTH = '💚';

/** Markdown `command:` link (optional URL-encoded JSON arg). */
export function cmdLink(label: string, command: string, arg?: string): string {
  const target = arg === undefined ? `command:${command}` : `command:${command}?${encodeURIComponent(JSON.stringify(arg))}`;
  return `[${label}](${target})`;
}

/**
 * V5-6 closed-loop layout (issue-4 feedback):
 *  - the "状态" column shows ONLY the outcome (result) of the last run, plus
 *    entry links that OPEN that result (输出 / 测试结果 / Doxygen / Sphinx /
 *    报告 / 明细) — never a button that STARTS an action;
 *  - every action that executes something lives in the "快捷操作" row below
 *    the table (检查环境 / 构建并测试 / 构建文档 / 生成覆盖率 / 重新体检).
 */
function envCell(m: ChipModel): string {
  const summary = (m.envSummary ?? '').trim();
  return summary.length > 0 ? summary : '未检测';
}

function buildCell(m: ChipModel): string {
  const ok = m.lastBuildOk;
  const ago = ok && m.buildAgo ? ` · ${m.buildAgo}` : '';
  const type = ok && m.buildType ? ` · ${m.buildType}` : '';
  if (ok === null) {
    return '未运行';
  }
  const head = ok ? `✅ 成功${type}${ago}` : '❌ 失败';
  // 失败 = 结果 + 入口（打开输出/问题）；不在此处放「构建」动作。
  return ok ? head : `${head} · ${cmdLink('输出', 'het.openBuildOutput')}`;
}

function testCell(m: ChipModel): string {
  const t = m.test;
  if (!t) {
    return '未运行';
  }
  const ok = t.failed === 0;
  const line = `${ok ? '✅' : '❌'} 通过 ${t.passed} · 失败 ${t.failed} · 跳过 ${t.skipped}`;
  // 失败时给「测试结果」入口（查看明细），动作统一在快捷操作区。
  return ok ? line : `${line} · ${cmdLink('测试结果', 'het.showTestResults')}`;
}

function docsCell(m: ChipModel): string {
  const state = m.docs ?? 'none';
  // §F.35：构建中 → 显示"进行中"，别让上一次的 `✗ 失败` 当结论（观感上等于咒它失败）。
  if (state === 'running' || busyDomainOf(m.runningAction ?? null) === 'docs') {
    return '$(sync~spin) 构建中';
  }
  if (state === 'ok') {
    const links: string[] = [];
    if (m.docsDoxygen) {
      links.push(cmdLink('Doxygen', 'het.openDocsArtifact', 'doxygen'));
    }
    if (m.docsSphinx) {
      links.push(cmdLink('Sphinx', 'het.openDocsArtifact', 'sphinx'));
    }
    return links.length ? `✅ 成功 · ${links.join(' ')}` : '✅ 成功（产物未找到）';
  }
  if (state === 'fail') {
    return `❌ 失败 · ${cmdLink('详情', 'het.docs')}`;
  }
  return '未构建';
}

function coverageCell(m: ChipModel): string {
  if (m.coverageEnabled === false) {
    return '未开启（metadata 开关）';
  }
  const found = m.coverageFound === true;
  if (found) {
    const pct = m.coverageLine !== null && m.coverageLine !== undefined
      ? `行 ${m.coverageLine}%${m.coverageFunc !== null && m.coverageFunc !== undefined ? ` · 函数 ${m.coverageFunc}%` : ''} · `
      : '';
    return `✅ ${pct}${cmdLink('报告', 'het.openCoverageReport')}`;
  }
  return '未生成';
}

function templateCell(m: ChipModel): string {
  return m.templateBehind > 0 ? `可更新 ${m.templateBehind} 个提交` : '与参考一致';
}

function healthCell(m: ChipModel): string {
  const base = m.health === null ? '未体检' : `${m.health}/100 · ${m.healthVerdict ?? '—'}`;
  const count = (m.healthGaps ?? []).length;
  // 极简：长文案（可提升项标签）走表格下方 hint，不进单元格以免撑破列宽；
  // 「重新体检」是动作 → 只留在快捷操作区，这里保留「明细」入口。
  return count === 0 ? base : `${base} · ${count}项 · ${cmdLink('明细', 'het.healthReport')}`;
}

/** 可提升项提示（独立段落，避免破坏表格格式）。 */
function healthHint(m: ChipModel): string {
  const gaps = (m.healthGaps ?? []).slice(0, 3);
  if (!gaps.length) {
    return '';
  }
  return `\n\n> 可提升：${gaps.join(' · ')} — 点「明细」查看完整体检`;
}

/** Render the chip only while a project is open — monitoring only. */
export function chipSpec(m: ChipModel): ChipSpec | null {
  if (!m.projectName) {
    return null;
  }
  // §F.35：忙 = 图标 + **进行中文字**（`⟳ HeT 构建中`）。绝不在忙的时候显示上次的
  // 分数或上次的失败 —— "正在跑"和"结果"是两件事，chip 只答前者。
  const busyText = m.running && m.running !== 'env' ? m.running : null;
  const run = busyText ? '$(sync~spin)' : '$(pulse)';
  const text = `${run} HeT ${busyText ?? chipStatusText(null, m.health)}`;
  const busyDom = busyDomainOf(m.runningAction ?? null);
  const busyTxt = '进行中';

  const healthIcon = m.health === null ? '$(question)' : m.health >= 80 ? '$(smi​ley)' : m.health >= 50 ? '$(warning)' : '$(error)';
  const healthTxt = m.health === null ? '未体检' : `${m.health}/100`;
  const buildBusy = busyDom === 'build';
  const buildIcon = buildBusy
    ? '$(sync~spin)'
    : m.lastBuildOk === null
      ? '$(circle-outline)'
      : m.lastBuildOk
        ? '$(pass)'
        : '$(error)';
  const buildTxt = buildBusy ? busyTxt : m.lastBuildOk === null ? '未运行' : m.lastBuildOk ? '成功' : '失败';
  const testBusy = busyDom === 'test';
  const testIcon = testBusy ? '$(sync~spin)' : m.test ? (m.test.failed > 0 ? '$(error)' : '$(pass)') : '$(circle-outline)';
  const testTxt = testBusy ? busyTxt : m.test ? `${m.test.passed}/${m.test.passed + m.test.failed + m.test.skipped}` : '—';

  const badges = [`${healthIcon} 健康 ${healthTxt}`, `${buildIcon} 构建 ${buildTxt}`, `${testIcon} 测试 ${testTxt}`].join('   ');

  const rows: Array<[string, string]> = [
    [`${G_ENV} 开发环境`, envCell(m)],
    [`${G_BUILD} 构建结果`, buildCell(m)],
    [`${G_TEST} 测试中心`, testCell(m)],
    [`${G_DOCS} 技术文档`, docsCell(m)],
    [`${G_COV} 代码覆盖`, coverageCell(m)],
    [`${G_TPL} 模板同步`, templateCell(m)],
    [`${G_HEALTH} 工程健康`, healthCell(m)],
  ];

  const table = ['| 项目 | 状态 |', '| --- | --- |', ...rows.map(([k, v]) => `| ${k} | ${v} |`)].join('\n');
  const runningLine = m.running && m.running !== 'env' ? `\n\n$(sync~spin) 运行中：${m.running}` : '';

  // V5-6 (issue-4): every EXECUTE action lives here — the status cells above
  // only show results + entry links. V5-7: bullet per action so the hover card
  // never squeezes 6 links into one wrapping line (issue-2 feedback).
  const quick = [
    '━━━ 快捷操作（点按即执行）━━━',
    '',
    `- ${cmdLink('🔧 检查环境', 'het.envCheck')}`,
    `- ${cmdLink('🚀 构建并测试', 'het.test')}`,
    `- ${cmdLink('📚 构建文档', 'het.docs')}`,
    `- ${cmdLink('📊 生成覆盖率', 'het.coverage')}`,
    `- ${cmdLink('💚 重新体检', 'het.healthCheck')}`,
    `- ${cmdLink('🖥️ 完整监控卡', 'het.chipOverview')}`,
  ].join('\n');

  const tooltip = [
    `**$(package) HeT DevTools · ${m.projectName}**`,
    '',
    badges,
    '',
    table,
    runningLine,
    healthHint(m),
    '',
    quick,
    '',
    '$(keyboard) Enter 打开完整监控卡 · 悬停链接点击即执行 · $(eye) 可隐藏监控 chip',
  ].join('\n');

  return {
    text,
    tooltip,
    command: 'het.chipOverview',
    // §F.35：**忙的时候绝不红**。红色只表达"跑完了、失败了"这个结论；
    // 把"正在构建"染成红底，是实测反馈里最刺眼的一处误读（"看着像已经炸了"）。
    color: !busyText && m.lastBuildOk === false ? 'statusBarItem.errorBackground' : undefined,
  };
}
