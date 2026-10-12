/**
 * 「工具链与环境」的 Slot 视图（V3 计划 §4.5 / G13）。
 *
 * 只做三件事，**不自己算任何事实**：
 * 1. 拿 `discoverTools()` 的探测结果（每个工具的**路径 + 来源**）；
 * 2. 把 `detectToolchain()` 已经探测到的版本（若有）挂上去；
 * 3. 交给纯函数 `toolViewRows` / `toolTableHtml` 渲染。
 *
 * 两条消息（页内 → host）：
 * · `tools:copy` + `path` —— 复制**真实**路径（用户拿去粘进终端/文档）；
 * · `tools:config` + `key` —— 直接打开该工具的设置项（`het.tools.<key>`），
 *   而不是让用户自己去翻设置面板找那一项。
 */
import * as vscode from 'vscode';
import { showDetailPanel, type SlotPanel } from '../slots/host';
import { discoverTools, type ToolRow } from '../../core/toolchainDiscovery';
import { detectToolchain } from '../../core/toolchainDetector';
import { toolViewRows, toolsPageHtml } from './toolTableView';

/** 覆盖配置（`het.tools.*`）——与 `extension.ts` 同一读取口径。 */
function toolOverridesConfig(): Record<string, string> {
  return vscode.workspace.getConfiguration('het').get<Record<string, string>>('tools', {});
}

/** 版本表：`detectToolchain()` 的 name → version（只保留真探到版本的）。 */
async function versionsOf(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    for (const [name, status] of Object.entries(await detectToolchain())) {
      if (status.version) {
        out[name] = status.version;
      }
    }
  } catch {
    /* 探测失败 → 不显示版本（宁可不显示，不编造） */
  }
  return out;
}

export function showToolsPanel(context: vscode.ExtensionContext): SlotPanel {
  return showDetailPanel(context, { id: 'tools', title: '就绪：工具链与环境' }, (panel) => {
    let disposed = false;
    const render = async (): Promise<void> => {
      const rows: ToolRow[] = await discoverTools({ overrides: toolOverridesConfig(), wsl: true });
      const versions = await versionsOf();
      if (disposed) {
        return;
      }
      panel.webview.html = toolsPageHtml(toolViewRows(rows, versions));
    };
    void render().catch((e) => console.error('[het] tools render failed', e));
    const sub = panel.webview.onDidReceiveMessage(
      async (message: { type: string; path?: string; key?: string }) => {
        if (message.type === 'tools:copy' && message.path) {
          await vscode.env.clipboard.writeText(message.path);
          return;
        }
        if (message.type === 'tools:config' && message.key) {
          // 直接把该工具的设置项摆到眼前（比"打开设置再搜"少三步）。
          await vscode.commands.executeCommand(
            'workbench.action.openSettings',
            `het.tools.${message.key}`,
          );
          return;
        }
        if (message.type === 'tools:refresh') {
          await render();
        }
      },
    );
    panel.onDidDispose(() => {
      disposed = true;
    });
    return sub;
  });
}
