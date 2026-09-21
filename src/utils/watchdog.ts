/**
 * 看门狗：给"可能卡住的任务"加硬上限。
 *
 * 用途：本项目要求**测试 0 人工参与**（无人值守的 agentic 编码）。任何可能阻塞的任务
 * （spawn、网络、浏览器、长循环）都必须能自己退出，而不是把 CI/会话挂在那里等人按 Ctrl-C。
 *
 * 约定：
 * - `withWatchdog(ms, label, fn)` 超时后 reject `WatchdogError`（调用方决定怎么办）；
 * - 脚本类调用传 `onTimeout`（如 `() => process.exit(97)`）——退出码 97 = 看门狗触发，
 *   与普通失败（1）区分，便于无人值守时快速定位"是卡住而不是挂错"。
 */
export class WatchdogError extends Error {
  readonly label: string;
  readonly ms: number;
  constructor(label: string, ms: number) {
    super(`看门狗触发：${label} 超过 ${ms}ms 仍未结束`);
    this.name = 'WatchdogError';
    this.label = label;
    this.ms = ms;
  }
}

/** 无人值守脚本的约定退出码（看门狗触发）。 */
export const WATCHDOG_EXIT_CODE = 97;

export async function withWatchdog<T>(
  ms: number,
  label: string,
  fn: () => Promise<T>,
  onTimeout?: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.();
      } finally {
        reject(new WatchdogError(label, ms));
      }
    }, ms);
    // 不要让看门狗本身拖住进程退出
    timer.unref?.();
  });
  try {
    return await Promise.race([fn(), guard]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
