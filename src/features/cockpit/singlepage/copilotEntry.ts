/**
 * Copilot 斜杠命令入口族（计划 §8 / §8.1）—— **纯数据 + 纯函数**，不 import vscode。
 *
 * 为什么单独一个文件：单页里的「补注释 / 生成测试 / 生成提交 / 环境答疑」四个按钮都走同一个
 * 入口，"打开哪个会话、预填什么、点几次算一次、会话叫什么名"这些规则必须**单点维护**，
 * 否则很容易退化成"点 N 次开 N 个 session"（用户第二轮第 1 条的硬约束）。
 *
 * 三条铁律（§8.1）：
 * 1. **永不新建会话** —— 只允许 `workbench.action.chat.open`，禁止一切"新建聊天/会话"命令；
 * 2. **点 N 次只有一次动作** —— 同一入口 1.5s 内的重复点击直接忽略（宿主侧闸门）；
 * 3. **命名只做一次** —— 成功/失败都记账，同一次 VS Code 会话内不反复尝试。
 */

/** 会话标题（§8.1：用户要求以它命名）。 */
export const COPILOT_SESSION_TITLE = 'HeT DevTools Agent';

/**
 * 可见标记（降级链第 2 条）。
 *
 * **有意修正**：计划原写"每条预填命令都以它开头"，但 VS Code 只在输入框**开头**识别斜杠命令
 * —— 把标记放最前会让 `/het-*` 变成普通文本（命令直接失效）。所以标记放在命令**之后**（独立一行）：
 * 命令照常生效，会话内容里也留得下可检索的标记；标题仍优先靠改名命令（降级链第 1 条）。
 */
export const COPILOT_PROMPT_MARKER = '【HeT DevTools Agent】';

/** Copilot 入口的记账通道名（与 `core/outputChannels.ts` 的 chat 类动作一致）。 */
export const COPILOT_CHANNEL = 'HeT DevTools · Copilot';

/** 同一入口的重复点击窗口（§8.1 铁律 2）。 */
export const COPILOT_DEDUPE_MS = 1500;

/** 唯一允许执行的"打开 Chat"命令（§8.1 铁律 1）。 */
export const CHAT_OPEN_COMMAND = 'workbench.action.chat.open';

/**
 * 明令禁止的命令前缀/全名 —— 出现任何一个都意味着"可能新建会话"。
 *
 * 注意：这里是**黑名单声明处**，本文件之外（controller/extension）不得出现这些字符串（有门禁扫描）。
 */
export const FORBIDDEN_CHAT_COMMANDS: readonly string[] = [
  'github.copilot.cli.newSession',
  'github.copilot.cli.newSessionToSide',
  'github.copilot.cli.newSessionSidebar',
  'workbench.action.chat.openNewSessionSidebar',
  'workbench.action.chat.newChat',
  'workbench.action.chat.newSession',
  'workbench.action.chat.newSessionSidebar',
];

/**
 * 改名候选（优先级从高到低）。
 *
 * 参数形状**未实测**（本机没装 Copilot 扩展）→ 调用方必须：先 `getCommands()` 探测存在性，
 * 再 `try/catch` 逐个尝试并记账（§8.1 降级链）。两个都不行就退化为"标记 + 手册里的人工步骤"。
 */
export const RENAME_COMMANDS: readonly string[] = [
  'github.copilot.cli.sessions.setTitle',
  'github.copilot.cli.sessions.rename',
];

export interface CopilotEntryDef {
  /** 斜杠命令（必须在最前，否则 VS Code 不认）。 */
  command: string;
  /** 忙语义/输出通道的动作 id（必须已在 `core/outputChannels.ts` 登记）。 */
  action: string;
  /** 卡片 id（必须已在 `singlepage/sections.ts` 登记）。 */
  card: string;
  /** 卡片上的"预期产物"（§8 Phase 1：不能让用户猜）。 */
  expect: string;
  /** 预填附言（跟在命令后面的上下文提示）。 */
  hint: string;
}

