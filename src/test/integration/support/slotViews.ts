/**
 * **页内 Slot 的"命令 → Slot id"对照表**（c8 / c9 共用一份）。
 *
 * 为什么抽出来：两块会话都在"逐个打开所有视图、并断言页签恒为 1"。各写一份的话，
 * 新增视图时只会顺手更新一处 —— 另一个脚本就悄悄失去覆盖（"新功能绕过一致性验证"
 * 正是 H 块要防的事）。`consistency.test.ts` 还有一条门禁：本表必须覆盖
 * `features/slots/titles.ts` 里登记的全部 Slot（漏一个即红）。
 *
 * 注意：这里**不能**带上依赖前置条件的视图（如 `het.showTestResults` 要求先有测试结果）
 * —— 把它写进来会得到一个"永远失败的假期望"（断言照着自己想象的产品行为写，c8 踩过）。
 */
export interface SlotView {
  command: string;
  /** `het.getSlotState().open.id` 应当报的值。 */
  slot: string;
}

export const SLOT_VIEWS: readonly SlotView[] = [
  { command: 'het.openDeps', slot: 'deps' },
  { command: 'het.docs', slot: 'docs' },
  { command: 'het.quality', slot: 'quality' },
  { command: 'het.preflight', slot: 'preflight' },
  { command: 'het.openSettings', slot: 'settings' },
  { command: 'het.newModule', slot: 'moduleWizard' },
  { command: 'het.coverage', slot: 'coverage' },
  { command: 'het.openOutput', slot: 'output' },
  { command: 'het.healthReport', slot: 'health' },
  { command: 'het.commit', slot: 'commit' },
  { command: 'het.release', slot: 'release' },
  { command: 'het.ci', slot: 'ci' },
  { command: 'het.benchmark', slot: 'bench' },
  { command: 'het.generateTests', slot: 'testgen' },
  { command: 'het.openTasks', slot: 'tasks' },
];
