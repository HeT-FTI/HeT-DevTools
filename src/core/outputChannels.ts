/**
 * 输出通道映射（计划 §7）：每个"长耗时动作"的输出该去哪里。
 *
 * 纯数据，**不 import vscode** —— 真正的 channel 由 host 侧按名字创建（`features/busyHost.ts`）。
 *
 * 规则（§7）：
 * - 构建 / 环境 / 文档 → **Output 通道**（结构化摘要 + tail，不需要交互）；
 * - 质量门禁 → **Terminal**（用户常想复制命令自己跑）；
 * - Copilot 入口 → **Copilot Chat 面板**（命令必须由 Copilot 执行）+ Output「Copilot」记一笔"我发了什么"。
 */
export type ChannelKind = 'output' | 'terminal' | 'chat';

export interface ChannelDef {
  kind: ChannelKind;
  /** Output 通道名（kind === 'output'/'chat' 时有值；terminal 用既有终端）。 */
  channel?: string;
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
  build: { kind: 'output', channel: 'HeT DevTools · 构建', label: '构建' },
  test: { kind: 'output', channel: 'HeT DevTools · 构建', label: '构建并测试' },
  clean: { kind: 'output', channel: 'HeT DevTools · 构建', label: '干净构建' },
  envCheck: { kind: 'output', channel: 'HeT DevTools · 环境', label: '检查环境' },
  envPrepare: { kind: 'output', channel: 'HeT DevTools · 环境', label: '准备托管环境' },
  envRemove: { kind: 'output', channel: 'HeT DevTools · 环境', label: '移除托管环境' },
  wslImport: { kind: 'output', channel: 'HeT DevTools · 环境', label: '拉取发行版' },
  docsBuild: { kind: 'output', channel: 'HeT DevTools · 文档', label: '编译文档' },
  quality: { kind: 'terminal', label: '质量门禁' },
  commitCopilot: { kind: 'chat', channel: 'HeT DevTools · Copilot', label: '生成提交' },
  docsCopilot: { kind: 'chat', channel: 'HeT DevTools · Copilot', label: '补文档注释' },
  testgenCopilot: { kind: 'chat', channel: 'HeT DevTools · Copilot', label: '生成测试' },
  moduleCopilot: { kind: 'chat', channel: 'HeT DevTools · Copilot', label: '新增模块' },
  setupCopilot: { kind: 'chat', channel: 'HeT DevTools · Copilot', label: '环境答疑' },
  board: { kind: 'output', channel: 'HeT DevTools · 上板', label: '采集并解析' },
  cacheClean: { kind: 'output', channel: 'HeT DevTools · 环境', label: '清理缓存' },
  targetSwitch: { kind: 'output', channel: 'HeT DevTools · 环境', label: '切换目标' },
};

export function isBusyAction(value: string): value is BusyAction {
  return (BUSY_ACTIONS as readonly string[]).includes(value);
}

export function channelDef(action: string): ChannelDef | undefined {
  return isBusyAction(action) ? CHANNELS[action] : undefined;
}

/** 需要创建的 Output 通道名（去重；不包含 terminal/chat）。 */
export function outputChannelNames(): string[] {
  const names = new Set<string>();
  for (const a of BUSY_ACTIONS) {
    const def = CHANNELS[a];
    if (def.channel && def.kind !== 'terminal') {
      names.add(def.channel);
    }
  }
  return [...names].sort();
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
