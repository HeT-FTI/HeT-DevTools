/**
 * `BusyHost` 的 VS Code 适配层（计划 §7）。
 *
 * `core/busy.ts` 是纯逻辑，真正的 OutputChannel / 通知由这里提供 —— 这样同一套
 * "转圈 → 输出 → 结论 → 恢复"语义在扩展各功能间**只有一份实现**。
 *
 * 两个刻意的取舍：
 * - 通道默认 `show(true)`（**preserveFocus**）：日志面板不该抢走用户正在看的焦点；
 * - 只有"允许抢焦点"的通道才会被 reveal：Copilot 入口的记账通道**不** reveal，否则用户刚点
 *   开 Chat 就被输出面板盖住（chat 类动作要的产物在 Chat 里，不在 Output 里）。
 */
import * as vscode from 'vscode';
import type { BusyHost } from '../core/busy';
import { OUTPUT_CHANNEL_NAME } from '../core/outputChannels';
import { outputChannel as getOutputChannel } from '../constants';

export interface BusyHostOptions {
  /** 通知 webview 忙点开/关（§7 第 3 条）。 */
  notifyBusy(action: string, on: boolean): void;
  /** 完成通知；缺省 = 成功轻提示 / 失败警告（§7 第 4 条）。 */
  notifyDone?(action: string, ok: boolean, message: string): void;
  /** 该通道是否允许被 reveal（默认允许；**是否真的 reveal 由 Intent 的 `output.focus` 决定**）。 */
  reveal?(name: string): boolean;
  /** 创建的 OutputChannel 交给调用方登记（deactivate 时释放）。 */
  register?(d: vscode.Disposable): void;
}

export function createBusyHost(opts: BusyHostOptions): BusyHost {
  // D 块：**只有一个**通道（`constants.outputChannel()` 单例）。这里不再按名字新建 ——
  // 以前"extension 建一个 + 这里建一个"会让 Output 下拉里出现两条同名的 `HeT DevTools`。
  const ch = getOutputChannel();
  return {
    outputChannel(name: string) {
      if (name !== OUTPUT_CHANNEL_NAME) {
        console.warn(`[het] 只允许一个输出通道（收到 ${name}）—— 已改用 ${OUTPUT_CHANNEL_NAME}`);
      }
      const reveal = opts.reveal ? opts.reveal(name) : true;
      return reveal
        ? { appendLine: (line: string) => ch.appendLine(line), show: () => ch.show(true) }
        : { appendLine: (line: string) => ch.appendLine(line) };
    },
    notifyBusy: opts.notifyBusy,
    notifyDone:
      opts.notifyDone ??
      ((_action: string, ok: boolean, message: string): void => {
        if (ok) {
          void vscode.window.showInformationMessage(message);
        } else {
          void vscode.window.showWarningMessage(message);
        }
      }),
    now: () => Date.now(),
  };
}
