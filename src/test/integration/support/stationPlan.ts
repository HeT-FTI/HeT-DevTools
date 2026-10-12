/**
 * c10 会话脚本要用的两个**只读**事实表（V3 阶段带）：
 * · `getAllTabIds()` —— 8 站的 id（顺序 = 动作序列）；
 * · `tabStationOf(tab)` —— 旧 tab id → 它现在落到的站（供"旧链接还认吗"断言）。
 *
 * 只读：不改产品状态，也不 import vscode —— 与产品同源（`spine.ts` / `sections.ts`）。
 */
import { SECTIONS, sectionForTab } from '../../../features/cockpit/singlepage/sections';
import { SPINE_STATIONS } from '../../../features/cockpit/singlepage/spine';
import { LEGACY_TAB_IDS, type LegacyTabId } from '../../../features/cockpit/singlepage/model';

/** 8 站的 id（顺序 = rail 顺序 = 动作序列）。 */
export function getAllTabIds(): string[] {
  return SPINE_STATIONS.map((s) => s.id);
}

/**
 * 旧 tab → **期望**落到哪个站（c10 逐条断言）。
 *
 * 写死这张表而不是"用产品函数算一遍再对一遍"：那样只能证明函数自洽，证明不了
 * "它落到的地方真的是我们想要的那个站"。每条都带上理由，改归属时必须同步改这里。
 */
export const LEGACY_LINK_EXPECTATION: Readonly<Record<string, string>> = {
  overview: 'ready', // 体检 / 环境 / 托管车道 / 网络与源
  deps: 'build',
  buildTest: 'build',
  moduleTest: 'build', // 模块两卡排在构建站最前面（8 站里没有"改码"站）
  docs: 'docs',
  quality: 'quality',
  commit: 'commit',
  release: 'release',
  bench: 'deliver', // 上板 = 交付形态
  collab: 'release', // CI 状态与审计在发布站
  settings: 'settings', // 与组同名 → 落到设置组（否则会被"网络与源"卡抢到就绪站）
};

/** 旧 tab id → 现在归属的站（`undefined` = 没有归属，会话要报出来）。 */
export function tabStationOf(tab: string): string | undefined {
  return sectionForTab(tab);
}

/** 组的展示名（会话日志用；找不到就退回 id）。 */
export function stationLabelOf(id: string): string {
  return SECTIONS.find((s) => s.id === id)?.label ?? id;
}

/** 旧 UI 的全部 tab（11 个；"信息不丢"与"旧链接不丢"共用）。 */
export function legacyTabIds(): readonly LegacyTabId[] {
  return LEGACY_TAB_IDS;
}
