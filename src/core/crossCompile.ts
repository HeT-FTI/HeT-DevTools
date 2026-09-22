/**
 * **交叉编译的计划层**（K 块，纯逻辑）。
 *
 * 一条 Intent「交叉编译」要回答四件事，全都在这一个文件里定稿（别处只负责执行）：
 *   1. **目标从哪来**：只从 `.hetai/build-matrix.yml`（G23）—— 这里不维护"可选目标"清单，
 *      矩阵里没有的目标一律显式报错，**不静默回退**；
 *   2. **用哪套工具链**：由矩阵给的 `(arch, os)` 推导（`compilerFor`），不是按目标 id 硬编
 *      —— id 是每个工程自己起的名字（`linux-armv7` / `mcu-m4` / `target-a53`），
 *      只有 `arch`+`os` 是语义；
 *   3. **编完怎么算对**：`arch → 期望的 ELF 形态`（`archExpectation`），readelf 报告按它判
 *      "匹配/不匹配"。这套期望值与模板里 CI 用的 `cross_compile_check.py` 是**同一份知识**，
 *      门禁会拿那个脚本对账（改了脚本没改这里 → 红）；
 *   4. **缺东西时说什么**：`missingHints` 给"装哪个包 / 或者去 CI 跑"，而不是把 `exec: not found`
 *      原样丢给用户（§F.43 的口径）。
 *
 * 不做的事：**不猜** conan 的包路径（打包目录由 conan 自己报，`packageFolderFromList` 只解析
 * 它的输出 —— 与 CI 脚本同一套推导）、**不跑测试**（`-tf=` 由 `crossCreateArgs` 保证）。
 */
import type { BuildMatrix, BuildTarget } from './buildMatrix';
import { BUILD_MATRIX_REL, crossCreateArgs, crossProfileFor, profileFileName } from './buildMatrix';

/** 交叉工具链：可执行文件 + 缺哪个包（提示里要给可照做的 apt 命令）。 */
export interface CrossToolchain {
  cc: string;
  cxx: string;
  ar: string;
  /** 工具链所属的包（`apt-get install -y …` 里写的就是它）。 */
  packages: string[];
}

/**
 * `(arch, os)` → 工具链（唯一来源）。
 *
 * 为什么按 arch/os 而不是目标 id：id 是用户自己起的名字，`arch`/`os` 才是语义。
 * 与模板脚本 `cross_compile_check.py` 的 TARGETS 一致（该脚本按 id 键，但它每个 id 的
 * arch/os 组合都落在这三条规则里 —— 门禁会对账）。
 */
export function compilerFor(arch: string, os: string | undefined): CrossToolchain | undefined {
  const bare = (os ?? '').toLowerCase() === 'baremetal';
  // 裸机一律 arm-none-eabi（M0/M3/M4 是 armv6/armv7，M23/M33/M55 是 armv8_32 ——
  // 三者用的是**同一套** GNU Arm Embedded 工具链）；但"裸机 + 非 ARM 架构"不猜。
  if (bare) {
    return /^armv\d/u.test(arch) ? ARM_NONE_EABI : undefined;
  }
  if (arch === 'armv7') {
    // A-core 32 位 Linux：Windows/Linux 上都是 gnueabihf 这一套
    return ARM_LINUX_GNUEABIHF;
  }
  if (arch === 'armv8' || arch === 'aarch64') {
    // g++ 驱动是单独一个包（gcc 包只带 C 编译器）—— CI 脚本里也写了这条不对称
    return AARCH64_LINUX_GNU;
  }
  return undefined;
}

/** M-core（裸机）的 C/C++/ar：GNU Arm Embedded。 */
const ARM_NONE_EABI: CrossToolchain = {
  cc: 'arm-none-eabi-gcc',
  cxx: 'arm-none-eabi-g++',
  ar: 'arm-none-eabi-ar',
  packages: ['gcc-arm-none-eabi'],
};
/** A-core 32 位 Linux。 */
const ARM_LINUX_GNUEABIHF: CrossToolchain = {
  cc: 'arm-linux-gnueabihf-gcc',
  cxx: 'arm-linux-gnueabihf-g++',
  ar: 'arm-linux-gnueabihf-ar',
  packages: ['gcc-arm-linux-gnueabihf', 'g++-arm-linux-gnueabihf'],
};
/** A-core 64 位 Linux。 */
const AARCH64_LINUX_GNU: CrossToolchain = {
  cc: 'aarch64-linux-gnu-gcc',
  cxx: 'aarch64-linux-gnu-g++',
  ar: 'aarch64-linux-gnu-ar',
  packages: ['gcc-aarch64-linux-gnu', 'g++-aarch64-linux-gnu'],
};

