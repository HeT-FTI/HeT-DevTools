/**
 * **单页驾驶舱的静态预览生成器**（开发辅助；只被 `npm run preview:cockpit` 使用，
 * 不在扩展运行路径上）。
 *
 * 起因：开发机是远端服务器（Remote-SSH），VS Code 窗口开在用户桌面上 —— 改完 UI 我自己
 * 看不到渲染结果，只能靠文字描述。这里把**真正的渲染函数**在 Node 里跑一遍，导出
 * 自包含 HTML，再由截图驱动落成 PNG，于是"页面到底长什么样"变成可留档、可逐版对比的证据。
 *
 * 与真机的差别（必须在读图时知道）：
 * 1. `acquireVsCodeApi()` 换成空壳 —— 只影响 `postMessage`，**不影响渲染**；
 * 2. 颜色走 `--vscode-*` 变量，浏览器里没有主题 → 预览页补了一套深色等价色；
 * 3. 悬停本来是 VS Code 渲染 Markdown，这里用极简 table 近似（**文案与行数与真机一致**）。
 *
 * 产物：`workspace/develope/preview/*.html`（`workspace/` 已被 gitignore）。
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cockpitSinglePageHtml } from '../features/cockpit/singlepage/shell';
import { singlePageModelFrom, type SinglePageFacts } from '../features/cockpit/singlepage/modelFrom';
import { DEFAULT_FOLDED, SECTION_IDS, type SinglePageModel } from '../features/cockpit/singlepage/model';
import { initialCockpitState } from '../features/cockpit/state';
import { hoverProjection } from '../core/statusItem';
import { chipHoverActions, chipStatusItems, chipSpec } from '../features/statusChip';
import {
  toolFactsOf,
  toolViewRows,
  toolsPageHtml,
  type ToolFact,
} from '../features/env/toolTableView';
import { orchestratorFactOf, parseOrchestrator } from '../core/orchestratorFacts';
import { auditNewLib, newLibAuditFact } from '../core/newLibAudit';
import { auditPythonBindings, pyBindFact } from '../core/pythonBindings';
import { CONTRACT_REL, collectLibSnapshot, collectPyBindFiles } from '../core/libSnapshot';
import { newLibAuditPageHtml } from '../features/audit/newLibPage';
import { listDependencies } from '../core/dependencyService';
import { emptyLedger, recordBuild, type BuildLedger } from '../core/buildLedger';
import { BUILD_MATRIX_REL, enabledTargets, parseBuildMatrix } from '../core/buildMatrix';
import { matrixView, recordedRuns, type MatrixView } from '../core/targetMatrix';
import type { HeaderCostRun } from '../core/headerCost';
import { agoText } from '../core/taskCenter';

const OUT_DIR = join(process.cwd(), 'workspace', 'develope', 'preview');

/**
 * 工具链探测结果的夹具（形状同 `discoverTools()` 的真输出：路径 + 来源）。
 * **故意带上一条"手动覆盖"与三条"缺"** —— 这两类才是截图要看的东西。
 */
const TOOL_FACTS: ToolFact[] = [
  { key: 'conan', label: 'Conan', exe: '/home/zc/miniforge3/envs/build/bin/conan', source: 'conda', sourceDetail: 'conda 环境 build' },
  { key: 'cmake', label: 'CMake', exe: '/usr/bin/cmake', source: 'path', sourceDetail: 'PATH' },
  { key: 'ninja', label: 'Ninja', exe: '/usr/bin/ninja', source: 'path', sourceDetail: 'PATH' },
  { key: 'python', label: 'Python', exe: '/home/zc/miniforge3/envs/build/bin/python', source: 'conda', sourceDetail: 'conda 环境 build' },
  { key: 'gcc', label: 'GCC (gcc)', exe: '/usr/bin/gcc', source: 'path', sourceDetail: 'PATH' },
  { key: 'g++', label: 'G++ (g++)', exe: '/usr/bin/g++', source: 'path', sourceDetail: 'PATH' },
  { key: 'make', label: 'Make', exe: '/usr/bin/make', source: 'path', sourceDetail: 'PATH' },
  { key: 'clang-format', label: 'clang-format', exe: '/home/zc/.local/share/uv/tools/clang-format/bin/clang-format', source: 'uv', sourceDetail: 'uv 工具环境' },
  { key: 'clang-tidy', label: 'clang-tidy', exe: '/opt/override/clang-tidy', source: 'override', sourceDetail: '手动指定（het.tools.clang-tidy）', overridden: true },
  { key: 'gitleaks', label: 'Gitleaks', exe: '/usr/local/bin/gitleaks', source: 'path', sourceDetail: 'PATH' },
  { key: 'gtest', label: 'GTest', exe: '', source: 'missing', sourceDetail: '', managed: true },
  { key: 'lcov', label: 'LCOV', exe: '', source: 'missing', sourceDetail: '', optional: true },
  { key: 'gcovr', label: 'gcovr', exe: '', source: 'missing', sourceDetail: '', optional: true },
  { key: 'doxygen', label: 'Doxygen', exe: '', source: 'missing', sourceDetail: '' },
  { key: 'graphviz', label: 'Graphviz (dot)', exe: '', source: 'missing', sourceDetail: '' },
];

