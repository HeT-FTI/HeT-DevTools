/**
 * 上板（bench）卡片的 L2 文案（计划 §19.3 / G23）—— 纯函数，不 import vscode。
 *
 * §19.3 的判据只有一条硬的：**模式（是否 flash）必须在 L2 可见**，避免误刷板。
 * 所以这里把"这个平台 + 这次会不会真的刷写芯片"写成一行必须看得见的话，
 * 而不是藏在二级面板里。附带把"上次采集"也放上来（没有就说"无"，不编造时间）。
 */
import type { BenchPlatform } from './benchmark';

/** 上次采集（由面板解析成功时记账；没有就不会有这一行）。 */
export interface BoardLast {
  /** 人话时间（`14:05` / `2026-09-17 14:05`）。 */
  at?: string;
  /** 解析到的用例数。 */
  cases?: number;
  /** 是否收到 BENCHMARK_END（协议完整）。 */
  complete?: boolean;
}

export function platformText(p: BenchPlatform): string {
  switch (p) {
    case 'm':
      return 'Cortex-M 裸机';
    case 'a':
      return 'Cortex-A Linux';
    default:
      return '未知平台';
  }
}

/**
 * 模式文案：**只有明确 `flashing === true` 才说"会刷写"**，其余一律按安全默认（只构建）说。
 * 宁可说保守的那句（用户会自己去确认），也不要把"会刷写"藏起来。
 */
export function boardModeText(flashing?: boolean): string {
  return flashing === true ? '⚠ 会上板刷写' : '默认只构建（--no-flash）';
}

export function boardLastText(last?: BoardLast): string {
  if (!last?.at) {
    return '上次：无';
  }
  const cases = typeof last.cases === 'number' ? ` · ${last.cases} 例` : '';
  const incomplete = last.complete === false ? '（协议未结束）' : '';
  return `上次 ${last.at}${cases}${incomplete}`;
}

export interface BoardFactInput {
  platform: BenchPlatform;
  /** 明确要上板刷写时为 true（默认 undefined = 只构建）。 */
  flashing?: boolean;
  last?: BoardLast;
  /** `metadata.workflow_triggers.cross_compile`（K 块：卡上要看得见 CI 到底跑不跑）。 */
  crossTrigger?: boolean;
}

export function boardFact(input: BoardFactInput): { fact: string; next?: string } {
  const fact = `${platformText(input.platform)} · ${boardModeText(input.flashing)}`;
  const last = boardLastText(input.last);
  // 触发开关只说"开/关"，不编造 CI 的实际结果（那是 CI 状态面板的事）
  const trigger =
    input.crossTrigger === undefined ? null : `🛠️ 提交触发交叉编译：${input.crossTrigger ? '开' : '关'}`;
  const tail = [last, ...(trigger ? [trigger] : [])].join(' · ');
  if (input.flashing === true) {
    return { fact, next: `${tail} —— 上板前请确认目标板与供电（--flash 会真的刷写芯片）` };
  }
  return { fact, next: tail };
}
