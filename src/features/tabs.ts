/**
 * **"哪些页签是我们的"唯一口径**（H 块从集成测试里收上来的）。
 *
 * 背景：A 块的验收标准是"有且只有 1 个 tab"，而"数页签"这件事以前写在**集成测试里**
 * （`c8.ts` 的局部函数），产品诊断命令 `het.getSlotState` 又自己写了一版 —— 两边口径
 * 一旦不同，"页签数 = 1"就成了各说各话（测试绿、诊断说 2，或反过来）。
 *
 * 实测教训（VS Code 1.134 真实宿主）：`tab.input.viewType` 拿到的**不是** `het.cockpit`，
 * 而是 `mainThreadWebview-het.cockpit` 这种内部形状。只按 viewType 前缀匹配会得到 0 个
 * —— 于是"页签数正确"变成**永远不会成立的假断言**（反向同样危险：漏判会放过真的多开）。
 * 所以这里同时看 viewType 与 label，并**把判定依据一起返回**（失败时能说清"多出来的是谁"）。
 *
 * 判定宁可**多算不少算**：多算会在"应恒为 1"的断言上立刻红（响亮地错），
 * 少算会静默地把真问题放过去（这正是我们要防的那类"假绿"）。
 */
import * as vscode from 'vscode';

export interface HetTabFact {
  /** 页签输入里的 viewType（真实宿主里可能是 `mainThreadWebview-het.cockpit`）。 */
  viewType: string | null;
  label: string;
  /** 命中的依据（诊断文案用：写清"凭什么算我们的"）。 */
  why: 'viewType' | 'label';
}

const VIEW_TYPE_PREFIX = 'het.';
/** 标签兜底：唯一页签的标题与通道名同名（`HeT DevTools`），Slots 一律画在页内。 */
const LABEL_HINTS = ['HeT DevTools'];

/** 全部页签（包含别人的）——失败时用来说明"到底开了什么"。 */
export function allTabFacts(): Array<{ viewType: string | null; label: string }> {
  return vscode.window.tabGroups.all.flatMap((group) =>
    group.tabs.map((tab) => ({
      viewType: (tab.input as { viewType?: string } | undefined)?.viewType ?? null,
      label: tab.label,
    })),
  );
}

/** 我们自己的页签（见文件头的两道判定）。 */
export function hetTabs(): HetTabFact[] {
  const out: HetTabFact[] = [];
  for (const fact of allTabFacts()) {
    if ((fact.viewType ?? '').startsWith(VIEW_TYPE_PREFIX)) {
      out.push({ ...fact, why: 'viewType' });
      continue;
    }
    if (LABEL_HINTS.some((hint) => fact.label.includes(hint))) {
      out.push({ ...fact, why: 'label' });
    }
  }
  return out;
}

/** 页签数（`het.getSlotState` / `het.getUiSnapshot` 与集成测试共用这一份）。 */
export function hetTabCount(): number {
  return hetTabs().length;
}

/** 给断言失败用的可读快照：我们的页签 + 全部页签（避免只报一个数字无从下手）。 */
export function tabReport(): string {
  return `我们的页签=${JSON.stringify(hetTabs())}；全部页签=${JSON.stringify(allTabFacts())}`;
}
