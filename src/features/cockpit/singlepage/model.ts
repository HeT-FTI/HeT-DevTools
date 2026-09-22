/**
 * 单页 cockpit 的数据模型（纯类型 + 纯函数，**不 import vscode**，可直接单测）。
 *
 * 设计来源：`workspace/develope/gui-single-page-rework-plan.md` §3（5 段工作流）与 §4（L1/L2/L3 三层密度）。
 * 这里只描述"页面上有什么"，不关心怎么取数（那由 host 侧的 controller/adapter 负责）。
 */
/**
 * 5 个工作流段 + 齿轮（设置）（E 块定稿，计划 §5.1）。
 *
 * 名字就是 rail 上的定稿名：环境车道 / 构建验证 / 模块文档 / 质量安全 / 交付发布（+ 设置）。
 * 顺序 = 页面顺序 = rail 顺序。
 */
export type SectionId = 'env' | 'build' | 'module' | 'quality' | 'deliver' | 'settings';

/**
 * 历史 tab id（旧 UI 的 11 个 tab）。
 *
 * 旧 UI 本身已经归档（`_archive/`，dead scope），这串 id 留下只有一个用途：
 * **“信息不丢”校验** —— 每张卡片都标了它承载的旧 tab，加起来必须覆盖这 11 个。
 * 所以它是**历史记录**，不是导航目标。
 */
export type LegacyTabId =
  | 'overview'
  | 'buildTest'
  | 'deps'
  | 'moduleTest'
  | 'docs'
  | 'quality'
  | 'commit'
  | 'release'
  | 'bench'
  | 'collab'
  | 'settings';

export const LEGACY_TAB_IDS: readonly LegacyTabId[] = [
  'overview',
  'buildTest',
  'deps',
  'moduleTest',
  'docs',
  'quality',
  'commit',
  'release',
  'bench',
  'collab',
  'settings',
];

/** 卡片/条目的状态词（与 §7 忙语义的五态一致）。 */
export type CardState = 'ok' | 'warn' | 'fail' | 'na' | 'idle' | 'running';

/** 卡片详情去处（§3.1 的"详情去处"列）。 */
export type CardStage = 'inline' | 'panel' | 'external' | 'output' | 'chat';

/** 卡片的主按钮（最多一个；§3.1 规则）。 */
export interface CardAction {
  /**
   * 走 `{type:'action'}` 协议的 id、`{type:'copilot'}` 的命令名，
   * 或 `kind: 'jump'` 时的**目标段 id**。
   */
  id: string;
  label: string;
  /**
   * `jump` = 跳到某段（导航，不是动作）。
   *
   * 用途（实测反馈第 6 条）：段 1 是**只读摘要**，执行入口只在执行段里有一份；
   * 摘要卡上不留第二个同名按钮，只给一个"去那边做"的链接。
   */
  kind: 'action' | 'copilot' | 'jump';
}

export interface CardRow {
  id: string;
  /** 这张卡承载的**旧 tab**（历史记录；用于"信息不丢"校验：11 个旧 tab 必须各有归属）。 */
  tab: LegacyTabId;
  label: string;
  /**
   * 静态副标题（≤ 30 字）：说清"这张卡到底跑的是哪条链"。
   *
   * 与 `fact` 分工：`fact` 是**结果**（会变），`sub` 是**语义**（不变）——
   * 实测反馈里"构建与测试到底有什么区别"就是因为只有结果、没有语义。
   */
  sub?: string;
  state: CardState;
  /** L2 一行事实（≤24 字；材料第 1 条要求能看出"是否需要人工介入"）。 */
  fact: string;
  /** 需要人工介入时的下一步（如 `需要你执行：sudo apt-get install -y lcov`）。 */
  next?: string;
  /** 主按钮（最多一个）。 */
  action?: CardAction;
  /** 次级按钮（如「移除托管环境」「手动提交…」）；样式弱化，不算主按钮。 */
  secondary?: CardAction;
  /**
   * 更多弱化按钮（0..n）。用于"同一张卡上还有别的合规入口"的情况，
   * 例如环境卡上的「让 Copilot 讲清楚」（§8：失败项旁的解释入口）。
   */
  extra?: CardAction[];
  stage: CardStage;
  /** 懒加载：正文首次展开时才取（§13）。 */
  lazy: boolean;
}

/** L1 吸顶条的一项（构建 · 测试 · 覆盖率 · 环境 + 忙点）。 */
export interface L1Item {
  id: string;
  label: string;
  value: string;
  state: CardState;
}

export interface SinglePageModel {
  l1: L1Item[];
  cards: CardRow[];
  /** 正在跑的动作名（§7）：非空时 L1 显示忙点。 */
  busy: string | null;
  /** 折叠的段（§6：默认只展开第 1 段「环境车道」）。 */
  folded: SectionId[];
  /** 模板落后多少提交（0 = 不提示）。 */
  templateBehind: number;
}

/** L1 的项顺序（决策：构建 · 测试 · 覆盖率 · 环境）。 */
export const L1_IDS = ['build', 'test', 'coverage', 'env'] as const;

export const DEFAULT_FOLDED: SectionId[] = ['build', 'module', 'quality', 'deliver', 'settings'];

export function defaultL1(): L1Item[] {
  return [
    { id: 'build', label: '构建', value: '—', state: 'idle' },
    { id: 'test', label: '测试', value: '—', state: 'idle' },
    { id: 'coverage', label: '覆盖率', value: '—', state: 'idle' },
    { id: 'env', label: '环境', value: '—', state: 'idle' },
  ];
}

export function defaultModel(): SinglePageModel {
  return {
    l1: defaultL1(),
    cards: [],
    busy: null,
    folded: [...DEFAULT_FOLDED],
    templateBehind: 0,
  };
}

/** 全部合法段 id（顺序同 rail）。 */
export const SECTION_IDS: readonly SectionId[] = ['env', 'build', 'module', 'quality', 'deliver', 'settings'];

/**
 * 归一化折叠状态：去重 + 只保留合法段 id。
 *
 * 持久化的数据可能来自**改过名字的旧版本**（如 `now`/`code`/`config`）—— `normalizeFolded`
 * 负责把认不出的丢掉，而不是把它们当成未知段渲染出一个空壳。
 */
export function normalizeFolded(raw: unknown): SectionId[] {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_FOLDED];
  }
  const out = raw.filter((x): x is SectionId => typeof x === 'string' && (SECTION_IDS as readonly string[]).includes(x));
  return [...new Set(out)];
}

/** 状态 → 图标（与 §3.1 的三态/五态一致；供 L1/L2 共用，避免两处判断）。 */
export function stateIcon(state: CardState): string {
  switch (state) {
    case 'ok': return '✓';
    case 'warn': return '!';
    case 'fail': return '✗';
    case 'na': return '–';
    case 'running': return '⟳';
    default: return '·';
  }
}
