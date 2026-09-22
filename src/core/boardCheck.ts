/**
 * **上板验证的前置检查**（K 块下半，纯逻辑）。
 *
 * 上板这件事最容易出的事故是"以为在跑，其实什么也没连"：用户在面板上点了几次，等来的是
 * 一句 `openocd ENOENT` 或者干脆一片安静。所以这里把"能不能上板"写成**可判定的前置检查**：
 *
 *   1. **这次到底会不会刷写芯片**：`mode === 'cross'`（交叉编译那条腿）永远只构建 —— 语义
 *      不同，不许把两条流水线混成一条；
 *   2. **工具链够不够**：cpu → conan arch 的映射与模板 `run_bench.py` 的 `CONAN_ARCH_MAP`
 *      **逐条对账**（改了脚本没改这里就是红），工具链按 `(arch, os)` 取（与交叉编译同一张表）；
 *   3. **板子在不在**：看得到串口/探针才算"可能连着"；看不见就给"没连板 or 驱动/权限"，
 *      并且说清**还有第二条路**（CI 的 `hetai-package-matrix.yml` 跑在自托管 runner 上，那里
 *      真的连板）；
 *   4. **推提交会不会自动跑**：`metadata.workflow_triggers.cross_compile` 的状态要说出来，
 *      否则用户永远不知道 CI 上到底在不在跑交叉编译。
 *
 * 纯函数：可见性/可执行文件存在性/配置内容全部由宿主注入，本机没板子也能把四种情况跑一遍。
 */
import { BUILD_MATRIX_REL } from './buildMatrix';
import { compilerFor, type CrossToolchain } from './crossCompile';

/** 这次要干什么：只构建（交叉那条腿）还是真的上板。 */
export type BenchMode = 'cross' | 'on-board';

/** 板子看得出连着吗（`unknown` = 这个平台我们不枚举设备，**不许**说成"没连"）。 */
export type ProbeVisibility = 'seen' | 'none' | 'unknown';

export interface BoardFacts {
  platform: 'm' | 'a' | 'unknown';
  /** M-core 看 `target_mcu`，A-core 看 `target_cpu`（配置里就是这个键）。 */
  cpu: string;
  /** A-core 才有 `target_os`；M-core 固定 baremetal。 */
  targetOs?: string;
  configPresent: boolean;
  flashTool: string;
  serialPort?: string;
  probeVisibility: ProbeVisibility;
  /** 本机有没有这个可执行（注入：纯函数保持可测）。 */
  toolPresent: (exe: string) => boolean;
  mode: BenchMode;
  /** `metadata.workflow_triggers.cross_compile`；字段缺失 = `undefined`。 */
  workflowTrigger?: boolean;
}

export interface BoardPlan {
  /** `build-only` = 这次**不会**刷写芯片。 */
  mode: 'build-only' | 'on-board';
  arch?: string;
  toolchain?: CrossToolchain;
  /** 缺的可执行（工具链 + 上板工具）。 */
  missing: string[];
  canFlash: boolean;
  hints: { lines: string[]; fix: string[] };
  /** `workflow_triggers.cross_compile` 的人话（卡片上要看得见）。 */
  trigger: { state: 'on' | 'off' | 'missing'; text: string };
}

/** CI 里跑真机的那条流水线（提示里要指向它 —— 这句必须是**真的**）。 */
export const BOARD_CI_WORKFLOW = 'hetai-package-matrix.yml';
/** 只构建时用的 conan 目标 profile 来源（提示里要说清目标从哪来）。 */
export const BOARD_TARGET_SOURCE = BUILD_MATRIX_REL;

/**
 * CPU → conan arch。
 *
 * 与模板 `benchmark/script/run_bench.py` 的 `CONAN_ARCH_MAP` 是**同一份知识**（门禁拿那个
 * 脚本逐条对账）：这里多出来的条目只能比它多，不能与它不同。
 */
const CPU_ARCH: Readonly<Record<string, string>> = {
  // Cortex-M（裸机）
  'cortex-m0': 'armv6',
  'cortex-m0plus': 'armv6',
  'cortex-m1': 'armv6',
  'cortex-m3': 'armv7',
  'cortex-m4': 'armv7',
  'cortex-m4f': 'armv7',
  'cortex-m7': 'armv7',
  'cortex-m7f': 'armv7',
  'cortex-m7d': 'armv7',
  'cortex-m23': 'armv8_32',
  'cortex-m33': 'armv8_32',
  'cortex-m33f': 'armv8_32',
  'cortex-m55': 'armv8_32',
  'cortex-m85': 'armv8_32',
  // Cortex-A（Linux）
  'cortex-a5': 'armv7',
  'cortex-a7': 'armv7',
  'cortex-a8': 'armv7',
  'cortex-a9': 'armv7',
  'cortex-a15': 'armv7',
  'cortex-a17': 'armv7',
  'cortex-a35': 'armv8',
  'cortex-a53': 'armv8',
  'cortex-a55': 'armv8',
  'cortex-a72': 'armv8',
  'cortex-a73': 'armv8',
  'cortex-a76': 'armv8',
  'cortex-a78': 'armv8',
};

export function cpuToArch(cpu: string): string | undefined {
  return CPU_ARCH[cpu.trim().toLowerCase()];
}

/** CPU → 工具链（M-core 一律 arm-none-eabi；A-core 按 arch 取）。 */
export function toolchainForCpu(cpu: string, platform: 'm' | 'a' | 'unknown'): CrossToolchain | undefined {
  const arch = cpuToArch(cpu);
  if (!arch) {
    return undefined;
  }
  return compilerFor(arch, platform === 'm' ? 'baremetal' : 'Linux');
}

