import * as vscode from 'vscode';
import { initialCockpitState, reduceCockpit, CockpitEvent, CockpitState } from './state';
import { cockpitSinglePageHtml, cockpitSinglePageBody, cardsBySection } from './singlepage/shell';
import { EMPTY_FACTS, singlePageModelFrom, type SinglePageFacts } from './singlepage/modelFrom';
import { normalizeFolded, type SectionId, type SinglePageModel } from './singlepage/model';
import { commandForAction } from './singlepage/actions';
import { SECTIONS, sectionForTab } from './singlepage/sections';
import { channelDef, nextStepHint } from '../../core/outputChannels';
import { currentStatus, runWithBusy, type BusyHost } from '../../core/busy';
import { IDLE_GATE, beginRefresh, endRefresh, type RefreshGate } from '../../core/refreshGate';
import { createBusyHost } from '../busyHost';
import {
  CHAT_OPEN_COMMAND,
  COPILOT_CHANNEL,
  COPILOT_PROMPT_MARKER,
  COPILOT_SESSION_TITLE,
  TITLED_STATE_KEY,
  assertAllowedChatCommand,
  chatOpenArgs,
  copilotEntryFor,
  prefillText,
  renameAttemptOrder,
  shouldHandleEntry,
  type EntryGate,
} from './singlepage/copilotEntry';

/**
 * 单页驾驶舱控制器（gui-rework-plan §7）。
 *
 * **只有一条路径**：单页壳（L1 + 5 段 + 竖向 rail）。旧 UI（11 tab 单列文档 / 抽屉 / 向导 /
 * 每页一个 payload 的适配器）已整体归档到 `_archive/`（dead scope，不进 git、不参与编译与测试），
 * 需要回看或回滚时见 `_archive/ARCHIVE.md`。
 *
 * 事实（健康/环境/构建/测试/覆盖率/质量/CI/网络/上板…）由 host 通过 `setFactsCollector`
 * 注册的收集器喂进来；单页自己决定"什么时候该取数"（懒加载 + 刷新闸门）。
 */

let cockpitPanel: vscode.WebviewPanel | undefined;
let cockpitState: CockpitState = initialCockpitState();
let cockpitContext: vscode.ExtensionContext | undefined;
let singlePageFacts: SinglePageFacts = EMPTY_FACTS;
let foldedSections: SectionId[] | undefined;
/** 懒加载：已经请求过正文的段（§6 `section:open`）。 */
const openedSections = new Set<SectionId>();
/**
 * 最近一次深链解析出来的段（旧 tab id → 段）。
 *
 * 为什么存起来：新 UI 没有“当前页”这个概念（旧 `state.page` 已归档），
 * 但深链（`het.dashboard ['deps']`、“打开依赖管理器”等旧链接）必须继续能用 ——
 * 于是“它到底定位到哪一段、那一段可不可见”就成了**可验收**的事实。
 */
let lastFocus: SectionId | null = null;
/** 忙语义宿主（§7）：Output 通道 + 通知 + 忙点，全部走 `core/busy` 那一套。 */
let busyHost: BusyHost | undefined;
/** §8.1 铁律 2 的闸门（同一入口 1.5s 内只当一次）。 */
let copilotGate: EntryGate = { lastAt: 0, lastCommand: '' };
/** §8.1 铁律 3：命名每次 VS Code 会话最多试一次（成功靠 globalState 永久记账）。 */
let titleChecked = false;
let titleHintShown = false;

/**
 * host 侧的事实收集器（G18）。
 *
 * 为什么需要它：单页的事实是**懒**取的（打开面板、展开某段、动作跑完才取），而"怎么取数"
 * 只有 host 知道（健康快照 / 车道方案 / 环境契约 / 覆盖率 / 质量工具 / CI 缓存…）。
 * 所以把收集器注册进来、由单页决定时机 —— 也保证**只取一次**（不第二次取数）。
 */
let factsCollector: (() => Promise<void>) | undefined;

export function setFactsCollector(fn: () => Promise<void>): void {
  factsCollector = fn;
}

