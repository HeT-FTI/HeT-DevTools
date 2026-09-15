/**
 * Cockpit single-page renderer (gui-rework-plan §4).
 * Pure string builder — no VS Code imports (unit-testable).
 * Icon policy (§3.4): rail main items carry codicons; sub-items / lists are
 * text-only with ✓/✗ status marks.
 */

import { esc } from '../../ui';
import { PAGES, CockpitPage } from '../layout';
import { CockpitState, CockpitWizard } from '../state';
import type { ToolRow } from '../../../core/toolchainDiscovery';
import type { Disposition, EnvContract } from '../../../core/envContract';
import { EnvPhaseView, envPhaseHtml } from '../../../core/envPhase';

export interface CockpitAssets {
  codiconCss: string;
  lang?: CockpitLang;
}

export type CockpitLang = 'zh' | 'en';

/** Chrome-only i18n (page content stays on the zh base per the plan). */
function t(lang: CockpitLang, zh: string, en: string): string {
  return lang === 'en' ? en : zh;
}

/* ------------------------------------------------------------------ *
 * Page content payloads (P-G2 adapters feed these).
 * ------------------------------------------------------------------ */

export interface ToolChip {
  name: string;
  ok: boolean;
}

export interface TestSummaryPayload {
  passed?: number;
  failed?: number;
  skipped?: number;
}

export interface OverviewPayload {
  projectName?: string;
  version?: string;
  buildType?: string;
  healthScore?: number;
  tools: ToolChip[];
  lastBuildOk: boolean | null;
  lastTest: TestSummaryPayload | null;
  /** Sniffed conan runtime (conda env / PATH / null). */
  runtime?: { version?: string; envName?: string; custom?: boolean } | null;
  /** Generic toolchain discovery rows (V2 env block). */
  envRows?: ToolRow[];
  /** V4-1 provider decision (heuristic, non-binding). */
  plan?: PlanView | null;
  /** V4-2/V4-5 managed environment state (globalStorage). */
  managed?: ManagedView | null;
  /** V4-3 WSL2 lane status (win32 + win-wsl2 plan). */
  wsl?: WslView | null;
  /** V4-4 macOS lane status (darwin + macos-native plan). */
  osx?: OsxView | null;
  /** A3 native-Linux managed lane status (linux + linux-managed plan). */
  linux?: LinuxView | null;
  /** T06: the unified environment contract (rows/ready/next) — preferred view. */
  contract?: EnvContract | null;
  /** T19: the lane lifecycle strip (detecting → needsConsent → provisioning → ready/blocked). */
  envPhase?: EnvPhaseView | null;
}

export interface BuildTestPayload {
  lastBuildOk: boolean | null;
  lastTest: TestSummaryPayload | null;
}

export interface DepItemView {
  bucket: string;
  displayKey: string;
  conanName: string;
  version?: string;
  targets: string[];
}

export interface DepsPayload {
  items: DepItemView[];
  issues: string[];
}

export interface BenchPayload {
  platform: string;
  parsed: { complete: boolean; cases: [string, string][] } | null;
  note?: string;
}

export type PagePayload =
  | OverviewPayload
  | BuildTestPayload
  | DepsPayload
  | BenchPayload
  | SummaryPayload
  | Record<string, unknown>
  | undefined;

export interface SummaryAction {
  cmd: string;
  icon: string; // codicon suffix
  label: string;
}

export interface SummaryPayload {
  rows: [string, string][];
  actions: SummaryAction[];
  note?: string;
}

/** Text-only summary rows + primary action buttons (no icons on sub-items). */
export function summaryContent(p: SummaryPayload): string {
  const rows = p.rows.map(([k, v]) => `<div class="srow"><span class="sk">${esc(k)}</span><span class="sv">${esc(v)}</span></div>`).join('');
  const actions = p.actions
    .map((a) => `<button class="primary" data-cmd="${esc(a.cmd)}"><i class="codicon codicon-${a.icon}"></i>${esc(a.label)}</button>`)
    .join('');
  return `<div class="slist">${rows || '<div class="status">（暂无数据）</div>'}</div>
    <div class="actions">${actions}</div>
    ${p.note ? `<div class="status">${esc(p.note)}</div>` : ''}`;
}

function statusMark(ok: boolean | null | undefined): string {
  if (ok === undefined || ok === null) {
    return '·';
  }
  return ok ? '✓' : '✗';
}

/**
 * V5-2B: manual-override block — the ONLY generic-tool rows still shown on the
 * overview. Everything else about the toolchain comes from the managed/lane
 * semantics (envTopHtml / envWslHtml / envOsxHtml); no more automatic-sniff
 * detail dump.
 */
function envBlockHtml(rows: ToolRow[]): string {
  if (!rows.length) {
    return '';
  }
  const items = rows
    .map((r) => {
      const src = r.source === 'missing' ? '未找到（手动指定需指向存在的可执行文件）' : r.exe ?? '';
      const clear = r.overridden ? `<button class="textbtn" data-page-action="env:clear" data-arg-tool="${esc(r.key)}">清除</button>` : '';
      return `<div class="drow"><span class="dk">${esc(r.label)}</span><span class="dv dim">${esc(src)}</span><span class="dv">${clear}</span></div>`;
    })
    .join('');
  return `<details class="mini">
    <summary class="mini-head">手动覆盖（het.tools · 仅列非空项）</summary>
    ${items}
    <div class="status">其余工具链语义由「构建环境方案 / 托管环境 / 车道」决定；这里只列出你手动指定的覆盖。</div>
  </details>`;
}

export interface PlanView {
  label: string;
  coverage: 'full' | 'partial' | 'none';
  reason?: string;
}

