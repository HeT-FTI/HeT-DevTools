/** Global identifiers and small constants shared across the extension. */
import { OUTPUT_CHANNEL_NAME, formatLogLine, type LogDomain } from './core/outputChannels';
import { outputLog } from './core/outputLog';

/** Output channel name（**唯一**一个；D 块后各域不再各开一个通道）。 */
export { OUTPUT_CHANNEL_NAME as LOG_CHANNEL_NAME };

/**
 * **唯一的** OutputChannel（懒建单例）。
 *
 * D 块踩过的坑：`extension.ts` 与 `features/busyHost.ts` 各建一个**同名**通道 ——
 * VS Code 的 Output 下拉里就会出现两条一模一样的 `HeT DevTools`（用户看到"两个通道"，
 * 而我们的门禁还以为只有一个）。所以创建权收在这里，别处只能取用。
 */
let channel: import('vscode').OutputChannel | undefined;

export function outputChannel(): import('vscode').OutputChannel {
  if (!channel) {
    // 唯一的创建点（门禁：`createOutputChannel(` 在 src 下只允许出现在这一处）
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    channel = (require('vscode') as typeof import('vscode')).window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  }
  return channel;
}

/** 测试/兼容：注入一个已有通道（生产的创建走 `outputChannel()`）。 */
export function setOutputChannel(c: import('vscode').OutputChannel): void {
  channel = c;
}

/**
 * 写一行结构化日志到唯一通道（**必须给域**）。
 *
 * D 块之前这里是 `log('template', '…')` —— 域是手写在文案里的，所以"忘了写"或"写错了"
 * 都没人管（Output 面板里就会出现没有标签的裸行）。现在域是**参数**，门禁能逐行解析验证。
 */
export function log(domain: LogDomain, message: string): void {
  const entry = { at: Date.now(), domain, level: 'info' as const, text: message.replace(/\s+$/u, '') };
  outputChannel().appendLine(formatLogLine(entry));
  outputLog.append(entry);
}

/**
 * **外来文本块**（子进程输出 / 报表 / tail 片段）—— 唯一允许"原样写"的两种之一。
 *
 * 为什么需要它：这些不是我们的行（是 cmake/quality/审计的输出），逐行重写成
 * `[domain] level text` 会**失真**（用户就是要原样拷出去搜）。但也不能让它消失在
 * 结构化体系之外，所以：
 *   · 通道里：先一行结构化**头**（谁打印的、多少行），再原样块；
 *   · 环形缓冲里：**只放头那一行** —— 500 行的环形不该被一份报表吃光，而"按域过滤
 *     能看到发生了什么"这个能力必须保留。
 */
export function logBlock(domain: LogDomain, label: string, text: string): void {
  const lines = text.split(/\r?\n/u).filter((l) => l.length > 0);
  const entry = {
    at: Date.now(),
    domain,
    level: 'info' as const,
    text: `${label}（${lines.length} 行原始输出，下面原样保留）`,
  };
  outputChannel().appendLine(formatLogLine(entry));
  outputLog.append(entry);
  outputChannel().append(text.endsWith('\n') ? text : `${text}\n`);
}

/**
 * **实时流**（子进程的 stdout/stderr，半行也是常态）—— 唯一允许"逐块追加"的入口。
 *
 * 不进环形缓冲：流的"边界"由动作自己的结构化行给出（`▶ 开始` / `✓✗⌛⊘ 结束`），
 * 中间的原始字节属于工具本身。
 */
export function logStream(text: string): void {
  outputChannel().append(text);
}
