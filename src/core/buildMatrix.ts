/**
 * **目标矩阵**（`.hetai/build-matrix.yml`）的读取与交叉 profile 生成（K 块 / §6-K.1）。
 *
 * 为什么单独一层：交叉编译的目标（id / arch / 工具链）**只能有一个来源** —— 就是模板里的
 * `.hetai/build-matrix.yml`。硬编码目标名（`arm-linux-a53` 之类）会在矩阵变化时静默失配，
 * 那种错误的症状是"构建出来的架构不对"，极难查。所以：
 *   · 解析失败 **必须显式抛错**（绝不返回空列表 —— 空列表会让下拉框静默变空）；
 *   · profile 文本由此处生成，并带稳定 hash（供账本比对"上次用的是哪份 profile"）；
 *   · conan 命令参数里 **强制** `-pr:b=default`（漏掉它 = cross profile 泄漏进 build context，
 *     工具类包会被编成 arm，症状是 `exec format error`）。
 *
 * 纯逻辑（只依赖 node:crypto 做 hash），可直接单测。
 */
import { createHash } from 'node:crypto';

export const BUILD_MATRIX_REL = '.hetai/build-matrix.yml';

export class BuildMatrixError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BuildMatrixError';
  }
}

export interface BuildTarget {
  id: string;
  enabled: boolean;
  isDefault: boolean;
  buildKind?: string;
  os?: string;
  arch?: string;
  toolchainVersions: string[];
}

export interface BuildMatrix {
  /** 模板包的引用（如 `fcpp/1.0.0`）。 */
  packageRef: string;
  mode?: string;
  defaultToolchain?: string;
  createExtraArgs?: string;
  targets: BuildTarget[];
}

interface Line {
  indent: number;
  text: string;
  no: number;
}

