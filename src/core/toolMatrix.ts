/**
 * 工具矩阵（计划 §9）：**谁装、怎么装、要不要人**的唯一数据源。
 *
 * 为什么单独一层：外部评审第 1/4 条的原话是「**要说明是否需要人为介入**；后台是自行安装的，
 * 还是需要手动安装」，而质量面板此前每项各写各的提示、且 clang-format/clang-tidy 这类
 * "本机装没装"完全是"随缘"。把归属与处置放在一处，面板、环境自检、单页卡片就都说同一套话。
 *
 * 纯数据 + 纯函数（不 import vscode），可直接单测。
 */

/** 谁来装/提供这个工具。 */
export type ToolOwner =
  /** 车道私有 venv（用户级，不需要 root） */
  | 'lane-venv'
  /** 系统包，缺了要 root（有免密 root 自动装，否则给命令） */
  | 'system-root'
  /** 宿主机器（用户自己装，插件不动系统） */
  | 'host'
  /** Docker 容器（MegaLinter） */
  | 'docker';

/** 属于哪条链（用于"缺了会怎样"的说明）。 */
export type ToolChain = 'build' | 'coverage' | 'docs' | 'quality' | 'security' | 'optional';

export interface ToolSpec {
  id: string;
  label: string;
  owner: ToolOwner;
  chain: ToolChain;
  /** CI 里是否是**阻塞门禁**（缺了 CI 会红）。 */
  ciBlocking: boolean;
  /** 本地缺失时的处置（人话，含可复制命令或"自动安装"）。 */
  install: string;
}

/** 与 §9 表格一一对应；新增长动作/门禁工具必须在此登记（单测会校验 id 集合）。 */
export const TOOL_MATRIX: readonly ToolSpec[] = [
  {
    id: 'clang-format',
    label: '格式检查 (clang-format)',
    owner: 'host',
    chain: 'quality',
    ciBlocking: true,
    install: '需要你执行：pip install clang-format（warning 即失败，本地绿=CI 绿）',
  },
  {
    id: 'clang-tidy',
    label: '静态检查 (clang-tidy)',
    owner: 'host',
    chain: 'quality',
    ciBlocking: true,
    install: '需要你执行：装 LLVM/clang-tools（如 sudo apt-get install clang-tidy，或 conda/官方包）',
  },
  {
    id: 'commitlint',
    label: '提交信息规范 (commitlint)',
    owner: 'host',
    chain: 'quality',
    ciBlocking: true,
    install: '需要你执行：npm i -g @commitlint/cli（或用 npx 临时跑）',
  },
  {
    id: 'gitleaks',
    label: '密钥扫描 (gitleaks)',
    owner: 'host',
    chain: 'security',
    ciBlocking: true,
    install: '需要你执行：装 gitleaks（CI 原生门禁；本地不装则本项标 –，但 CI 仍会拦）',
  },
  {
    id: 'megalinter',
    label: '深度扫描 (MegaLinter / SAST)',
    owner: 'docker',
    chain: 'security',
    ciBlocking: true,
    install: '需要你执行：装 Docker（首次拉 MegaLinter 镜像约 1–2 GB）；不装则本项标 –，但 CI 里它是**阻塞门禁** → 本地不装时建议直接走在线 CI',
  },
  {
    id: 'conan',
    label: 'conan',
    owner: 'lane-venv',
    chain: 'build',
    ciBlocking: true,
    install: '自动安装（车道私有 venv 内 pip 装，不碰系统）',
  },
  {
    id: 'cmake',
    label: 'cmake',
    owner: 'lane-venv',
    chain: 'build',
    ciBlocking: true,
    install: '自动安装（车道 venv 自带；构建时跳过 ConanCenter 那份）',
  },
  {
    id: 'ninja',
    label: 'ninja',
    owner: 'lane-venv',
    chain: 'build',
    ciBlocking: false,
    install: '自动安装（车道 venv 自带）',
  },
  {
    id: 'gcc',
    label: '编译器 (gcc-13 基线)',
    owner: 'system-root',
    chain: 'build',
    ciBlocking: true,
    install: '有免密 root 时自动 apt 装；否则需要你执行：sudo apt-get install -y gcc g++',
  },
  {
    id: 'lcov',
    label: 'lcov（覆盖率）',
    owner: 'system-root',
    chain: 'coverage',
    ciBlocking: false,
    install: '有免密 root 时自动 apt 装；否则需要你执行：sudo apt-get install -y lcov',
  },
  {
    id: 'make',
    label: 'make（构建链与文档链都要）',
    owner: 'system-root',
    chain: 'build',
    ciBlocking: true,
    install: '有免密 root 时自动 apt 装；否则需要你执行：sudo apt-get install -y make',
  },
  {
    id: 'doxygen',
    label: 'doxygen',
    owner: 'system-root',
    chain: 'docs',
    ciBlocking: true,
    install: '有免密 root 时自动 apt 装；否则需要你执行：sudo apt-get install -y doxygen',
  },
  {
    id: 'graphviz',
    label: 'graphviz（dot）',
    owner: 'system-root',
    chain: 'docs',
    ciBlocking: true,
    install: '有免密 root 时自动 apt 装；否则需要你执行：sudo apt-get install -y graphviz',
  },
  {
    id: 'sphinx',
    label: 'sphinx（文档渲染）',
    owner: 'lane-venv',
    chain: 'docs',
    ciBlocking: true,
    install: '自动安装（车道 venv 内 pip 装；文档需要用 Python ≥3.10）',
  },
];

export function toolSpec(id: string): ToolSpec | undefined {
  return TOOL_MATRIX.find((t) => t.id === id);
}

/** 探测结果 → 面板/自检条目（`present: undefined` = 尚未探测，别谎报缺失）。 */
export interface ToolRowView {
  id: string;
  label: string;
  /** 面板第二列的短标签（工具名 / 缺失说明）。 */
  tool: string;
  present: boolean | undefined;
  /** 缺失时的人话（含"要不要人"）。 */
  detail?: string;
}

export function toolRowsFromPresence(presence: Readonly<Record<string, boolean | undefined>>): ToolRowView[] {
  return TOOL_MATRIX.map((spec) => {
    const present = presence[spec.id];
    return {
      id: spec.id,
      label: spec.label,
      tool: present === false ? `${spec.label.split(' ')[0]} 未安装` : spec.label,
      present,
      ...(present === false ? { detail: spec.install } : {}),
    };
  });
}

/**
 * 人话总结：这台机器上"本地门禁"能不能自己跑完（§9 的关键结论）。
 * `ready` = 阻塞门禁里已就绪数 / 总数；缺失的列出名字。
 */
export function localGateSummary(presence: Readonly<Record<string, boolean | undefined>>): {
  ready: number;
  total: number;
  missing: string[];
  hint: string;
} {
  const blocking = TOOL_MATRIX.filter((t) => t.ciBlocking && (t.chain === 'quality' || t.chain === 'security'));
  const missing = blocking.filter((t) => presence[t.id] === false).map((t) => t.id);
  const ready = blocking.length - missing.length;
  const hint =
    missing.length === 0
      ? '本地门禁工具齐备'
      : `${missing.join('、')} 未装 —— 本地跑不全，但 CI 仍会拦（按条目里的命令装即可）`;
  return { ready, total: blocking.length, missing, hint };
}
