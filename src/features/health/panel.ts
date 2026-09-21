import * as vscode from 'vscode';
import type { HealthReport } from '../../core/healthCheck';
import { showDetailPanel, type SlotPanel } from '../slots/host';
import { healthBodyHtml, healthPageHtml } from './html';

export interface HealthPanelDeps {
  /** 最近一次体检报告（没体检过就是 null）。 */
  getReport: () => HealthReport | null;
  /** 重新体检（宿主自己做输出通道/忙语义；这里只等它结束）。 */
  rerun: () => Promise<void>;
  /**
   * 订阅"仓库状态变了"（构建/测试/覆盖率都会广播）→ 明细要跟着刷新。
   *
   * V5-6 的老需求：明细与悬停卡必须**同一份事实**，不许用固定延时去"等"。
   */
  onStateChange: (fn: () => void) => { dispose: () => void };
}

/**
 * 工程健康明细（L3 · 细节页签）——方案 D 的**最后一个**迁移项。
 *
 * 以前这是 `extension.ts` 里自己 `createWebviewPanel` 的面板（也是唯一没被细节页签
 * 接管的那个）。搬过来的同时按 F.29/F.30 补齐三件事：
 * 1. 交互走事件委托（不再 `onclick=`）；
 * 2. 状态变化时**局部替换 `#body`**，不整页重写（不丢滚动、不闪）；
 * 3. `rerun` 有明确的进行中提示（"⏳ 体检中…"），结束无论成败都刷新。
 */
export function showHealthReportPanel(
  context: vscode.ExtensionContext,
  deps: HealthPanelDeps,
): SlotPanel {
  return showDetailPanel(
    context,
    { id: 'health', title: 'HeT DevTools — 工程健康明细' },
    (panel) => {
      let busy = false;
      const push = (): void => {
        void panel.webview.postMessage({ type: 'health', html: healthBodyHtml(deps.getReport(), busy) });
      };
      // 首帧整页一次；之后只推 `#body`。
      panel.webview.html = healthPageHtml(deps.getReport(), busy);
      const offState = deps.onStateChange(push);
      const sub = panel.webview.onDidReceiveMessage(async (message: { type: string }) => {
        if (message.type !== 'rerun') {
          return;
        }
        busy = true;
        push();
        try {
          await deps.rerun();
        } finally {
          // §F.41：失败也必须收尾（不许把"体检中…"永久留在页面上）。
          busy = false;
          push();
        }
      });
      return vscode.Disposable.from(sub, { dispose: offState.dispose });
    },
  );
}
