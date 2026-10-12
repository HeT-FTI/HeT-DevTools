/**
 * 单页 cockpit 的数据模型（纯类型 + 纯函数，**不 import vscode**，可直接单测）。
 *
 * 设计来源：`workspace/develope/gui-single-page-rework-plan.md` §3（5 段工作流）与 §4（L1/L2/L3 三层密度）。
 * 这里只描述"页面上有什么"，不关心怎么取数（那由 host 侧的 controller/adapter 负责）。
 */
import type { CapabilityFact, CapabilityId } from '../../../core/capability';

/**
 * 5 个工作流段 + 齿轮（设置）（E 块定稿，计划 §5.1）。
 *
 * 名字就是 rail 上的定稿名：动作序列 8 站（就绪/构建/测试/文档/质量/提交/发布/交付）+ 设置。
 * 顺序 = 页面顺序 = rail 顺序。
 *
 * V3 · L2：`SectionId` 从"按领域的 6 段"换成"按动作序列的 8 站 + 设置"。
 * 分组知识全部在 `spine.ts`（`SPINE_STATIONS`），这里只留类型。
 */
export type SectionId = SpineStationId | 'settings';

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

/** 卡片的主按钮（最多一个；§3.1 规则）。 */export interface CardAction {
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
   * 显示条件（G11 门禁：**必须**声明）。
   *
   * - `'always'`：常驻（谁都要做的那一步）；
   * - 能力事实 id 列表：只有产物**真有**该能力时才显示（§5.2）。
   *   能力**未知**（metadata 读不到）时一律显示 —— 见 `spine.ts` 的 `visibleCards`。
   *
   * 类型上可选是为了不强迫单测里造卡时都写它；**门禁**（`infoBudget.test.ts`）
   * 对真实的 `SECTIONS` 是强制的。
   */
  show?: 'always' | CapabilityId[];
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

/** 阶段带的站点 id（顺序 = 动作顺序，见 `spine.ts` 的 `SPINE_STATIONS`）。 */
export type SpineStationId =
  | 'ready'
  | 'build'
  | 'test'
  | 'docs'
  | 'quality'
  | 'commit'
  | 'release'
  | 'deliver';

/** 一个站点的视图（状态是站内卡片状态的聚合；站**不自己读事实**）。 */
export interface SpineStationView {
  id: SpineStationId;
  order: number;
  label: string;
  hint: string;
  /** 该站实际存在的卡片 id（能力显隐后可能变少）。 */
  cards: string[];
  state: CardState;
}

/** "下一步"：第一个未完成站里第一张有主动作的卡（唯一来源，不许再手写）。 */
export interface SpineNextStep {
  station: SpineStationId;
  cardId: string;
  action: CardAction;
}

export interface SinglePageModel {
  cards: CardRow[];
  /** 正在跑的动作名（§7）：非空时顶部常驻条显示忙点。 */
  busy: string | null;
  /** 手风琴：已折叠的组（同一时刻最多一组是展开的，见 `normalizeFolded`）。 */
  folded: SectionId[];
  /** 模板落后多少提交（0 = 不提示）。 */
  templateBehind: number;
  /**
   * 产物能力事实（§5.2）。`undefined` = **未知**（metadata 读不到）→ 一律不隐藏。
   */
  caps?: CapabilityFact[];
  /** 阶段带视图（8 站，含各站状态）。 */
  spine?: SpineStationView[];
}

/** 全部合法组 id（顺序同 rail）：8 站 + 设置。 */
export const SECTION_IDS: readonly SectionId[] = [
  'ready',
  'build',
  'test',
  'docs',
  'quality',
  'commit',
  'release',
  'deliver',
  'settings',
];

/** 手风琴默认展开哪一站（与 `sections.ts` 的 `DEFAULT_OPEN_ID` 保持一致，单测对账）。 */
export const DEFAULT_OPEN: SectionId = 'ready';

/**
 * 默认折叠的组 = 除默认开站以外的全部。
 *
 * 为什么默认开"就绪"：装环境期它的信息量最大（缺什么、谁装、要不要人介入）；
 * 装好之后它就安静了（全绿时只有一行摘要）。
 */
export const DEFAULT_FOLDED: SectionId[] = SECTION_IDS.filter((id) => id !== DEFAULT_OPEN);

export function defaultModel(): SinglePageModel {
  return {
    cards: [],
    busy: null,
    folded: [...DEFAULT_FOLDED],
    templateBehind: 0,
    spine: [],
  };
}

/**
 * 旧版本的"按领域分段"名字 → 现在的站名（只用于**迁移持久化的折叠状态**）。
 *
 * `module` 的卡现在分布在构建/测试/文档三个站里，这里取名字最接近的 `docs`
 * （那一段当时就叫"模块文档"）；`deliver`（交付发布）→ `release`。
 */
const LEGACY_SECTION_ALIAS: Readonly<Record<string, SectionId>> = {
  env: 'ready',
  build: 'build',
  module: 'docs',
  quality: 'quality',
  deliver: 'release',
  settings: 'settings',
};

/**
 * 归一化折叠状态（手风琴）：
 * 1. 认不出的（含改过名字的老版本如 `now`/`code`/`config`）丢掉；
 * 2. 旧段名按 `LEGACY_SECTION_ALIAS` 迁移；
 * 3. 去重；
 * 4. **最多只允许一组展开**（持久化数据可能来自"多段同开"的旧版本或旧 bug）——
 *    保留页面顺序最靠前的那一组，其余补回折叠。
 */
export function normalizeFolded(raw: unknown): SectionId[] {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_FOLDED];
  }
  const mapped: SectionId[] = [];
  for (const x of raw) {
    if (typeof x !== 'string') {
      continue;
    }
    const id = (SECTION_IDS as readonly string[]).includes(x) ? (x as SectionId) : LEGACY_SECTION_ALIAS[x];
    if (id && !mapped.includes(id)) {
      mapped.push(id);
    }
  }
  const folded = new Set(mapped);
  const open = SECTION_IDS.filter((id) => !folded.has(id));
  for (const extra of open.slice(1)) {
    folded.add(extra);
  }
  return SECTION_IDS.filter((id) => folded.has(id));
}

/** 状态 → 图标（与 §3.1 的三态/五态一致；供 rail/卡片共用，避免两处判断）。 */
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

/** 状态 → 人话（title/aria 用；**同一个状态在页面上只允许一种说法**）。 */
export function cardStateText(state: CardState): string {
  switch (state) {
    case 'ok': return '通过';
    case 'warn': return '需要注意';
    case 'fail': return '失败';
    case 'running': return '正在跑';
    case 'na': return '不适用';
    default: return '还没跑过';
  }
}