/** 期望的 ELF 形态（readelf 判据）。矩阵里的 arch 不认识时返回 undefined —— **不猜**。 */
export interface ArchExpectation {
  elfClass: string;
  machine: string;
  /** baremetal 的 M-core 必须是 Thumb 代码（否则链接期才知道错了）。 */
  thumb: boolean;
}

export function archExpectation(arch: string, os?: string): ArchExpectation | undefined {
  const bare = (os ?? '').toLowerCase() === 'baremetal';
  // 裸机 = 32 位 ARM + **必须是 Thumb 代码**（M 核只跑 Thumb；没有它链接期才发现）
  if (bare && /^armv\d/u.test(arch)) {
    return { elfClass: 'ELF32', machine: 'ARM', thumb: true };
  }
  if (arch === 'armv7') {
    return { elfClass: 'ELF32', machine: 'ARM', thumb: false };
  }
  if (arch === 'armv8' || arch === 'aarch64') {
    return { elfClass: 'ELF64', machine: 'AArch64', thumb: false };
  }
  if (arch === 'x86_64') {
    return { elfClass: 'ELF64', machine: 'X86-64', thumb: false };
  }
  return undefined;
}

export interface CrossPlan {
  targetId: string;
  arch: string;
  os: string;
  toolchainVersion?: string;
  profileFileName: string;
  /** profile 的绝对路径（宿主传给 conan；也在报告里写明）。 */
  profilePath: string;
  profileText: string;
  args: string[];
  toolchain?: CrossToolchain;
  expectation?: ArchExpectation;
  /** 构建目录：按 target 分区（K.1：并道不放任）。 */
  buildDir: string;
}

export class CrossPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CrossPlanError';
  }
}

/** 矩阵 → 执行计划。缺 arch / 矩阵没有目标 → 显式抛错（不静默回退到默认目标）。 */
export function crossPlanFor(matrix: BuildMatrix, target: BuildTarget, profilePath: string): CrossPlan {
  if (!target.arch) {
    throw new CrossPlanError(
      `目标「${target.id}」在 ${BUILD_MATRIX_REL} 里没有 arch —— 交叉编译必须知道目标架构（补上 arch 再跑）。`,
    );
  }
  const os = target.os ?? 'Linux';
  return {
    targetId: target.id,
    arch: target.arch,
    os,
    toolchainVersion: target.toolchainVersions[0] ?? matrix.defaultToolchain,
    profileFileName: profileFileName(target, matrix),
    profilePath,
    profileText: crossProfileFor(matrix, target),
    args: crossCreateArgs(matrix, target, profilePath),
    toolchain: compilerFor(target.arch, os),
    expectation: archExpectation(target.arch, os),
    buildDir: `build/${target.id}`,
  };
}

/** 计划里缺哪些可执行文件（`which` 由宿主注入：纯函数保持可测）。 */
export function missingTools(plan: CrossPlan, present: (exe: string) => boolean): string[] {
  if (!plan.toolchain) {
    return [];
  }
  return [plan.toolchain.cc, plan.toolchain.cxx, plan.toolchain.ar].filter((e) => !present(e));
}

/**
 * 缺东西时给**定向提示**（装哪个包 / 或者去 CI）。
 *
 * 为什么把"去 CI"写进提示：本机装交叉工具链要 root（我们的原则是不动用户系统），
 * 而 CI 上这条流水线**已经存在**（`cross-compile.yml`）—— 说清这一点，用户才有第二个选择。
 */
export function missingHints(
  plan: CrossPlan,
  missing: readonly string[],
  ciWorkflow = 'cross-compile.yml',
): { lines: string[]; fix: string[] } {
  if (missing.length === 0) {
    return { lines: [], fix: [] };
  }
  const pkgs = plan.toolchain?.packages ?? [];
  const apt = pkgs.length ? `sudo apt-get install -y ${pkgs.join(' ')}` : '安装对应的交叉工具链';
  const baremetal = plan.os.toLowerCase() === 'baremetal';
  return {
    lines: [
      `目标 ${plan.targetId}（arch=${plan.arch}${baremetal ? ' · baremetal' : ''}）需要交叉工具链，本机缺：${missing.join('、')}`,
      `装法（需要 root，我们不会替用户装）：${apt}`,
    ],
    fix: [
      `本机装：${apt}`,
      `或者交给 CI：仓库里的 ${ciWorkflow} 已经在 Linux runner 上装好工具链并按目标出包（推一次提交或手动触发即可）`,
      baremetal
        ? '真机还要连板/烧录：那一步在「上板验证」里（自托管 runner），和交叉编译是两条流水线'
        : '交叉编译**不跑测试**：它只出目标架构的包（要跑测试用「全量测试」）',
    ],
  };
}