export interface ManagedView {
  state: 'absent' | 'provisioning' | 'ready' | 'error';
  tools: Record<string, string>;
  note?: string;
}

export interface WslView {
  distro?: string;
  ready: boolean;
  tools: Record<string, string>;
  note?: string;
}

export interface OsxView {
  clt: boolean;
  clangVersion?: string;
  python?: string;
  note?: string;
}

export interface LinuxView {
  home: string;
  ready: boolean;
  tools: Record<string, string>;
  note?: string;
}

const MANAGED_STATE_ZH: Record<ManagedView['state'], string> = {
  absent: '未准备（点「准备」即可离线自给 conan/cmake/ninja）',
  provisioning: '准备中…',
  ready: '已就绪（位于扩展存储 · 卸载自动清理）',
  error: '异常（可重试，或移除后重新准备）',
};

/**
 * T06: THE environment card — one renderer for all three platforms.
 * Rows come from the EnvContract (disposition + baseline + fix), so the card
 * can never drift from what the lane actually verified (the old four blocks
 * each re-derived their own wording and could disagree with the build path).
 */
export function envCardHtml(contract?: EnvContract | null): string {
  if (!contract || contract.rows.length === 0) {
    return '';
  }
  const MARKS: Record<Disposition, string> = { present: '✓', healable: '⟳', guide: '⚠', unsupported: '—' };
  const head =
    `<div class="drow"><span class="dk">${contract.ready ? '✓' : '!'} 构建环境 · ${esc(contract.lane)}</span>` +
    `<span class="dv dim">${esc(contract.platform)}${contract.arch ? ` · ${esc(contract.arch)}` : ''} · 覆盖率 ${esc(contract.coverage)}</span></div>`;
  const rows = contract.rows
    .map((r) => {
      const baseline = r.baseline === 'ci' ? ' [CI 同基线]' : r.baseline === 'compatible' ? ' [兼容模式]' : '';
      const value = r.found
        ? `${esc(r.found.version)}${baseline ? `<span class="dim">${baseline}</span>` : ''}`
        : esc(r.note ?? (r.disposition === 'healable' ? '可自动修复' : r.disposition === 'guide' ? '需你操作' : ''));
      const fix =
        r.fix && r.fix.action && r.disposition !== 'present'
          ? `<button class="textbtn" data-page-action="${esc(r.fix.action)}">${esc(r.fix.text)}</button>`
          : '';
      // Explicit escape hatch (lane blocked) — the user must confirm; we never
      // silently switch a project to the native toolchain.
      const alt =
        r.altFix && r.altFix.action && r.disposition !== 'present'
          ? `<button class="textbtn" data-page-action="${esc(r.altFix.action)}">${esc(r.altFix.text)}</button>`
          : '';
      const required = r.required ? '' : '<span class="dim">（可选）</span>';
      return `<div class="drow"><span class="dk">${MARKS[r.disposition]} ${esc(r.label)}${required}</span><span class="dv">${value}</span><span class="dv">${fix}${alt}</span></div>`;
    })
    .join('');
  const guides = contract.rows.filter((r) => r.fix?.copy);
  const guideHtml = guides.length
    ? `<details class="mini"><summary class="mini-head">前置指引（可复制）</summary>${guides
        .map(
          (r) =>
            `<div class="drow"><span class="dk">${esc(r.label)}</span><span class="dv dim">${esc(r.fix?.copy ?? '').replace(/\n/gu, '<br>')}</span></div>`,
        )
        .join('')}</details>`
    : '';
  const action = contract.next
    ? `<div class="actions"><button class="primary" data-page-action="${esc(contract.next.action)}">${esc(contract.next.label)}</button></div>`
    : '';
  return `<div class="env">${head}${rows}${guideHtml}${action}</div>`;
}

/** V4-5: provider decision + managed env block (buttons post env:prepare/remove). */
export function envTopHtml(plan?: PlanView | null, managed?: ManagedView | null): string {
  const parts: string[] = [];
  if (plan) {
    const mark = plan.coverage === 'full' ? '✓' : plan.coverage === 'partial' ? '!' : '✗';
    parts.push(
      `<div class="drow"><span class="dk">${mark} 构建环境方案（启发式推断）</span><span class="dv dim">${esc(plan.label)}</span></div>`,
    );
    if (plan.reason) {
      parts.push(`<div class="drow dim"><span class="dk">说明</span><span class="dv dim">${esc(plan.reason)}</span></div>`);
    }
  }
  if (managed) {
    const zh = MANAGED_STATE_ZH[managed.state] ?? managed.state;
    const tools = Object.entries(managed.tools)
      .map(([k, v]) => `${k} ${v}`)
      .join(' · ');
    const prep =
      managed.state === 'ready'
        ? ''
        : `<button class="textbtn" data-page-action="env:prepare">${managed.state === 'absent' ? '准备托管环境' : '重试准备'}</button>`;
    const rm = managed.state === 'absent' ? '' : `<button class="textbtn" data-page-action="env:remove">移除托管环境</button>`;
    parts.push(
      `<div class="drow"><span class="dk">托管环境（globalStorage · 卸载自动清理）</span>` +
        `<span class="dv dim">${zh}${tools ? ` · ${esc(tools)}` : ''}${managed.note ? ` · ${esc(managed.note)}` : ''}</span>` +
        `<span class="dv">${prep}${rm}</span></div>`,
    );
  }
  if (parts.length === 0) {
    return '';
  }
  return `<div class="env">${parts.join('')}</div>`;
}

