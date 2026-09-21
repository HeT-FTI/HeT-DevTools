/**
 * **StatusItem：三档密度的单一来源**（§3.6 / C 块）。
 *
 * 现状（C 块之前）：芯片文字在 `core/status.ts` 里算，悬停表格在 `features/statusChip.ts` 里
 * 另写一套，页内卡片又由 `singlepage/*` 从 Facts 各拼一遍 —— 三处口径不一致时，症状是
 * "chip 说成功、卡片说失败"这类没法解释的观感（实测反馈里"构建时 chip 飘红"同源）。
 *
 * 这里把一个"状态项"写成**一个对象**，三档只是它的三种投影：
 *   · 紧凑（状态栏芯片）：图标 + 一句；
 *   · 极简（悬停）：每行 = 状态项（左对齐）+ ≤1 个主动作 + ≤1 个产物入口；
 *   · 完整（页内卡片）：状态 + 事实 + 下一步 + 全部动作。
 *
 * 同时把 §3.6 / G18 的**预算**写进机制：悬停最多 5 行、主动作 ≤3、导航 ≤2，超了直接抛错
 * （而不是"渲染出来才发现挤成一片"）。
 *
 * 纯逻辑（不 import vscode），可直接单测。
 */
import { statusText } from './status';

export type StatusDomain = 'env' | 'build' | 'test' | 'docs' | 'quality' | 'release';

/** 与 §5.1 rail 定稿名一一对应（悬停行名 == 页内段名 = 用户看到的同一套词）。 */
export const DOMAIN_LABEL: Readonly<Record<StatusDomain, string>> = {
  env: '环境车道',
  build: '构建验证',
  test: '构建验证',
  docs: '模块文档',
  quality: '质量安全',
  release: '交付发布',
};

/** 悬停里按这个顺序出现（与 rail 顺序一致；同一域合并成一行）。 */
export const HOVER_DOMAIN_ORDER: readonly string[] = ['环境车道', '构建验证', '模块文档', '质量安全', '交付发布'];

export type StatusState = 'unknown' | 'idle' | 'running' | 'ok' | 'fail' | 'timedOut' | 'cancelled';

export interface StatusAction {
  /** 动作 id（与 Intent/命令同名，供"悬停动作 ⊆ 页内意图"门禁对账）。 */
  id: string;
  label: string;
  command: string;
  arg?: string;
}

export interface StatusItem {
  id: string;
  domain: StatusDomain;
  state: StatusState;
  /** 一句结论（三档同源；不许某一档自己改写文案）。 */
  text: string;
  /** 补充一行（如"缓存 12.4 GB · 3 个架构"），悬停里跟在结论后。 */
  detail?: string;
  /** 结果入口（悬停每行最多 1 个）。 */
  artifact?: StatusAction;
  /** 主动作（**只在悬停的快捷操作区**出现，每行不出按钮 —— §6-C 的既定纪律）。 */
  action?: StatusAction;
  updatedAt?: number;
}

export const HOVER_LIMITS = {
  rows: 5,
  primaryActions: 3,
  nav: 2,
} as const;

export class StatusItemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StatusItemError';
  }
}

const STATE_ICON: Readonly<Record<StatusState, string>> = {
  unknown: '$(circle-outline)',
  idle: '$(circle-outline)',
  running: '$(sync~spin)',
  ok: '$(pass)',
  fail: '$(error)',
  timedOut: '$(clock)',
  cancelled: '$(circle-slash)',
};

export function stateIcon(state: StatusState): string {
  return STATE_ICON[state];
}

/** 在跑的状态项（悬停里用它把该行换成"进行中"）。 */
export function runningItem(items: readonly StatusItem[]): StatusItem | undefined {
  const running = items.filter((it) => it.state === 'running');
  return running.find((it) => it.domain !== 'env') ?? running[0];
}

/**
 * **抢芯片**的进行中项：环境检查不算（它是秒级动作，抢了会让芯片一闪一闪）。
 * 与 `runningItem` 分开是有意的：悬停里 env 行照样要显示"进行中"，但芯片不被它抢。
 */
export function chipBusyItem(items: readonly StatusItem[]): StatusItem | undefined {
  return items.find((it) => it.state === 'running' && it.domain !== 'env');
}

/**
 * 紧凑档：状态栏芯片文字。忙 → `⟳ HeT 构建中`（进行时口径来自 `core/status.ts`，单一来源）；
 * 空闲 → `HeT <健康分>`。
 */
export function chipTextOf(items: readonly StatusItem[], health: number | null): string {
  const busy = chipBusyItem(items);
  if (busy) {
    return `$(sync~spin) HeT ${statusText(busy.id)}`;
  }
  return `$(pulse) HeT ${health === null ? '·' : health}`;
}

