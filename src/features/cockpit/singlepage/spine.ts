/**
 * 阶段带（Spine）—— V3 计划 §4.1：把"按领域分的 6 段"换成"按动作序列的 8 站"。
 *
 * 只做三件事（纯数据 + 纯函数，**不 import vscode、不碰 DOM**）：
 * 1. **站点定义**：8 站 + 每站承载哪几张卡（`SPINE_STATIONS`）；
 * 2. **站状态**：从**卡的既有状态**聚合而来 —— 站**不自己读事实**（"禁自算"）；
 * 3. **下一步**：第一个未完成的站里，第一张有主动作的卡 → 这就是"下一步"的真实来源
 *    （以前 `next` 是各卡手写的字符串，两边可以互相矛盾）。
 *
 * 硬约束（单测钉死）：`SPINE_STATIONS` 的卡片并集 ∪ `NON_SPINE_CARD_IDS` **必须恰好等于**
 * `SECTIONS` 里的全部卡片 —— 这是"结构重排不许丢卡"的可测形式（计划 §7.1）。
 */
import type {
  CardAction,
  CardRow,
  CardState,
  SinglePageModel,
  SpineNextStep,
  SpineStationId,
  SpineStationView,
} from './model';
import { CAPABILITY_IMPLIES, CAPABILITY_LABELS, type CapabilityId, type CapabilityFact } from '../../../core/capability';

export interface SpineStationDef {
  id: SpineStationId;
  /** 1..8，页面顺序 = 动作顺序。 */
  order: number;
  /** 站名（≤ 4 字；阶段带上横向排）。 */
  label: string;
  /** 点的顺序就是"我下一步该干什么"，所以每站必须能一句话说清。 */
  hint: string;
  /** rail 上的图标（彩色 emoji，一眼可辨）。 */
  rail: string;
  /** rail 上的短名（一律两个汉字：竖排窄栏，字数不齐就会参差）。 */
  railLabel: string;
  /** codicon 后缀（悬停/详情用）。 */
  icon: string;
  /** 该站承载的卡片 id（来自卡片注册表，必须是真实存在的卡）。 */
  cards: readonly string[];
}

/**
 * 8 站 = 一次改动的完整动作序列。
 *
 * 归属说明（§4.2 的落地）：
 * - 两张模块卡（AI 框架设计&实现 / 单模块微调）是**改动的入口**，8 站里没有"改码"站，
 *   所以它们排在 ② 构建站的最前面（构建的输入就是它们）。
 * - 交叉编译归 ⑧ 交付（它是**出货形态**，不是日常构建）；覆盖率归 ③ 测试。
 */
export const SPINE_STATIONS: readonly SpineStationDef[] = [
  { id: 'ready', order: 1, label: '就绪', rail: '🧭', railLabel: '就绪', icon: 'server-environment', hint: '模板同步 · 工具链 · 环境 · 托管车道 · 网络与源', cards: ['health', 'tools', 'templateSync', 'env', 'lane', 'network'] },
  { id: 'build', order: 2, label: '构建', rail: '🔨', railLabel: '构建', icon: 'beaker', hint: '改动入口 · 依赖 · 编译打包', cards: ['moduleAgent', 'moduleWizard', 'deps', 'buildTest'] },
  { id: 'test', order: 3, label: '测试', rail: '🧪', railLabel: '测试', icon: 'checklist', hint: '全量测试 · 覆盖率 · 性能基线 · 测试生成', cards: ['testFull', 'coverageDetail', 'perfBaseline', 'testgen'] },
  { id: 'docs', order: 4, label: '文档', rail: '📄', railLabel: '文档', icon: 'book', hint: '注释补全 · 本地出 HTML', cards: ['docsAuthoring', 'docsBuild'] },
  { id: 'quality', order: 5, label: '质量', rail: '🛡️', railLabel: '质量', icon: 'shield', hint: '格式 · 静态检查 · 密钥扫描 · 导出符号 · 编译期成本', cards: ['quality', 'abiSymbols', 'headerCost'] },
  { id: 'commit', order: 6, label: '提交', rail: '✍️', railLabel: '提交', icon: 'git-commit', hint: '智能提交 · 手动兜底', cards: ['commit', 'commitManual'] },
  { id: 'release', order: 7, label: '发布', rail: '📦', railLabel: '发布', icon: 'rocket', hint: '预检 · 发布中心 · CI · 总编排 · 审计', cards: ['release', 'ci', 'orchestrator', 'audit'] },
  { id: 'deliver', order: 8, label: '交付', rail: '🚚', railLabel: '交付', icon: 'package', hint: '交付自检 · Python 绑定 · 交叉编译 · 上板采集', cards: ['newLibAudit', 'pythonBindings', 'crossBuild', 'board'] },
];

/** 不进阶段带的卡片：设置段（偏好/兜底）。 */
export const NON_SPINE_CARD_IDS: readonly string[] = ['settings'];

/**
 * 能力事实 → 消费点的**登记表**（尚未落地的）。
 *
 * 用途：`infoBudget.test.ts` 要求**每条能力必须被消费**（某张卡的 `show` 引用它，
 * 或在这里登记"哪个块会消费它"）。登记即承认"还没落地"，不许静默积压。
 *
 * **L6e 之后这张表是空的**：8 条能力全部有卡片消费（这就是"清零"的样子 —— 表只许变短，
 * 变空是它的终点）。留一条都不许：那说明有个能力在静默积压。
 */