/** V4-3: WSL2 lane status block (win32 + win-wsl2 plan). */
export function envWslHtml(wsl?: WslView | null): string {
  if (!wsl) {
    return '';
  }
  const mark = wsl.ready ? '✓' : '!';
  const tools = Object.entries(wsl.tools)
    .map(([k, v]) => `${k} ${v}`)
    .join(' · ');
  const parts: string[] = [
    `<div class="drow"><span class="dk">${mark} WSL2 车道${wsl.distro ? ` · ${esc(wsl.distro)}` : ''}</span>` +
      `<span class="dv dim">${wsl.ready ? '就绪（gcc 系统级 · 覆盖率全语义）' : '发行版存在但 gcc 未就绪'}</span></div>`,
  ];
  if (tools) {
    parts.push(`<div class="drow dim"><span class="dk">工具</span><span class="dv dim">${esc(tools)}</span></div>`);
  }
  if (wsl.note) {
    parts.push(`<div class="drow dim"><span class="dk">说明</span><span class="dv dim">${esc(wsl.note)}</span></div>`);
  }
  return `<div class="env">${parts.join('')}</div>`;
}

/** V4-4: macOS lane status block (darwin + macos-native plan). */
export function envOsxHtml(osx?: OsxView | null): string {
  if (!osx) {
    return '';
  }
  const mark = osx.clt && osx.clangVersion ? '✓' : '!';
  const parts: string[] = [
    `<div class="drow"><span class="dk">${mark} macOS 车道（Xcode CLT）</span>` +
      `<span class="dv dim">${osx.clangVersion ? `Apple clang ${esc(osx.clangVersion)}` : osx.clt ? 'CLT 已装（clang 版本未知）' : '未检测到 Command Line Tools'}</span></div>`,
  ];
  if (osx.python) {
    parts.push(`<div class="drow dim"><span class="dk">python</span><span class="dv dim">${esc(osx.python)}</span></div>`);
  }
  if (osx.note) {
    parts.push(`<div class="drow dim"><span class="dk">说明</span><span class="dv dim">${esc(osx.note)}</span></div>`);
  }
  return `<div class="env">${parts.join('')}</div>`;
}

/** A3: native-Linux managed lane status block (linux + linux-managed plan). */
export function envLinuxHtml(linux?: LinuxView | null): string {
  if (!linux) {
    return '';
  }
  const mark = linux.ready ? '✓' : '!';
  const tools = Object.entries(linux.tools)
    .map(([k, v]) => `${k} ${v}`)
    .join(' · ');
  const parts: string[] = [
    `<div class="drow"><span class="dk">${mark} Linux 派生 managed lane · ${esc(linux.home)}/.het-fti/managed-env</span>` +
      `<span class="dv dim">${linux.ready ? '就绪（隔离 venv · gcc 系统级 · 覆盖率全语义）' : '托管 lane 未就绪'}</span></div>`,
  ];
  if (tools) {
    parts.push(`<div class="drow dim"><span class="dk">工具</span><span class="dv dim">${esc(tools)}</span></div>`);
  }
  if (linux.note) {
    parts.push(`<div class="drow dim"><span class="dk">说明</span><span class="dv dim">${esc(linux.note)}</span></div>`);
  }
  return `<div class="env">${parts.join('')}</div>`;
}

function overviewContent(p: OverviewPayload): string {
  const health = p.healthScore === undefined ? '' : `<span class="chip ${p.healthScore >= 80 ? 'ok' : p.healthScore >= 50 ? 'warn' : 'fail'}">健康分 ${p.healthScore}</span>`;
  return `<div class="row">${health}</div>
    <div class="grid">
      <div class="card"><div class="ct">最近构建</div><div class="cv">${statusMark(p.lastBuildOk)} ${p.lastBuildOk === null ? '未运行' : p.lastBuildOk ? '成功' : '失败'}</div></div>
      <div class="card"><div class="ct">最近测试</div><div class="cv">${p.lastTest ? `${statusMark((p.lastTest.failed ?? 0) === 0)} ${p.lastTest.passed ?? 0}/${(p.lastTest.failed ?? 0) + (p.lastTest.passed ?? 0)}` : '未运行'}</div></div>
    </div>
    ${envPhaseHtml(p.envPhase ?? null)}
    ${p.contract ? envCardHtml(p.contract) : `${envTopHtml(p.plan ?? null, p.managed ?? null)}
    ${envWslHtml(p.wsl ?? null)}
    ${envOsxHtml(p.osx ?? null)}
    ${envLinuxHtml(p.linux ?? null)}`}
    ${envBlockHtml(p.envRows ?? [])}
    <div class="actions">
      <button class="primary" data-cmd="het.test"><i class="codicon codicon-play"></i>构建并测试</button>
      <button class="primary" data-cmd="het.docs"><i class="codicon codicon-book"></i>文档</button>
      <button class="primary" data-cmd="het.quality"><i class="codicon codicon-shield"></i>质量</button>
      <button class="primary" data-cmd="het.release"><i class="codicon codicon-rocket"></i>发布</button>
    </div>`;
}

function buildTestContent(p: BuildTestPayload): string {
  const line = `最近构建 ${statusMark(p.lastBuildOk)} · 测试 ${p.lastTest ? `通过 ${p.lastTest.passed ?? 0} · 失败 ${p.lastTest.failed ?? 0} · 跳过 ${p.lastTest.skipped ?? 0}` : '未运行'}`;
  return `<div class="row"><span class="status">${line}</span></div>
    <div class="actions">
      <button class="primary" data-cmd="het.build"><i class="codicon codicon-tools"></i>构建</button>
      <button class="primary" data-cmd="het.test"><i class="codicon codicon-beaker"></i>构建并测试</button>
      <button data-cmd="het.showTestResults">查看测试结果</button>
    </div>
    <div class="placeholder">构建日志将自动出现在底部抽屉（运行中自动展开，完成后 3 秒收起）。</div>`;
}

