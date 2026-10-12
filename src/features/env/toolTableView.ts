/**
 * 「工具链一览」的纯渲染层（V3 计划 §4.5 / G13）。
 *
 * 起因：`discoverTools()` 早就给出了每个工具的 **绝对路径**（`exe`）与 **来源**
 * （`source` / `sourceDetail`：手动覆盖 / PATH / conda env / venv / uv / WSL），
 * 但**一处渲染都没有** —— 用户想确认"我用的是哪套、装在哪"只能去导一份诊断文件。
 *
 * 三条铁律（与 capability 同源）：
 * 1. **只渲染真实拿到的路径**；没拿到就写"未找到"，**绝不**显示推测路径；
 * 2. **未知 ≠ 没有**：没探测过的工具不许说"缺失"；
 * 3. 每条信息都要能被用户用起来 —— 所以在行上直接给「复制路径」「在哪配置」。
 *
 * 纯函数（不 import vscode、不 import discovery 内部），输入用**结构类型**描述，
 * 于是单测可以直接造夹具。
 */
import { TOOL_MATRIX, type ToolChain } from '../../core/toolMatrix';
import { pageShell } from '../ui';
import type { SinglePageFacts } from '../cockpit/singlepage/modelFrom';

/** 探测结果的形状（结构类型：`ToolRow` 天然满足，不必互相 import）。 */
export interface ToolFact {
  key: string;
  label: string;
  /** 绝对路径；空串 = 没找到。 */
  exe: string;
  /** `path` / `conda` / `mamba` / `uv` / `venv` / `wsl` / `override` / `missing`。 */
  source: string;
  /** 来源明细（如 `conda 环境 build`）。 */
  sourceDetail: string;
  overridden?: boolean;
  /** conan 自己管的（gtest/benchmark）：宿主不需要装。 */
  managed?: boolean;
  /** 可选工具（lcov/gcovr）：缺了不是错。 */
  optional?: boolean;
  /** WSL 行：仅供参考（Windows 侧构建用不到）。 */
  informational?: boolean;
}

/** 一行的视图模型。 */
export interface ToolViewRow {
  key: string;
  label: string;
  /** 真实路径；`undefined` = 未找到（渲染成"未找到"）。 */
  path?: string;
  /** 来源的人话（`conda 环境 build` / `PATH` / `手动覆盖` …）。 */
  sourceLabel: string;
  /** 手动覆盖（最容易被"我用的是不是我以为的那个"坑到）→ 界面上要显眼。 */
  overridden: boolean;
  /** 版本（只在真探测到时才有）。 */
  version?: string;
  /** 属于哪条链；`undefined` = 这条工具不在矩阵里（不编造）。 */
  chain?: ToolChain;
  /** 未找到（且不是 conan 托管、不是可选）。 */
  missing: boolean;
}

/** 链的展示顺序（先"没有它什么都干不了"的）。 */
const CHAIN_ORDER: readonly ToolChain[] = ['build', 'coverage', 'docs', 'quality', 'security', 'optional'];

const CHAIN_LABEL: Readonly<Record<ToolChain, string>> = {
  build: '构建',
  coverage: '覆盖率',
  docs: '文档',
  quality: '质量',
  security: '安全',
  optional: '可选',
};

const SOURCE_LABEL: Readonly<Record<string, string>> = {
  path: 'PATH',
  conda: 'conda 环境',
  mamba: 'mamba 环境',
  uv: 'uv',
  venv: 'venv',
  wsl: 'WSL（仅参考）',
  override: '手动覆盖',
  missing: '未找到',
};

/** 工具 key → 链（`TOOL_MATRIX` 是唯一来源；不在表里就不显示链）。 */
export function chainOf(key: string): ToolChain | undefined {
  return TOOL_MATRIX.find((t) => t.id === key)?.chain;
}

/** 该工具的"怎么装"人话（同样来自矩阵，不另写一份）。 */
export function installHintOf(key: string): string | undefined {
  return TOOL_MATRIX.find((t) => t.id === key)?.install;
}

function chainRank(chain: ToolChain | undefined): number {
  const at = chain ? CHAIN_ORDER.indexOf(chain) : CHAIN_ORDER.length;
  return at < 0 ? CHAIN_ORDER.length : at;
}

