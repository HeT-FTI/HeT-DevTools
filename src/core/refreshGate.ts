/**
 * "刷新请求闸门"（G18）—— 纯逻辑，不 import vscode。
 *
 * 场景：单页驾驶舱的事实刷新由多个入口触发（打开面板、展开某段、动作跑完），
 * 而取数是有成本的（健康快照 + 车道方案 + 环境契约）。
 *
 * 两条必须要的语义：
 * 1. **不并发**：正在刷时再来请求，不能同时跑第二遍（否则同样的取数跑两次，还可能交错写 UI）；
 * 2. **不丢最新**：刷的过程中来的请求要**记下来**，当前这轮结束后再补一轮
 *    —— 否则"动作刚跑完时正好在刷"这一次的结果就永远不会出现（用户看到的是旧值）。
 */
export interface RefreshGate {
  inFlight: boolean;
  queued: boolean;
}

export const IDLE_GATE: RefreshGate = { inFlight: false, queued: false };

/** 收到一次刷新请求：该不该立刻开跑？ */
export function beginRefresh(gate: RefreshGate): { start: boolean; next: RefreshGate } {
  if (gate.inFlight) {
    return { start: false, next: { inFlight: true, queued: true } };
  }
  return { start: true, next: { inFlight: true, queued: false } };
}

/** 一轮刷完：要不要因为等着的请求再跑一轮？ */
export function endRefresh(gate: RefreshGate): { rerun: boolean; next: RefreshGate } {
  if (gate.queued) {
    return { rerun: true, next: { inFlight: true, queued: false } };
  }
  return { rerun: false, next: { ...IDLE_GATE } };
}