const BUCKET_LABELS: Record<string, string> = {
  common: '公共 (common)',
  c: 'C (c)',
  cpp: 'C++ (cpp)',
  infra: '基础设施 (infra)',
};

function depsContent(p: DepsPayload): string {
  const items = p.items.length
    ? p.items
        .map(
          (i) => `<div class="drow">
      <span class="dk">${esc(BUCKET_LABELS[i.bucket] ?? i.bucket)}</span>
      <span class="dv"><b>${esc(i.displayKey)}</b><span class="dim"> ${esc(i.conanName)}${i.version ? '@' + esc(i.version) : ''}</span></span>
      <span class="dv dim">${esc(i.targets.join(', ') || '—')}</span>
      <button class="textbtn" data-page-action="deps:remove" data-arg-bucket="${esc(i.bucket)}" data-arg-key="${esc(i.displayKey)}">移除</button>
    </div>`,
        )
        .join('')
    : '<div class="status">（暂无依赖）</div>';
  const bucketOptions = Object.entries(BUCKET_LABELS).map(([k, label]) => `<option value="${k}">${esc(label)}</option>`).join('');
  return `<div class="slist">${items}</div>
    ${p.issues.length ? `<div class="warn">${p.issues.map((x) => esc(x)).join('<br>')}</div>` : ''}
    <form class="addform" data-action="deps:add">
      <input name="conanName" placeholder="conan 包名（如 zlib）" required>
      <input name="version" placeholder="版本（如 1.3.1）" required>
      <input name="targets" placeholder="目标（逗号分隔，可空）">
      <select name="bucket">${bucketOptions}</select>
      <button class="primary" type="submit"><i class="codicon codicon-add"></i>添加依赖</button>
    </form>
    <div class="status">增删均先弹窗确认，随后原子写入 conandata.yml 与 metadata.json。</div>`;
}

function benchContent(p: BenchPayload): string {
  const table = p.parsed
    ? `<div class="slist">${
        p.parsed.cases.length
          ? p.parsed.cases
              .map(([n, v]) => `<div class="srow"><span class="sk">${esc(n)}</span><span class="sv">${esc(v)}</span></div>`)
              .join('')
          : '<div class="status">未解析到 RESULT 行</div>'
      }
      <div class="status">${p.parsed.complete ? '✓ 协议完整（START/END 齐全）' : '✗ 协议不完整（缺少 START/END）'}</div></div>`
    : '';
  return `<div class="row"><span class="status">平台：${esc(p.platform)}</span></div>
    <form data-action="bench:parse">
      <textarea name="text" rows="8" placeholder="粘贴模拟串口输出，如：&#10;BENCHMARK_START&#10;RESULT|matmul_4x4|12345&#10;BENCHMARK_END"></textarea>
      <button class="primary" type="submit"><i class="codicon codicon-chrome-maximize"></i>解析协议输出</button>
    </form>
    ${table}
    ${p.note ? `<div class="status">${esc(p.note)}</div>` : ''}`;
}

/** Render the full main-region HTML for a page with its payload (P-G2; used by tests). */
export function buildPageContentHtml(page: CockpitPage, payload: PagePayload): string {
  const def = PAGES.find((p) => p.id === page) ?? PAGES[0];
  const head = `<h1>${esc(def.label)}</h1><div class="sub">${esc(def.hint)}</div>`;
  return `<section class="page">${head}${buildSectionBodyHtml(page, payload)}</section>`;
}

/** Body-only HTML of a section payload (V2-2: embedded in the single-column doc). */
export function buildSectionBodyHtml(page: CockpitPage, payload: PagePayload): string {
  if (page === 'overview') {
    return overviewContent((payload ?? { tools: [], lastBuildOk: null, lastTest: null }) as OverviewPayload);
  }
  if (page === 'buildTest') {
    return buildTestContent((payload ?? { lastBuildOk: null, lastTest: null }) as BuildTestPayload);
  }
  if (page === 'deps') {
    return depsContent((payload as DepsPayload) ?? { items: [], issues: [] });
  }
  if (page === 'bench') {
    return benchContent((payload as BenchPayload) ?? { platform: '未检测', parsed: null });
  }
  const def = PAGES.find((p) => p.id === page) ?? PAGES[0];
  if (payload && typeof payload === 'object' && 'rows' in payload && 'actions' in payload) {
    return summaryContent(payload as SummaryPayload);
  }
  return `<div class="placeholder">（「${esc(def.label)}」分区暂未就绪）</div>`;
}

/** P-G4 host-supplied wizard facts (template source, destination parent). */
export interface CockpitWizardInfo {
  templateRepo: string;
  templateRef: string;
  modeLabel: string;
  parentDir: string;
  /** V2-4: resolvable local template path ('' = none) + availability flag. */
  localPath?: string;
  hasLocal?: boolean;
}

const WIZARD_STEPS = ['模板源', '身份', '构建参数', '开关', '确认'];

function selOption(value: string, label: string, current: string | undefined): string {
  return `<option value="${esc(value)}"${current === value ? ' selected' : ''}>${esc(label)}</option>`;
}