/**
 * 版本表匹配：先按工具 key，再按可执行文件名（`graphviz` 的 exe 是 `dot`，
 * `sphinx` 的 exe 是 `sphinx-build` —— 探测层用的是后者）。
 */
function versionOf(fact: ToolFact, versions: Readonly<Record<string, string>> | undefined): string | undefined {
  if (!versions) {
    return undefined;
  }
  const direct = versions[fact.key];
  if (direct) {
    return direct;
  }
  const base = fact.exe ? fact.exe.split(/[\\/]/u).pop() : '';
  return base ? versions[base] : undefined;
}

/**
 * 探测结果 → 视图行。
 *
 * 排序：**未找到的排最前**（有事要做的先看见），其余按"链"的顺序，再按名字。
 */
export function toolViewRows(
  tools: readonly ToolFact[],
  versions?: Readonly<Record<string, string>>,
): ToolViewRow[] {
  const rows: ToolViewRow[] = tools.map((t) => {
    const chain = chainOf(t.key);
    const missing = t.exe === '' && t.source === 'missing';
    return {
      key: t.key,
      label: t.label,
      sourceLabel: SOURCE_LABEL[t.source] ?? t.source,
      overridden: t.overridden === true,
      missing: missing && t.managed !== true && t.optional !== true,
      chain,
      ...(t.exe ? { path: t.exe } : {}),
      ...(versionOf(t, versions) ? { version: versionOf(t, versions) as string } : {}),
    };
  });
  return rows.sort((a, b) => {
    if (a.missing !== b.missing) {
      return a.missing ? -1 : 1;
    }
    const ca = chainRank(a.chain);
    const cb = chainRank(b.chain);
    if (ca !== cb) {
      return ca - cb;
    }
    return a.label.localeCompare(b.label, 'zh');
  });
}

/** 综合状态：有缺失 = warn；全部就绪 = ok；一个都没探测到 = idle（不谎报）。 */
export function toolSummaryState(tools: readonly ToolFact[]): 'ok' | 'warn' | 'idle' {
  if (tools.length === 0) {
    return 'idle';
  }
  return toolViewRows(tools).some((r) => r.missing) ? 'warn' : 'ok';
}

/**
 * 一行摘要（① 就绪站的卡片事实）。
 *
 * 规矩：**全绿时不啰嗦**（只报 `配套工具 15/15 就绪`）；有缺时**缺失项排最前**，
 * 再补关键三件（conan / cmake / ninja）的来源 —— 这三件决定"这套环境能不能干活"。
 */
export function toolSummaryText(tools: readonly ToolFact[]): string {
  if (tools.length === 0) {
    return '';
  }
  const rows = toolViewRows(tools);
  const ready = rows.length - rows.filter((r) => r.missing).length;
  const missing = rows.filter((r) => r.missing).map((r) => r.label);
  if (missing.length === 0) {
    return `配套工具 ${ready}/${rows.length} 就绪`;
  }
  const key3 = ['conan', 'cmake', 'ninja']
    .map((k) => tools.find((t) => t.key === k))
    .filter((t): t is ToolFact => t !== undefined && t.exe !== '')
    .map((t) => `${t.label} (${SOURCE_LABEL[t.source] ?? t.source})`)
    .join(' · ');
  const parts = [`配套工具 ${ready}/${rows.length} 就绪`, `缺 ${missing.join(' ')}`];
  if (key3) {
    parts.push(key3);
  }
  return parts.join(' · ');
}

/**
 * 探测结果 → 单页模型要的那一份事实（① 就绪站的「工具链」卡）。
 *
 * 只给**已经算好的东西**：总数/就绪数/缺谁/一行摘要 —— 布局层不再自己算一遍。
 */
export function toolFactsOf(tools: readonly ToolFact[]): NonNullable<SinglePageFacts['tools']> {
  const rows = toolViewRows(tools);
  const missing = rows.filter((r) => r.missing).map((r) => r.label);
  return {
    total: rows.length,
    ready: rows.length - missing.length,
    missing,
    summary: toolSummaryText(tools),
  };
}

/**
 * 「工具链与环境」的整页 HTML（Slot 正文；`pageShell` = 全文档只有一段脚本）。
 *
 * 交互走事件委托 + `pageShell` 提供的 `send()`（不再 `acquireVsCodeApi()`）。
 */