/** 刷新闸门（合并并发 + 不丢最新，纯逻辑在 `core/refreshGate.ts`）。 */
let refreshGate: RefreshGate = IDLE_GATE;

/** 请求一次事实刷新（懒加载入口都走它）。 */
export function requestFacts(): void {
  if (!factsCollector) {
    return;
  }
  const begin = beginRefresh(refreshGate);
  refreshGate = begin.next;
  if (!begin.start) {
    return;
  }
  const run = factsCollector;
  void (async () => {
    try {
      await run();
    } catch {
      /* host 自己记账；这里只负责闸门与不丢请求 */
    } finally {
      const end = endRefresh(refreshGate);
      refreshGate = end.next;
      if (end.rerun) {
        requestFacts();
      }
    }
  })();
}

function readFolded(): SectionId[] {
  return normalizeFolded(cockpitContext?.globalState.get('het.cockpit.folded'));
}

/** host 侧事实增量喂给单页（由 extension.ts 在数据变化时调用）。 */
export function setSinglePageFacts(patch: Partial<SinglePageFacts>): void {
  singlePageFacts = { ...singlePageFacts, ...patch };
  if (cockpitPanel) {
    postSinglePage();
  }
}

export function getSinglePageFacts(): SinglePageFacts {
  return singlePageFacts;
}

export function getCockpitState(): CockpitState {
  return cockpitState;
}

/**
 * 单页**视图状态**（可观测）：深链定位到哪一段、哪些段已加载/已折叠。
 *
 * 给集成测试与现场排查用 —— 它回答的是“用户点完那条链接后，真能看到那一段吗”：
 * 旧链接（tab id）不能静默失效（那会变成“点了没反应”）。
 */
export function getCockpitView(): { focus: SectionId | null; folded: SectionId[]; opened: SectionId[] } {
  return { focus: lastFocus, folded: [...(foldedSections ?? readFolded())], opened: [...openedSections] };
}

/**
 * 点亮/熄灭单页 L1 的忙点（§7 第 3 条）。
 *
 * 给 host 侧所有长动作用（不只是本文件的 Copilot 入口）—— 这样"忙"的呈现只有一处实现。
 */
export function notifySinglePageBusy(action: string, _on: boolean): void {
  // §F.35：忙语义的**唯一来源**是 `core/busy.ts` 的注册表 —— 这里顺手把它同步成
  // "仓库级状态"，吸顶右侧 / chip / 悬停卡都读这同一份（以前 chip 读的是
  // 上一次构建结果，于是"正在跑"被显示成"已失败"）。
  const st = currentStatus();
  const had = singlePageFacts.status ?? null;
  setSinglePageFacts({ status: st ? { action: st.action, text: st.text } : null });
  if (cockpitPanel) {
    // 卡片按钮禁用/恢复仍走这条即时消息（L1 与正文由 postSinglePage 局部刷新）
    void cockpitPanel.webview.postMessage({ type: 'busy', on: st !== null, action });
    postSinglePage();
  }
  // §F.36：**动作跑完 = 仓库事实变了**，不管用户是从哪个入口点的（单页按钮 / 悬停链接 /
  // 命令面板），都在这里统一补一次取数 —— 否则卡片上的数字要等下一次交互才动，
  // 实测反馈里就是"构建/测试/覆盖率不刷新，只有体检刷新"（体检本来就走面板入口）。
  if (had && !st) {
    requestFacts();
  }
}

function singlePageModel(): SinglePageModel {
  return singlePageModelFrom(cockpitState, singlePageFacts, foldedSections ?? readFolded());
}

/** 局部刷新：L1 + 已展开过的段的正文（§6/§13：页面只生成一次）。 */
function postSinglePage(): void {
  if (!cockpitPanel) {
    return;
  }
  const model = singlePageModel();
  const grouped = cardsBySection(model);
  void cockpitPanel.webview.postMessage({ type: 'l1', html: l1HtmlOf(model) });
  for (const def of SECTIONS) {
    if (!openedSections.has(def.id)) {
      continue;
    }
    void cockpitPanel.webview.postMessage({
      type: 'section',
      id: def.id,
      html: bodyOf(def.id, grouped),
    });
  }
}

