/**
 * 输出通道与**结构化日志标签**（计划 §7 / §6-D）。
 *
 * 纯数据，**不 import vscode** —— 真正的 channel 由 host 侧按名字创建（`features/busyHost.ts`）。
 *
 * ## D 块：只留 1 个通道（C4 的原话：“你搞那么多分项 output 是刷存在感吗”）
 *
 * 以前每个域一个通道（`HeT DevTools · 构建` / `· 环境` / `· 文档` / `· 上板` / `· Copilot`），
 * 于是 Output 下拉里一排名字，用户得先“选对频道”才看得到日志 —— 而且同一次构建的日志还可能
 * 被拆到两个通道里。现在**只有一个** `HeT DevTools`，域的区分回到**行首标签**：
 *
 *     [10:31:02] [build] ▶ 编译打包
 *     [10:31:19] [build] ✓ 编译打包完成（17.4s）
 *     [10:31:20] [env]   · 缓存 12.4 GB
 *
 * 这条规矩可机器检：通道名只有一个常量；每行必须带已知域标签（门禁跑 `parseLogLine`）。
 */
export type ChannelKind = 'output' | 'terminal' | 'chat';

/** **唯一**的 Output 通道名（§5.3：品牌名只允许出现在唯一页签标题与这个通道名上）。 */
export const OUTPUT_CHANNEL_NAME = 'HeT DevTools';

/** 行首域的定稿名单（与 §5.1 的 rail 领域对应 + 少数工程域；新增要在此登记）。 */
export const LOG_DOMAINS = [
  'build',
  'test',
  'docs',
  'env',
  'quality',
  'release',
  'chat',
  'task',
  'cache',
  'target',
  'bench',
  'init',
  'template',
  'audit',
  'patent',
  'ui',
  'tools',
  'conda',
  'lane',
  'settings',
  'conan',
  'cmake',
  'wizard',
  'dump',
  'perf',
  'telemetry',
] as const;

export type LogDomain = (typeof LOG_DOMAINS)[number];

/** 注入式 logger 的形状（各模块的 `log:` 选项都用它，别再造 `(line: string) => void`）。 */
export type LogFn = (domain: LogDomain, message: string) => void;