export function toolsPageHtml(rows: readonly ToolViewRow[]): string {
  return pageShell(
    '就绪：工具链与环境',
    `<div class="card">
      <h1>工具链与环境</h1>
      <div class="sub">这是**真实探测**的结果：每个工具的路径与来源。手动覆盖的那几行要重点看 —— 它是"我用的是不是我以为的那个"最大的坑。</div>
      <div id="tools-root">${toolTableHtml(rows)}</div>
      <div class="row"><button class="secondary" data-action="tools:refresh">重新探测</button></div>
    </div>
    <script>
      document.addEventListener('click', function (ev) {
        var el = ev.target instanceof Element ? ev.target : null;
        if (!el) { return; }
        var btn = el.closest('[data-action]');
        if (!btn) { return; }
        var act = btn.getAttribute('data-action');
        if (act === 'tools:copy') {
          send({ type: 'tools:copy', path: btn.getAttribute('data-tool-path') });
          btn.textContent = '已复制';
          setTimeout(function () { btn.textContent = '复制路径'; }, 1200);
          return;
        }
        if (act === 'tools:config') {
          send({ type: 'tools:config', key: btn.getAttribute('data-tool-key') });
          return;
        }
        if (act === 'tools:refresh') {
          send({ type: 'tools:refresh' });
          return;
        }
      });
    </script>`,
  );
}

function esc(s: string): string {
  return s
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}

const TABLE_CSS = `
  table.tools { width: 100%; border-collapse: collapse; font-size: .88em; }
  table.tools th, table.tools td { border-bottom: 1px solid var(--het-border); padding: 4px 8px; text-align: left; vertical-align: top; }
  table.tools th { color: var(--het-fg-dim); font-weight: 600; }
  table.tools tr.row-missing td { color: var(--het-warn); }
  table.tools tr.row-override td.src { color: var(--het-warn); font-weight: 600; }
  table.tools td.path { font-family: var(--vscode-editor-font-family, monospace); font-size: .92em; overflow-wrap: anywhere; }
  table.tools td.acts { white-space: nowrap; }
  .empty { padding: 10px 2px; opacity: .75; }
`;

/**
 * 「工具链与环境」的表格片段（Slot 正文）。
 *
 * 动作协议（视图自己的两条消息，由 host 侧 `tools:` 前缀接管）：
 * · `tools:copy` + `path` —— 复制真实路径；
 * · `tools:config` + `key` —— 打开该工具的设置项（`het.tools.<key>`）。
 * 缺失行还会带上"怎么装"（来自 `TOOL_MATRIX`），**同一句话全库只写一次**。
 */
export function toolTableHtml(rows: readonly ToolViewRow[]): string {
  if (rows.length === 0) {
    return `<style>${TABLE_CSS}</style><div class="empty">还没探测到工具 —— 先跑一次环境体检（① 就绪站）。</div>`;
  }
  const body = rows
    .map((r) => {
      const cls = r.missing ? 'row-missing' : r.overridden ? 'row-override' : '';
      const path = r.path
        ? `<td class="path" title="${esc(r.path)}">${esc(r.path)}</td>`
        : `<td class="path">未找到</td>`;
      const copy = r.path
        ? `<button class="secondary" data-action="tools:copy" data-tool-path="${esc(r.path)}">复制路径</button>`
        : '';
      const install = r.missing ? installHintOf(r.key) : undefined;
      return `<tr class="${cls}">
        <td>${esc(r.label)}${r.version ? ` <span class="sub">${esc(r.version)}</span>` : ''}</td>
        <td>${r.chain ? esc(CHAIN_LABEL[r.chain]) : '—'}</td>
        ${path}
        <td class="src">${esc(r.sourceLabel)}</td>
        <td class="acts">
          ${copy}
          <button class="secondary" data-action="tools:config" data-tool-key="${esc(r.key)}">在哪配置</button>
        </td>
      </tr>${install ? `\n<tr class="row-missing"><td colspan="5" class="sub">${esc(install)}</td></tr>` : ''}`;
    })
    .join('\n');
  return `<style>${TABLE_CSS}</style>
  <table class="tools">
    <thead><tr><th>工具</th><th>链</th><th>路径</th><th>来源</th><th></th></tr></thead>
    <tbody>${body}</tbody>
  </table>
  <div class="sub">路径与来源都来自**真实探测**（未找到就是未找到，不显示推测路径）；来源为「手动覆盖」时请确认是你想要的那一套。</div>`;
}
