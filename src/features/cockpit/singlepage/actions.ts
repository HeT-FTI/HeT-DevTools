/**
 * 卡片动作 id → VS Code 命令 id 的映射（**纯数据**，不 import vscode）。
 *
 * 为什么单独一张表：单页壳里的按钮是 `data-act="<动作 id>"`，host 侧要把它翻译成真实命令。
 * 表放在这里就能被单测覆盖 —— **新增卡片动作忘了接线会直接让测试红**（而不是点了没反应）。
 *
 * 约定：
 * - `kind: 'action'` 的动作必须在此登记（`commandForAction` 返回命令 id）；
 * - `kind: 'copilot'` 的动作不在此表（它们走 §8 的 `/het-*` 入口，由 G21 守卫）。
 */
export const COMMAND_FOR_ACTION: Readonly<Record<string, string>> = {
  // 段 1 · 现在怎么样
  health: 'het.healthCheck',
  envPrepare: 'het.envPrepare',
  envRemove: 'het.envRemove',
  build: 'het.build',
  test: 'het.test',
  openCoverageReport: 'het.openCoverageReport',
  docsRun: 'het.docsRun',
  // 段 2 · 构建与验证
  clean: 'het.build',
  // 段 3 · 代码与文档
  newModule: 'het.newModule',
  quality: 'het.quality',
  openDeps: 'het.openDeps',
  // 段 4 · 交付
  commitManual: 'het.commit',
  // 段 4 · 智能提交卡的 ③（§19.1）：只把自查提示写进终端，**不回车、不自动 push**
  pushHint: 'het.pushHint',
  preflight: 'het.preflight',
  ci: 'het.ci',
  audit: 'het.audit',
  // 段 5 · 配置
  openSettings: 'het.openSettings',
  benchmark: 'het.benchmark',
};

export function commandForAction(actionId: string): string | undefined {
  return COMMAND_FOR_ACTION[actionId];
}

/** 反查（诊断/测试用）：某个命令被哪些动作引用。 */
export function actionsUsingCommand(command: string): string[] {
  return Object.entries(COMMAND_FOR_ACTION)
    .filter(([, cmd]) => cmd === command)
    .map(([id]) => id)
    .sort();
}