/** Five-step onboarding overlay (P-G4). */
export function renderWizardRegion(
  wizard: CockpitWizard | null,
  info: CockpitWizardInfo,
  draft: Record<string, string>,
  lang: CockpitLang = 'zh',
): string {
  if (!wizard) {
    return '';
  }
  const dots = WIZARD_STEPS.map((label, i) => {
    const cls = i + 1 === wizard.step ? 'cur' : i + 1 < wizard.step ? 'done' : '';
    const localized = t(lang, label, ['Template', 'Identity', 'Build', 'Switches', 'Confirm'][i]);
    return `<span class="wstep ${cls}">${i + 1} ${esc(localized)}</span>`;
  }).join('');

  const row = (k: string, v: string): string => `<div class="srow"><span class="sk">${esc(k)}</span><span class="sv">${esc(v)}</span></div>`;
  let body = '';
  if (wizard.step === 1) {
    const srcOpts = [
      { v: 'pinned', label: '固定哈希（推荐 · 可复现）', en: 'Pinned ref (recommended)' },
      { v: 'release', label: '在线最新（默认分支）', en: 'Online latest (default branch)' },
      { v: 'local', label: '本地模板', en: 'Local template', disabled: !info.hasLocal },
    ]
      .map(
        (o) =>
          `<option value="${o.v}"${draft.source === o.v ? ' selected' : ''}${o.disabled ? ' disabled' : ''}>${t(lang, o.label, o.en)}</option>`,
      )
      .join('');
    const localLine = info.hasLocal && info.localPath ? t(lang, `本地模板：${info.localPath}`, `Local: ${info.localPath}`) : t(lang, '本地模板：未配置', 'Local template: not configured');
    body = `<div class="slist">
      ${row(t(lang, '模板仓库', 'Template repo'), info.templateRepo)}
      ${row(t(lang, '固定 ref', 'Pinned ref'), info.templateRef)}
      ${row(t(lang, '模板源', 'Source'), info.modeLabel)}
    </div>
    <form data-wizard="submit">
      <label>${t(lang, '本次使用', 'Use source')}
        <select name="source">${srcOpts}</select>
      </label>
      <div class="status">${localLine} · ${t(lang, '在线不可用时自动回退到本地模板并明确提示（来源记录在 .het/template-ref.json）。', 'Auto-falls back to the local template with a clear notice (source recorded in .het/template-ref.json).')}</div>
    </form>`;
  } else if (wizard.step === 2) {
    body = `<form data-wizard="submit">
      <label>${t(lang, '项目名（字母/数字/下划线/连字符）', 'Project name (letters/digits/_/-)')}
        <input name="name" value="${esc(draft.name ?? '')}" placeholder="my-lib" required>
      </label>
      <label>${t(lang, '描述', 'Description')}
        <input name="description" value="${esc(draft.description ?? '')}" placeholder="${t(lang, '一句话描述', 'one-line description')}">
      </label>
    </form>`;
  } else if (wizard.step === 3) {
    body = `<form data-wizard="submit">
      <label>build_type
        <select name="buildType">
          ${selOption('Debug', 'Debug', draft.buildType)}
          ${selOption('Release', 'Release', draft.buildType)}
          ${selOption('RelWithDebInfo', 'RelWithDebInfo', draft.buildType)}
          ${selOption('MinSizeRel', 'MinSizeRel', draft.buildType)}
        </select>
      </label>
      <label>build_cppstd
        <select name="cppstd">
          ${selOption('11', 'C++11', draft.cppstd)}
          ${selOption('14', 'C++14', draft.cppstd)}
          ${selOption('17', 'C++17', draft.cppstd)}
          ${selOption('20', 'C++20', draft.cppstd)}
          ${selOption('23', 'C++23', draft.cppstd)}
        </select>
      </label>
    </form>`;
  } else if (wizard.step === 4) {
    body = `<form data-wizard="submit">
      <label>enable_python_bindings
        <select name="pybind">
          ${selOption('no', '否（默认）', draft.pybind)}
          ${selOption('yes', '是', draft.pybind)}
        </select>
      </label>
    </form>`;
  } else {
    const dest = joinWeb(draft.name ?? 'my-lib', info.parentDir);
    const srcLabel =
      draft.source === 'local' && info.hasLocal
        ? t(lang, '本地模板', 'Local template')
        : draft.source === 'release'
          ? t(lang, '在线最新', 'Online latest')
          : t(lang, '固定哈希', 'Pinned ref');
    body = `<div class="slist">
      ${row(t(lang, '项目名', 'Project'), draft.name ?? '—')}
      ${row(t(lang, '目标目录', 'Destination'), dest)}
      ${row(t(lang, '模板源', 'Source'), `${info.modeLabel} · ${srcLabel}`)}
      ${row(t(lang, '构建参数', 'Build params'), `${draft.buildType ?? 'Debug'} · C++${draft.cppstd ?? '17'}`)}
      ${row(t(lang, 'Python 绑定', 'Python bindings'), draft.pybind === 'yes' ? t(lang, '开启', 'On') : t(lang, '关闭', 'Off'))}
    </div>
    <div class="status">${t(lang, '确认后将：复制模板 → 改写 metadata.json（保留原排版）→ git init + 基线提交 → 记录模板 ref。离线环境自动回退本地模板副本。', 'Will: copy template → rewrite metadata.json (format-preserving) → git init + baseline commit → record template ref. Offline auto-falls back to the local copy.')}</div>`;
  }

  const err = wizard.error ? `<div class="warn">${esc(wizard.error)}</div>` : '';
  const back = wizard.step > 1 ? `<button data-wizard="prev">${t(lang, '上一步', 'Back')}</button>` : '';
  const next =
    wizard.step < 5 ? `<button class="primary" data-wizard="next">${t(lang, '下一步', 'Next')}</button>` : `<button class="primary" data-wizard="finish">${t(lang, '创建项目', 'Create project')}</button>`;
  return `<div class="wiz-mask">
    <div class="wiz-box">
      <div class="wiz-head"><span class="wiz-title">${t(lang, '新项目向导', 'New project wizard')}</span><button class="textbtn" data-wizard="close">✕</button></div>
      <div class="wiz-dots">${dots}</div>
      ${body}
      ${err}
      <div class="actions">${back}${next}</div>
    </div>
  </div>`;
}

