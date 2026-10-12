/**
 * **任务中心模型**（J 块）：回答"现在在跑什么 / 之前跑过什么 / 结果如何"。
 *
 * 为什么做成纯函数：任务中心的第一条门禁是"所有数字/结论都必须来自 Task/Fact，不许写死"
 * —— 把"事实 → 模型"抽成纯函数之后，门禁可以直接断言模型（最近 10 条是截出来的、进度来自
 * Task、结论来自终态映射），而不是去猜 HTML 里的字符串。渲染（`features/tasks/html.ts`）
 * 只做"模型 → HTML"，一行判断逻辑都不放。
 *
 * **它不是第二个操作面板**：模型里没有任何"发起动作"的字段 —— 唯一的动作是取消（由
 * `feature/tasks/panel.ts` 直接调用 `cancelBusy`）。要构建/测试/发布，去对应段。
 */
import { intentForBusy } from './intents';
import { STATE_GLYPH, STATE_TEXT, isTerminal, type Task, type TaskState } from './tasks';

/** 最近完成显示多少条（§6-J：10 条 —— 再多就成了"日志"，那是输出通道的事）。 */
export const RECENT_LIMIT = 10;

export interface TaskArtifactLink {
  label: string;
  command?: string;
  arg?: string;
  path?: string;
}

export interface TaskCenterRow {
  id: string;
  /** 领域术语名（Intent 表；没有就退回 `Task.label` —— 绝不显示 undefined）。 */
  label: string;
  state: TaskState;
  glyph: string;
  stateText: string;
  /** 已用时（进行中）或总耗时（已完成）。 */
  durationText: string;
  /** 完成时间（"3 分钟前"）—— 只有已完成的行有；进行中的"开始于"信息在 durationText 里。 */
  whenText?: string;
  /** 归属：本机 / CI（来自 `Task.owner`，出问题要能问责）。 */
  ownerText: string;
  /** 有进度才给（`12%`）；没有就不显示，不写"0%"假装有。 */
  progressText?: string;
  /** 失败/超时的原因（人话，一行）。 */
  reasonText?: string;
  /** 下一步（只给失败；取消/超时是用户/环境造成的，不再劝人排错）。 */
  nextStep?: string;
  artifacts: TaskArtifactLink[];
}

export interface TaskCenterCi {
  /** `owner/repo`（拿不到时为空串，此时不会有这一行 —— 用 `ciNote` 说明为什么）。 */
  label: string;
  conclusion: string;
  glyph: string;
  whenText: string;
  url: string;
}

/** CI 区块拿不到时的**显式说明**（§F.43 的口径：原因 + 能怎么办，不留空白）。 */
export interface TaskCenterNote {
  reason: string;
  fix: string[];
}

export interface TaskCenterModel {
  running: TaskCenterRow[];
  recent: TaskCenterRow[];
  ci: TaskCenterCi | null;
  ciNote?: TaskCenterNote;
  emptyRunningText: string;
  emptyRecentText: string;
}

/** CI 事实的最小形状（由 host 侧适配 `features/ci/panel.ts › CiState` 后传入）。 */
export interface CiInput {
  online: boolean;
  repoLabel: string;
  runs: ReadonlyArray<{
    name: string;
    branch: string;
    status: string;
    conclusion: string;
    createdAt: string;
    url: string;
  }>;
  actionsUrl: string;
  reason?: string;
  fix?: string[];
}

export interface TaskCenterInput {
  tasks: readonly Task[];
  /** 没传 = 这个环境根本不看 CI（例如未配置 origin）；传了但 `online=false` 会显示原因。 */
  ci?: CiInput | null;
  now: number;
}

/** 人话耗时：`8 秒` / `3 分 5 秒` / `1 小时 2 分`。 */
export function durationText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) {
    return `${s} 秒`;
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    const rest = s % 60;
    return rest === 0 ? `${m} 分` : `${m} 分 ${rest} 秒`;
  }
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

/** `刚刚` / `3 分钟前` / `2 小时前`（与 chip 的口径一致）。 */
export function agoText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 15) {
    return '刚刚';
  }
  if (s < 60) {
    return `${s} 秒前`;
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `${m} 分钟前`;
  }
  const h = Math.floor(m / 60);
  if (h < 24) {
    return `${h} 小时前`;
  }
  return `${Math.floor(h / 24)} 天前`;
}

