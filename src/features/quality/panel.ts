import * as vscode from 'vscode';
import {
  QUALITY_IDLE_HINT,
  qualityErrorHtml,
  qualityRefreshedHtml,
  qualityPageHtml,
  qualityResultHtml,
  qualityRowsHtml,
} from './qualityHtml';
import type { GateRowStatus, QualityRow, QualityRunResult } from './qualityHtml';
import { showDetailPanel, type SlotPanel } from '../slots/host';

// F.29：页面 HTML 全部搬到 ./qualityHtml（纯函数、可单测）；这里只做面板生命周期与
// 消息路由。类型照旧从这里导出，调用方不受影响。
export type { GateRowStatus, QualityRow, QualityRunResult };

export interface QualityDeps {
  getRows: () => Promise<QualityRow[]>;
  runRow: (rowId: string) => Promise<QualityRunResult>;
  fixFormat: () => Promise<{ ok: boolean; message: string }>;
  openIssue: (file: string, line?: number) => void;
}

export function showQualityPanel(context: vscode.ExtensionContext, deps: QualityDeps): SlotPanel {
  // §D：细节面板共用一个页签（切视图换内容）——实现原样搬进来，只把"谁来持有面板"交给 host。
  return showDetailPanel(context, { id: 'quality', title: 'HeT DevTools — 质量与安全' }, (panel) => {

    /**
     * 局部刷新：只把 `#rows` / `#detail` 两块内容推给页面，**不整页重载**。
     *
     * 为什么不再 `panel.webview.html = …`：整页重载会丢滚动位置、闪一下，而且一旦有片段
     * 自带 `<script>` 就会和 pageShell 抢 `acquireVsCodeApi()`（那正是 F.29 里"点一次之后
     * 按钮全哑"的根因）。两处内容都只放 HTML，交互由页面里的委托脚本处理。
     */
    const push = async (detailHtml: string): Promise<void> => {
      const rows = await deps.getRows();
      await panel.webview.postMessage({
        type: 'update',
        rows: qualityRowsHtml(rows),
        detail: detailHtml,
      });
    };

    const sub = panel.webview.onDidReceiveMessage(async (message: { type: string; rowId?: string; file?: string; line?: number }) => {
      if (message.type === 'refresh') {
        // 真的重探（getRows → which 实扫 PATH）+ 给可见反馈（时间戳），见 qualityRefreshedHtml 注释
        await push(qualityRefreshedHtml());
      } else if (message.type === 'runRow' && message.rowId) {
        try {
          const result = await deps.runRow(message.rowId);
          await push(qualityResultHtml(result));
        } catch (err) {
          // 点了检查就一定会回一次结果 —— 否则按钮永久停在「检查中…」（还是"没反应"）。
          await push(qualityErrorHtml(message.rowId, err));
        }
      } else if (message.type === 'fixFormat') {
        const r = await deps.fixFormat();
        void vscode.window.showInformationMessage(r.message);
        await push(QUALITY_IDLE_HINT);
      } else if (message.type === 'openIssue' && message.file) {
        deps.openIssue(message.file, message.line);
      }
    });

    void (async () => {
      const rows = await deps.getRows();
      panel.webview.html = qualityPageHtml(rows);
    })().catch((e) => console.error('[het] quality render failed', e));
    return sub;
  });
}
