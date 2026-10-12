/**
 * 「新库自检」的 Slot 视图（V3 计划 §7.1 · L5 / G4）。
 *
 * 只做三件事，**不自己算任何判据**：
 * 1. 采一份工程快照（`collectLibSnapshot()`：真实文件内容/清单 + metadata + conandata
 *    + CI 里装过系统头的包 + 模板自带的 LICENSE/NOTICE）；
 * 2. 交给纯函数 `auditNewLib()` 逐条判定；
 * 3. 渲染（`newLibPageHtml`）+ 回喂卡片（`setSinglePageFacts`）。
 *
 * 一条消息（页内 → host）：`audit:refresh` = 重新读一遍工程（用户在 IDE 里改完文件后点它）。
 */
import * as vscode from 'vscode';
import { showDetailPanel, type SlotPanel } from '../slots/host';
import { auditNewLib, newLibAuditFact, type LibSnapshot } from '../../core/newLibAudit';
import { CONTRACT_REL, collectLibSnapshot } from '../../core/libSnapshot';
import { newLibAuditPageHtml } from './newLibPage';

export { CONTRACT_REL, collectLibSnapshot };

export function showNewLibAuditPanel(
  context: vscode.ExtensionContext,
  deps: {
    /** 工程根（没有工程时返回 undefined）。 */
    root: () => string | undefined;
    /** 与卡片**同一份**事实来源。 */
    snapshot: () => Promise<LibSnapshot>;
    /** 采完把卡片那行也更新掉（两处同一份结果）。 */
    onResult?: (results: ReturnType<typeof auditNewLib>) => void;
  },
): SlotPanel {
  return showDetailPanel(context, { id: 'newLibAudit', title: '交付：新库自检' }, (panel) => {
    let disposed = false;
    const render = async (): Promise<void> => {
      const snap = await deps.snapshot();
      if (disposed) {
        return;
      }
      const results = auditNewLib(snap);
      deps.onResult?.(results);
      // 没打开工程时不谎报"合同文件缺失"（那是另一回事）：只有真在工程里才判它在不在。
      const inProject = deps.root() !== undefined;
      panel.webview.html = newLibAuditPageHtml({
        phrase: newLibAuditFact(results).fact,
        results,
        contractPresent: inProject && snap.paths.includes(CONTRACT_REL),
        contractPath: CONTRACT_REL,
      });
    };
    void render().catch((e) => console.error('[het] new-lib audit render failed', e));
    const sub = panel.webview.onDidReceiveMessage(async (message: { type: string }) => {
      if (message.type === 'audit:refresh') {
        await render();
      }
    });
    panel.onDidDispose(() => {
      disposed = true;
    });
    return sub;
  });
}