function l1HtmlOf(model: SinglePageModel): string {
  // 复用 shell 的渲染，避免第二份实现（§5 单点维护）
  const body = cockpitSinglePageBody(model);
  const m = /<header class="l1" data-l1>([\s\S]*?)<\/header>/.exec(body);
  return m ? m[1] : '';
}

function bodyOf(section: SectionId, grouped: ReturnType<typeof cardsBySection>): string {
  const html = cockpitSinglePageBody({ ...singlePageModel(), cards: grouped[section] });
  const m = new RegExp(`<div class="sec-body" data-sec-body="${section}"[^>]*>([\\s\\S]*?)<\\/div>\\s*<\\/section>`).exec(html);
  return m ? m[1] : '';
}

/** 忙语义宿主（§7）：单一实现，避免每个功能各写一套"转圈 + 输出"。 */
function host(): BusyHost {
  if (!busyHost) {
    busyHost = createBusyHost({
      notifyBusy: (action, on) => {
        notifySinglePageBusy(action, on);
      },
      notifyDone: (action, ok, message) => {
        // chat 类动作成功时不再弹提示：Chat 面板本身就打开了，那是反馈（别"通知叠通知"）
        if (ok && channelDef(action)?.kind === 'chat') {
          return;
        }
        if (ok) {
          void vscode.window.showInformationMessage(message);
        } else {
          void vscode.window.showWarningMessage(`${message}｜下一步：${nextStepHint(action)}`);
        }
      },
      register: (d) => cockpitContext?.subscriptions.push(d),
    });
  }
  return busyHost;
}

/**
 * 打开（或聚焦）Copilot Chat 并预填命令。
 *
 * §8.1 铁律 1：只允许 `workbench.action.chat.open` —— 第二次点击只是"把输入框内容换成新命令"，
 * **不会**多出一个会话。
 *
 * @returns 需要人工粘贴（自动打开不可用 → 已写进剪贴板）时为 `true`。
 */
async function openCopilotChat(query: string): Promise<boolean> {
  assertAllowedChatCommand(CHAT_OPEN_COMMAND);
  try {
    await vscode.commands.executeCommand(CHAT_OPEN_COMMAND, chatOpenArgs(query));
    return false;
  } catch {
    /* 降到老签名：直接给字符串 */
  }
  try {
    await vscode.commands.executeCommand(CHAT_OPEN_COMMAND, query);
    return false;
  } catch {
    /* 连命令都没有 → 退化为剪贴板（不放弃：用户照着手动执行即可） */
  }
  await vscode.env.clipboard.writeText(query);
  return true;
}

/**
 * 命名降级链第 1 条（§8.1 铁律 3）：能改名就**只改一次**。
 *
 * 两个改名命令的参数形状未实测（本机没装 Copilot）→ 先 `getCommands()` 探测、再 `try/catch` 逐个试；
 * 都不行就退回"标记（降级链第 2 条）+ 手册里的人工步骤（第 3 条）"。
 */
async function ensureSessionTitle(): Promise<{ ok: boolean; via: string }> {
  if (titleChecked) {
    return { ok: false, via: '本次会话已尝试过' };
  }
  titleChecked = true;
  if (vscode.workspace.getConfiguration('het.copilot').get<boolean>('renameSession', true) !== true) {
    return { ok: false, via: '设置 het.copilot.renameSession 已关闭' };
  }
  const done = cockpitContext?.globalState.get<string>(TITLED_STATE_KEY);
  if (done && done.startsWith('ok:')) {
    return { ok: true, via: done.slice(3) };
  }
  const available = await vscode.commands.getCommands(true);
  const order = renameAttemptOrder(available);
  for (const id of order) {
    try {
      await vscode.commands.executeCommand(id, COPILOT_SESSION_TITLE);
      void cockpitContext?.globalState.update(TITLED_STATE_KEY, `ok:${id}`);
      return { ok: true, via: id };
    } catch {
      /* 试下一个候选 */
    }
  }
  return {
    ok: false,
    via: order.length > 0 ? `已尝试但失败（参数形状未实测）：${order.join(' / ')}` : '本机没有声明改名命令',
  };
}

