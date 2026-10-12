/**
 * **Slot 注册表**：驾驶舱收到的消息按 `__slot` 路由回对应视图。
 *
 * 单独一层的理由：驾驶舱（`cockpit/controller.ts`）需要把消息交给宿主（`slots/host.ts`），
 * 而宿主又要通过驾驶舱发消息 —— 两边互相 import 就成了循环依赖。这里只放**无框架**的
 * 登记表：两边都依赖它，它不依赖任何一边。
 */

export type SlotMessage = Record<string, unknown>;
export type SlotHandler = (message: SlotMessage) => unknown;

const handlers = new Map<string, SlotHandler>();

/** 关闭请求：驾驶舱里点了 Slot 的"关闭"时，通知宿主真正撤销接线。 */
let closeRequester: (() => void) | undefined;

/** 路由不到的消息（诊断用：视图已关但消息还在飘 —— F.29 家族问题的根因排查口）。 */
let lastDropped: { id: string; type: string } | undefined;
let droppedCount = 0;

export function registerSlotHandler(id: string, handler: SlotHandler): { dispose: () => void } {
  handlers.set(id, handler);
  return {
    dispose: () => {
      if (handlers.get(id) === handler) {
        handlers.delete(id);
      }
    },
  };
}

/** 把消息交给对应视图的处理函数；返回是否有人接住。 */
export function routeSlotMessage(id: string, message: SlotMessage): boolean {
  const handler = handlers.get(id);
  if (!handler) {
    lastDropped = { id, type: String(message.type ?? '?') };
    droppedCount += 1;
    return false;
  }
  handler(message);
  return true;
}

export function onSlotCloseRequest(fn: () => void): void {
  closeRequester = fn;
}

export function requestSlotClose(): void {
  closeRequester?.();
}

export function openSlotIds(): string[] {
  return [...handlers.keys()].sort();
}

export interface SlotDiagnostics {
  open: string[];
  lastDropped?: { id: string; type: string };
  droppedCount: number;
}

export function slotDiagnostics(): SlotDiagnostics {
  return { open: openSlotIds(), lastDropped, droppedCount };
}

/** 测试用：清空登记表与诊断计数。 */
export function resetSlots(): void {
  handlers.clear();
  closeRequester = undefined;
  lastDropped = undefined;
  droppedCount = 0;
}
