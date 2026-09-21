/**
 * **Slot 宿主**：代替原来的「细节页签」，把 14 个细节视图画进驾驶舱页内的互斥 Slot。
 *
 * 用户诉求原话："有且只有 1 个 tab"。旧实现（`detail/host.ts`）做到了"最多两个页签"，
 * 但 ① 仍然是 2；② 还留了一个 `het.detail.pin` 逃生门（把细节视图钉成独立页签）——
 * 那是我为自己引入的限制买的保险，用户从来没用过、也看不懂（见 §6-A）。
 *
 * 现在的契约：**面板实现一行不改**。
 *   · 面板照旧 `showDetailPanel(context, {id,title}, wire)`；
 *   · 面板拿到的 `panel` 是"像 `vscode.WebviewPanel` 的对象"（`webview.html` / `webview.postMessage`
 *     / `webview.onDidReceiveMessage` / `onDidDispose` 都在，语义一致）；
 *   · 差别只有一处：`webview.html` 的整页 HTML 会被切成片段注入驾驶舱（见 `protocol.ts`）。
 *
 * 互斥折叠（定稿 D3）：同时只开一个 Slot。开启新 Slot 会先关掉旧的 —— 这不是省事的妥协，
 * 而是**必须**：两个片段的全局函数会互相覆盖（各自都有同名 helper），串台后表现为
 * "点了这个视图的按钮，改的是那个视图"。
 */
import * as vscode from 'vscode';
import { cockpitWebview, openCockpitPanel, postToCockpit } from '../cockpit/controller';
import { SLOT_CLOSE, SLOT_OPEN, SLOT_POST, fragmentOf } from './protocol';
import {
  onSlotCloseRequest,
  registerSlotHandler,
  slotDiagnostics,
  type SlotMessage,
} from './registry';
import { slotTitle } from './titles';

/** 面板实际用到的那一小撮 `WebviewPanel` 能力（其余能力刻意不提供：用不到就不该有）。 */
export interface SlotWebview {
  html: string;
  postMessage(message: unknown): Thenable<boolean>;
  /**
   * 面板自己声明消息形状（如 `{ type: string; input?: AddInputDraft }`），
   * 这里从回调参数**推断**，不强迫 14 个面板改成同一个宽类型 ——
   * 改形状就得多改 14 处，而 A 块的目标是“面板实现一行不改”。
   */
  onDidReceiveMessage<T = SlotMessage>(handler: (message: T) => unknown): vscode.Disposable;
  asWebviewUri(uri: vscode.Uri): vscode.Uri;
}

export interface SlotPanel {
  readonly id: string;
  readonly title: string;
  /** 兼容旧命名空间（旧代码/测试里可能读它）。 */
  readonly viewType: string;
  readonly webview: SlotWebview;
  readonly visible: boolean;
  /** 让驾驶舱页签可见（Slot 已经在里面，不会新开页签）。 */
  reveal(): void;
  dispose(): void;
  onDidDispose(handler: () => void): vscode.Disposable;
}

export interface SlotViewSpec {
  id: string;
  title: string;
}

export type SlotWire = (panel: SlotPanel) => vscode.Disposable;

interface OpenSlot {
  id: string;
  panel: SlotPanel;
  wire: vscode.Disposable;
  handler: { dispose: () => void };
  disposeHandlers: (() => void)[];
}

let currentSlot: OpenSlot | undefined;

/** 当前页内 Slot 是哪个视图（诊断与测试用）。 */
export function currentDetailView(): SlotViewSpec | undefined {
  return currentSlot ? { id: currentSlot.id, title: currentSlot.panel.title } : undefined;
}

/** 诊断：开着哪些 Slot、有没有"没人接"的消息（F.29 家族问题的排查口）。 */
export function slotHostDiagnostics(): ReturnType<typeof slotDiagnostics> {
  return slotDiagnostics();
}

function disposeOf(fn: () => void): vscode.Disposable {
  return { dispose: fn };
}

