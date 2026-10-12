/**
 * 产物能力事实（capability facts）—— V3 计划 §5.2（纯函数，**不 import vscode**）。
 *
 * 与"领域标签 / 主题回显"的分水岭：
 *   ❌ 回显领域 = "你在做求解器库"（用户已知 → 零信息 → 违反 P7）
 *   ✅ 能力事实 = "你的产物**有**这个能力 ⇒ 因此**你必须做这件事**"（用户可能不知道 → 直接推出动作）
 *
 * 两条铁律：
 * 1. **只从真实存在的字段/产物推导**；字段缺失就是缺失，绝不猜测（沿用 `boardFact` 的既有原则）。
 * 2. **`metadata` 读不到时返回 `undefined`（未知）**，而不是空数组（"没有能力"）。
 *    未知不许当成否定 —— 否则一次读取失败就会把卡片从界面上抹掉。
 */
import type { FcppMetadata } from '../types';

export type CapabilityId =
  | 'shared-abi'
  | 'header-only'
  | 'python-bindings'
  | 'baremetal'
  | 'cross-target'
  | 'coverage'
  | 'c-abi'
  | 'perf-baseline';

/** 稳定的输出顺序（同一份输入 → 同一串输出；快照/对账要用）。 */
export const CAPABILITY_ORDER: readonly CapabilityId[] = [
  'shared-abi',
  'header-only',
  'python-bindings',
  'baremetal',
  'cross-target',
  'coverage',
  'c-abi',
  'perf-baseline',
];

export const CAPABILITY_LABELS: Record<CapabilityId, string> = {
  'shared-abi': '共享库 ABI',
  'header-only': '仅头文件',
  'python-bindings': 'Python 绑定',
  baremetal: '裸机',
  'cross-target': '多目标',
  coverage: '覆盖率',
  'c-abi': 'C 接口',
  'perf-baseline': '性能基线',
};

/** 每条能力**推出的动作或门禁**（单点定义：实例不再自带一份副本）。 */
export const CAPABILITY_IMPLIES: Record<CapabilityId, string> = {
  'shared-abi': '发布前必须做导出符号 / ABI 兼容检查',
  'header-only': '无 ABI 检查；关注编译期成本',
  'python-bindings': '公开 API 必须全部绑定；出 wheel 前对 Python 版本矩阵',
  baremetal: '裸机交叉矩阵必须绿，发布前要在板上采集',
  'cross-target': '发布前每个目标都要绿（交付站跑交叉编译）',
  coverage: '测试站显示覆盖率；低于阈值不允许标"发布就绪"',
  'c-abi': 'C 接口回归测试（ABI 稳定是它的对外承诺）',
  'perf-baseline': '性能基线与回归对比（有基线才对比）',
};

export interface CapabilityFact {
  id: CapabilityId;
  /** 界面上一行短标签（理想 ≤ 8 字、硬顶 10；能力行是横排，超了就换更短的说法）。 */
  label: string;
  /** **证据**：这条事实从哪个字段/产物读出来的（可追溯，不猜）。 */
  evidence: string;
  /** **推出的动作或门禁**：它值得占一个位置的理由（P7）。空字符串表示"推不出动作" = 不许进界面。 */
  implies: string;
}

export interface CapabilityInput {
  metadata?: FcppMetadata;
  /** 产物事实：`include/*.h` 存在（C ABI）。 */
  hasCHeader?: boolean;
  /** 产物事实：仓库里有 bench 入口（`benchmark/script/run_bench.py`）。 */
  hasBenchmark?: boolean;
  /** 产物事实：`.hetai/build-matrix.yml` 存在（多目标发布需求）。 */
  hasBuildMatrix?: boolean;
}

function evidenceList(values: readonly string[]): string {
  const head = values.slice(0, 2).join(', ');
  return values.length > 2 ? `${head}, …（共 ${values.length} 项）` : head;
}

/**
 * 推导产物能力事实。
 *
 * @returns `undefined` = **未知**（没有 metadata 可读）；数组（可能为空）= **已知**。
 */
export function deriveCapabilities(input: CapabilityInput): CapabilityFact[] | undefined {
  const meta = input.metadata;
  if (!meta) {
    return undefined;
  }
  const found = new Map<CapabilityId, CapabilityFact>();
  const put = (id: CapabilityId, evidence: string): void => {
    found.set(id, { id, label: CAPABILITY_LABELS[id], evidence, implies: CAPABILITY_IMPLIES[id] });
  };

  if (meta.is_shared === true) {
    put('shared-abi', 'metadata.is_shared = true');
  }
  if (meta.is_header === true) {
    put('header-only', 'metadata.is_header = true');
  }
  if (meta.enable_python_bindings === true) {
    put('python-bindings', 'metadata.enable_python_bindings = true');
  }
  const white = meta.baremetal_white_list;
  if (Array.isArray(white) && white.length > 0) {
    put('baremetal', `metadata.baremetal_white_list = [${evidenceList(white)}]`);
  }
  if (meta.activate_code_coverage === true) {
    put('coverage', 'metadata.activate_code_coverage = true');
  }
  if (input.hasBuildMatrix === true) {
    put('cross-target', '.hetai/build-matrix.yml 存在');
  }
  if (input.hasCHeader === true && meta.is_header !== true) {
    // V3 · L6e：**仅头文件产物不出这条**（计划 §5.2 的"反向隐藏"）。
    // C 接口能力推出的动作是"符号/ABI 回归" —— 那需要有**编出来的产物**可读；纯头文件库
    // 压根没有产物，给它的只会是一张点了就失败的卡（真机截图抓到的就是这个：
    // 仅头文件的工程上出现「导出符号」，下一步却是"先「扫描当前产物」"）。
    put('c-abi', 'include/*.h 存在');
  }
  // 同理：`is_shared` 与 `is_header` 不可能同时成立（有产物 vs 没产物），
  // 真同时写了就是 metadata 自相矛盾 —— 保留 is_shared 那条（它是更具体的产物承诺）。
  if (input.hasBenchmark === true) {
    put('perf-baseline', 'benchmark/script/run_bench.py 存在（bench 入口）');
  }

  return CAPABILITY_ORDER.filter((id) => found.has(id)).map((id) => found.get(id) as CapabilityFact);
}

/** 能力事实一行摘要（① 就绪站的"产物能力"行用；空数组 = 已知但没有 → 返回空串）。 */
export function capabilitySummary(caps: readonly CapabilityFact[] | undefined): string {
  if (caps === undefined || caps.length === 0) {
    return '';
  }
  return caps.map((c) => c.label).join(' · ');
}
