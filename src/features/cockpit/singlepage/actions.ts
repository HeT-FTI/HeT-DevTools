/**
 * 卡片动作 id → VS Code 命令 id（**I 块后不再自己维护**：从 `core/intents.ts` 推导）。
 *
 * 为什么要合并：以前这里一张表、`copilotEntry.ts` 又一份映射、悬停还有第三份 label ——
 * 同一个动作四处说法不同，新增动作要改四处，改漏了没人发现（表现是"点了没反应"）。
 * 现在**唯一的表**是 `core/intents.ts`，本文件只保留壳里的两个便捷函数。
 */
import { INTENTS, commandOf, intentFor } from '../../../core/intents';

/** 卡片可用的动作 → 命令（诊断/测试用；新增动作只需改 Intent 表）。 */
export const COMMAND_FOR_ACTION: Readonly<Record<string, string>> = Object.fromEntries(
  INTENTS.filter((it) => it.kind !== 'copilot').map((it) => [it.id, it.command]),
);

export function commandForAction(actionId: string): string | undefined {
  return commandOf(actionId);
}

/** 反查（诊断/测试用）：某个命令被哪些动作引用。 */
export function actionsUsingCommand(command: string): string[] {
  return INTENTS.filter((it) => it.command === command)
    .map((it) => it.id)
    .sort();
}

/** 动作的领域术语名（§5.2 定稿；卡片/输出/任务名共用同一串字）。 */
export function nameForAction(actionId: string): string | undefined {
  return intentFor(actionId)?.name;
}
