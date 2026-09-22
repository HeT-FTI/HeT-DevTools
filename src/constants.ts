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