/** Copilot 入口（§8 Phase 1）：打开会话 → 预填 → 回执到卡片 → 记账（不解析 Copilot 结果）。 */
async function runCopilotEntry(command: string): Promise<void> {
  const def = copilotEntryFor(command);
  if (!def) {
    void vscode.window.showWarningMessage(`未登记的 Copilot 入口：${command}`);
    return;
  }
  const now = Date.now();
  const gate = shouldHandleEntry(copilotGate, command, now);
  if (!gate.handle) {
    host().outputChannel(COPILOT_CHANNEL)?.appendLine(
      `[${new Date(now).toLocaleTimeString()}] ⊘ ${command} 已忽略：${gate.reason}（§8.1 铁律 2）`,
    );
    return;
  }
  copilotGate = gate.next;
  const query = prefillText(def);
  const res = await runWithBusy(
    host(),
    def.action,
    () => openCopilotChat(query),
    `预填 ${command}（复用当前会话，不新建）`,
  );
  if (res.status === 'skipped') {
    return;
  }
  const copied = res.status === 'done' && res.out === true;
  const opened = res.status === 'done' && res.out === false;
  const title = opened ? await ensureSessionTitle() : { ok: false, via: 'Chat 未打开' };
  const at = new Date().toLocaleTimeString();
  setSinglePageFacts({
    copilot: { card: def.card, ok: opened, at, command: def.command },
  });
  if (cockpitPanel) {
    void cockpitPanel.webview.postMessage({ type: 'copilotResult', card: def.card, ok: opened });
  }
  const ch = host().outputChannel(COPILOT_CHANNEL);
  ch?.appendLine(`[${at}] 单会话：只聚焦/预填当前会话，未执行任何"新建会话"命令（§8.1 铁律 1）`);
  ch?.appendLine(
    `[${at}] 会话命名：${title.ok ? `已设为「${COPILOT_SESSION_TITLE}」（${title.via}）` : `未自动命名（${title.via}）→ 标记 ${COPILOT_PROMPT_MARKER} 兜底`}`,
  );
  if (copied) {
    void vscode.window.showInformationMessage(
      `没能自动打开 Copilot Chat，已把 ${command} 复制到剪贴板：粘贴进去执行即可。`,
    );
  } else if (opened && !title.ok && !titleHintShown) {
    titleHintShown = true;
    void vscode.window.showInformationMessage(
      `已在 Copilot Chat 预填 ${command}。若会话标题不是「${COPILOT_SESSION_TITLE}」：右键该会话 → 重命名，或命令面板搜"重命名会话"。`,
    );
  }
}

/** 把一个深链目标（旧 tab id 或段 id）解析成段 id —— 旧链接继续可用。 */
function resolveFocus(focus?: string): SectionId | undefined {
  if (!focus) {
    return undefined;
  }
  if (SECTIONS.some((s) => s.id === focus)) {
    return focus as SectionId;
  }
  return sectionForTab(focus);
}

/** 把某段标成"展开"（深链用；不动用户其它的折叠选择）。 */
function unfold(section: SectionId): void {
  const cur = new Set(foldedSections ?? readFolded());
  if (!cur.has(section)) {
    return;
  }
  cur.delete(section);
  foldedSections = [...cur];
  void cockpitContext?.globalState.update('het.cockpit.folded', foldedSections);
}

/**
 * host 侧事件（构建/测试/体检/模板）→ 更新 L1，并让卡片跟着刷新。
 *
 * 旧 UI 的抽屉/日志区域已归档，所以这里只做两件事：折叠状态与事实。
 */
export function emitCockpitEvent(event: CockpitEvent): void {
  cockpitState = reduceCockpit(cockpitState, event);
  postSinglePage();
  if (
    event.type === 'log:done' ||
    event.type === 'issue:summary' ||
    event.type === 'project' ||
    event.type === 'health' ||
    event.type === 'template:update'
  ) {
    // 数字要跟得上刚发生的事（走闸门：不并发、不丢最新）
    requestFacts();
  }
}