/** Join a project name onto a parent dir (webview-safe, '/' separators only). */
function joinWeb(name: string, parent: string): string {
  const n = name.replace(/[\\/]/g, '');
  return `${parent.replace(/[\\]+$/u, '')}/${n}`;
}

/** In-page table of contents: horizontal chips that anchor to each section. */
function railHtml(active: CockpitPage): string {
  return `<div class="toc-inner">${PAGES.map(
    (p) =>
      `<a class="rail-item ${p.id === active ? 'active' : ''}" href="#sec-${p.id}" data-page="${p.id}" title="${esc(p.hint)}">
        <i class="codicon codicon-${p.icon}"></i><span>${esc(p.label)}</span>
      </a>`,
  ).join('')}</div>`;
}

function placeholderBody(def: { label: string }): string {
  return `<div class="placeholder">（「${esc(def.label)}」分区暂未就绪）</div>`;
}

/** One collapsible dashboard section: <details> gives free open/close (V2-2). */
function sectionHtml(def: { id: CockpitPage; icon: string; label: string; hint: string }, body: string): string {
  return `<details class="dsec" open data-sec="${def.id}">
    <summary class="dsec-head" id="sec-${def.id}"><i class="codicon codicon-${def.icon}"></i><span class="sl">${esc(def.label)}</span><span class="hint">${esc(def.hint)}</span></summary>
    <div class="dsec-body">${body}</div>
  </details>`;
}

/**
 * Single-column, markdown-like document of every dashboard section (V2-2).
 * The page field keeps the active TOC highlight; all bodies render stacked so
 * the panel never needs a left rail and never breaks at narrow widths.
 */
export function dashboardMainHtml(
  s: CockpitState,
  bodies: Partial<Record<CockpitPage, string>> = {},
  lang: CockpitLang = 'zh',
): string {
  void s;
  void lang;
  return `<div class="doc">${PAGES.map((p) => sectionHtml(p, bodies[p.id] ?? placeholderBody(p))).join('')}</div>`;
}

function topHtml(s: CockpitState, lang: CockpitLang = 'zh'): string {
  const health = s.top.health === null ? '' : `<span class="chip ${s.top.health >= 80 ? 'ok' : s.top.health >= 50 ? 'warn' : 'fail'}">${t(lang, '健康分', 'Health')} ${s.top.health}</span>`;
  const tpl = s.top.templateBehind > 0 ? `<span class="chip warn">${t(lang, '●模板可更新', '● Template update')} ${s.top.templateBehind}</span>` : '';
  const run = s.top.running ? `<span class="chip running"><span class="spin">●</span> ${esc(s.top.running)}</span>` : '';
  const name = s.top.projectName ? `<span class="proj"><i class="codicon codicon-package"></i>${esc(s.top.projectName)}</span>` : '<span class="proj dim">HeT DevTools</span>';
  const np = `<button class="chip action" data-wizard="open">${t(lang, '＋ 新项目', '+ New project')}</button>`;
  return `${name}${health}${tpl}${run}<span class="flex"></span>${np}`;
}

function drawerHtml(s: CockpitState, lang: CockpitLang = 'zh'): string {
  const collapsed = t(lang, '日志 · 问题 · 向导', 'Log · Issues · Wizard');
  if (!s.drawer.expanded) {
    return `<div class="drawer collapsed" data-toggle="drawer"><span class="caret">▸</span> ${esc(collapsed)}</div>`;
  }
  const body =
    s.drawer.kind === 'log'
      ? `<pre>${s.drawer.lines.map((l) => esc(l)).join('\n') || '（暂无输出）'}</pre>`
      : s.drawer.kind === 'issues'
        ? `<div class="warn">${esc(s.drawer.title)} <button data-cmd="workbench.actions.view.problems">查看问题</button></div>`
        : '';
  return `<div class="drawer expanded">
    <div class="drawer-head" data-toggle="drawer"><span class="caret">▾</span> ${esc(s.drawer.title || collapsed)}</div>
    ${body}
  </div>`;
}

