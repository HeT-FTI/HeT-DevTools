/**
 * **输出环形缓冲**（D 块）：唯一通道的日志在内存里留一份尾部，供**页内“输出”视图**过滤/检索。
 *
 * 为什么不是"再开一个 webview 看日志"：输出面板已经存在且是唯一的（C4：不许分域炫耀）；
 * 页内这份的作用是**不用离开当前页**就能按域/级别/关键字看那一段（比如"只看 build 的 ✗"）。
 *
 * 纯函数 + 有界内存（默认 500 行，与 `CockpitState` 的 200 行上限同精神：长构建不会把内存吃穿）。
 */
import type { LogDomain, LogEntry, LogLevel } from './outputChannels';

export const OUTPUT_LOG_CAP = 500;

let entries: LogEntry[] = [];

export function appendLog(entry: LogEntry): void {
  entries = [...entries, entry].slice(-OUTPUT_LOG_CAP);
}

/** 测试/重启清空（也是"新一轮会话"的边界）。 */
export function resetLog(): void {
  entries = [];
}

export function allEntries(): readonly LogEntry[] {
  return entries;
}

export interface LogFilter {
  /** 只留这些域（空/缺省 = 全部）。 */
  domains?: readonly LogDomain[];
  /** 只留这些级别（空/缺省 = 全部）。 */
  levels?: readonly LogLevel[];
  /** 关键字（大小写不敏感；空 = 不过滤）。 */
  keyword?: string;
}

/** 纯过滤（门禁直接单测它，不依赖 UI）。 */
export function filterEntries(list: readonly LogEntry[], filter: LogFilter = {}): LogEntry[] {
  const kw = (filter.keyword ?? '').trim().toLowerCase();
  return list.filter((e) => {
    if (filter.domains?.length && !filter.domains.includes(e.domain)) {
      return false;
    }
    if (filter.levels?.length && !filter.levels.includes(e.level)) {
      return false;
    }
    if (kw && !e.text.toLowerCase().includes(kw)) {
      return false;
    }
    return true;
  });
}

/** 页内视图取用：过滤 + 只要尾部 N 行（默认 200，避免"再看一遍全量日志"）。 */
export function tailEntries(filter: LogFilter = {}, limit = 200): LogEntry[] {
  return filterEntries(entries, filter).slice(-limit);
}

/**
 * 进程级单例（host 侧模块共享）：`busy.ts` 写、`features/output/panel.ts` 读。
 *
 * 为什么用模块级状态而不是注入：它是**只读派生缓存**，没有需要替换的依赖；
 * 注入反而会让"谁都可以塞一份"变成新的分叉源。
 */
export const outputLog = {
  append: appendLog,
  reset: resetLog,
  all: allEntries,
  filter: filterEntries,
  tail: tailEntries,
  cap: OUTPUT_LOG_CAP,
};
