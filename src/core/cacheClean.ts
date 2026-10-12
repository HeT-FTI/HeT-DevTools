/**
 * **缓存清理计划**（K 块 / §3.4.4 `clean-cache` 四档 + G25）。
 *
 * 用户把"清理车道内 conan 缓存"列为高频刚需，同时点出一个关键约束：
 * **"如放单独车道，可能存储的浪费又是个问题"** —— 所以这里是"同一份缓存 + 定向清理"，
 * 而不是"每个架构一份缓存"。四档的能力与风险必须**明说**：
 *
 * | 档 | 命令（conan 2.25 实测） | 风险 |
 * |---|---|---|
 * | ① 构建目录 | 删 `<工程>/build/<target>/` | 极低（下次重编） |
 * | ② conan 构建目录（默认） | `conan cache clean -b` | 低（只丢中间产物，包还在） |
 * | ③ 临时 + 下载 | `conan cache clean -t -d` | 低（下次重新下载） |
 * | ④ 按 ref/架构删包（危险） | `conan remove -c [-p "arch=…"] "<ref>:*"` | 高（包没了，要重编） |
 *
 * 两条实测得到的细节（写进代码免得再踩）：
 *   · `conan cache clean` 只认短开关 `-b/-t/-d/-s`，没有 `--build` 这种长形式；
 *   · `conan remove -p "<query>"` 的 pattern **必须是 `<ref>:*`**（只写 `*` 会报
 *     "the pattern does not match packages"）；而 `--dry-run` 能给出真实影响面清单 ——
 *     所以危险档的"预览"不是我们猜的，是 conan 自己算的。
 *
 * 纯逻辑（不执行命令）：生成计划、校验确认、算释放量；执行留给调用方（便于单测与审阅）。
 */

export type CleanScope = 'build-dir' | 'conan-build' | 'conan-temp' | 'conan-pkgs';

/** UI 顺序 = 安全 → 危险（默认选中第一项，用户要往下走得刻意选）。 */
export const CLEAN_SCOPES: readonly CleanScope[] = ['conan-build', 'build-dir', 'conan-temp', 'conan-pkgs'];

export interface CleanPlan {
  scope: CleanScope;
  label: string;
  /** 影响面预览（人话，含"删什么、哪些目标受影响"）。 */
  effect: string;
  /** 需要执行的命令（按顺序）；`rm` 由调用方实现为 fs 删除。 */
  commands: Array<{ cmd: string; args: string[] }>;
  /** 危险档：必须二次确认（默认折叠在"高级"里）。 */
  danger: boolean;
  /** 危险档的**真实影响面预览命令**（`conan remove --dry-run`），执行前先跑它。 */
  previewCommand?: { cmd: string; args: string[] };
  /** 档①：要删的目录（相对 `projectRoot`；由调用方做 fs 删除）。 */
  dirs?: string[];
}

export interface CleanContext {
  /** conan 可执行文件（默认 `conan`）。 */
  conanExe?: string;
  /** 本工程根（档① 用）。 */
  projectRoot?: string;
  /** 要删的构建目录名（target id）；缺省 = 所有目标。 */
  targets?: string[];
  /** 危险档：要删的 ref 模式（必须 `<ref>:*` 形状）。 */
  pattern?: string;
  /** 危险档：按架构定向（`-p "arch=armv7"`）。 */
  arch?: string;
  /** 缓存目录（报表用；不进命令）。 */
  cacheRoot?: string;
}

export class CleanPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CleanPlanError';
  }
}

const SCOPE_LABEL: Readonly<Record<CleanScope, string>> = {
  'build-dir': '① 本工程构建目录',
  'conan-build': '② conan 构建目录（默认，最省空间）',
  'conan-temp': '③ conan 临时文件 + 下载缓存',
  'conan-pkgs': '④ 按包删除（危险：要重编）',
};

/**
 * 生成清理计划。**不做任何删除**（执行是调用方的事）。
 * 缺少必要信息时抛错，而不是"猜一个默认值去删"。
 */