/** Render the full cockpit document for the given state. */
export function buildCockpitHtml(
  s: CockpitState,
  assets: CockpitAssets,
  wizardInfo?: CockpitWizardInfo,
  wizardDraft?: Record<string, string>,
  sectionBodies?: Partial<Record<CockpitPage, string>>,
): string {
  const lang: CockpitLang = assets.lang ?? 'zh';
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>HeT DevTools 驾驶舱</title>
<link rel="stylesheet" href="${esc(assets.codiconCss)}">
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
    color: var(--vscode-foreground); background: var(--vscode-editor-background); height: 100vh; display: flex; flex-direction: column; }
  .top { display: flex; align-items: center; gap: 10px; padding: 6px 12px;
    border-bottom: 1px solid var(--vscode-widget-border,#333); background: var(--vscode-editorWidget-background); font-size: 12px; }
  .top .proj { display: inline-flex; align-items: center; gap: 5px; font-weight: 600; }
  .top .dim { opacity: .6; }
  .chip { padding: 2px 8px; border-radius: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .chip.ok { background: #388a34; color: #fff; }
  .chip.warn { background: #9c6b1c; color: #fff; }
  .chip.fail { background: #a1260d; color: #fff; }
  .spin { display: inline-block; animation: het-spin 1s linear infinite; }
  @keyframes het-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  .main { flex: 1; overflow-y: auto; padding: 12px 16px 24px; }
  .rail { position: sticky; top: 0; z-index: 6; display: flex; overflow-x: auto; gap: 2px;
    padding: 4px 12px; border-bottom: 1px solid var(--vscode-widget-border,#333);
    background: var(--vscode-editorWidget-background); }
  .rail-item { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; text-decoration: none;
    color: var(--vscode-foreground); padding: 3px 10px; border-radius: 12px; font-size: 12px; cursor: pointer; opacity: .75; }
  .rail-item i { width: 14px; }
  .rail-item:hover { background: var(--vscode-list-hoverBackground); opacity: 1; }
  .rail-item.active { background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground); opacity: 1; }
  .doc { max-width: 900px; margin: 0 auto; }
  .dsec { margin: 8px 0; border: 1px solid var(--vscode-widget-border,#2b2b2b); border-radius: 8px; }
  .dsec-head { display: flex; align-items: center; gap: 7px; padding: 7px 12px; cursor: pointer;
    user-select: none; font-size: 13px; font-weight: 600; background: var(--vscode-editorWidget-background);
    list-style: none; scroll-margin-top: 44px; border-radius: 8px; }
  .dsec-head::-webkit-details-marker, .dsec-head::marker { display: none; content: ''; }
  .dsec-head i { width: 16px; }
  .dsec-head .hint { font-weight: 400; opacity: .55; font-size: 11px; margin-left: 4px; }
  .dsec-body { padding: 4px 14px 12px; }
  details.mini { margin: 8px 0; border: 1px solid var(--vscode-widget-border,#2b2b2b); border-radius: 6px; }
  .mini-head { padding: 6px 10px; cursor: pointer; font-size: 12px; font-weight: 600;
    list-style: none; background: var(--vscode-editorWidget-background); border-radius: 6px; }
  .mini-head::-webkit-details-marker, .mini-head::marker { display: none; content: ''; }
  details.mini .drow { padding: 3px 10px; }
  .grid { display: flex; gap: 10px; flex-wrap: wrap; margin: 8px 0; }
  .page h1 { font-size: 17px; margin: 0 0 2px; }
  .page .sub { opacity: .7; font-size: 12px; margin-bottom: 10px; }
  .placeholder { margin-top: 14px; padding: 22px; text-align: center; opacity: .55; font-size: 12px;
    border: 1px dashed var(--vscode-widget-border,#444); border-radius: 8px; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin: 10px 0; }
  button.primary { display: inline-flex; align-items: center; gap: 6px;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; border-radius: 4px; padding: 6px 12px; cursor: pointer; }
  button.primary i { width: 16px; }
  .row { margin: 6px 0; font-size: 12px; }
  .status { font-size: 12px; }
  .drawer { border-top: 1px solid var(--vscode-widget-border,#333); background: var(--vscode-editorWidget-background); }
  .drawer.collapsed { padding: 6px 12px; font-size: 12px; opacity: .8; cursor: pointer; }
  .drawer-head { padding: 6px 12px; font-size: 12px; cursor: pointer; opacity: .9; }
  .caret { display: inline-block; width: 12px; }
  .drawer pre { margin: 0; padding: 6px 12px; max-height: 180px; overflow-y: auto;
    font-size: 11px; font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background,#111); }
  .warn { padding: 6px 12px; font-size: 12px; }
  .grid { display: flex; gap: 10px; margin: 8px 0; }
  .slist { margin: 8px 0; }
  .srow { display: flex; gap: 12px; padding: 4px 0; border-bottom: 1px solid var(--vscode-widget-border,#2b2b2b); font-size: 12px; }
  .srow .sk { width: 130px; opacity: .75; flex-shrink: 0; }
  .srow .sv { flex: 1; }
  .drow { display: flex; gap: 12px; align-items: center; padding: 4px 0;
    border-bottom: 1px solid var(--vscode-widget-border,#2b2b2b); font-size: 12px; }
  .drow .dk { width: 120px; opacity: .75; flex-shrink: 0; }
  .drow .dv { flex: 1; }
  .dim { opacity: .65; }
  button.textbtn { background: none; border: none; color: var(--vscode-textLink-foreground);
    cursor: pointer; font-size: 12px; padding: 0; }
  .addform { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 10px 0; }
  .addform input, .addform select { background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border,#555); border-radius: 4px; padding: 5px 8px; font-size: 12px; min-width: 120px; }
  textarea { width: 100%; max-width: 640px; box-sizing: border-box; background: var(--vscode-input-background);
    color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border,#555); border-radius: 4px;
    padding: 6px 8px; font-family: var(--vscode-editor-font-family); font-size: 12px; }
  form[data-action] { margin: 10px 0; }
  .card { border: 1px solid var(--vscode-widget-border,#333); border-radius: 8px;
    padding: 10px 14px; background: var(--vscode-editorWidget-background); min-width: 160px; }
  .card .ct { font-size: 11px; opacity: .7; }
  .card .cv { font-size: 15px; font-weight: 600; margin-top: 4px; }
  .flex { flex: 1; }
  button.chip.action { border: none; cursor: pointer; font-size: 12px; }
  .wiz-mask { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: flex;
    align-items: center; justify-content: center; z-index: 10; }
  .wiz-box { width: 560px; max-width: 92vw; max-height: 84vh; overflow-y: auto;
    background: var(--vscode-editor-background); border: 1px solid var(--vscode-widget-border,#444);
    border-radius: 8px; padding: 14px 18px; }
  .wiz-head { display: flex; align-items: center; justify-content: space-between; }
  .wiz-title { font-weight: 600; font-size: 14px; }
  .wiz-dots { display: flex; gap: 6px; margin: 10px 0 12px; flex-wrap: wrap; }
  .wstep { font-size: 11px; padding: 2px 8px; border-radius: 10px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); opacity: .55; }
  .wstep.cur { opacity: 1; }
  .wstep.done { background: #388a34; color: #fff; }
  .wiz-box form { display: flex; flex-direction: column; gap: 10px; margin: 10px 0; }
  .wiz-box label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
  .wiz-box input, .wiz-box select { background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border,#555); border-radius: 4px; padding: 5px 8px; font-size: 12px; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
    border: none; border-radius: 4px; padding: 6px 12px; cursor: pointer; }
</style>
</head>
<body>
  <div class="top" id="top">${topHtml(s, lang)}</div>
  <nav class="rail" id="rail">${railHtml(s.page)}</nav>
  <main class="main" id="main">${dashboardMainHtml(s, sectionBodies, lang)}</main>
  <div id="drawer">${drawerHtml(s, lang)}</div>
  <div id="wizard">${renderWizardRegion(s.wizard, wizardInfo ?? { templateRepo: '', templateRef: '', modeLabel: '', parentDir: '', localPath: '', hasLocal: false }, wizardDraft ?? {}, lang)}</div>
  <script>
    (function () {
      const vscode = acquireVsCodeApi();
      const escH = (v) => String(v ?? '').replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
      document.getElementById('rail').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-page]');
        if (btn) { vscode.postMessage({ type: 'cockpit:navigate', page: btn.getAttribute('data-page') }); }
      });
      document.getElementById('main').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-cmd]');
        if (btn) { vscode.postMessage({ type: 'page:action', command: btn.getAttribute('data-cmd') }); return; }
        const pa = e.target.closest('[data-page-action]');
        if (pa) {
          const data = {};
          for (const a of pa.attributes) {
            if (a.name.indexOf('data-arg-') === 0) { data[a.name.slice('data-arg-'.length)] = a.value; }
          }
          const sec = e.target.closest('[data-sec]') ? e.target.closest('[data-sec]').getAttribute('data-sec') : undefined;
          vscode.postMessage({ type: 'cockpit:page:action', action: pa.getAttribute('data-page-action'), data, section: sec });
        }
      });
      document.getElementById('main').addEventListener('submit', (e) => {
        const form = e.target.closest('form[data-action]');
        if (!form) { return; }
        e.preventDefault();
        const data = {};
        new FormData(form).forEach((v, k) => { data[k] = String(v); });
        const sec = form.closest('[data-sec]') ? form.closest('[data-sec]').getAttribute('data-sec') : undefined;
        vscode.postMessage({ type: 'cockpit:page:action', action: form.getAttribute('data-action'), data, section: sec });
      });
      document.getElementById('drawer').addEventListener('click', (e) => {
        if (e.target.closest('[data-toggle="drawer"]')) { vscode.postMessage({ type: 'drawer:toggle', expand: !document.getElementById('drawer').firstElementChild.classList.contains('expanded') }); }
        const btn = e.target.closest('[data-cmd]');
        if (btn) { vscode.postMessage({ type: 'page:action', command: btn.getAttribute('data-cmd') }); }
      });
      document.getElementById('top').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-wizard]');
        if (btn) { vscode.postMessage({ type: 'cockpit:wizard', action: btn.getAttribute('data-wizard') }); }
      });
      document.getElementById('wizard').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-wizard]');
        if (!btn || btn.getAttribute('data-wizard') === 'submit') { return; }
        const action = btn.getAttribute('data-wizard');
        let data;
        if (action === 'next' || action === 'finish') {
          // “下一步/创建”位于表单之外，点击时同样采集当前步骤的表单值，
          // 否则草稿永远收不到 name 等字段（destination 停留在 my-lib）。
          const form = document.querySelector('#wizard form[data-wizard="submit"]');
          if (form) {
            data = {};
            new FormData(form).forEach((v, k) => { data[k] = String(v); });
          }
        }
        vscode.postMessage({ type: 'cockpit:wizard', action, data });
      });
      document.getElementById('wizard').addEventListener('submit', (e) => {
        const form = e.target.closest('form[data-wizard="submit"]');
        if (!form) { return; }
        e.preventDefault();
        const data = {};
        new FormData(form).forEach((v, k) => { data[k] = String(v); });
        vscode.postMessage({ type: 'cockpit:wizard', action: 'submit', data });
      });
      window.addEventListener('message', (e) => {
        const m = e.data;
        if (m && m.type === 'cockpit:state' && m.regions) {
          document.getElementById('top').innerHTML = m.regions.top;
          document.getElementById('rail').innerHTML = m.regions.rail;
          const mainEl = document.getElementById('main');
          // Skip no-op doc writes so a TOC jump never resets the scroll.
          if (mainEl.innerHTML !== m.regions.main) { mainEl.innerHTML = m.regions.main; }
          document.getElementById('drawer').innerHTML = m.regions.drawer;
          document.getElementById('wizard').innerHTML = m.regions.wizard;
          if (m.focusSection) {
            const el = document.getElementById('sec-' + m.focusSection);
            if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
          }
        }
      });
    })();
  </script>
</body>
</html>`;
}

/** Render just the mutable regions (top/toc/main/drawer) from a state. */
export function renderCockpitRegions(
  s: CockpitState,
  lang: CockpitLang = 'zh',
  bodies?: Partial<Record<CockpitPage, string>>,
): { top: string; rail: string; main: string; drawer: string } {
  return {
    top: topHtml(s, lang),
    rail: railHtml(s.page),
    main: dashboardMainHtml(s, bodies, lang),
    drawer: drawerHtml(s, lang),
  };
}