export interface HoverAction extends StatusAction {
  /** 主动作（快捷操作区）/ 导航（打开某个界面）。 */
  kind: 'primary' | 'nav';
}

export interface HoverProjection {
  /** 每行 = `[行名, 内容]`（内容已含图标与入口链接）。 */
  rows: Array<[string, string]>;
  /** 快捷操作（≤3）。 */
  actions: HoverAction[];
  /** 导航（≤2）。 */
  nav: HoverAction[];
}

/**
 * 极简档投影。**同时执行预算检查**：行数/主动作/导航超限直接抛错 ——
 * "挤成一片"要在开发期红，而不是等用户看晕。
 */
export function hoverProjection(
  items: readonly StatusItem[],
  opts: { actions: readonly HoverAction[]; nav: readonly HoverAction[] },
): HoverProjection {
  const knownDomains = new Set(HOVER_DOMAIN_ORDER);
  for (const it of items) {
    const label = DOMAIN_LABEL[it.domain];
    if (!knownDomains.has(label)) {
      // 静默丢掉 = 某个状态项永远不会出现在悬停里（比报错难查得多）
      throw new StatusItemError(`状态项 ${it.id} 的域「${label}」不在 rail 名单里（${HOVER_DOMAIN_ORDER.join(' / ')}）`);
    }
  }
  const rows: Array<[string, string]> = [];
  for (const domain of HOVER_DOMAIN_ORDER) {
    const inDomain = items.filter((it) => DOMAIN_LABEL[it.domain] === domain);
    if (inDomain.length === 0) {
      continue;
    }
    // 同一域多个状态项合成一行：进行中的优先，其余按传入顺序
    const ordered = [...inDomain].sort((a, b) => (a.state === 'running' ? -1 : b.state === 'running' ? 1 : 0));
    const cells = ordered.map((it) => {
      const parts = [`${stateIcon(it.state)} ${it.text}`];
      if (it.detail) {
        parts.push(it.detail);
      }
      if (it.artifact) {
        parts.push(linkify(it.artifact.label, it.artifact.command, it.artifact.arg));
      }
      return parts.join(' · ');
    });
    rows.push([domain, cells.join('　|　')]);
  }
  const actions = opts.actions.filter((a) => a.kind === 'primary');
  const nav = opts.nav.filter((a) => a.kind === 'nav');
  // 行数上限是**结构性**保证：每个域都映射到 rail 的 5 个名字之一（上面已经断言过），
  // 所以 rows ≤ HOVER_LIMITS.rows 不可能被破 —— 这里不做"永远不会触发的检查"。
  // 真正容易失控的是**动作数量**，下面两条预算是必须的：
  if (actions.length > HOVER_LIMITS.primaryActions) {
    throw new StatusItemError(`悬停主动作 ${actions.length} 个，超过上限 ${HOVER_LIMITS.primaryActions}（必须挑最重要的）`);
  }
  if (nav.length > HOVER_LIMITS.nav) {
    throw new StatusItemError(`悬停导航 ${nav.length} 个，超过上限 ${HOVER_LIMITS.nav}`);
  }
  // 每行最多 1 个主动作 + 1 个产物：状态项本身已经限制了（各最多一个字段）
  for (const it of items) {
    if (it.action && it.artifact && it.action.command === it.artifact.command) {
      throw new StatusItemError(`状态项 ${it.id} 的主动作与产物入口指向同一条命令（重复了：${it.action.command}）`);
    }
  }
  return { rows, actions, nav };
}

/** Markdown `command:` 链接（悬停里点一下就执行）。 */
export function linkify(label: string, command: string, arg?: string): string {
  const target = arg === undefined ? `command:${command}` : `command:${command}?${encodeURIComponent(JSON.stringify(arg))}`;
  return `[${label}](${target})`;
}

/** 极简档 → Markdown 文本（悬停面板内容）。 */
export function hoverMarkdown(project: string, projection: HoverProjection): string {
  const table = [
    '| 项目 | 状态 |',
    '| --- | --- |',
    ...projection.rows.map(([k, v]) => `| ${k} | ${v} |`),
  ].join('\n');
  const actions = ['━━━ 快捷操作（点按即执行）━━━', '', ...projection.actions.map((a) => `- ${linkify(a.label, a.command, a.arg)}`)].join('\n');
  const nav = projection.nav.length
    ? ['', '━━━ 打开 ━━━', '', ...projection.nav.map((a) => `- ${linkify(a.label, a.command, a.arg)}`)].join('\n')
    : '';
  return [`**$(package) HeT DevTools · ${project}**`, '', table, '', actions, nav].join('\n');
}

/**
 * **三档同源**断言（门禁用）：三档里出现的"结论串"必须都能在状态项里找到 ——
 * 不允许某一档自己造文案。
 */
export function projectionTexts(items: readonly StatusItem[]): string[] {
  return items.map((it) => it.text);
}
