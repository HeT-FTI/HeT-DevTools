/**
 * §D（2026-09-20 定案）：**工作区最多两个页签** —— 一个是整体（驾驶舱），
 * 一个是"细节"页签（内容跟着你点的域切换，不在就创建）。
 *
 * 为什么这样做：16 处 `createWebviewPanel` 里只有 2 处是单例，其余每调用一次就多一个页签
 * （实测反馈：点几下工作区就变成一排页签，"像页游广告"）。而"每个域各留一个页签"仍然会长。
 *
 * 设计要点（**面板实现一行不改**，只换"谁来持有面板"）：
 *   · 本文件是**唯一**允许 `createWebviewPanel` 的地方（驾驶舱与 HUD 是既有单例，见门禁白名单）；
 *   · 面板模块把自己的 `render()` + `onDidReceiveMessage()` 写在 `wire(panel)` 里，返回要在
 *     **切走时撤销**的 Disposable —— 不撤销的话两个视图的消息处理器会同时收到消息（真会串）；
 *   · 切换 = 改标题 + 换 `webview.html` + `reveal()`，页签数不变；
 *   · **逃生门（pin）**：想同时看两个视图时，把当前视图"钉"成独立页签（同样是单例）。
 *     一旦某个视图被钉住，该域的入口就直接去它自己的页签 —— 避免同一内容在两处重复显示。
 *
 * 与 `het.detail.pin` 命令配套（编辑器标题栏菜单里给"固定成独立页签"）。
 */
import * as vscode from 'vscode';

/** 面板模块把自己接到宿主面板上；返回值在**切走/关闭**时被撤销。 */
export type DetailWire = (panel: vscode.WebviewPanel) => vscode.Disposable;

export interface DetailViewSpec {
  /** 稳定 id：用作 webview viewType 后缀与 pin 的键。 */
  id: string;
  /** 页签标题（= 当前视图名，用户一眼看出"现在在看什么"）。 */
  title: string;
}

interface OpenView extends DetailViewSpec {
  wire: DetailWire;
}

let contextRef: vscode.ExtensionContext | undefined;
let detailPanel: vscode.WebviewPanel | undefined;
let detailWire: vscode.Disposable | undefined;
let current: OpenView | undefined;
/** 被钉住的视图：view id → 它自己的单例页签。 */
const pinned = new Map<string, { panel: vscode.WebviewPanel; wire: vscode.Disposable }>();

function panelOptions(context: vscode.ExtensionContext): vscode.WebviewPanelOptions &
  vscode.WebviewOptions {
  return {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [context.extensionUri],
  };
}

function attach(context: vscode.ExtensionContext, view: OpenView, isPinned: boolean): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(
    `het.detail.${view.id}`,
    view.title,
    vscode.ViewColumn.Active,
    panelOptions(context),
  );
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');
  const wire = view.wire(panel);
  const entry = { panel, wire };
  if (isPinned) {
    pinned.set(view.id, entry);
  } else {
    detailPanel = panel;
    detailWire = wire;
  }
  panel.onDidDispose(() => {
    if (pinned.get(view.id)?.panel === panel) {
      pinned.delete(view.id);
    }
    if (detailPanel === panel) {
      detailPanel = undefined;
      detailWire = undefined;
      current = undefined;
    }
  });
  return panel;
}

/**
 * 打开/切换到某个"细节"视图。**这是细节面板的唯一入口**。
 *
 * - 该视图被 pin 过 → 直接 `reveal` 它自己的页签（不占用细节页签，也不重复显示）；
 * - 细节页签不存在 → 创建（此时工作区从 1 个页签变 2 个）；
 * - 已存在 → 换标题 + 让新视图接上（旧视图的接线先撤销）+ `reveal`。
 */
export function showDetailPanel(
  context: vscode.ExtensionContext,
  view: DetailViewSpec & { pinned?: boolean },
  wire: DetailWire,
): vscode.WebviewPanel {
  contextRef = context;
  const pinnedEntry = pinned.get(view.id);
  if (pinnedEntry && !view.pinned) {
    pinnedEntry.panel.reveal(vscode.ViewColumn.Active);
    return pinnedEntry.panel;
  }
  if (view.pinned) {
    const already = pinned.get(view.id);
    if (already) {
      already.panel.reveal(vscode.ViewColumn.Active);
      return already.panel;
    }
    return attach(context, { id: view.id, title: view.title, wire }, true);
  }
  const open: OpenView = { id: view.id, title: view.title, wire };
  if (!detailPanel) {
    const panel = attach(context, open, false);
    current = open;
    return panel;
  }
  // 切换视图：先撤销上一个视图的接线，再接上新的（顺序不能反，否则旧 handler 会多收一轮）
  detailWire?.dispose();
  detailPanel.title = view.title;
  detailWire = wire(detailPanel);
  current = { id: view.id, title: view.title, wire };
  detailPanel.reveal(vscode.ViewColumn.Active);
  return detailPanel;
}

/** 当前细节页签里是哪个视图（没有就 undefined）——诊断与测试用。 */
export function currentDetailView(): DetailViewSpec | undefined {
  return current ? { id: current.id, title: current.title } : undefined;
}

/** 被钉住的视图 id 列表 —— 诊断与测试用。 */
export function pinnedDetailViews(): string[] {
  return [...pinned.keys()].sort();
}

/**
 * 逃生门：把**当前**细节视图钉成独立页签（想两个视图并排看时用）。
 * 已经钉过就只是 reveal，不会开第三个页签。
 */
export function pinCurrentDetail(): vscode.WebviewPanel | undefined {
  if (!contextRef || !current) {
    return undefined;
  }
  const panel = showDetailPanel(contextRef, { id: current.id, title: current.title, pinned: true }, current.wire);
  void vscode.window.showInformationMessage(
    `已固定「${current.title}」为独立页签；之后该入口直接来这里，细节页签不再重复显示它。`,
  );
  return panel;
}

/** 取消固定（命令/面板关掉时也会自动清）。 */
export async function unpinDetail(viewId?: string): Promise<void> {
  const ids = viewId ? [viewId] : [...pinned.keys()];
  for (const id of ids) {
    const entry = pinned.get(id);
    if (entry) {
      pinned.delete(id);
      entry.wire.dispose();
      entry.panel.dispose();
    }
  }
}