/** 上板工具的可执行名（配置里 `flash_tool` 的取值；`adb` 是 A-core 的部署工具）。 */
export function flashExeFor(fact: Pick<BoardFacts, 'flashTool' | 'platform'>): string | undefined {
  const tool = (fact.flashTool || '').trim().toLowerCase();
  if (tool) {
    if (tool.includes('jlink') || tool === 'j-link') {
      return 'JLinkExe';
    }
    if (tool.includes('openocd')) {
      return 'openocd';
    }
    if (tool.includes('pyocd')) {
      return 'pyocd';
    }
    if (tool === 'adb') {
      return 'adb';
    }
    if (tool === 'none' || tool === '') {
      return undefined;
    }
    return tool;
  }
  return fact.platform === 'a' ? 'adb' : undefined;
}

/** `workflow_triggers.cross_compile` 的人话（模板 schema 里它是**必填**字段）。 */
export function triggerText(value: boolean | undefined): BoardPlan['trigger'] {
  if (value === undefined) {
    return {
      state: 'missing',
      text: '推提交触发交叉编译：**没这一项**（模板 schema 要求 workflow_triggers.cross_compile）',
    };
  }
  return value
    ? { state: 'on', text: '推提交会触发 🛠️ 交叉编译（CI：cross-compile.yml）' }
    : { state: 'off', text: '推提交**不会**触发 🛠️ 交叉编译（只在本地/手动触发）' };
}

/**
 * 事实 → 计划 + 定向提示。
 *
 * 提示的排序原则：先说**这次会干什么**（会不会刷芯片），再说缺什么、怎么办 —— 上板事故里
 * 最贵的一条就是"以为只构建，结果刷了板"。
 */
export function boardPlanFor(facts: BoardFacts): BoardPlan {
  const mode: BoardPlan['mode'] = facts.mode === 'cross' ? 'build-only' : 'on-board';
  const arch = cpuToArch(facts.cpu);
  const toolchain = toolchainForCpu(facts.cpu, facts.platform);
  const missing = toolchain
    ? [toolchain.cc, toolchain.cxx, toolchain.ar].filter((e) => !facts.toolPresent(e))
    : [];
  const flashExe = mode === 'on-board' ? flashExeFor(facts) : undefined;
  if (flashExe && !facts.toolPresent(flashExe)) {
    missing.push(flashExe);
  }
  const canFlash = mode === 'on-board' && missing.length === 0 && facts.probeVisibility === 'seen';

  const lines: string[] = [];
  const fix: string[] = [];

  if (!facts.configPresent) {
    lines.push('没有 bench 配置（benchmark/platform/bench_config.json）—— 板卡型号/探针/串口都在它里面。');
    fix.push('从模板复制一份：benchmark/platform/bench_config.json（按板卡改 target_mcu 或 target_cpu）');
  } else if (!arch) {
    lines.push(
      `配置里的 cpu「${facts.cpu}」不在已知表里 —— 不知道该用哪套工具链（不会猜）。`,
    );
    fix.push('把 bench_config.json 的 target_mcu / target_cpu 改成模板里列出的型号之一');
  }

  if (mode === 'build-only') {
    lines.push(`这次是**只构建**（--no-flash）：不会烧板，目标是 ${arch ?? '?'} 架构的可执行文件。`);
  } else {
    lines.push(`这次会**真的上板**（flash_tool=${facts.flashTool || '未配置'}，串口 ${facts.serialPort ?? '未配置'}）。`);
  }

  if (toolchain && missing.length > 0) {
    const pkgs = toolchain.packages.join(' ');
    lines.push(`本机缺：${missing.join('、')}`);
    fix.push(`本机装：sudo apt-get install -y ${pkgs}`);
    fix.push(`或者交给 CI：${BOARD_CI_WORKFLOW} 跑在自托管 runner 上，那里真的连板`);
  }

  if (facts.probeVisibility === 'none') {
    lines.push(
      facts.platform === 'a'
        ? '没看到板子的串口/网络部署目标 —— 板子没连、或者驱动/权限没装。'
        : '没看到调试探针/串口（如 /dev/ttyACM*、/dev/ttyUSB*）—— 板子没插好，或者驱动/权限没装。',
    );
    fix.push('插好板子再刷新一次；Linux 上串口要 dialout 组权限（`sudo usermod -aG dialout $USER` 后重登）');
    fix.push('没有真机也能往前进：先点「只构建」（--no-flash）验交叉构建，上板那一步交给 CI');
  } else if (facts.probeVisibility === 'unknown') {
    lines.push('这个平台我们不枚举设备：**看不出**板子连没连（不代表没连）—— 以实际现象为准。');
  }

  if (missing.some((e) => e === flashExe) && flashExe) {
    fix.push(`上板工具 ${flashExe} 不在 PATH：装好它，或者把 bench_config.json 的 flash_tool 改成你实际有的那个`);
  }

  if (mode === 'on-board' && canFlash) {
    lines.push('前置检查通过：工具链齐、探针可见 —— 可以上板（上板前再确认目标板与供电）。');
  }

  return {
    mode,
    ...(arch ? { arch } : {}),
    ...(toolchain ? { toolchain } : {}),
    missing,
    canFlash,
    hints: { lines, fix },
    trigger: triggerText(facts.workflowTrigger),
  };
}

/** 队列里那一步的"下一步"（失败时给：不能只说"上板失败"）。 */
export function boardNextStep(plan: BoardPlan): string {
  if (plan.hints.fix.length > 0) {
    return plan.hints.fix[0];
  }
  return plan.mode === 'build-only'
    ? '只构建通过后，接上板子再跑一次上板验证（或交给 CI 的 ' + BOARD_CI_WORKFLOW + '）。'
    : '看「输出」里 bench 那几行；连不上板时先确认探针/串口与供电。';
}