export function planClean(scope: CleanScope, ctx: CleanContext = {}): CleanPlan {
  const conan = ctx.conanExe ?? 'conan';
  switch (scope) {
    case 'build-dir': {
      if (!ctx.projectRoot) {
        throw new CleanPlanError('清理本工程构建目录需要工程根路径');
      }
      const targets = ctx.targets?.length ? ctx.targets : [];
      const dirs = targets.length ? targets.map((t) => `build/${t}`) : ['build'];
      return {
        scope,
        label: SCOPE_LABEL[scope],
        effect: `删除 ${ctx.projectRoot} 下的 ${dirs.join('、')}（中间产物；下次构建会重新生成，包不受影响）`,
        commands: [],
        dirs,
        danger: false,
      };
    }
    case 'conan-build':
      return {
        scope,
        label: SCOPE_LABEL[scope],
        effect: 'conan cache clean -b：清掉所有包的**构建目录**（膨胀主因）。已构建好的包仍在，只是下次改代码要重编。',
        commands: [{ cmd: conan, args: ['cache', 'clean', '-b'] }],
        danger: false,
      };
    case 'conan-temp':
      return {
        scope,
        label: SCOPE_LABEL[scope],
        effect: 'conan cache clean -t -d：清掉临时文件与下载缓存（.tgz）。下次拉依赖会重新下载。',
        commands: [{ cmd: conan, args: ['cache', 'clean', '-t', '-d'] }],
        danger: false,
      };
    case 'conan-pkgs': {
      const pattern = ctx.pattern?.trim();
      if (!pattern) {
        throw new CleanPlanError('按包删除必须给出 ref 模式（形如 `fmt/*:*`）—— 不许"猜一个全删"');
      }
      if (!pattern.includes(':*')) {
        throw new CleanPlanError(
          `ref 模式「${pattern}」形状不对：conan 2 需要 <ref>:* 才能匹配到包（如 fmt/*:*）`,
        );
      }
      const args = ['remove', '-c'];
      if (ctx.arch) {
        args.push('-p', `arch=${ctx.arch}`);
      }
      args.push(pattern);
      const previewArgs = ['remove', '--dry-run', '-c'];
      if (ctx.arch) {
        previewArgs.push('-p', `arch=${ctx.arch}`);
      }
      previewArgs.push(pattern);
      return {
        scope,
        label: SCOPE_LABEL[scope],
        effect: `删除包 ${pattern}${ctx.arch ? `（仅 arch=${ctx.arch}）` : ''}：包会被真的删掉，下次构建需要重新编译/下载。`,
        commands: [{ cmd: conan, args }],
        danger: true,
        previewCommand: { cmd: conan, args: previewArgs },
      };
    }
    default: {
      const never: never = scope;
      throw new CleanPlanError(`未知清理档：${String(never)}`);
    }
  }
}

/** G25：危险档必须二次确认（未确认直接抛，避免"手滑就删包"）。 */
export function assertCleanConfirmed(plan: CleanPlan, confirmed: boolean): void {
  if (plan.danger && !confirmed) {
    throw new CleanPlanError(`「${plan.label}」是危险操作（会删掉包，需要重新编译）—— 需要二次确认后才执行`);
  }
}

/** 清理完成后的"实际释放量"（G25：必须回报真实数字，而不是"已完成"）。 */
export function cleanResultText(beforeBytes: number, afterBytes: number): string {
  const freed = Math.max(0, beforeBytes - afterBytes);
  const pct = beforeBytes > 0 ? Math.round((freed / beforeBytes) * 100) : 0;
  return `释放 ${formatBytes(freed)}（${formatBytes(beforeBytes)} → ${formatBytes(afterBytes)}，${pct}%）`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  }
  if (bytes >= 1024 ** 2) {
    return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${bytes} B`;
}

/** UI 用的档位名（QuickPick 的 label）。 */
export function cleanScopeLabel(scope: CleanScope): string {
  return SCOPE_LABEL[scope];
}
