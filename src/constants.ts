/** Global identifiers and small constants shared across the extension. */

/** Output channel (full logs for long-running tasks). */
export const LOG_CHANNEL_NAME = 'HeT DevTools';

/** Output channel instance (lazy). */
let channel: import('vscode').OutputChannel | undefined;

export function setOutputChannel(c: import('vscode').OutputChannel): void {
  channel = c;
}

/** Timestamped log line to the HeT output channel. */
export function log(message: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  channel?.appendLine(`[${ts}] ${message}`);
}