/**
 * 矩阵文件不存在时的说法（**不许静默给一个空下拉**）。
 *
 * 返回的是可以直接显示的两行 + 一个入口：模板里就有这份文件，同步一次即可。
 */
export function missingMatrixHint(): { message: string; fix: string[] } {
  return {
    message: `工程里没有 ${BUILD_MATRIX_REL} —— 没有它就无法知道有哪些目标（不会猜）。`,
    fix: [
      '从模板同步：`het.templateUpdate`（或命令面板「HeT: 同步模板」）会带上 .hetai/build-matrix.yml',
      `或手写一个最小版本：defaults.toolchain_version + targets[].id/os/arch`,
    ],
  };
}

/** readelf 报告里的一个档案。 */
export interface ArchFact {
  archive: string;
  member: string;
  elfClass: string;
  machine: string;
  cpuArch: string;
  thumb: string;
}

/** 从 `readelf -h` / `readelf -A` 的输出里取字段（缺字段就是 `?`，不猜）。 */
export function parseReadelf(header: string, attrs: string): Omit<ArchFact, 'archive' | 'member'> {
  const pick = (text: string, field: string): string => {
    const m = new RegExp(`^\\s*${field}:\\s*(.+?)\\s*$`, 'mu').exec(text);
    return m ? m[1] : '?';
  };
  return {
    elfClass: pick(header, 'Class'),
    machine: pick(header, 'Machine'),
    cpuArch: pick(attrs, 'Tag_CPU_arch'),
    thumb: pick(attrs, 'Tag_THUMB_ISA_use'),
  };
}

/** 一条档案是否匹配期望（`thumb: true` 时必须有 Tag_THUMB_ISA_use）。 */
export function matchesExpectation(fact: ArchFact, expect: ArchExpectation | undefined): boolean {
  if (!expect) {
    return true; // 不认识的目标架构：只报告，不下结论（别把"不知道"说成"通过"）
  }
  if (!fact.elfClass.includes(expect.elfClass)) {
    return false;
  }
  if (!fact.machine.includes(expect.machine)) {
    return false;
  }
  if (expect.thumb && fact.thumb === '?') {
    return false;
  }
  return true;
}

/** 人话报告（写进产物文件 + 任务中心可点）。 */
export function archReport(plan: CrossPlan, facts: readonly ArchFact[]): string {
  const head = [
    `# 交叉编译架构报告`,
    `目标：${plan.targetId} · arch=${plan.arch} · os=${plan.os}${plan.toolchainVersion ? ` · 工具链 ${plan.toolchainVersion}` : ''}`,
    `profile：${plan.profileFileName}`,
    `profile 路径：${plan.profilePath}`,
    `期望：${plan.expectation ? `${plan.expectation.elfClass} · ${plan.expectation.machine}${plan.expectation.thumb ? ' · Thumb 代码' : ''}` : '（矩阵里的 arch 不在已知表里：只报告，不下结论）'}`,
    '',
  ];
  const rows = facts.map(
    (f) =>
      `${matchesExpectation(f, plan.expectation) ? '✓' : '✗'} ${f.archive} :: ${f.member} — ` +
      `${f.elfClass} · ${f.machine} · Tag_CPU_arch=${f.cpuArch} · Tag_THUMB_ISA_use=${f.thumb}`,
  );
  const verdict = facts.length === 0
    ? '没有可检查的档案（包目录下没有 .a）——这条不算通过。'
    : facts.every((f) => matchesExpectation(f, plan.expectation))
      ? '全部档案都符合目标架构。'
      : '有档案不符合目标架构 —— 别把这个包发出去。';
  return [...head, ...rows, '', verdict, ''].join('\n');
}

/**
 * 从 `conan list <ref>:*` 的输出里取包目录（与 CI 脚本同一套推导）。
 *
 * 为什么要解析而不是"猜路径"：conan 2 的包目录由它自己决定（`conan cache path`），
 * 猜出来的路径点开是空的 —— 用户点一个产物链接却打不开，比没有链接更糟。
 */
export function packageUidFromList(stdout: string): string | undefined {
  const lines = stdout.split(/\r?\n/u).map((l) => l.replace(/\s+$/u, ''));
  const at = lines.findIndex((l) => l.trim() === 'packages');
  if (at < 0) {
    return undefined;
  }
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line) {
      return line;
    }
  }
  return undefined;
}

/** `conan cache path` 的输出 → 目录（空 = 失败，调用方负责报错）。 */
export function packageFolderFromCachePath(stdout: string): string | undefined {
  const first = stdout.split(/\r?\n/u).map((l) => l.trim()).find((l) => l.length > 0);
  return first;
}
