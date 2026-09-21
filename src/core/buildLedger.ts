/**
 * **构建账本**（K 块 / §3.4.4）：记"上次用哪个目标、哪份 profile、什么时候"。
 *
 * 它存在的唯一理由是**守卫**：先 x86_64 试很多次、再切 arm，或者今天 armv7、明天 armv8 ——
 * 来回切时如果没人记得上次是谁，就会出现两类事故：
 *   · 静默复用上一次的构建上下文 → 产出架构不对（最难查的那种）；
 *   · 用户以为自己切了，其实 profile 没换。
 * 所以切目标时**必须**先比对账本，不一致就给一行定向提示（而不是默默就用）。
 *
 * 账本放在 `globalStorage`（按工程路径哈希命名），**不写进用户工程**（C5）。
 * 纯逻辑（hash 用 node:crypto），可直接单测。
 */
import { createHash } from 'node:crypto';

export interface TargetRecord {
  target: string;
  arch?: string;
  toolchain?: string;
  profileHash: string;
  /** 最近一次用这个目标构建的时间（ms）。 */
  at: number;
  /** 该目标的构建输出目录（按目标分区，见 G24）。 */
  buildDir?: string;
}

export interface BuildLedger {
  version: 1;
  project: string;
  lastTarget?: string;
  byTarget: Record<string, TargetRecord>;
}

export function emptyLedger(project: string): BuildLedger {
  return { version: 1, project, byTarget: {} };
}

/** 账本文件路径：`<storageRoot>/ledger/<工程路径哈希>.json`。 */
export function ledgerPath(storageRoot: string, project: string): string {
  const hash = createHash('sha256').update(project).digest('hex').slice(0, 16);
  return `${storageRoot.replace(/[\\/]+$/u, '')}/ledger/${hash}.json`;
}

/** 解析账本；坏文件**不抛给用户**（返回空账本），但要如实说"读不到"。 */
export function parseLedger(text: string | undefined, project: string): { ledger: BuildLedger; issue?: string } {
  if (!text || !text.trim()) {
    return { ledger: emptyLedger(project) };
  }
  try {
    const parsed = JSON.parse(text) as BuildLedger;
    if (parsed?.version !== 1 || typeof parsed.byTarget !== 'object' || parsed.byTarget === null) {
      return { ledger: emptyLedger(project), issue: '账本版本不认识（当作首次构建）' };
    }
    return { ledger: { ...parsed, project } };
  } catch {
    return { ledger: emptyLedger(project), issue: '账本内容损坏（当作首次构建）' };
  }
}

export function recordBuild(ledger: BuildLedger, record: TargetRecord): BuildLedger {
  return {
    ...ledger,
    lastTarget: record.target,
    byTarget: { ...ledger.byTarget, [record.target]: record },
  };
}

export interface SwitchCheck {
  changed: boolean;
  previous?: TargetRecord;
  /** 给用户看的一行（`changed=false` 时也有一句，便于"我刚切了吗"这类疑问）。 */
  text: string;
}

/**
 * 目标切换检查：`profileHash` 不同也算切换（工具链/矩阵变了，旧构建上下文同样不能复用）。
 */
export function checkTargetSwitch(
  ledger: BuildLedger,
  next: { target: string; arch?: string; toolchain?: string; profileHash: string },
  previousBuildBytes?: number,
): SwitchCheck {
  const previous = ledger.lastTarget ? ledger.byTarget[ledger.lastTarget] : undefined;
  const archText = next.arch ? `（arch=${next.arch}）` : '';
  if (!previous) {
    return { changed: false, text: `目标：${next.target}${archText} —— 本工程还没有构建记录，这是第一次` };
  }
  const sameTarget = previous.target === next.target;
  const sameProfile = previous.profileHash === next.profileHash;
  if (sameTarget && sameProfile) {
    return { changed: false, previous, text: `目标未变：${next.target}${archText}（与上次同一份 profile）` };
  }
  const reason = !sameTarget ? '目标变了' : '工具链/profile 变了';
  const size =
    previousBuildBytes !== undefined && previousBuildBytes > 0
      ? `；上个目标的构建目录占 ${formatBytes(previousBuildBytes)}，可顺带清理`
      : '';
  return {
    changed: true,
    previous,
    text: `检测到${reason}：${previous.target} → ${next.target}${archText}${size}（不会复用旧构建上下文）`,
  };
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  }
  if (bytes >= 1024 ** 2) {
    return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  }
  return `${Math.round(bytes / 1024)} KB`;
}
