/**
 * 发布/Preflight 的三态摘要（计划 §19.2 / G23）—— 纯函数，不 import vscode。
 *
 * 材料第 1 条的硬要求：**✓ / ✗ / – 三态必须齐**，`–` 必须写原因，红项后面必须有下一步命令。
 * 卡片（L2）只有一行事实 + 一行"下一步"，所以这里把面板里的 item 列表压成这两行，
 * 面板（L3）继续显示完整列表 —— 两处用**同一批 item**，不会各说一套。
 */

export interface PreflightSummary {
  /** ✓ 数。 */
  ok: number;
  /** ✗ 数。 */
  fail: number;
  /** – 数（未判定：会话里还没构建/没跑测试/工具缺失…）。 */
  na: number;
  /** L2 一行事实，例如 `✓ 4 · ✗ 1 · – 2 · CHANGELOG`。 */
  fact: string;
  /** 红项（优先）或未判定项的"下一步"；全绿时 undefined。 */
  next?: string;
  /** required 项是否全绿（= 能不能发布）。 */
  allowRelease: boolean;
  /** 首个 ✗ 的标签（面板里高亮用）。 */
  firstFail?: string;
}

/**
 * 只取摘要需要的几个字段。
 *
 * **刻意不从面板模块 import 类型**：面板带 `vscode` 依赖，而这个模块要被卡片侧（纯函数）用；
 * 面板的 `PreflightItem` 结构上天然满足本接口。
 */
export interface PreflightLikeItem {
  label: string;
  ok?: boolean;
  detail?: string;
  required?: boolean;
}

function short(label: string, max = 12): string {
  const l = (label ?? '').trim();
  return l.length > max ? `${l.slice(0, max)}…` : l;
}

/**
 * 三态统计 + 两行文案。
 *
 * `next` 的取值顺序是**刻意的**：有红项就先说红项（要人动手），没红项但有 `–` 就说为什么
 * 还没判定（也是"要不要人介入"的信息）——两者都不许空着。
 */
export function summarizePreflight(items: readonly PreflightLikeItem[]): PreflightSummary {
  const ok = items.filter((i) => i.ok === true).length;
  const naItems = items.filter((i) => i.ok === undefined);
  const failItems = items.filter((i) => i.ok === false);
  const fail = failItems.length;
  const na = naItems.length;

  const bits = [`✓ ${ok}`];
  if (fail > 0) {
    bits.push(`✗ ${fail}`);
  }
  if (na > 0) {
    bits.push(`– ${na}`);
  }
  const firstFailItem = failItems.find((i) => i.required) ?? failItems[0];
  const fact = fail === 0 && na === 0 ? `${bits.join(' · ')} · 预检就绪` : `${bits.join(' · ')}${firstFailItem ? ` · ${short(firstFailItem.label)}` : ''}`;

  let next: string | undefined;
  if (firstFailItem) {
    next = `需要你执行：${(firstFailItem.detail ?? '').trim() || '点「运行预检」在面板里看红项'}`;
  } else if (naItems.length > 0) {
    const first = naItems[0];
    next = `– ${short(first.label)}：${(first.detail ?? '').trim() || '未判定（点「运行预检」跑一遍）'}`;
  }

  return {
    ok,
    fail,
    na,
    fact,
    ...(next ? { next } : {}),
    allowRelease: items.filter((i) => i.required).every((i) => i.ok === true),
    ...(firstFailItem ? { firstFail: firstFailItem.label } : {}),
  };
}