/**
 * 一份"有血有肉"的事实集：覆盖 8 站的站状态、能力行、模板落后、失败项……
 * （空事实的模型看起来全是 `·`，截图没有信息量。）
 */
const FACTS: SinglePageFacts = {
  health: { score: 87, issues: 2 },
  env: { provider: 'win-wsl2', label: '托管车道 ready', ready: true, selfHeal: true },
  build: { ok: true, ago: '3 分钟前', buildType: 'Debug' },
  test: { passed: 42, failed: 1, skipped: 2 },
  coverage: { pct: 76.9, at: '3 分钟前' },
  docs: { pages: 128, at: '昨天' },
  quality: { ready: 4, total: 5, failing: 'clang-tidy' },
  // L5b：依赖事实来自**真的模板文件**（下面 main() 里读）；这里只占位，避免手写数字。
  // 占位：main() 读到真文件后会覆盖（见 FACTS_WITH_AUDIT）
  commit: { repo: true, branch: 'feat/v3-l4-delivery', detached: false, upstream: 'origin/main', ahead: 2, behind: 0, dirty: 3 },
  // ⑦ 发布站的「CI 总编排」（L4 / G10）：**真读模板里那份文件**，数字不是手写的
  orchestrator: (() => {
    const view = orchestratorFactOf(
      parseOrchestrator(readFileSync(join('assets', 'template', '.github', 'workflows', 'ci-orchestrator.yml'), 'utf8')),
    );
    return { fact: view.fact, ...(view.next ? { next: view.next } : {}) };
  })(),
  release: { notReady: 1 },
  ci: { lastRun: 'ok', branch: 'feat/v3-l1-spine' },
  network: { profile: 'cn', summary: '国内源 · rootfs 走镜像' },
  board: { mode: '--no-flash', collected: false, fact: '提交触发交叉编译：开' },
  template: { behind: 4 },
  metadata: {
    name: 'mylib',
    version: '0.3.1',
    is_shared: true,
    activate_code_coverage: true,
    enable_python_bindings: true,
    baremetal_white_list: ['etl', 'ArduinoJson'],
  },
  artifacts: { cHeader: true, benchmark: true },
  // L6b：导出符号（共享库）—— 基线 + 最近一次扫描（模拟一次"改名"）
  abi: {
    baseline: {
      at: '昨天',
      artifact: 'lib/libmylib.so',
      symbols: [
        { name: '_Z3addii', kind: 'T' },
        { name: '_Z3subii', kind: 'T' },
        { name: 'mylib_global', kind: 'D' },
      ],
    },
    now: {
      at: '14:05',
      artifact: 'lib/libmylib.so',
      symbols: [
        { name: '_Z3sumii', kind: 'T' },
        { name: '_Z3subii', kind: 'T' },
        { name: 'mylib_global', kind: 'D' },
      ],
    },
  },
  // L6a：性能基线（原始值；这份 fixture 用的就是 bench 面板里那段样例协议的用例名）
  perf: {
    baseline: {
      at: '昨天',
      values: [
        { name: 'vec_add_f32_1k', value: 487 },
        { name: 'vec_sub_f32_1k', value: 523 },
        { name: 'mat_mul_8x8', value: 1201 },
      ],
    },
    run: {
      at: '14:05',
      values: [
        { name: 'vec_add_f32_1k', value: 512 },
        { name: 'vec_sub_f32_1k', value: 700 },
        { name: 'mat_mul_8x8', value: 1201 },
      ],
    },
    regressPct: 20,
  },
  tools: toolFactsOf(TOOL_FACTS),
};

