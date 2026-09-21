/**
 * **仓库级语义状态**（2026-09-20 定案）：扩展"此刻正在忙什么"只有这一个来源。
 *
 * 为什么单独成模块：实测反馈里"构建时 chip 飘红"的根因不是样式，而是**没有单一状态源** ——
 * 忙语义（`core/busy.ts` 的注册表）只往 webview 发了个"忙点开关"，状态栏 chip 与悬停卡读的
 * 仍是"上一次构建结果"（失败），于是"正在跑"被显示成"已失败"（不可逆的观感）。
 *
 * 规矩：
 *   · 状态文字只说**现在**（进行中/检查中…），历史结果留在各自的单元格里；
 *   · 同一时刻多件事在跑 → 取**最早开始**的那件（用户先看到它在动）；
 *   · 吸顶右侧、状态栏 chip、HUD、悬停卡都读这一份，谁都不许自己造一个"忙"。
 *
 * 纯函数（不 import vscode），可直接单测。
 */
import { CHANNELS, type BusyAction } from './outputChannels';

/** 动作 id → "现在正在做什么"的人话（比 `CHANNELS[].label` 更像进行时）。 */
const STATUS_TEXT: Readonly<Record<string, string>> = {
  build: '构建中',
  clean: '干净构建中',
  test: '测试中',
  envCheck: '检查环境',
  envPrepare: '准备环境',
  envRemove: '移除环境',
  wslImport: '拉取发行版',
  docsBuild: '编译文档',
  quality: '质量门禁',
  board: '上板采集',
  commitCopilot: '生成提交',
  docsCopilot: '补文档注释',
  testgenCopilot: '生成测试',
  setupCopilot: '环境答疑',
};

/** 忙语义落在哪个**域**：悬停卡用它把"上一次结果"换成"进行中"（表意准确）。 */
export type StatusDomain = 'build' | 'test' | 'docs' | 'env';

const STATUS_DOMAIN: Readonly<Record<string, StatusDomain>> = {
  build: 'build',
  clean: 'build',
  test: 'test',
  docsBuild: 'docs',
  docsCopilot: 'docs',
  envCheck: 'env',
  envPrepare: 'env',
  envRemove: 'env',
  wslImport: 'env',
};

export interface ActiveStatus {
  action: string;
  /** 进行时人话（"构建中"）。 */
  text: string;
  startedAt: number;
}

/** 动作 id → 进行时文案（未知动作退回它的 label，再退回 id 本身）。 */
export function statusText(action: string): string {
  return STATUS_TEXT[action] ?? CHANNELS[action as BusyAction]?.label ?? action;
}

/** 动作 id → 它影响的域（没有就 undefined）。 */
export function busyDomainOf(action: string | null | undefined): StatusDomain | undefined {
  return action ? STATUS_DOMAIN[action] : undefined;
}

/**
 * 从"正在跑的动作"里挑出**展示用的那一个**：最早开始的优先（先动起来的先被看到）。
 * 空数组 → null（空闲）。
 */
export function pickActiveStatus(
  entries: ReadonlyArray<{ action: string; startedAt: number }>,
): ActiveStatus | null {
  if (entries.length === 0) {
    return null;
  }
  const first = [...entries].sort((a, b) => a.startedAt - b.startedAt)[0];
  return { action: first.action, text: statusText(first.action), startedAt: first.startedAt };
}

/**
 * 状态栏 chip 的主文字。
 *
 * 忙 → **图标由调用方加**、文字是"进行中"（`HeT 构建中`）—— 明确、无歧义；
 * 空闲 → `HeT <健康分>`（原来的样子）。
 */
export function chipStatusText(status: ActiveStatus | null, score: number | null): string {
  if (status) {
    return status.text;
  }
  return score === null ? '·' : String(score);
}
