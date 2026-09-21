/**
 * **页内 Slot 协议**（A 块：收敛到 1 个页签）。
 *
 * 背景：V1 里 13 个细节视图各自 `createWebviewPanel`，点几下工作区就变成一排页签
 * （实测反馈："像页游广告"）。V2 的结论是**驾驶舱是唯一页签**，细节视图画成它内部的
 * **互斥折叠 Slot**（同时只开一个）。
 *
 * 关键设计：**面板实现一行不改**。原来的面板拿到的是一个"像 WebviewPanel 的对象"，
 * 它照旧 `webview.html = 整页 HTML`、照旧 `webview.onDidReceiveMessage(...)`：
 *   · `html` setter → 这里把整页 HTML **切成片段**（丢掉 pageShell 的 `<head>`/`acquireVsCodeApi`），
 *     发给驾驶舱注入 Slot；
 *   · 片段里的脚本调用的 `send()` 会被驾驶舱**临时打上 `__slot` 标记**（单开原则 ⇒ 页内
 *     只有一个片段，不会串台），宿主据此把消息路由回正确的视图；
 *   · 宿主 `postMessage` 反向包成 `slot:post`，由驾驶舱重新派发 `message` 事件给片段。
 *
 * 为什么必须"单开"：两个片段同时在页内会**重名全局函数互相覆盖**（各自都有 `syncPackage()`
 * 这种函数），这类 bug 只能靠约束避免，不能靠自觉。
 */

/** 片段消息上标记来源视图的字段名（驾驶舱注入 `send` 时附加）。 */
export const SLOT_FIELD = '__slot';

/** 驾驶舱 → 页内：打开（或替换）Slot 内容。 */
export const SLOT_OPEN = 'slot:open';
/** 驾驶舱 → 页内：关闭 Slot。 */
export const SLOT_CLOSE = 'slot:close';
/** 驾驶舱 → 页内：把宿主的消息派发给片段（片段用 `window.addEventListener('message')` 接）。 */
export const SLOT_POST = 'slot:post';

/** 驾驶舱自己用掉的消息类型：片段消息**不许**复用这些名字，否则会被驾驶舱抢先处理。 */
export const COCKPIT_RESERVED_TYPES: readonly string[] = [
  'l1',
  'section',
  'busy',
  'copilotResult',
  'action',
  'copilot',
  'section:open',
  'folded',
  SLOT_OPEN,
  SLOT_CLOSE,
  SLOT_POST,
];

/**
 * 整页 HTML → Slot 片段：只取 `<body>` 内部。
 *
 * 丢掉 `<head>` 是**必须**的（不是优化）：`pageShell` 的 head 里有一次
 * `acquireVsCodeApi()`，注入到驾驶舱文档里会抛 "An instance of the VS Code API has
 * already been acquired"，把该 `<script>` 后面的代码整段带走（按钮全变哑）。
 * 片段靠驾驶舱的全局 `send()` 发消息，不需要自己的 API 实例。
 */
export function fragmentOf(pageHtml: string): string {
  const match = /<body[^>]*>([\s\S]*?)<\/body>/iu.exec(pageHtml);
  return (match ? match[1] : pageHtml).trim();
}

export function isSlotMessage(message: unknown): boolean {
  return !!message && typeof (message as Record<string, unknown>)[SLOT_FIELD] === 'string';
}

export function slotFieldOf(message: unknown): string | undefined {
  const value = (message as Record<string, unknown> | null)?.[SLOT_FIELD];
  return typeof value === 'string' ? value : undefined;
}

/** 给片段发出的消息打来源标记（页面内由驾驶舱的 `send` 包装器调用；测试也用它）。 */
export function tagSlotMessage(message: unknown, slotId: string): Record<string, unknown> {
  return { ...(message as Record<string, unknown>), [SLOT_FIELD]: slotId };
}

/** 片段消息是否用了驾驶舱保留的类型名（门禁用：这是"接不住/被抢处理"的常见根因）。 */
export function usesReservedType(message: { type?: unknown }): boolean {
  return typeof message.type === 'string' && COCKPIT_RESERVED_TYPES.includes(message.type);
}
