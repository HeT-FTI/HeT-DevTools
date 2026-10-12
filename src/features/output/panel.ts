import * as vscode from 'vscode';
import { showDetailPanel, type SlotPanel } from '../slots/host';
import { outputLog, type LogFilter } from '../../core/outputLog';
import type { LogDomain, LogLevel } from '../../core/outputChannels';
import { EMPTY_FILTER, DEFAULT_VIEW_LEVELS, type OutputFilterState } from './html';
import { outputViewPageHtml } from './page';

export interface OutputDeps {
  /** 打开**唯一的输出通道**（页面只管过滤与阅读，通道本身仍由 VS Code 持有）。 */
  revealChannel: () => void;
}

/**
 * 页内「输出」视图（D 块）。
 *
 * 消息协议只有两条：`output:filter`（改过滤条件）与 `output:reveal`（打开唯一通道）。
 * 页面**不持有任何输出状态** —— 过滤条件留在 host，行来自 `core/outputLog` 的环形缓冲，
 * 这样"页内看到的那一段"与"Output 面板里那一段"永远是同一份数据。
 */
export function showOutputPanel(context: vscode.ExtensionContext, deps: OutputDeps): SlotPanel {
  return showDetailPanel(context, { id: 'output', title: '输出：HeT DevTools' }, (panel) => {
    let filter: OutputFilterState = { ...EMPTY_FILTER };
    let disposed = false;

    const render = (): void => {
      if (disposed) {
        return;
      }
      panel.webview.html = outputViewPageHtml(rowsOf(filter), filter);
    };

    const sub = panel.webview.onDidReceiveMessage(
      (message: { type: string; domain?: string; level?: string; keyword?: string; diag?: boolean }) => {
        if (message.type === 'output:filter') {
          filter = {
            domain: (message.domain ?? '') as LogDomain | '',
            level: (message.level ?? '') as LogLevel | '',
            keyword: message.keyword ?? '',
            includeDiag: message.diag === true,
          };
          render();
        } else if (message.type === 'output:reveal') {
          deps.revealChannel();
        }
      },
    );

    panel.onDidDispose(() => {
      disposed = true;
    });

    render();
    return sub;
  });
}

/**
 * 过滤条件的翻译（页面用空串表示"全部"，`LogFilter` 用 undefined 表示）。
 *
 * **诊断行默认不进视图**（§6.0 第 7 条）：只在用户勾了「包含诊断行」时才给 `levels` 放开。
 * 注意"给了 level 选择"时按用户选的走 —— 他明确要看诊断级别就不该再被默认口径拦一层。
 */
export function rowsOf(filter: OutputFilterState): ReturnType<typeof outputLog.tail> {
  const levels = filter.level
    ? [filter.level as LogLevel]
    : filter.includeDiag
      ? undefined
      : [...DEFAULT_VIEW_LEVELS];
  const f: LogFilter = {
    domains: filter.domain ? [filter.domain] : undefined,
    levels,
    keyword: filter.keyword || undefined,
  };
  return outputLog.tail(f);
}