const DARK_THEME_STUB =
  '<style>:root{--vscode-foreground:#cccccc;--vscode-descriptionForeground:#9d9d9d;' +
  '--vscode-editor-background:#1f1f1f;--vscode-editorWidget-background:#252526;' +
  '--vscode-widget-border:#3c3c3c;--vscode-panel-border:#3c3c3c;--vscode-textLink-foreground:#4daafc;' +
  '--vscode-editorError-foreground:#f14c4c;--vscode-editorWarning-foreground:#cca700;' +
  '--vscode-testing-iconPassed:#73c991;--vscode-button-secondaryBackground:#3a3d41;}' +
  'body{margin:0;padding:12px;background:var(--vscode-editor-background);color:var(--vscode-foreground);' +
  'font-family:"Segoe UI",system-ui,sans-serif;font-size:13px;}</style>';

/**
 * 把 `pageShell` 产出的完整文档里的 `acquireVsCodeApi()` 换成空壳 —— **其余一个字节都不改**，
 * 保证预览的 CSS/结构就是产品真正的那一份。
 */
function standalone(html: string): string {
  const stub = `<script>window.acquireVsCodeApi = () => ({ postMessage() {}, getState() {}, setState() {} });</script>\n${DARK_THEME_STUB}\n`;
  return html.replace('<meta charset="utf-8">', `<meta charset="utf-8">\n${stub}`);
}

function writePage(name: string, model: SinglePageModel): string {
  const file = join(OUT_DIR, `${name}.html`);
  writeFileSync(file, standalone(cockpitSinglePageHtml(model)), 'utf8');
  return file;
}

