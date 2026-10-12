/**
 * **子进程报活**：把"子进程还活着"这件事，绑在**它自己的取消信号**上。
 *
 * ── 为什么要有这个文件（2026-10-12 真机走查，问题 ①）────────────────────
 * 任务状态机的规则是"`running` 必须有 ≤10s 的心跳，否则对账器判 `timedOut` 并 abort"。
 * 但**生产代码里没有任何一处打点**：于是一次跑了 101.6s 的 `conan create`
 * （下载/配置期一句话不说）被判成超时，随后动作正常结束 → 完成路径撞上
 * `非法状态转换: timedOut → succeeded` → 输出里同时出现"✓ 编译打包完成"和"超时"。
 *
 * ── 为什么绑在 signal 上，而不是"每个调用点记得传回调"──────────────────
 * 这个仓库的规矩是**机制保证，不靠自觉**：长动作有 ~20 个调用点（构建/测试/文档/质量/
 * 交叉编译/覆盖率/环境准备…），要求每一处都记得接一个报活回调，等于把"已证明会失败"的
 * 自觉又请回来一次。
 *
 * 而"我拿到了这个 abort 信号"与"我起的子进程还活着吗"**本来就是同一件事**：
 * 拿信号的人负责在活着的时候报活，实现它的人（`utils/exec.run`）不需要知道任何上层概念 ——
 * 参数里已经有 signal 了。
 *
 * ── 语义边界（别把它的意义吹大）──────────────────────────────────────
 * 它证明的是"**这个动作起的子进程还没退出**"，不是"任务在取得进展"。
 * "多久算太久"的唯一来源仍然是 §3.5 的 deadline（`utils/exec` 的 `timeoutMs` 会真的杀进程）。
 *
 * 用 `WeakMap`：信号一被回收，绑定随手消失，没有全局表要清（不会随会话越积越多）。
 */
const beats = new WeakMap<AbortSignal, () => void>();

/** 绑定"这个信号对应的任务该怎么报活"（由 `core/busy.ts` 在动作启动时登记一次）。 */
export function bindLiveness(signal: AbortSignal | undefined, beat: () => void): void {
  if (signal) {
    beats.set(signal, beat);
  }
}

/** 解绑（动作结束；`WeakMap` 不会泄漏，但显式解绑能让"结束后的迟到报活"变成空操作）。 */
export function unbindLiveness(signal: AbortSignal | undefined): void {
  if (signal) {
    beats.delete(signal);
  }
}

/** 报一次活（`utils/exec` 在"子进程还活着/又有输出"时调用；无绑定时是空操作）。 */
export function beatLiveness(signal: AbortSignal | undefined): void {
  if (!signal) {
    return;
  }
  const beat = beats.get(signal);
  if (!beat) {
    return;
  }
  try {
    beat();
  } catch {
    /* 报活失败不是错误：它只是"我还在"的通知，绝不许影响子进程 */
  }
}