function createSlotPanel(context: vscode.ExtensionContext, spec: SlotViewSpec): {
  panel: SlotPanel;
  messageHandlers: ((message: SlotMessage) => unknown)[];
} {
  const title = slotTitle(spec.id, spec.title);
  const messageHandlers: ((message: SlotMessage) => unknown)[] = [];
  const disposeHandlers: (() => void)[] = [];
  let html = '';
  let disposed = false;

  const panel: SlotPanel = {
    id: spec.id,
    title,
    viewType: `het.slot.${spec.id}`,
    visible: true,
    webview: {
      get html(): string {
        return html;
      },
      set html(value: string) {
        html = value;
        // 片段注入：丢掉 pageShell 的 head（里面有一次 acquireVsCodeApi，注入会抛）
        void postToCockpit({
          type: SLOT_OPEN,
          id: spec.id,
          title,
          html: fragmentOf(value),
        });
      },
      postMessage(message: unknown): Thenable<boolean> {
        return postToCockpit({ type: SLOT_POST, id: spec.id, payload: message });
      },
      onDidReceiveMessage<T = SlotMessage>(handler: (message: T) => unknown): vscode.Disposable {
        const fn = handler as unknown as (message: SlotMessage) => unknown;
        messageHandlers.push(fn);
        return disposeOf(() => {
          const at = messageHandlers.indexOf(fn);
          if (at >= 0) {
            messageHandlers.splice(at, 1);
          }
        });
      },
      asWebviewUri(uri: vscode.Uri): vscode.Uri {
        const webview = cockpitWebview();
        return webview ? webview.asWebviewUri(uri) : uri;
      },
    },
    reveal(): void {
      void openCockpitPanel(context);
    },
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      closeSlot(spec.id);
    },
    onDidDispose(handler: () => void): vscode.Disposable {
      if (disposed) {
        handler();
        return disposeOf(() => undefined);
      }
      disposeHandlers.push(handler);
      return disposeOf(() => {
        const at = disposeHandlers.indexOf(handler);
        if (at >= 0) {
          disposeHandlers.splice(at, 1);
        }
      });
    },
  };

  // 让宿主能把"驾驶舱里点了关闭"翻译成真正的撤销接线
  onSlotCloseRequest(() => {
    if (currentSlot?.id === spec.id) {
      disposeHandlers.length = 0;
      disposed = true;
      closeSlot(spec.id);
    }
  });
  void context;
  return { panel, messageHandlers };
}

function closeSlot(id?: string): void {
  const open = currentSlot;
  if (!open || (id && open.id !== id)) {
    return;
  }
  currentSlot = undefined;
  open.wire.dispose();
  open.handler.dispose();
  for (const fn of open.disposeHandlers) {
    try {
      fn();
    } catch {
      /* 一个视图的清理失败不该拖死其它视图 */
    }
  }
  void postToCockpit({ type: SLOT_CLOSE, id: open.id });
}

/**
 * 打开/切换到某个细节视图 —— **细节视图的唯一入口**（原来是 `detail/host.ts`）。
 * 页签数恒为 1：内容画在驾驶舱页内的 Slot 里。
 */
export function showDetailPanel(
  context: vscode.ExtensionContext,
  view: SlotViewSpec,
  wire: SlotWire,
): SlotPanel {
  openCockpitPanel(context);
  if (currentSlot?.id === view.id) {
    currentSlot.panel.reveal();
    return currentSlot.panel;
  }
  closeSlot();

  const created = createSlotPanel(context, view);
  const panel = created.panel;
  const open: OpenSlot = {
    id: view.id,
    panel,
    wire: disposeOf(() => undefined),
    handler: { dispose: () => undefined },
    disposeHandlers: [],
  };
  currentSlot = open;
  open.handler = registerSlotHandler(view.id, (message) => {
    for (const fn of [...created.messageHandlers]) {
      fn(message);
    }
  });
  open.wire = wire(panel);
  panel.reveal();
  return panel;
}

/** 关掉当前 Slot（命令/面板内部调用）。没有开着的 Slot 时是空操作。 */
export function closeCurrentDetail(): void {
  closeSlot();
}

/** 是否开着某个 Slot（HUD 的按键守卫用它：没开就别抢按键）。 */
export function detailViewOpen(id: string): boolean {
  return currentSlot?.id === id;
}

/** 当前 Slot 的上下文键（`when` 子句用，如 `het.hudOpen`）。 */
export function currentDetailContextKey(): string | undefined {
  return currentSlot?.id;
}

export { SLOT_CLOSE, SLOT_OPEN, SLOT_POST };