/** 级别 → 行首符号（与 §7 的 6 态一致：`▶` 开始、`✓` 成功、`✗` 失败、`⌛` 超时、`⊘` 取消）。 */
export const LOG_LEVELS = ['step', 'ok', 'fail', 'warn', 'timeout', 'cancel', 'info'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_GLYPH: Readonly<Record<LogLevel, string>> = {
  step: '▶',
  ok: '✓',
  fail: '✗',
  warn: '!',
  timeout: '⌛',
  cancel: '⊘',
  info: '·',
};

/** 结构化日志条目（通道行与页内“输出”视图的**同一份**数据）。 */
export interface LogEntry {
  /** 毫秒时间戳。 */
  at: number;
  domain: LogDomain;
  level: LogLevel;
  text: string;
}

/** `HH:MM:SS`（按本地时间；输出面板的日期由 VS Code 自己给）。 */
function hhmmss(at: number): string {
  const d = new Date(at);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 条目 → 一行（**唯一**的行格式；谁都不要自己拼字符串）。 */
export function formatLogLine(entry: LogEntry): string {
  return `[${hhmmss(entry.at)}] [${entry.domain}] ${LEVEL_GLYPH[entry.level]} ${entry.text}`.trimEnd();
}

/** 行 → 条目（解析失败返回 `null`：门禁靠它确认“每行都带已知域标签”）。 */
export function parseLogLine(line: string): LogEntry | null {
  const m = /^\[(\d{2}):(\d{2}):(\d{2})\] \[([a-z]+)\] ([^\s]) ?(.*)$/u.exec(line.trim());
  if (!m) {
    return null;
  }
  const domain = m[4] as LogDomain;
  if (!(LOG_DOMAINS as readonly string[]).includes(domain)) {
    return null;
  }
  const glyph = m[5];
  const level = (Object.keys(LEVEL_GLYPH) as LogLevel[]).find((l) => LEVEL_GLYPH[l] === glyph);
  if (!level) {
    return null;
  }
  const d = new Date();
  d.setHours(Number(m[1]), Number(m[2]), Number(m[3]), 0);
  return { at: d.getTime(), domain, level, text: m[6] };
}

export interface ChannelDef {
  kind: ChannelKind;
  /** L1/按钮上显示的动作名（中文短语，≤6 字）。 */
  label: string;
}

/** 与 §7 表一一对应的动作清单（新增长动作必须在此登记，否则门禁失败）。 */
export const BUSY_ACTIONS = [
  'build',
  'test',
  'clean',
  'envCheck',
  'envPrepare',
  'envRemove',
  'wslImport',
  'docsBuild',
  'quality',
  'commitCopilot',
  'docsCopilot',
  'testgenCopilot',
  'moduleCopilot',
  'setupCopilot',
  'board',
  'cacheClean',
  'targetSwitch',
] as const;

export type BusyAction = (typeof BUSY_ACTIONS)[number];

export const CHANNELS: Readonly<Record<BusyAction, ChannelDef>> = {
  build: { kind: 'output', label: '构建' },
  test: { kind: 'output', label: '构建并测试' },
  clean: { kind: 'output', label: '干净构建' },
  envCheck: { kind: 'output', label: '检查环境' },
  envPrepare: { kind: 'output', label: '准备托管环境' },
  envRemove: { kind: 'output', label: '移除托管环境' },
  wslImport: { kind: 'output', label: '拉取发行版' },
  docsBuild: { kind: 'output', label: '编译文档' },
  quality: { kind: 'terminal', label: '质量门禁' },
  commitCopilot: { kind: 'chat', label: '生成提交' },
  docsCopilot: { kind: 'chat', label: '补文档注释' },
  testgenCopilot: { kind: 'chat', label: '生成测试' },
  moduleCopilot: { kind: 'chat', label: '新增模块' },
  setupCopilot: { kind: 'chat', label: '环境答疑' },
  board: { kind: 'output', label: '采集并解析' },
  cacheClean: { kind: 'output', label: '清理缓存' },
  targetSwitch: { kind: 'output', label: '切换目标' },
};

export function isBusyAction(value: string): value is BusyAction {
  return (BUSY_ACTIONS as readonly string[]).includes(value);
}

export function channelDef(action: string): ChannelDef | undefined {
  return isBusyAction(action) ? CHANNELS[action] : undefined;
}

/** 需要创建的 Output 通道名（去重；不包含 terminal/chat）。 */
export function outputChannelNames(): string[] {
  // D 块：**只有一个**通道（域的区分回到行首标签，见上面的说明）
  return [OUTPUT_CHANNEL_NAME];
}

/** 给"失败要给出下一步"用的默认提示（§7 第 5 条）。 */
export function nextStepHint(action: string): string {
  switch (action) {
    case 'build':
    case 'test':
    case 'clean':
      return '可看输出通道的完整 tail，或执行 `/het-build` 让 Copilot 陪你排错。';
    case 'envPrepare':
    case 'envCheck':
      return '缺系统包时会给出可复制的 apt 命令；也可以 `/het-setup` 让 Copilot 讲清楚要先装什么。';
    case 'wslImport':
      return '可换源重试（配置 › 网络与源），或手动下载 rootfs 后指定本地路径。';
    case 'docsBuild':
      return '若要补源码注释，用「文档注释补全（Copilot）」，再回来编译。';
    case 'quality':
      return '若提示某工具未安装，按面板里的"谁装、怎么装"处理；`--fix` 类命令可在终端里自己跑。';
    case 'commitCopilot':
      return '若 Chat 没打开：在 Copilot Chat 里执行 `/het-commit`；不想用 Copilot 就走「手动提交」。';
    case 'docsCopilot':
      return '若 Chat 没打开：在 Copilot Chat 里执行 `/het-docs`；只想本地出 HTML 用「文档编译」。';
    case 'testgenCopilot':
      return '若 Chat 没打开：在 Copilot Chat 里执行 `/het-testgen`（可选从代码 / 从蓝图）。';
    case 'moduleCopilot':
      return '若 Chat 没打开：在 Copilot Chat 里执行 `/het-module`；只想先出骨架（不含 PRD/测试）可用「单模块微调（向导）」。';
    case 'setupCopilot':
      return '若 Chat 没打开：在 Copilot Chat 里执行 `/het-setup`；完整自检日志在「环境」输出通道。';
    default:
      return '可重试；若反复失败，请在输出通道复制完整日志。';
  }
}
