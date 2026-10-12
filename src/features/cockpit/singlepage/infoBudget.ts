/**
 * 信息预算（Info Budget）—— V3 计划 §6.0 / G11 / G12（纯函数，**不 import vscode**）。
 *
 * 规则来自用户的硬约束（P7/P8）：**UI 显示是有代价的**，任何放上去的东西必须是使用者
 * 关心的、能提升体验的，而不是"炫耀式设计"或"无效的信息传达"。
 *
 * 这里把三件事变成可执行门禁：
 * 1. **副标题字数额度**（棘轮：**只许减不许增**；新卡有绝对上限）——
 *    防止有人往 `sub` 里塞"报告由哪几章组成"这种实现者视角的枚举。
 * 2. **内部机制词黑名单**：面向用户的解释文案里出现"门禁/计数/第几/双写"这类
 *    我们内部怎么做的词 = 把内部约定外泄（G12）。
 * 3. **空事实不渲染**：占位符 `—` 是零信息却占一格视觉位置（`factText` 返回 null）。
 *
 * 额度表取值 = 2026-09-30 实测（`feat/v2-e-terms-hud`）。**改文案只能改短**；
 * 真要写长，先把信息挪进 Slot/面板（那里没有预算），再回头调低额度。
 */
import type { CardRow } from './model';

/** 新卡（额度表里没有的）默认上限：一句话说清"这卡跑的是哪条链"。 */
export const SUB_CEILING = 32;

/** 额度表的绝对上限（防止有人给某张卡开一个荒谬的额度）。 */
export const ABS_SUB_CEILING = 80;

/** 每张卡的副标题字数额度（棘轮：只减不增）。 */
export const SUB_QUOTA: Readonly<Record<string, number>> = {
  health: 47,
  tools: 30,
  // L5b 新增卡（模板同步）
  templateSync: 21,
  env: 28,
  lane: 44,
  network: 39,
  // ↓ 这四条是 L1 顺手清掉的"无效信息/内部词"（§6.0 第 1/2/3 条 + 依赖卡），额度同步收紧
  deps: 28,
  buildTest: 43,
  crossBuild: 79,
  testFull: 52,
  coverageDetail: 28,
  // L6a 新增卡（性能基线）
  perfBaseline: 17,
  moduleAgent: 77,
  moduleWizard: 55,
  testgen: 24,
  docsAuthoring: 35,
  docsBuild: 47,
  quality: 54,
  // L6b 新增卡（导出符号）
  abiSymbols: 18,
  // L6e 新增卡（编译期成本）
  headerCost: 18,
  commit: 39,
  commitManual: 33,
  release: 19,
  ci: 31,
  // L4 新增卡：额度 = 实测值（只许减不许增）
  orchestrator: 21,
  // L5 新增卡（新库自检）
  newLibAudit: 15,
  // L6c 新增卡（Python 绑定）
  pythonBindings: 19,
  audit: 28,
  settings: 35,
  board: 27,
};

/**
 * 内部机制词：**只查面向用户的解释文案**（`sub`）。
 *
 * 不查 `label`（"质量门禁"是产品定名，全仓库都在用）也不查 `next`
 * （那里面本来就该写"需要你执行：…"这种操作话术）。
 */
export const INTERNAL_WORDS: readonly string[] = ['门禁', '计数', '第几', '双写', '白名单'];

/** 单张卡的副标题违规原因（空数组 = 通过）。 */
export function subtitleViolations(cardId: string, sub: string | undefined): string[] {
  const out: string[] = [];
  if (sub === undefined || sub === '') {
    return out;
  }
  const quota = SUB_QUOTA[cardId] ?? SUB_CEILING;
  if (sub.length > quota) {
    out.push(`${cardId}: 副标题 ${sub.length} 字 > 额度 ${quota}（额度只许减不许增）`);
  }
  for (const word of INTERNAL_WORDS) {
    if (sub.includes(word)) {
      out.push(`${cardId}: 副标题里出现内部机制词「${word}」（用户不需要知道我们内部怎么做）`);
    }
  }
  return out;
}

/** 全部卡片的副标题违规（门禁直接用；空 = 绿）。 */
export function subtitleBudgetViolations(cards: readonly CardRow[]): string[] {
  return cards.flatMap((c) => subtitleViolations(c.id, c.sub));
}

/**
 * 事实格的显示文本：**占位符/空值一律不渲染**（返回 null）。
 *
 * `—` 是我们自己的"没有值"记号，它对用户是零信息，却占掉卡片上最贵的一格。
 */
export function factText(fact: string | undefined | null): string | null {
  const text = (fact ?? '').trim();
  if (text === '' || text === '—' || text === '-' || text === '--') {
    return null;
  }
  return text;
}
