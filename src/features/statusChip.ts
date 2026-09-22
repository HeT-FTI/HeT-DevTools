/**
 * HeT status-bar chip (GUI rework — V5-2 "hover console"；C 块收敛)。
 *
 * PURE module (no VS Code imports). 芯片只在打开 fcpp 工程时出现。
 *
 * **C 块的变化**（依据 §3.6 / D2 / G18）：悬停不再是"7 行表格 + 6 个动作"，而是
 * **5 条域行（与 rail 同名）+ ≤3 动作 + ≤2 导航**；健康分与"可提升"进徽章行/提示行。
 * 三档（芯片文字 / 悬停 / 页内卡片）全部由 `core/statusItem.ts` 的 StatusItem 投影，
 * 谁都不许自己再拼一套文案 —— 这是"chip 说成功、卡片说失败"这类观感的根治。
 *
 * 行名与 §5.1 的 rail 定稿名一致（环境车道 / 构建验证 / 模块文档 / 质量安全 / 交付发布）。
 */

export interface ChipTest {
  passed: number;
  failed: number;
  skipped: number;
}

export type DocsRowState = 'none' | 'running' | 'ok' | 'fail';

/** 缓存事实（K.1）：环境车道那一行的补充数字（动作在快捷操作区，状态行只放结论）。 */
export interface ChipCacheFacts {
  /** 人类可读的总体积（如 `12.4 GB`）。 */
  sizeText: string;
  /** 缓存里并存几个架构（>1 说明"今天 armv7、明天 v8"确实在吃盘）。 */
  archs: number;
  /** 最近一次清理（如 `3 分钟前`）；没有就不显示。 */
  lastCleanAgo?: string;
}

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
  /** K.1: 构建缓存事实（体积/架构数/上次清理）。 */
  cache?: ChipCacheFacts | null;
}

export interface ChipSpec {
  text: string;
  /** Markdown with `$(codicon)` + `command:` links (host wraps & trusts). */
  tooltip: string;
  command?: string;
  color?: string;
}

import { busyDomainOf } from '../core/status';
import {
  chipTextOf,
  hoverMarkdown,
  hoverProjection,
  linkify,
  runningItem,
  type HoverAction,
  type StatusItem,
} from '../core/statusItem';

/** Markdown `command:` link (optional URL-encoded JSON arg). */
export function cmdLink(label: string, command: string, arg?: string): string {
  return linkify(label, command, arg);
}

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
  return ok ? line : `${line} · ${cmdLink('测试结果', 'het.showTestResults')}`;
}

function docsCell(m: ChipModel): string {
  const state = m.docs ?? 'none';
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
    const pct =
      m.coverageLine !== null && m.coverageLine !== undefined
        ? `行 ${m.coverageLine}%${m.coverageFunc !== null && m.coverageFunc !== undefined ? ` · 函数 ${m.coverageFunc}%` : ''} · `
        : '';
    return `✅ ${pct}${cmdLink('报告', 'het.openCoverageReport')}`;
  }
  return '未生成';
}

function templateCell(m: ChipModel): string {
  return m.templateBehind > 0 ? `可更新 ${m.templateBehind} 个提交` : '与参考一致';
}

/**
 * ChipModel → **StatusItem 列表**（§3.6 的"同一对象"）。三档都从这里取。
 * 健康分不是"域行"而是徽章 + 提示（它没有对应的 rail），所以不进 items。
 */