function scalar(raw: string): string {
  return raw.trim().replace(/^["'](.*)["']$/u, '$1');
}

function linesOf(text: string): Line[] {
  const out: Line[] = [];
  text.split(/\r?\n/u).forEach((raw, i) => {
    const no = i + 1;
    const withoutComment = raw.replace(/\s+#.*$/u, '');
    if (!withoutComment.trim() || /^\s*#/u.test(withoutComment)) {
      return;
    }
    out.push({ indent: withoutComment.length - withoutComment.trimStart().length, text: withoutComment.trim(), no });
  });
  return out;
}

/**
 * 解析目标矩阵。只支持这个文件实际用到的 YAML 子集（两层映射 + 对象列表 + 字符串列表）；
 * 遇到不认识的结构**抛错并指出行号**（"静默忽略"会让目标凭空消失）。
 */
export function parseBuildMatrix(text: string, sourceName = BUILD_MATRIX_REL): BuildMatrix {
  const lines = linesOf(text);
  if (lines.length === 0) {
    throw new BuildMatrixError(`${sourceName} 是空的 —— 没有目标矩阵就无法交叉编译`);
  }
  const matrix: BuildMatrix = { packageRef: '', targets: [] };
  let section: 'none' | 'defaults' | 'targets' = 'none';
  let target: BuildTarget | undefined;
  let inToolchainList = false;

  for (const line of lines) {
    const isListItem = line.text.startsWith('- ');
    const body = isListItem ? line.text.slice(2).trim() : line.text;
    const kv = /^([A-Za-z0-9_.-]+):\s*(.*)$/u.exec(body);

    if (line.indent === 0 && !isListItem && kv) {
      const key = kv[1];
      const value = kv[2];
      inToolchainList = false;
      if (key === 'defaults') {
        section = 'defaults';
        continue;
      }
      if (key === 'targets') {
        section = 'targets';
        continue;
      }
      section = 'none';
      if (key === 'package_ref') {
        matrix.packageRef = scalar(value);
      } else {
        // 顶层未知键：不静默忽略（模板/矩阵演进时能立刻发现）
        throw new BuildMatrixError(`${sourceName}:${line.no} 顶层键「${key}」不认识（本解析器只认 package_ref/defaults/targets）`);
      }
      continue;
    }

    if (section === 'defaults' && kv && line.indent > 0) {
      const key = kv[1];
      const value = scalar(kv[2]);
      if (key === 'mode') {
        matrix.mode = value;
      } else if (key === 'toolchain_version') {
        matrix.defaultToolchain = value;
      } else if (key === 'create_extra_args') {
        matrix.createExtraArgs = value;
      } else {
        throw new BuildMatrixError(`${sourceName}:${line.no} defaults 里的键「${key}」不认识`);
      }
      continue;
    }

    if (section === 'targets') {
      // 先处理 `toolchain_versions:` 下的列表项 —— 它们也以 `- ` 开头，但不是 key:value
      if (inToolchainList && line.text.startsWith('- ')) {
        if (!target) {
          throw new BuildMatrixError(`${sourceName}:${line.no} 工具链列表项出现在目标之前`);
        }
        target.toolchainVersions.push(scalar(line.text.slice(2)));
        continue;
      }
      if (isListItem) {
        const kv2 = /^([A-Za-z0-9_.-]+):\s*(.*)$/u.exec(body);
        if (!kv2) {
          throw new BuildMatrixError(`${sourceName}:${line.no} 目标项必须是「key: value」`);
        }
        if (kv2[1] === 'id') {
          target = { id: scalar(kv2[2]), enabled: true, isDefault: false, toolchainVersions: [] };
          matrix.targets.push(target);
          inToolchainList = false;
          continue;
        }
        if (!target) {
          throw new BuildMatrixError(`${sourceName}:${line.no} 目标项缺少 id`);
        }
        assignTargetKey(target, kv2[1], scalar(kv2[2]), line.no, sourceName);
        continue;
      }
      if (!target) {
        throw new BuildMatrixError(`${sourceName}:${line.no} 目标字段出现在任何目标之前`);
      }
      if (line.text.endsWith(':')) {
        const key = line.text.slice(0, -1).trim();
        if (key !== 'toolchain_versions') {
          throw new BuildMatrixError(`${sourceName}:${line.no} 目标里的嵌套键「${key}」不认识`);
        }
        inToolchainList = true;
        continue;
      }
      if (kv) {
        inToolchainList = false;
        assignTargetKey(target, kv[1], scalar(kv[2]), line.no, sourceName);
        continue;
      }
      throw new BuildMatrixError(`${sourceName}:${line.no} 无法解析这一行：「${line.text}」`);
    }

    throw new BuildMatrixError(`${sourceName}:${line.no} 无法解析这一行：「${line.text}」`);
  }

  if (!matrix.packageRef) {
    throw new BuildMatrixError(`${sourceName} 缺少 package_ref`);
  }
  if (matrix.targets.length === 0) {
    throw new BuildMatrixError(`${sourceName} 里没有任何 target —— 交叉编译无从下手`);
  }
  return matrix;
}

function assignTargetKey(
  target: BuildTarget,
  key: string,
  value: string,
  no: number,
  sourceName: string,
): void {
  switch (key) {
    case 'enabled':
      target.enabled = value !== 'false';
      return;
    case 'default':
      target.isDefault = value === 'true';
      return;
    case 'build_kind':
      target.buildKind = value;
      return;
    case 'os':
      target.os = value;
      return;
    case 'arch':
      target.arch = value;
      return;
    case 'toolchain_versions':
      target.toolchainVersions = [value];
      return;
    default:
      throw new BuildMatrixError(`${sourceName}:${no} 目标 ${target.id} 的键「${key}」不认识`);
  }
}

export function enabledTargets(matrix: BuildMatrix): BuildTarget[] {
  return matrix.targets.filter((t) => t.enabled);
}

/** 目标选择：给定 id 必须存在（不存在就抛错，**不静默回退到默认目标**）。 */
export function pickTarget(matrix: BuildMatrix, id?: string): BuildTarget {
  const enabled = enabledTargets(matrix);
  if (id) {
    const found = enabled.find((t) => t.id === id);
    if (!found) {
      throw new BuildMatrixError(
        `目标「${id}」不在 ${BUILD_MATRIX_REL} 的启用列表里（可选：${enabled.map((t) => t.id).join('、')}）`,
      );
    }
    return found;
  }
  return enabled.find((t) => t.isDefault) ?? enabled[0];
}

export function toolchainVersionFor(matrix: BuildMatrix, target: BuildTarget): string | undefined {
  return target.toolchainVersions[0] ?? matrix.defaultToolchain;
}

/** 交叉 profile 路径（落在扩展存储里，**不进用户工程** —— C5）。 */
export function profileFileName(target: BuildTarget, matrix: BuildMatrix): string {
  const version = toolchainVersionFor(matrix, target) ?? 'default';
  return `het-${target.id}-${version}.profile`;
}

/**
 * 生成 conan 2 profile 文本。
 *
 * 编译器版本从工具链版本里取主版本号（`11.3.rel1` → `11`）—— 这是 arm-none-eabi /
 * aarch64-linux-gnu 的通行做法；`arch`/`os` 直接来自矩阵，**不猜**。
 * 生成结果会被门禁交给真实 conan 校验（`conan profile show -pr:h` 必须接受）。
 */
export function crossProfileFor(matrix: BuildMatrix, target: BuildTarget): string {
  const version = toolchainVersionFor(matrix, target);
  const major = version ? /^(\d+)/u.exec(version)?.[1] : undefined;
  if (!target.arch) {
    throw new BuildMatrixError(`目标「${target.id}」没有 arch —— 无法生成交叉 profile`);
  }
  if (!major) {
    throw new BuildMatrixError(`目标「${target.id}」没有可用工具链版本（toolchain_versions / defaults.toolchain_version）`);
  }
  const os = target.os ?? 'Linux';
  return [
    '# 由 HeT DevTools 生成 —— 来源：' + BUILD_MATRIX_REL,
    `# target: ${target.id}${target.buildKind ? ` (build_kind=${target.buildKind})` : ''}`,
    '[settings]',
    `os=${os}`,
    `arch=${target.arch}`,
    'compiler=gcc',
    `compiler.version=${major}`,
    'compiler.libcxx=libstdc++11',
    'build_type=Release',
    '',
  ].join('\n');
}

export function profileHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * `conan create` 的参数（交叉编译）。
 *
 * **`-pr:b=default` 是硬要求**（G24）：漏掉它，cross profile 会泄漏进 build context，
 * 于是 protoc/cmake 这类构建期工具也被编成 arm，之后本机再构建就 `exec format error`。
 * `-tf=""`（跳过 test folder）是"交叉编译 ≠ 跑测试"的机制保证（C11a）。
 */
export function crossCreateArgs(matrix: BuildMatrix, target: BuildTarget, profilePath: string): string[] {
  if (!target.arch) {
    throw new BuildMatrixError(`目标「${target.id}」没有 arch，拒绝生成交叉构建命令`);
  }
  const extra = (matrix.createExtraArgs ?? '').trim();
  const extraArgs = extra ? extra.split(/\s+/u).filter((a) => a !== '--test-folder=') : [];
  return ['create', '.', '-pr:b=default', `-pr:h=${profilePath}`, '-tf=', ...extraArgs];
}
