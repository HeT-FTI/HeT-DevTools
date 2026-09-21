import * as vscode from 'vscode';
import { showDetailPanel } from '../detail/host';
import { depsListHtml, depsPageHtml, type DepPanelState } from './html';
import { validateAddInput, type AddInputDraft } from './model';

export interface DepAddInput {
  conanName: string;
  version: string;
  bucket: 'common' | 'c' | 'cpp' | 'infra';
  targets?: string;
}

export type { DepPanelState };

export interface DepPanelDeps {
  getState: () => Promise<DepPanelState>;
  add: (input: DepAddInput) => Promise<{ ok: boolean; message: string }>;
  remove: (bucket: string, displayKey: string) => Promise<{ ok: boolean; message: string }>;
}

function stamp(at: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(at.getHours())}:${p(at.getMinutes())}:${p(at.getSeconds())}`;
}

/**
 * 依赖管理器（L3 · 细节页签）。
 *
 * 实测反馈第 4 条的三处硬伤都在这里收口：
 * 1. **点不动**：不再静默 return（校验失败必回一句人话），也不再 `onclick=`；
 * 2. **入口错**（`het.openDeps` 以前深链到驾驶舱）：现在它直接打开本详情页；
 * 3. **看不出有没有生效**：每次操作都在 `#note` 回显结论 + 时间戳，并**局部刷新**清单。
 */
export function showDepsPanel(context: vscode.ExtensionContext, deps: DepPanelDeps): vscode.WebviewPanel {
  // §D：细节面板共用一个页签（切视图换内容）——实现原样搬进来，只把"谁来持有面板"交给 host。
  return showDetailPanel(context, { id: 'deps', title: 'HeT DevTools — 依赖管理器' }, (panel) => {
    const push = async (note: string): Promise<void> => {
      try {
        const state = await deps.getState();
        void panel.webview.postMessage({ type: 'render', listHtml: depsListHtml(state), note });
      } catch (err) {
        void panel.webview.postMessage({
          type: 'render',
          listHtml: '<div class="fail">读取依赖失败（先看下方提示）</div>',
          note: `读取失败：${err instanceof Error ? err.message : String(err)}`,
        });
      }
    };

    const afterWrite = async (result: { ok: boolean; message: string }): Promise<void> => {
      const state = await deps.getState().catch(() => null);
      const tail = state ? ` · 当前 ${state.views.length} 个依赖` : '';
      await push(`${result.ok ? '✅' : '⚠'} ${result.message} · ${stamp()}${tail}`);
    };

    const sub = panel.webview.onDidReceiveMessage(
      async (message: { type: string; input?: AddInputDraft; bucket?: string; displayKey?: string }) => {
        if (message.type === 'refresh') {
          await push(`已刷新 · ${stamp()} · 直接读 conandata.yml / metadata.json（与上次相同也不代表没生效）`);
        } else if (message.type === 'add') {
          const draft = message.input ?? { conanName: '', version: '', bucket: 'cpp' };
          // §F.42：校验失败**必须回话**（以前这里静默 return，用户看到的就是"按钮是死的"）
          const bad = validateAddInput(draft);
          if (bad) {
            await push(`⚠ ${bad}`);
            return;
          }
          await afterWrite(await deps.add(draft as DepAddInput));
        } else if (message.type === 'remove' && message.bucket && message.displayKey) {
          await afterWrite(await deps.remove(message.bucket, message.displayKey));
        }
      },
    );

    // 首帧：整页一次；之后只走 push（§F.29：刷新不整页重载）。
    void (async (): Promise<void> => {
      try {
        const state = await deps.getState();
        panel.webview.html = depsPageHtml(state);
      } catch (err) {
        panel.webview.html = depsPageHtml(
          { views: [], issues: [] },
          `读取依赖失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();
    return sub;
  });
}
