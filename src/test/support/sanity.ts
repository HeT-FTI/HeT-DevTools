/**
 * 门禁用的小工具（只给测试用；不 import vscode）。
 */
import { PLANNED_CAPABILITY_CONSUMERS } from '../../features/cockpit/singlepage/spine';

/**
 * "还没被任何卡消费的能力"登记表（键 = 能力 id）。
 *
 * 用途见 `perfBaseline.test.ts`：这张表**只许变短** —— 落地了就必须删条目，
 * 否则门禁会一直替一个已经做完的事"挂账"。
 */
export function baremetalCapabilityConsumers(): string[] {
  return Object.keys(PLANNED_CAPABILITY_CONSUMERS).sort();
}