/** 结论 → 符号（CI 的结论串来自 GitHub：success/failure/cancelled/in_progress/…）。 */
export function ciGlyph(conclusion: string, status = ''): string {
  const c = (conclusion || status).toLowerCase();
  if (c === 'success') {
    return '✓';
  }
  if (c === 'failure' || c === 'timed_out' || c === 'startup_failure') {
    return '✗';
  }
  if (c === 'cancelled') {
    return '⊘';
  }
  if (c === 'in_progress' || c === 'queued' || c === 'queued' || c === 'waiting') {
    return '⟳';
  }
  return '·';
}

function artifactLinks(task: Task): TaskArtifactLink[] {
  return (task.artifacts ?? []).map((a) => ({
    label: a.label,
    ...(a.command ? { command: a.command } : {}),
    ...(a.arg ? { arg: a.arg } : {}),
    ...(a.path ? { path: a.path } : {}),
  }));
}

function rowOf(task: Task, now: number): TaskCenterRow {
  const started = task.startedAt ?? task.createdAt;
  const done = task.state === 'running' || task.state === 'queued' ? now : task.updatedAt;
  const row: TaskCenterRow = {
    id: task.id,
    label: intentForBusy(task.action)?.name ?? task.label,
    state: task.state,
    glyph: STATE_GLYPH[task.state],
    stateText: STATE_TEXT[task.state],
    durationText: durationText(done - started),
    ownerText: task.owner === 'card' ? '本机' : task.owner === 'ci' ? 'CI' : task.owner,
    artifacts: artifactLinks(task),
  };
  if (task.state !== 'running' && task.state !== 'queued') {
    row.whenText = agoText(now - task.updatedAt);
  }
  if (typeof task.progress === 'number' && task.progress > 0) {
    row.progressText = `${task.progress}%`;
  }
  if (isTerminal(task.state) && task.state !== 'succeeded') {
    // **只给终态里"没成功"的那些**：
    //   · 进行中的 `message` 是心跳文案（"编译中"）——把它当"原因"显示出去就是误导；
    //   · 取消/重启恢复的 `message` 恰恰是用户最需要的"为什么"（"扩展重启，未完成的任务已中止"）；
    //   · 失败/超时看 `errorTail`（原始一句）优先。
    const reason = (task.errorTail ?? task.message ?? '').trim();
    if (reason) {
      row.reasonText = reason.split('\n')[0].slice(0, 200);
    }
  }
  if (task.state === 'failed' && task.nextStep) {
    row.nextStep = task.nextStep;
  }
  return row;
}

function ciBlock(ci: CiInput | null | undefined, now: number): { ci: TaskCenterCi | null; ciNote?: TaskCenterNote } {
  if (ci === null || ci === undefined) {
    return { ci: null };
  }
  const latest = ci.runs[0];
  if (ci.online && latest) {
    return {
      ci: {
        label: ci.repoLabel,
        conclusion: latest.conclusion || latest.status,
        glyph: ciGlyph(latest.conclusion, latest.status),
        whenText: agoText(now - Date.parse(latest.createdAt)),
        url: latest.url || ci.actionsUrl,
      },
    };
  }
  if (ci.online) {
    return {
      ci: null,
      ciNote: {
        reason: '远端还没有运行记录（刚建仓库、或还没跑过 workflow）。',
        fix: ['在 GitHub 上手动触发一次 workflow', '或先跑一次「运行预检」拿到机械结论'],
      },
    };
  }
  return {
    ci: null,
    ciNote: {
      reason: ci.reason ?? '未登录 GitHub（或未配置 origin）时拿不到远端状态。',
      fix: ci.fix ?? ['在 VS Code 里登录 GitHub 账户', '或安装 gh CLI 并执行 gh auth login'],
    },
  };
}

export function taskCenterModel(input: TaskCenterInput): TaskCenterModel {
  const { tasks, now } = input;
  const running = tasks
    .filter((t) => t.state === 'running' || t.state === 'queued')
    .sort((a, b) => (a.startedAt ?? a.createdAt) - (b.startedAt ?? b.createdAt))
    .map((t) => rowOf(t, now));
  const recent = tasks
    .filter((t) => t.state !== 'running' && t.state !== 'queued')
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, RECENT_LIMIT)
    .map((t) => rowOf(t, now));
  const { ci, ciNote } = ciBlock(input.ci, now);
  return {
    running,
    recent,
    ci,
    ...(ciNote ? { ciNote } : {}),
    emptyRunningText: '现在没有正在跑的任务。',
    emptyRecentText: '还没有跑完的任务（第一次构建/测试之后这里会有记录）。',
  };
}
