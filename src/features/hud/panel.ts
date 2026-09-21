/**
 * V4-6 Level-2 HUD card host: a single-instance webview that reuses/reveals.
 * Messages: command (run an action), close (Esc), snooze (hide chip 5 min),
 * hideHud (fall back to the QuickPick list). HTML is pure (hudModel).
 */
import * as vscode from 'vscode';
import { HudModel, hudHtml } from './hudModel';
import { actionForDigit } from './keys';

export interface HudDeps {
  getModel: () => Promise<HudModel>;
  fontSize: () => number;
  /** Hide the status chip for ~5 minutes. */
  onSnooze: () => void;
  /** Disable the HUD → chip click falls back to the QuickPick list. */
  onHideHud: () => void;
}

let panelRef: vscode.WebviewPanel | undefined;

export function openHudPanel(context: vscode.ExtensionContext, deps: HudDeps): vscode.WebviewPanel {
  if (panelRef) {
    panelRef.reveal(vscode.ViewColumn.Active);
    void render(panelRef, deps);
    return panelRef;
  }
  const panel = vscode.window.createWebviewPanel(
    'het.hud',
    'HeT 监控卡',
    vscode.ViewColumn.Active,
    { enableScripts: true, localResourceRoots: [context.extensionUri] },
  );
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');
  panelRef = panel;
  panel.onDidDispose(() => {
    if (panelRef === panel) {
      panelRef = undefined;
    }
  });
  panel.webview.onDidReceiveMessage((message: { type: string; command?: string }) => {
    if (message.type === 'close') {
      void panel.dispose();
    } else if (message.type === 'snooze') {
      deps.onSnooze();
    } else if (message.type === 'hideHud') {
      deps.onHideHud();
    } else if (message.type === 'command' && message.command) {
      void vscode.commands.executeCommand(message.command);
    }
  });
  void render(panel, deps).catch((e) => console.error('[het] HUD render failed', e));
  return panel;
}

/**
 * 宿主侧按键：`1`–`9` 执行对应动作，`Esc` 关卡片。
 *
 * 与页面内脚本走**同一张动作表**（`HudAction.digit`）—— 页面内按键只在卡片有焦点时有效，
 * 这条路径补上"焦点在编辑器里也能按"（实测反馈：HUD 写着能按，实际按了没反应）。
 */
export async function pressHudKey(digit: number | null, deps: HudDeps): Promise<void> {
  if (digit === null) {
    return;
  }
  const model = await deps.getModel();
  const action = actionForDigit(model.actions, digit);
  if (action) {
    await vscode.commands.executeCommand(action.cmd);
  }
}

/** HUD 卡片开着吗（按键命令要先确认面板存在，否则按键会去开一个空卡片）。 */
export function hudPanelOpen(): boolean {
  return panelRef !== undefined;
}

/** 关闭 HUD 卡片（Esc 命令用）。 */
export function closeHudPanel(): void {
  panelRef?.dispose();
}

async function render(panel: vscode.WebviewPanel, deps: HudDeps): Promise<void> {
  const model = await deps.getModel();
  panel.webview.html = hudHtml(model, deps.fontSize());
}