/** 入口表（§8 表格里"我们要做的 UI"那一列；§F.44 起模块走 `/het-module`）。 */
export const COPILOT_ENTRIES: readonly CopilotEntryDef[] = [
  {
    command: '/het-commit',
    action: 'commitCopilot',
    card: 'commit',
    expect: '预期：拆分提交预览（不 push）',
    hint: '先把当前改动拆成几个规范的提交，给我逐条预览，**不要 push**。',
  },
  {
    command: '/het-docs',
    action: 'docsCopilot',
    card: 'docsAuthoring',
    expect: '预期：Doxygen 注释补全',
    hint: '给这次改动涉及的源码补 Doxygen 注释；只做注释，不顺手改行为。',
  },
  {
    command: '/het-testgen',
    action: 'testgenCopilot',
    card: 'testgen',
    expect: '预期：GTest 骨架（从代码 / 从蓝图）',
    hint: '先问我用「从代码」还是「从蓝图」，再生成 GTest 骨架。',
  },
  {
    command: '/het-module',
    action: 'moduleCopilot',
    card: 'moduleAgent',
    expect: '预期：PRD → 接口设计 → 骨架计划 → diff 预览',
    hint: '我要给这个库加模块：先跟我把 PRD/接口定下来（配对命名、ImportStart/End、双语注释），给出 include/ + src/ 的骨架计划与 diff 预览，**我确认后再写盘**，并告诉我该补哪些 GTest。',
  },
  {
    command: '/het-setup',
    action: 'setupCopilot',
    card: 'env',
    expect: '预期：环境诊断 + 安装清单',
    hint: '按当前环境自检结果讲清缺什么、谁装、怎么装；需要 root 的给可复制命令，别静默改我的系统。',
  },
];

export function copilotEntryFor(command: string): CopilotEntryDef | undefined {
  return COPILOT_ENTRIES.find((e) => e.command === command);
}

export function copilotEntryForCard(card: string): CopilotEntryDef | undefined {
  return COPILOT_ENTRIES.find((e) => e.card === card);
}

/**
 * 预填正文：**命令在最前**（否则斜杠命令不生效），标记在末尾独立一行（可检索）。
 */
export function prefillText(def: CopilotEntryDef): string {
  const head = def.hint ? `${def.command} ${def.hint}` : def.command;
  return `${head}\n\n${COPILOT_PROMPT_MARKER}`;
}

/** `workbench.action.chat.open` 的预填参数（`isPartialQuery: true` = 只填不发，用户可先看）。 */
export function chatOpenArgs(query: string): { query: string; isPartialQuery: boolean } {
  return { query, isPartialQuery: true };
}

export interface EntryGate {
  lastAt: number;
  lastCommand: string;
}

export interface GateDecision {
  handle: boolean;
  next: EntryGate;
  /** `handle === false` 的原因（记账用）。 */
  reason?: string;
}

/**
 * 宿主侧闸门（§8.1 铁律 2）：**同一个入口**在 `windowMs` 内的重复点击直接忽略。
 *
 * 不同入口不算重复（那只是"把输入框内容换成另一条命令"，仍然是同一个会话）。
 */
export function shouldHandleEntry(
  gate: EntryGate,
  command: string,
  now: number,
  windowMs: number = COPILOT_DEDUPE_MS,
): GateDecision {
  const same = gate.lastCommand === command;
  const within = same && now >= gate.lastAt && now - gate.lastAt < windowMs;
  if (within) {
    return { handle: false, next: gate, reason: `同一入口在 ${windowMs}ms 内重复点击` };
  }
  return { handle: true, next: { lastAt: now, lastCommand: command } };
}

/** 按优先级挑出"本机真的存在"的改名命令（不存在的不调用 —— 别赌）。 */
export function renameAttemptOrder(available: Iterable<string>): string[] {
  const set = new Set(available);
  return RENAME_COMMANDS.filter((id) => set.has(id));
}

/** 铁律 1 的守卫：除 `CHAT_OPEN_COMMAND` 之外的 chat 命令一律不许执行。 */
export function assertAllowedChatCommand(id: string): void {
  if (FORBIDDEN_CHAT_COMMANDS.includes(id)) {
    throw new Error(`禁止执行"新建会话"类命令（§8.1 铁律 1）：${id}`);
  }
  if (id !== CHAT_OPEN_COMMAND) {
    throw new Error(`Copilot 入口只允许执行 ${CHAT_OPEN_COMMAND}（§8.1 铁律 1），收到：${id}`);
  }
}

/** 改名成功/尝试过的记账键（globalState）。 */
export const TITLED_STATE_KEY = 'het.copilot.titled';
