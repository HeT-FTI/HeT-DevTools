import * as vscode from 'vscode';
import { showDetailPanel, type SlotPanel } from '../slots/host';
import { outputLog, type LogFilter } from '../../core/outputLog';
import type { LogDomain, LogLevel } from '../../core/outputChannels';
import { EMPTY_FILTER, type OutputFilterState } from './html';
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
      (message: { type: string; domain?: string; level?: string; keyword?: string }) => {
        if (message.type === 'output:filter') {
          filter = {
            domain: (message.domain ?? '') as LogDomain | '',
            level: (message.level ?? '') as LogLevel | '',
            keyword: message.keyword ?? '',
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

/** 过滤条件的翻译（页面用空串表示"全部"，`LogFilter` 用 undefined 表示）。 */
export function rowsOf(filter: OutputFilterState): ReturnType<typeof outputLog.tail> {
  const f: LogFilter = {
    domains: filter.domain ? [filter.domain] : undefined,
    levels: filter.level ? [filter.level] : undefined,
    keyword: filter.keyword || undefined,
  };
  return outputLog.tail(f);
}