import { isSlotMessage, slotFieldOf } from '../slots/protocol';
import { requestSlotClose, routeSlotMessage } from '../slots/registry';

export function openCockpitPanel(context: vscode.ExtensionContext, focus?: string): vscode.WebviewPanel {
  const target = resolveFocus(focus);
  if (target) {
    lastFocus = target;
  }
  if (cockpitPanel) {
    cockpitPanel.reveal(vscode.ViewColumn.One);
    if (target) {
      unfold(target);
      openedSections.add(target);
      postSinglePage();
    }
    return cockpitPanel;
  }
  cockpitContext = context;
  cockpitPanel = vscode.window.createWebviewPanel(
    'het.cockpit',
    'HeT DevTools 仪表盘',
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [context.extensionUri] },
  );
  cockpitPanel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');

  foldedSections = readFolded();
  openedSections.clear();
  cockpitPanel.webview.html = cockpitSinglePageHtml(singlePageModel());

  // 段 1 默认展开（E 块后是「环境车道」；其余段等用户展开，§13 懒加载）；深链目标也直接展开。
  openedSections.add('env');
  if (target) {
    unfold(target);
    openedSections.add(target);
  }
  postSinglePage();
  // 事实懒加载：打开面板才取（同一个收集器，不第二次取数）
  requestFacts();

  cockpitPanel.webview.onDidReceiveMessage(
    (message: { type: string; section?: string; id?: string; expand?: boolean; command?: string; action?: string; copilot?: string }) => {
      // A 块：页内 Slot 的消息先按 `__slot` 路由回对应视图（驾驶舱不拆开看内容）
      if (isSlotMessage(message)) {
        const slotId = slotFieldOf(message);
        if (slotId) {
          routeSlotMessage(slotId, message as Record<string, unknown>);
        }
        return;
      }
      if (message.type === 'action' && message.action) {
        const cmd = commandForAction(message.action);
        if (cmd) {
          // 动作跑完再刷事实（成功/失败都刷，卡片上的数字要跟得上）
          void vscode.commands.executeCommand(cmd).then(
            () => requestFacts(),
            () => requestFacts(),
          );
        }
      } else if (message.type === 'nav' && message.id) {
        // J 块：导航动作（如 L1 忙点 → 任务中心）。与 action 的区别只有一条：
        // 导航**不会**产生"在跑"的语义，所以页面不改按钮文字、这里也不刷事实。
        const cmd = commandForAction(message.id);
        if (cmd) {
          void vscode.commands.executeCommand(cmd);
        }
      } else if (message.type === 'copilot' && message.command) {
        void runCopilotEntry(message.command);
      } else if (message.type === 'section:open' && message.id) {
        openedSections.add(message.id as SectionId);
        postSinglePage();
        requestFacts();
      } else if (message.type === 'slot:close') {
        // 页内 Slot 的“关闭”按钮：请宿主真正撤销接线（否则旧处理器会继续收消息）。
        // 这里用字面量而不是常量：跨层协议门禁靠“字面量 ↔ 字面量”对账（F.46）。
        requestSlotClose();
      } else if (message.type === 'folded' && message.id) {
        const id = message.id as SectionId;
        const cur = new Set(foldedSections ?? readFolded());
        if (message.expand === true) {
          cur.delete(id);
        } else {
          cur.add(id);
        }
        foldedSections = [...cur];
        void cockpitContext?.globalState.update('het.cockpit.folded', foldedSections);
      }
    },
  );

  cockpitPanel.onDidDispose(() => {
    cockpitPanel = undefined;
  });

  return cockpitPanel;
}

/** 往驾驶舱发一条消息（Slot 宿主用；驾驶舱没开时返 false，不抛）。 */
export function postToCockpit(message: unknown): Thenable<boolean> {
  return cockpitPanel ? cockpitPanel.webview.postMessage(message) : Promise.resolve(false);
}

/** 驾驶舱的 webview 句柄（Slot 宿主需要 `asWebviewUri` 等能力时用）。 */
export function cockpitWebview(): vscode.Webview | undefined {
  return cockpitPanel?.webview;
}