/** 极简 Markdown → HTML（只处理悬停真的会用到的形状：标题 / 表格 / 行 / 图标 / 链接）。 */
function mdToHtml(md: string): string {
  const ICONS: Record<string, string> = {
    pass: '✓', check: '✓', error: '✗', 'sync~spin': '⟳', 'circle-outline': '○',
    clock: '⏱', 'circle-slash': '⊘', package: '📦', rocket: '🚀', shield: '🛡️',
    smiley: '🙂', keyboard: '⌨', beaker: '🔨', checklist: '🧪', warning: '!',
  };
  const inline = (s: string): string =>
    s
      // `[文案](command:het.xxx)` → 只留文案（和 VS Code 渲染出来的一样）
      .replace(/\[([^\]]+)\]\(command:[^)]*\)/gu, '$1')
      // 图标：`$(name)` → 等价字形（VS Code 用 codicon 字体，浏览器里没有）
      .replace(/\$\(([a-z~-]+)\)/gu, (_m, n: string) => ICONS[n] ?? `[${n}]`)
      .replace(/\*\*([^*]+)\*\*/gu, '<b>$1</b>');
  const esc = (s: string): string => inline(s.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;'));
  const out: string[] = [];
  let inTable = false;
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();
    if (line.startsWith('|')) {
      const cells = line.split('|').slice(1, -1).map((c) => esc(c.trim()));
      if (cells.every((c) => /^-+$/u.test(c.replace(/\*\*/gu, '')))) {
        continue;
      }
      if (!inTable) {
        out.push('<table class="hv">');
        inTable = true;
        out.push(`<tr>${cells.map((c) => `<th>${c}</th>`).join('')}</tr>`);
      } else {
        out.push(`<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`);
      }
      continue;
    }
    if (inTable) {
      out.push('</table>');
      inTable = false;
    }
    if (line.trim() === '') {
      continue;
    }
    const cls = line.startsWith('>') ? 'ln dim' : 'ln';
    out.push(`<div class="${cls}">${esc(line.replace(/^>\s?/u, ''))}</div>`);
  }
  if (inTable) {
    out.push('</table>');
  }
  return out.join('\n');
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const state = initialCockpitState();
  const written: string[] = [];

  // ⑧ 交付站的「新库自检」（L5 / G4）：拿**真的模板工程**跑一遍判定（不是造数据）。
  //    卡片那一行与 ⑤b 的整页**共用这一次判定**，保证两处不会各说一套。
  const tplDir = join('assets', 'template');
  const tplMeta = JSON.parse(readFileSync(join(tplDir, 'metadata.json'), 'utf8')) as SinglePageFacts['metadata'];
  const auditResults = auditNewLib(
    await collectLibSnapshot(tplDir, {
      ...(tplMeta ? { metadata: tplMeta } : {}),
      templateLicense: readFileSync(join(tplDir, 'LICENSE'), 'utf8'),
      templateNotice: readFileSync(join(tplDir, 'NOTICE'), 'utf8'),
      templateName: tplMeta?.name ?? '',
      // 模板本体没在会话里构建过 → 那条如实是 `–`（不编造）
    }),
  );
  // L5b / G6：依赖事实也来自**真的模板文件**（declared 走 listDependencies，与依赖管理器同一份）。
  const tplConandata = readFileSync(join(tplDir, 'conandata.yml'), 'utf8');
  const tplCiWorkflow = readFileSync(join(tplDir, '.github', 'workflows', 'security-linters.yml'), 'utf8');
  const tplSrc: Record<string, string> = {};
  for (const f of readdirSync(join(tplDir, 'src'))) {
    if (/\.(c|cc|cpp|cxx)$/u.test(f)) {
      tplSrc[`src/${f}`] = readFileSync(join(tplDir, 'src', f), 'utf8');
    }
  }
  const tplDeclared = listDependencies(tplMeta as never, tplConandata).map((v) => ({
    name: v.displayKey,
    conan: v.conanName,
    ...(v.version !== undefined ? { version: v.version } : {}),
  }));
  const depFacts: SinglePageFacts['deps'] = {
    declared: tplDeclared,
    conandataText: tplConandata,
    ciWorkflowText: tplCiWorkflow,
    srcFiles: tplSrc,
  };
  const auditFact = newLibAuditFact(auditResults);
  // L6c / G9：Python 绑定对账也拿**真模板文件**跑（公开头 + 绑定源 + CMake 的约定都是真的）。
  // 模板本体 metadata 里 `enable_python_bindings=false`，所以这里把"开了绑定"当成工程事实。
  const tplPyFiles = await collectPyBindFiles(tplDir);
  const pyAuditOk = pyBindFact(auditPythonBindings({ files: tplPyFiles, projectName: tplMeta?.name }));
  const pyAuditDrift = pyBindFact(
    auditPythonBindings({
      files: {
        ...tplPyFiles,
        'include/cpptest.hpp': `${tplPyFiles['include/cpptest.hpp']}\n/**\n * @brief 新加的公开类（还没绑出去）\n * @exporter\n */\nclass EigenHelper {};\n`,
      },
      projectName: tplMeta?.name,
    }),
  );
  const pyFacts = (view: typeof pyAuditOk): SinglePageFacts['pythonBindings'] => ({
    state: view.state,
    fact: view.fact,
    ...(view.next ? { next: view.next } : {}),
  });
  const FACTS_WITH_AUDIT: SinglePageFacts = {
    ...FACTS,
    deps: depFacts,
    newLibAudit: {
      state: auditFact.state,
      fact: auditFact.fact,
      ...(auditFact.next ? { next: auditFact.next } : {}),
    },
    pythonBindings: pyFacts(pyAuditOk),
  };

  // ① 默认：手风琴只开「① 就绪」（第一次打开驾驶舱看到的样子）
  written.push(writePage('01-default', singlePageModelFrom(state, FACTS_WITH_AUDIT, [...DEFAULT_FOLDED])));
  // ② 八站全开：看整条动作序列 + 24 张卡
  written.push(writePage('02-all-stations-open', singlePageModelFrom(state, FACTS_WITH_AUDIT, [])));
  // ③ 忙 + 失败：站状态点 / 站头状态 / 「下一步」chip 同时有东西可看
  written.push(
    writePage(
      '03-busy-and-failing',
      singlePageModelFrom(
        state,
        {
          ...FACTS_WITH_AUDIT,
          status: { action: 'test', text: '全量测试' },
          test: { passed: 42, failed: 3 },
        },
        [],
      ),
    ),
  );
  // ④ 未知 metadata：能力相关的卡**一张都不隐藏**（未知 ≠ 没有）
  written.push(
    writePage('04-unknown-metadata', singlePageModelFrom(state, { ...FACTS_WITH_AUDIT, metadata: undefined }, [])),
  );

  // ④b L4 的两站各自单独展开（手风琴互斥：一次只能开一站）：
  //   11 = ⑥ 提交站的 Git 事实行（分支 / 领先 / 未提交）
  //   12 = ⑦ 发布站的「CI 总编排」（job 数 + 顺序入口）与预检三态
  const stations = SECTION_IDS.filter((id) => id !== 'settings');
  written.push(
    writePage('11-commit-git-facts', singlePageModelFrom(state, FACTS_WITH_AUDIT, stations.filter((id) => id !== 'commit'))),
  );
  written.push(
    writePage('12-release-orchestrator', singlePageModelFrom(state, FACTS_WITH_AUDIT, stations.filter((id) => id !== 'release'))),
  );

  // ⑤ 工具链一览（L2d）：路径 + 来源 + 链；缺失项排最前；手动覆盖标黄
  const toolsFile = join(OUT_DIR, '05-toolchain.html');
  writeFileSync(toolsFile, standalone(toolsPageHtml(toolViewRows(TOOL_FACTS))), 'utf8');
  written.push(toolsFile);

  // ⑤b 新库自检（L5）：**同一份判定结果**的整页（红项排最前；`–` 写清为什么）。
  {
    const file = join(OUT_DIR, '13-newlib-audit.html');
    writeFileSync(
      file,
      standalone(
        newLibAuditPageHtml({
          phrase: auditFact.fact,
          results: auditResults,
          contractPresent: true,
          contractPath: CONTRACT_REL,
        }),
      ),
      'utf8',
    );
    written.push(file);
  }


  // ⑤c 依赖演进的两态（L5b / G6）：同一份真事实，只改"外部世界"（CI 映射 / 上游缓存）。
  {
    const makePage = (name: string, deps: SinglePageFacts['deps']): void => {
      const file = join(OUT_DIR, `${name}.html`);
      writeFileSync(
        file,
        standalone(cockpitSinglePageHtml(singlePageModelFrom(state, { ...FACTS_WITH_AUDIT, deps }, ['ready', 'test', 'docs', 'quality', 'commit', 'release', 'deliver']))),
        'utf8',
      );
      written.push(file);
    };
    // ① 新加了依赖、忘了改 CI 的 apt 映射（src 里真的 include 了它）
    makePage('14-deps-sysheader-gap', {
      ...depFacts,
      srcFiles: { 'src/extra.c': '#include <zlib.h>\n#include <pcre2.h>\n' },
      ciWorkflowText: tplCiWorkflow.replace("'pcre2': 'libpcre2-dev'", "'pcre2x': 'libpcre2-dev'"),
    });
    // ② 真查过上游（缓存里有版本）→ 才敢说"有新版"
    makePage('15-deps-outdated', {
      ...depFacts,
      latest: { pcre2: '10.45', zlib: '1.3.2' },
      latestAt: '3 分钟前',
    });
  }


  // ⑤d 性能基线的两种"要看得见"的态（L6a / G7）
  {
    const base = FACTS.perf?.baseline;
    const mk = (name: string, perf: SinglePageFacts['perf']): void => {
      const file = join(OUT_DIR, `${name}.html`);
      writeFileSync(
        file,
        standalone(cockpitSinglePageHtml(singlePageModelFrom(state, { ...FACTS_WITH_AUDIT, perf }, []))),
        'utf8',
      );
      written.push(file);
    };
    // ① 还没钉基线（G7 要求的"显式说明"，而不是一张空表）
    mk('16-perf-baseline-unset', { run: FACTS.perf?.run, regressPct: 20 });
    // ② 有基线 + 超过阈值（vec_sub +34%）
    mk('17-perf-baseline-regression', { ...(base ? { baseline: base } : {}), run: FACTS.perf?.run, regressPct: 20 });
  }


  // ⑤e 导出符号的两态（L6b / G8）—— **⑤ 质量站单开**（手风琴只留它），
  //     否则卡片落在整页折线以下，截图拍不到它（上一版就是这么拍空的：整页八站全开，
  //     ⑤ 站在 2000px 以下 → 两张截图逐字节相同，等于没有证据）。
  {
    const qualityOnly = stations.filter((id) => id !== 'quality');
    const mk = (name: string, abi: SinglePageFacts['abi']): void => {
      const file = join(OUT_DIR, `${name}.html`);
      writeFileSync(
        file,
        standalone(cockpitSinglePageHtml(singlePageModelFrom(state, { ...FACTS_WITH_AUDIT, abi }, qualityOnly))),
        'utf8',
      );
      written.push(file);
    };
    // ① 基线 + 最近一次扫描（模拟一次"改名"：移除 _Z3addii、新增 _Z3sumii）→ 红
    mk('18-abi-compared', FACTS.abi);
    // ② 还没钉基线（G8 要求的"显式说明"，而不是一张空表）
    mk('18b-abi-baseline-unset', {});
  }

  // ⑤f Python 绑定的两态（L6c / G9）：同一份**真模板文件**，只改"有没有忘绑"。
  //     **⑧ 交付站单开**（理由同上：卡片在最后一站，整页全开时拍不到）。
  //     19 = 对上了（模块名与 CMake 一致、公开 API 全绑）
  //     20 = 新加了一个 @exporter 类忘了绑 → 红，指名道姓 + 指路
  {
    const deliverOnly = stations.filter((id) => id !== 'deliver');
    const mk = (name: string, py: SinglePageFacts['pythonBindings']): void => {
      const file = join(OUT_DIR, `${name}.html`);
      writeFileSync(
        file,
        standalone(cockpitSinglePageHtml(singlePageModelFrom(state, { ...FACTS_WITH_AUDIT, pythonBindings: py }, deliverOnly))),
        'utf8',
      );
      written.push(file);
    };
    mk('19-python-bindings-ok', pyFacts(pyAuditOk));
    mk('20-python-bindings-drift', pyFacts(pyAuditDrift));
  }

  // ⑤g 交叉目标矩阵的两态（L6d）：⑧ 交付站单开。
  //     目标用**模板本体那份矩阵**（真文件）+ 内存里补两个目标（模拟多目标工程，README 里写明）；
  //     结果用账本 —— 那正是真跑一次交叉编译后账本里会有的东西。
  {
    const realMatrix = readFileSync(join(tplDir, BUILD_MATRIX_REL), 'utf8');
    const threeTargets = `${realMatrix}
  - id: linux-aarch64
    enabled: true
    build_kind: linux
    os: Linux
    arch: armv8
  - id: linux-mips
    enabled: true
    build_kind: linux
    os: Linux
    arch: mips
`;
    const parsed = parseBuildMatrix(threeTargets, BUILD_MATRIX_REL);
    const targets = enabledTargets(parsed).map((t) => ({
      id: t.id,
      ...(t.arch ? { arch: t.arch } : {}),
      ...(t.isDefault ? { isDefault: true } : {}),
    }));
    const mkLedger = (records: { target: string; ok: boolean; minutesAgo: number }[]): BuildLedger => {
      let l = emptyLedger('preview');
      for (const r of records) {
        l = recordBuild(l, {
          target: r.target,
          profileHash: 'h',
          at: Date.now() - r.minutesAgo * 60_000,
          ok: r.ok,
        });
      }
      return l;
    };
    const deliverOnly = stations.filter((id) => id !== 'deliver');
    const mk = (name: string, matrix: SinglePageFacts['matrix']): void => {
      const file = join(OUT_DIR, `${name}.html`);
      writeFileSync(
        file,
        standalone(
          cockpitSinglePageHtml(
            singlePageModelFrom(
              state,
              { ...FACTS_WITH_AUDIT, artifacts: { ...FACTS.artifacts, buildMatrix: true }, matrix },
              deliverOnly,
            ),
          ),
        ),
        'utf8',
      );
      written.push(file);
    };
    const redView = matrixView(
      targets,
      recordedRuns(
        mkLedger([
          { target: 'linux-armv7', ok: true, minutesAgo: 12 },
          { target: 'linux-aarch64', ok: false, minutesAgo: 8 },
        ]),
        (at) => agoText(Date.now() - at),
      ),
    );
    const gapView = matrixView(
      targets,
      recordedRuns(mkLedger([{ target: 'linux-armv7', ok: true, minutesAgo: 30 }]), (at) => agoText(Date.now() - at)),
    );
    const asFact = (v: MatrixView): SinglePageFacts['matrix'] => ({
      state: v.state,
      fact: v.fact,
      ...(v.next ? { next: v.next } : {}),
    });
    mk('21-target-matrix-red', asFact(redView));
    mk('22-target-matrix-incomplete', asFact(gapView));  }

  // ⑤h 编译期成本的两态（L6e）：⑤ 质量站单开。
  //     仅头文件产物才看这张卡（共享库看的是符号表）。
  {
    const qualityOnly = stations.filter((id) => id !== 'quality');
    const headerMeta: SinglePageFacts['metadata'] = {
      name: 'mylib',
      version: '0.3.1',
      is_header: true,
      activate_code_coverage: true,
    };
    const run = (over: Partial<HeaderCostRun>): HeaderCostRun => ({
      at: '14:05',
      header: 'include/mylib.hpp',
      compiler: 'g++ 13.3.0',
      std: 'c++17',
      runs: 5,
      emptyMs: 90,
      includeMs: 510,
      deltaMs: 420,
      ...over,
    });
    const mk = (name: string, headerCost: SinglePageFacts['headerCost']): void => {
      const file = join(OUT_DIR, `${name}.html`);
      writeFileSync(
        file,
        standalone(
          cockpitSinglePageHtml(
            singlePageModelFrom(
              state,
              { ...FACTS_WITH_AUDIT, metadata: headerMeta, artifacts: {}, headerCost },
              qualityOnly,
            ),
          ),
        ),
        'utf8',
      );
      written.push(file);
    };
    // ① 涨过阈值（基线 310ms → 现在 420ms，+35%）
    mk('23-header-cost-over-threshold', { baseline: run({ deltaMs: 310 }), now: run({}), costPct: 20 });
    // ② 还没实测过（白 —— "不等于成本为零"）
    mk('24-header-cost-not-measured', { costPct: 20 });
  }

  // ⑥ 四类产物画像（L3）：同一份代码、四种产物事实 → 站/卡显隐必须不同。
  //    看起来"内容差不多"就说明显隐是摆设。
  const profiles: Array<{ name: string; metadata: SinglePageFacts['metadata']; artifacts?: SinglePageFacts['artifacts'] }> = [
    {
      name: '07-profile-shared',
      metadata: { name: 'mylib', is_shared: true, activate_code_coverage: true },
      artifacts: { buildMatrix: true, cHeader: true },
    },
    {
      name: '08-profile-embedded',
      metadata: { name: 'mylib', baremetal_white_list: ['etl', 'ArduinoJson'] },
      artifacts: { buildMatrix: true },
    },
    { name: '09-profile-header-only', metadata: { name: 'mylib', is_header: true }, artifacts: {} },
    { name: '10-profile-python-bindings', metadata: { name: 'mylib', enable_python_bindings: true }, artifacts: {} },
  ];
  for (const p of profiles) {
    written.push(
      writePage(
        p.name,
        singlePageModelFrom(state, { ...FACTS_WITH_AUDIT, metadata: p.metadata, artifacts: p.artifacts }, []),
      ),
    );
  }

  // ⑥ 悬停（状态栏芯片的 tooltip）：站行 + 快捷动作 + 导航
  //    注意 `chipSpec` 吃的是 `ChipModel`（芯片的输入事实），不是 `CockpitState`。
  const model = {
    projectName: 'mylib',
    health: 87,
    running: '全量测试',
    runningAction: 'test',
    lastBuildOk: true,
    buildAgo: '3 分钟前',
    buildType: 'Debug',
    test: { passed: 42, failed: 3, skipped: 2 },
    templateBehind: 4,
    envSummary: 'win-wsl2 · 托管车道 ready',
    docs: 'ok' as const,
    needsHuman: false,
    cache: { sizeText: '12.4 GB', archs: 3, lastCleanAgo: '2 天前' },
  };
  const spec = chipSpec(model);
  const items = chipStatusItems(model);
  const projection = hoverProjection(items, chipHoverActions());
  const hoverFile = join(OUT_DIR, '06-hover.html');
  writeFileSync(
    hoverFile,
    `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">
<style>
  body{margin:0;padding:16px;background:#1f1f1f;color:#ccc;font-family:"Segoe UI",system-ui,sans-serif;font-size:13px;}
  .hv{border-collapse:collapse;margin:6px 0;}
  .hv th,.hv td{border:1px solid #3c3c3c;padding:3px 10px;text-align:left;vertical-align:top;}
  .hv th{color:#9d9d9d;font-weight:600;}
  .ln{white-space:pre-wrap;line-height:1.6;}
  .dim{color:#9d9d9d;}
  h3{font-size:13px;margin:10px 0 4px;}
</style></head><body>
<h3>状态栏芯片（紧凑档）</h3>${mdToHtml(spec?.text ?? '')}
<h3>悬停（极简档：${projection.rows.length} 条站行 + ${projection.actions.length} 主动作 + ${projection.nav.length} 导航）</h3>
${mdToHtml(spec?.tooltip ?? '')}
</body></html>`,
    'utf8',
  );
  written.push(hoverFile);

  for (const f of written) {
    console.log('写出', f);
  }
}

main();