export function chipStatusItems(m: ChipModel): StatusItem[] {
  const busyDom = busyDomainOf(m.runningAction ?? null);
  /** 忙时该域只表达"进行中"（不变题 4：不与上一次失败并列）——**所有域用同一串字**。
   *
   * H 块踩到的一次：模块文档那一行以前自己写了个「构建中」，于是同一张悬停表里
   * 构建验证/构建时说「进行中」而文档说「构建中」—— 同一个概念两种写法（C 块的
   * 单一来源就是为这个设的）。现在只有"不在 Task 里、由 docs 模块自己的在跑标志"
   * 那一条旧路径还留着「构建中」（它不是一次 Task，没有 busy 状态可读）。 */
  const busyText = busyDom ? '进行中' : '';
  const cacheBits: string[] = [];
  if (m.cache) {
    cacheBits.push(`缓存 ${m.cache.sizeText}`);
    if (m.cache.archs > 1) {
      cacheBits.push(`${m.cache.archs} 个架构并存`);
    }
    if (m.cache.lastCleanAgo) {
      cacheBits.push(`上次清理 ${m.cache.lastCleanAgo}`);
    }
  }
  return [
    {
      id: 'envCheck',
      domain: 'env',
      state: busyDom === 'env' ? 'running' : m.envSummary ? 'ok' : 'unknown',
      text: busyDom === 'env' ? busyText : envCell(m),
      detail: cacheBits.length ? cacheBits.join(' · ') : undefined,
    },
    {
      id: 'build',
      domain: 'build',
      state: busyDom === 'build' ? 'running' : m.lastBuildOk === null ? 'unknown' : m.lastBuildOk ? 'ok' : 'fail',
      text: busyDom === 'build' ? busyText : buildCell(m),
    },
    {
      id: 'test',
      domain: 'test',
      state: busyDom === 'test' ? 'running' : !m.test ? 'unknown' : m.test.failed > 0 ? 'fail' : 'ok',
      text: busyDom === 'test' ? busyText : testCell(m),
    },
    {
      id: 'docsBuild',
      domain: 'docs',
      state:
        (m.docs ?? 'none') === 'running' || busyDom === 'docs'
          ? 'running'
          : (m.docs ?? 'none') === 'ok'
            ? 'ok'
            : (m.docs ?? 'none') === 'fail'
              ? 'fail'
              : 'unknown',
      text: busyDom === 'docs' ? busyText : (m.docs ?? 'none') === 'running' ? '构建中' : docsCell(m),
    },
    {
      id: 'coverage',
      domain: 'quality',
      state: m.coverageEnabled === false ? 'unknown' : m.coverageFound ? 'ok' : 'unknown',
      text: coverageCell(m),
    },
    {
      id: 'release',
      domain: 'release',
      state: m.templateBehind > 0 ? 'idle' : 'ok',
      text: templateCell(m),
    },
  ];
}

/** 悬停的快捷操作（≤3）与导航（≤2）—— 预算由 `hoverProjection` 强制。 */
export function chipHoverActions(): { actions: HoverAction[]; nav: HoverAction[] } {
  return {
    actions: [
      { id: 'envCheck', label: '🔧 检查环境', command: 'het.envCheck', kind: 'primary' },
      // §5.2：动作名 = 动词 + 对象，且两个链不许同形词 ——
      // 「编译打包」= 消费依赖→产出包（het.build）；「全量测试」在构建验证段里。
      { id: 'build', label: '🛠 编译打包', command: 'het.build', kind: 'primary' },
      { id: 'cacheClean', label: '🧹 清理构建缓存', command: 'het.cacheClean', kind: 'primary' },
    ],
    nav: [
      // 导航只留一条：仪表盘。chip 本身就是"点开驾驶舱"的入口，
      // 再放一个"完整监控卡"既重复又指向一个已经不存在的页签（E 块删了 HUD）。
      { id: 'dashboard', label: '🖥️ 仪表盘', command: 'het.dashboard', kind: 'nav' },
    ],
  };
}

/** Render the chip only while a project is open — monitoring only. */
export function chipSpec(m: ChipModel): ChipSpec | null {
  if (!m.projectName) {
    return null;
  }
  const items = chipStatusItems(m);
  const busyItem = runningItem(items);
  const text = chipTextOf(items, m.health);

  const { actions, nav } = chipHoverActions();
  const projection = hoverProjection(items, { actions, nav });
  const body = hoverMarkdown(m.projectName, projection);

  // 健康分与"可提升"：它是**没有 rail 的横切指标**，所以放徽章行 + 提示行，
  // 而不是硬塞成一条域行（塞进去就会让人以为它属于某个域）。
  const healthIcon = m.health === null ? '$(question)' : m.health >= 80 ? '$(smiley)' : m.health >= 50 ? '$(warning)' : '$(error)';
  const badges = [
    `${healthIcon} 工程健康 ${m.health === null ? '未体检' : `${m.health}/100${m.healthVerdict ? ` · ${m.healthVerdict}` : ''}`}`,
    busyItem ? `$(sync~spin) 进行中：${busyItem.text}` : '',
  ]
    .filter(Boolean)
    .join('   ');
  const gaps = (m.healthGaps ?? []).slice(0, 3);
  const hint = gaps.length
    ? `\n\n> 可提升：${gaps.join(' · ')} — ${cmdLink('重新体检', 'het.healthCheck')}`
    : '';

  const tooltip = `${body}\n\n> ${badges}${hint}\n\n$(keyboard) 悬停链接点击即执行`;

  return {
    text,
    tooltip,
    command: 'het.chipOverview',
    // §F.35：**忙的时候绝不红**。红色只表达"跑完了、失败了"这个结论；
    // 把"正在构建"染成红底，是实测反馈里最刺眼的一处误读（"看着像已经炸了"）。
    color: !busyItem && m.lastBuildOk === false ? 'statusBarItem.errorBackground' : undefined,
  };
}
