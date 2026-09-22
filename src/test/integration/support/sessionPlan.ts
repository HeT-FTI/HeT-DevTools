/**
 * **一致性会话的脚本表**（H 块；c9 与 `consistency.test.ts` 共用一份）。
 *
 * 为什么把"会话脚本"变成数据：H 的门禁要求 *"出口必须覆盖四种（成功/失败/超时/取消），
 * 新增长动作不许绕过一致性验证"*。写成散文式的 if/else，门禁只能靠字符串搜索（脆且假）；
 * 写成表之后，门禁可以对**结构**断言（见 `consistency.test.ts` 的"会话脚本的覆盖面"）。
 *
 * 每个条目 = 一次"注入体跑出来的出口"：
 *   · `ok`   —— 正常结束；
 *   · `fail` —— 抛错（失败出口，必须留一行"下一步"）；
 *   · `hang` + `settle: 'cancel'` —— 挂住，由用户取消（⊘ 出口）；
 *   · `hang` + `settle: 'timeout'` —— 挂住，由对账器按 deadline 收敛（⌛ 出口）。
 *
 * **同一个动作只能出现一次**：输出断言是"这个动作恰好一对行"，复用会让计数变成 2（门禁会查重）。
 */
import type { LogLevel } from '../../../core/outputChannels';

export type ExitState = 'succeeded' | 'failed' | 'cancelled' | 'timedOut';

export interface ExitStep {
  /** 真实 Intent 的 action id（动作名/域/阈值全部从 Intent 表推导）。 */
  action: string;
  mode: 'ok' | 'fail' | 'hang';
  settle: 'natural' | 'cancel' | 'timeout';
  /** 期望的 Task 终态（与出口一一对应，不许混）。 */
  expect: ExitState;
  /** 期望的终态行级别。 */
  level: LogLevel;
  /**
   * 状态栏 chip 是否应当换成"进行中"。
   *
   * **环境域是有意的例外**（`core/statusItem.ts › chipBusyItem`：秒级动作抢芯片会让它
   * 一闪一闪）—— 那一格断言的是"chip 保持安静，但悬停与页内照样说进行中"，
   * 把这条设计钉住（它很容易被下一个好心人"顺手改回去"）。
   */
  chip: boolean;
}

export const EXIT_STEPS: readonly ExitStep[] = [
  { action: 'test', mode: 'ok', settle: 'natural', expect: 'succeeded', level: 'ok', chip: true },
  { action: 'envRemove', mode: 'fail', settle: 'natural', expect: 'failed', level: 'fail', chip: false },
  { action: 'build', mode: 'hang', settle: 'cancel', expect: 'cancelled', level: 'cancel', chip: true },
  { action: 'docsBuild', mode: 'hang', settle: 'timeout', expect: 'timedOut', level: 'timeout', chip: true },
];

/** 超时用例用的阈值（毫秒）：由 `scripts/run-c9.mjs` 写进工作区设置 `het.task.deadlines.docs`。 */
export const TIMEOUT_OVERRIDE_MS = 2_000;