export const PLANNED_CAPABILITY_CONSUMERS: Partial<Record<CapabilityId, 'L3' | 'L6'>> = {};

/** 状态的"信息量"排序：fail 最重，运行中次之，最后才是"没跑过"。 */
function stateRank(state: CardState): number {
  switch (state) {
    case 'fail': return 5;
    case 'warn': return 4;
    case 'running': return 3;
    case 'ok': return 2;
    case 'idle': return 1;
    default: return 0; // na
  }
}

/**
 * 站状态 = 站内卡片状态的**聚合**（只看有信息量的：`na`/`idle` 不参与，除非全是）。
 *
 * **不在这里读任何事实** —— 事实只有一条通路（卡），否则又会出现"站说绿、卡说红"。
 */
export function stationState(states: readonly CardState[]): CardState {
  if (states.length === 0) {
    return 'na';
  }
  const meaningful = states.filter((s) => s !== 'na' && s !== 'idle');
  if (meaningful.length === 0) {
    return states.every((s) => s === 'na') ? 'na' : 'idle';
  }
  return meaningful.reduce((worst, s) => (stateRank(s) > stateRank(worst) ? s : worst), meaningful[0]);
}

/** 按卡片取状态（站内卡片可能在能力显隐后不存在）。 */
function statesFor(cards: readonly string[], byId: ReadonlyMap<string, CardRow>): CardState[] {
  return cards.map((id) => byId.get(id)?.state).filter((s): s is CardState => s !== undefined);
}

/** 阶段带视图（纯函数，输入就是模型里已经算好的卡）。 */
export function spineFrom(cards: readonly CardRow[]): SpineStationView[] {
  const byId = new Map(cards.map((c) => [c.id, c]));
  return SPINE_STATIONS.map((def) => ({
    id: def.id,
    order: def.order,
    label: def.label,
    hint: def.hint,
    cards: def.cards.filter((id) => byId.has(id)),
    state: stationState(statesFor(def.cards, byId)),
  }));
}

/**
 * "下一步" = 第一个**未完成**的站（state ≠ ok），取它第一张有主动作的卡。
 *
 * 没有未完成的站 → `undefined`（此时界面不该硬编一句"下一步"）。
 */
export function spineNextStep(spine: readonly SpineStationView[], cards: readonly CardRow[]): SpineNextStep | undefined {
  const byId = new Map(cards.map((c) => [c.id, c]));
  for (const station of spine) {
    if (station.state === 'ok') {
      continue;
    }
    for (const id of station.cards) {
      const card = byId.get(id);
      const action: CardAction | undefined = card?.action;
      if (card && action) {
        return { station: station.id, cardId: card.id, action };
      }
    }
  }
  return undefined;
}

/** 卡片是否满足显示条件（`show` 缺省 = 常驻）。 */
export function cardVisible(card: CardRow, have: ReadonlySet<CapabilityId>): boolean {
  const show = card.show ?? 'always';
  if (show === 'always') {
    return true;
  }
  return show.some((id) => have.has(id));
}

/**
 * 能力显隐过滤。
 *
 * **`caps === undefined`（未知）→ 一张都不隐藏**：读不到 metadata 不是"没有这个能力"。
 */
export function visibleCards(cards: readonly CardRow[], caps: CapabilityFact[] | undefined): CardRow[] {
  if (caps === undefined) {
    return [...cards];
  }
  const have = new Set(caps.map((c) => c.id));
  return cards.filter((c) => cardVisible(c, have));
}

/** 被能力藏起来的卡（含原因）：隐藏必须**可解释**，否则用户只会觉得"功能没了"。 */
export interface HiddenCard {
  cardId: string;
  /** 缺哪个能力才藏（人话标签，如「多目标」）。 */
  reasons: string[];
  /** 怎么才能让它出现（取自能力的"推出的动作"）。 */
  howTo: string[];
}

/**
 * 哪些卡因为缺少产物能力而没显示。
 *
 * 用途：站点里给一行"按产物事实隐藏：交叉编译（缺 .hetai/build-matrix.yml）"——
 * 既回答"卡去哪了"，又告诉用户"加什么它会出现"（P7：信息要能推动作）。
 */
export function hiddenCards(
  cards: readonly CardRow[],
  caps: CapabilityFact[] | undefined,
): HiddenCard[] {
  if (caps === undefined) {
    return [];
  }
  const have = new Set(caps.map((c) => c.id));
  const out: HiddenCard[] = [];
  for (const card of cards) {
    const show = card.show ?? 'always';
    if (show === 'always' || show.some((id) => have.has(id))) {
      continue;
    }
    out.push({
      cardId: card.id,
      reasons: show.map((id) => CAPABILITY_LABELS[id]),
      howTo: show.map((id) => CAPABILITY_IMPLIES[id]),
    });
  }
  return out;
}

/** 每张卡属于哪一站（rail / 悬停 / 深链都要用；`settings` 返回 undefined）。 */
export function stationOfCard(cardId: string): SpineStationDef | undefined {
  return SPINE_STATIONS.find((s) => s.cards.includes(cardId));
}

/** 阶段带 + 模型 → 视图（`model.spine` 为空时现算，保持纯函数可单测）。 */
export function spineOf(model: Pick<SinglePageModel, 'cards' | 'spine'>): SpineStationView[] {
  return model.spine && model.spine.length > 0 ? model.spine : spineFrom(model.cards);
}
