/**
 * **Intent Registry**（计划 §3.4 / §6-I）：把"一个动作点下去会发生什么"变成**一份可校验的表**。
 *
 * 为什么需要它（C11，用户第二轮的原话）：
 *   「每个 action 引起的后续联动、状态刷新、回显、退出，你都得想清楚」
 * V1 的错法是**四类入口各自为政**：卡片一张表、悬停一份 label、命令面板一份 title、
 * Copilot 入口又是另一份 hint —— 于是同一个动作在四个地方说法不同，新增一个动作要改四处，
 * 而且改漏了没有任何人会发现（用户看到的是"点了没反应"）。
 *
 * 现在：**一条 Intent 就是一次"定向落地契约"**，其余全是外壳：
 *   · 卡片按钮      → `data-act="<intent.id>"`（host 用 `commandOf()` 翻译）
 *   · 悬停动作      → 同一批 intent id（门禁：悬停动作 ⊆ 本表）
 *   · 命令面板      → `package.json` 的命令（门禁：本表的 command 都真实声明了）
 *   · chip / 页内卡片 → 三处状态项取同一条 intent 的 `status` 域与 `name`
 *
 * 纯数据 + 纯函数，**不 import vscode**（可直接单测）。真正的执行在 host 侧（唯一执行器）。
 */
import { DEADLINE_KINDS, type DeadlineKind } from './deadlines';
import type { StatusDomain } from './statusItem';

/** 动作形态：长任务（进调度器）· Copilot 入口（开 Chat）· 导航（只开页内视图）。 */
export type IntentKind = 'task' | 'copilot' | 'nav';

/** 输出通道的域（行首 `[domain]` 标签；§7 单一通道的结构化标签）。 */
export type OutputDomain = 'build' | 'test' | 'docs' | 'env' | 'quality' | 'release' | 'chat';

/**
 * 允许牵动的 VS Code 体系（§3.4.1 的联动矩阵）。
 *
 * 这份声明**有用**：host 侧只有声明了 `notifications` 的动作才允许弹窗（其余一律只写输出），
 * 只有声明了 `terminal` 的才允许开终端。门禁会断言声明与 host 的真实调用一致 ——
 * "悄悄多开一个东西"就不会再发生。
 */
export type VscodeSurface =
  | 'output'
  | 'terminal'
  | 'chat'
  | 'problems'
  | 'editor'
  | 'testExplorer'
  | 'scm'
  | 'status'
  | 'notifications';

/** Copilot 出口：命令 + 预填 tag（`required` 缺一个即门禁失败，§3.4.3 / G22）。 */
export interface IntentPrompt {
  command: string;
  /** 卡片上的"预期产物"（§8 Phase 1：不能让用户猜）。**唯一来源**：卡片不再手抄一份。 */
  expect: string;
  /** 预填里出现的全部 tag（如 `[scope: build]`）。 */
  tags: readonly string[];
  /** 必备 tag 的**前缀**（如 `[scope`）—— 值可以来自 Fact，前缀必须有。 */
  required: readonly string[];
  /** 预填正文（跟在命令后；落盘类动作必须写明"确认后才写盘"）。 */
  hint: string;
}

export interface Intent {
  id: string;
  /** 领域术语名（§5.2 定稿）：输出行的 `▶ <name>`、卡片按钮、任务名共用这一串字。 */
  name: string;
  kind: IntentKind;
  /** 幂等键（重复点击 = 同一个任务，不排两个）。 */
  idem: string;
  /** 超时类别 —— **引用** `core/deadlines.ts` 的定稿阈值，不在这里复制数字。 */
  deadline: DeadlineKind;
  /** 三处状态项（chip / 悬停 / 页内）落在哪个域（rail 定稿名的来源）。 */
  status: StatusDomain;
  /** 唯一输出通道的域 + 是否自动聚焦（`null` = 这个动作不写输出）。 */
  output: { domain: OutputDomain; focus: boolean } | null;
  /** 执行入口的命令 id（卡片 `data-act` / 悬停链接 / 命令面板都走它）。 */
  command: string;
  /**
   * 忙语义/状态项里的 id（仅当它与 `id` 不同时写）。
   *
   * 为什么会有两份 id：卡片按钮用的是**入口**语义（`docsRun` = "跑文档构建"），
   * 而忙语义/输出通道用的是**任务**语义（`docsBuild` = "文档构建中"）。
   * 以前这两个名字散在两处表里，改一边忘了另一边就是"跑完了状态不变"；
   * 现在就在这里显式挂上，并有门禁逼着每个 busy action 都能反查到 Intent。
   */
  busy?: string;
  /** 页内互斥视图 id（打开/聚焦哪个 Slot；A 块后不再开页签）。 */
  slot?: string;
  /** Copilot 出口：要么给出 prompt（含必备 tag），要么用 `promptNone` 显式说明为什么没有。 */
  prompt?: IntentPrompt;
  promptNone?: string;
  vscode: readonly VscodeSurface[];
  /** 失败时的下一步 + 要不要打扰用户（`needsHuman=false` 只写输出，不弹窗）。 */
  onFail: { next: string; needsHuman: boolean };
  /** CI 对应（§5.2 / G16）。`null` = **仅本地**，必须在副标题里写明"无 CI 对应"。 */
  ci: { workflow: string; job: string } | null;
  /**
   * 显式声明"这个动作**本来就不该有** CI 对应"（本地自检/运维类）。
   *
   * 为什么要写出来：`ci: null` 有两种含义 —— "暂时没接"与"本地动作天然没有"。
   * 不区分的话，门禁只能靠白名单硬编，而硬编名单会随着新增动作悄悄失效。
   */
  localOnly?: boolean;
}

export const INTENTS: readonly Intent[] = [
  // ── 环境车道 ────────────────────────────────────────────────────────────
  {
    id: 'health',
    name: '环境体检',
    kind: 'task',
    idem: 'health',
    deadline: 'misc',
    status: 'env',
    output: { domain: 'env', focus: false },
    command: 'het.healthCheck',
    promptNone: '体检是本地自检：结论在「就绪」行与 Slot 明细里；要 Copilot 讲清缺什么用 `/het-setup`。',
    vscode: ['status'],
    onFail: { next: '体检本身失败：把「环境」输出通道的 tail 贴给 Copilot（`/het-setup`）。', needsHuman: false },
    ci: null,
    localOnly: true,
  },
  {
    // /het-setup 是**独立入口**（挂在环境卡的次级按钮上）：它回答的是"为什么这样、该装什么"，
    // 而不是自己去做体检 —— 所以与 `health` 分开登记（否则会出现"体检有 Copilot 出口"的错觉）。
    id: 'setupCopilot',
    name: '环境答疑',
    kind: 'copilot',
    idem: 'setupCopilot',
    deadline: 'misc',
    status: 'env',
    output: { domain: 'chat', focus: false },
    command: '/het-setup',
    prompt: {
      command: '/het-setup',
      expect: '预期：环境诊断 + 安装清单',
      tags: ['[platform: desktop]', '[arch: <本机>]'],
      required: ['[platform'],
      hint: '按当前环境自检结果讲清缺什么、谁装、怎么装；需要 root 的给可复制命令，别静默改我的系统。',
    },
    vscode: ['chat', 'status'],
    onFail: { next: '若 Chat 没打开：在 Copilot Chat 里执行 `/het-setup`；完整自检日志在「就绪」。', needsHuman: false },
    ci: null,
    localOnly: true,
  },
  {
    id: 'envCheck',
    name: '检查环境',
    kind: 'task',
    idem: 'envCheck',
    deadline: 'misc',
    status: 'env',
    output: { domain: 'env', focus: false },
    command: 'het.envCheck',
    promptNone: '检查环境是本地自检：结论在「就绪」行 + 悬停里，没有 Copilot 出口。',
    vscode: ['status'],
    onFail: { next: '检查环境失败：看「环境」输出通道；若疑似权限问题，`/het-setup` 会给出可复制命令。', needsHuman: false },
    ci: null,
    localOnly: true,
  },
  {
    id: 'envPrepare',
    name: '准备托管环境',
    kind: 'task',
    idem: 'envPrepare',
    deadline: 'envPrepare',
    status: 'env',
    output: { domain: 'env', focus: true },
    command: 'het.envPrepare',
    prompt: {
      command: '/het-setup',
      expect: '预期：环境诊断 + 安装清单',
      tags: ['[platform: desktop]', '[arch: <本机>]'],
      required: ['[platform'],
      hint: '按当前环境自检结果讲清缺什么、谁装、怎么装；别动我的系统环境。',
    },
    vscode: ['output', 'status', 'notifications'],
    onFail: { next: '准备失败时优先看缺的系统包：可复制的 apt/命令在输出里；也可 `/het-setup` 讲清顺序。', needsHuman: true },
    ci: null,
    localOnly: true,
  },
  {
    id: 'envRemove',
    name: '移除托管环境',
    kind: 'task',
    idem: 'envRemove',
    deadline: 'envPrepare',
    status: 'env',
    output: { domain: 'env', focus: true },
    command: 'het.envRemove',
    promptNone: '移除是本地动作，没有 Copilot 出口（不想动系统就选它，它只删我们自己的车道）。',
    vscode: ['output', 'status', 'notifications'],
    onFail: { next: '移除失败：多半是文件被占用（先关掉正在构建的窗口），或权限不足。', needsHuman: true },
    ci: null,
    localOnly: true,
  },
  {
    id: 'cacheClean',
    name: '清理构建缓存',
    kind: 'task',
    idem: 'cacheClean',
    deadline: 'cacheClean',
    status: 'env',
    output: { domain: 'env', focus: true },
    command: 'het.cacheClean',
    promptNone: '缓存清理是本地运维动作：命令与影响面都在四档预览里，没有 Copilot 出口。',
    vscode: ['output', 'status', 'notifications'],
    onFail: { next: '清理失败：看输出里的 conan 原话；危险档请先跑一次"预览"确认影响面。', needsHuman: true },
    ci: null,
    localOnly: true,
  },
  {
    id: 'targetSwitch',
    name: '切换目标架构',
    kind: 'task',
    idem: 'targetSwitch',
    deadline: 'switchTarget',
    status: 'env',
    output: { domain: 'env', focus: true },
    command: 'het.targetSwitch',
    promptNone: '切换目标是本地 profile/账本操作：目标来自 `.hetai/build-matrix.yml`，没有 Copilot 出口。',
    vscode: ['output', 'status'],
    onFail: { next: '切换失败：先确认 `.hetai/build-matrix.yml` 里有这个目标，再确认交叉工具链装了。', needsHuman: true },
    ci: { workflow: 'cross-compile.yml', job: 'cross-compile' },
  },
  {
    id: 'cacheUsage',
    name: '查看缓存占用',
    kind: 'nav',
    idem: 'cacheUsage',
    deadline: 'misc',
    status: 'env',
    output: null,
    command: 'het.cacheUsage',
    promptNone: '体积报表是只读视图：数字就在页内，没有 Copilot 出口。',
    vscode: ['status'],
    onFail: { next: '扫描失败：确认 CONAN_HOME 路径可读（本机 conan 是否在 PATH）。', needsHuman: false },
    ci: null,
    localOnly: true,
  },
  {
    id: 'openSettings',
    name: '项目设置',
    kind: 'nav',
    idem: 'openSettings',
    deadline: 'misc',
    status: 'env',
    output: null,
    command: 'het.openSettings',
    slot: 'settings',
    promptNone: '设置面板是字段级编辑：改动与校验都在表单里，没有 Copilot 出口。',
    vscode: ['status'],
    onFail: { next: '打不开设置面板：先确认当前文件夹里有 metadata.json。', needsHuman: false },
    ci: null,
    localOnly: true,
  },

  {
    id: 'openTasks',
    name: '任务',
    kind: 'nav',
    idem: 'openTasks',
    deadline: 'misc',
    status: 'env',
    output: null,
    command: 'het.openTasks',
    slot: 'tasks',
    promptNone: '任务中心是只读的：唯一的动作是取消，没有 Copilot 出口。',
    vscode: ['status'],
    onFail: { next: '打不开任务中心：在跑什么看悬停卡的「构建」那行，取消用命令面板的「取消任务」。', needsHuman: false },
    ci: null,
    localOnly: true,
  },

  {
    id: 'openOutput',
    name: '输出',
    kind: 'nav',
    idem: 'openOutput',
    deadline: 'misc',
    status: 'env',
    output: null,
    command: 'het.openOutput',
    slot: 'output',
    promptNone: '输出是只读的：域/级别/关键字都在页内过滤，没有 Copilot 出口。',
    vscode: ['status'],
    onFail: { next: '打不开输出视图：输出面板本身始终可用（入口：查看 → 输出 → HeT DevTools）。', needsHuman: false },
    ci: null,
    localOnly: true,
  },

  // ── 构建验证 ────────────────────────────────────────────────────────────
  {
    id: 'crossBuild',
    name: '交叉编译',
    kind: 'task',
    idem: 'crossBuild',
    deadline: 'cross',
    status: 'build',
    output: { domain: 'build', focus: true },
    command: 'het.crossBuild',
    prompt: {
      command: '/het-setup',
      expect: '预期：目标架构的工具链怎么装（或指向 CI），以及目标包是否符合预期架构',
      tags: ['[platform: cross]', '[arch: <matrix 目标 id>]'],
      required: ['[arch'],
      hint: '交叉编译不跑测试也不烧板：只关心目标架构的包与 readelf 报告；测试用「全量测试」，上板用「上板验证」。',
    },
    vscode: ['output', 'status'],
    onFail: { next: '交叉编译失败：先看缺哪个交叉工具链（提示里给了 apt 包名），或把这一步交给 CI 的 cross-compile.yml。', needsHuman: true },
    ci: { workflow: 'cross-compile.yml', job: 'cross-compile' },
  },
  {
    id: 'build',
    name: '编译打包',
    kind: 'task',
    idem: 'build',
    deadline: 'build',
    status: 'build',
    output: { domain: 'build', focus: true },
    command: 'het.build',
    prompt: {
      command: '/het-build',
      expect: '预期：编译打包结论 + 可点的产物',
      tags: ['[scope: build]', '[std: <build_cppstd>]', '[bt: Release]'],
      required: ['[scope', '[std', '[bt'],
      hint: '按上面的参数跑一次构建，失败时定位到具体文件与命令，别顺手改无关代码。',
    },
    vscode: ['output', 'problems', 'status'],
    onFail: { next: '构建失败：输出里有完整 tail 与诊断；把第一条错误贴给 `/het-build` 让它定位。', needsHuman: false },
    ci: { workflow: 'ci-build-test.yml', job: 'build-and-test' },
  },
  {
    id: 'test',
    name: '全量测试',
    kind: 'task',
    idem: 'test',
    deadline: 'test',
    status: 'test',
    output: { domain: 'test', focus: true },
    command: 'het.test',
    prompt: {
      command: '/het-build',
      expect: '预期：全套测试结论 + 覆盖率对账',
      tags: ['[scope: tests]', '[std: <build_cppstd>]', '[bt: Release]', '[coverage: 1]'],
      required: ['[scope'],
      hint: '跑全套测试 + 覆盖率对账；哪条用例失败就只分析那一条，别重写测试。',
    },
    vscode: ['output', 'testExplorer', 'status'],
    onFail: { next: '测试失败：先看「测试结果」里的失败用例名，再用 `/het-build` 的 scope=tests 定位。', needsHuman: false },
    ci: { workflow: 'full-test-automation.yml', job: 'auto-testing' },
  },
  {
    id: 'openCoverageReport',
    name: '覆盖率报告',
    kind: 'nav',
    idem: 'openCoverageReport',
    deadline: 'misc',
    status: 'test',
    output: null,
    command: 'het.openCoverageReport',
    slot: 'coverage',
    promptNone: '报告是可读产物：直接打开 HTML/行级明细，没有 Copilot 出口。',
    vscode: ['editor', 'status'],
    onFail: { next: '打不开报告：先生成覆盖率（`配置：metadata` 打开开关后跑全量测试）。', needsHuman: false },
    ci: { workflow: 'full-test-automation.yml', job: 'reconcile' },
  },
  {
    id: 'openTools',
    name: '工具链一览',
    kind: 'nav',
    idem: 'openTools',
    deadline: 'misc',
    status: 'env',
    output: null,
    command: 'het.openTools',
    slot: 'tools',
    prompt: {
      command: '/het-setup',
      expect: '预期：把缺失的工具按"谁装/怎么装"排好序',
      tags: ['[tool: <名字>]', '[where: <路径>]'],
      required: ['[tool'],
      hint: '我这台机器上缺了这些工具，帮我按"要不要 root、能不能自动装"给出处置顺序；路径我已经在工具链一览里拿到了。',
    },
    vscode: ['status'],
    onFail: {
      next: '探测不出来：确认工具真的装在 PATH/conda/venv 里，或用 `het.tools.*` 手动指定路径。',
      needsHuman: false,
    },
    // 它本身不是一条流水线 —— "列出我这台机器的工具"在 CI 里没有对应 job（不编造）。
    ci: null,
    localOnly: true,
  },
  {
    // V3 · L4 / G10：入口 workflow（总编排）此前**整个扩展 0 引用**。
    // 这个入口只做一件事：把那台"按顺序跑 job 的机器"原文摆到眼前（不改、不跑）。
    id: 'openOrchestrator',
    name: 'CI 总编排',
    kind: 'nav',
    idem: 'openOrchestrator',
    deadline: 'misc',
    status: 'release',
    output: null,
    command: 'het.openOrchestrator',
    promptNone: '编排文件是仓库里的真身（YAML）：直接看原文，Copilot 只会转述一遍。',
    vscode: ['editor', 'status'],
    onFail: {
      next: '打不开：确认文件在 .github/workflows/ci-orchestrator.yml（非模板项目没有它）。',
      needsHuman: false,
    },
    // "打开一个文件"在 CI 里没有对应 job；文件本身由卡片呈现（见 `WORKFLOW_SURFACES`）。
    ci: null,
    localOnly: true,
  },
  {
    // V3 · L6c / G9：绑定文件的原文 —— 对账的另一半事实在 `include/` 的头里，
    // 所以先把"我要改的那个文件"摆到眼前（只读打开，不改、不跑）。
    id: 'openPythonBindings',
    name: '打开 Python 绑定文件',
    kind: 'nav',
    idem: 'openPythonBindings',
    deadline: 'misc',
    status: 'release',
    output: null,
    command: 'het.openPythonBindings',
    promptNone: '绑定文件是源码（C++）：直接看原文、对照 include/ 里的 @exporter 声明，Copilot 只会转述一遍。',
    vscode: ['editor', 'status'],
    onFail: {
      next: '打不开：确认绑定文件在 api/python_bindings.cpp（开了 Python 绑定时 CMake 会指向它）。',
      needsHuman: false,
    },
    // "打开一个文件"在 CI 里没有对应 job；文件本身由卡片呈现。
    ci: null,
    localOnly: true,
  },
  {
    // V3 · L5 / G4：新库自检 —— 逐条读工程里的真文件、对着模板合同判。
    id: 'newLibAudit',
    name: '新库自检',
    kind: 'nav',
    idem: 'newLibAudit',
    deadline: 'misc',
    status: 'release',
    output: null,
    command: 'het.openNewLibAudit',
    slot: 'newLibAudit',
    prompt: {
      command: '/het-audit',
      expect: '预期：把没过的条款按"改哪个文件"排序',
      tags: ['[scope: new-lib-contract]'],
      required: ['[scope'],
      hint: '我这边新库自检有几条没过，按"先改哪个文件、怎么改"给我排一下顺序；判决理由用我自己工程里的事实，别猜。',
    },
    vscode: ['status'],
    onFail: {
      next: '读不到工程文件：确认工作区里打开的是库根目录（含 metadata.json）。',
      needsHuman: false,
    },
    // "读我自己的文件"是本地判断，CI 里没有对应 job。
    ci: null,
    localOnly: true,
  },
  {
    // V3 · L5b / G5：模板同步检查（读 .het/template-ref.json + 本地模板副本 → 只读对比）。
    id: 'templateUpdate',
    name: '模板更新检查',
    kind: 'task',
    idem: 'templateUpdate',
    deadline: 'misc',
    status: 'env',
    output: { domain: 'env', focus: true },
    command: 'het.templateUpdate',
    promptNone: '它是本地对比：读标记文件与模板副本，生成只读的同步计划（不合入、不改你的文件）。',
    vscode: ['output', 'editor', 'status', 'notifications'],
    onFail: {
      next: '读不到模板副本：用 HET_TEMPLATE_LOCAL / het.template.localPath 指向它，或等网络恢复后再试。',
      needsHuman: true,
    },
    // 模板同步是**本地**动作：CI 里没有"检查你这个库落后多少"的 job（不编造）。
    ci: null,
    localOnly: true,
  },
  {
    // V3 · L6a / G7：「存为基线」—— 把**最近一次真跑出来的结果**钉成基线。
    id: 'pinBaseline',
    name: '存为基线',
    // 它不只是"开个视图"：会落 state（基线）并写一行输出 —— 所以是 task 而不是 nav
    // （nav 的契约是"只开视图、不写输出"）。
    kind: 'task',
    idem: 'pinBaseline',
    deadline: 'misc',
    status: 'test',
    output: { domain: 'test', focus: false },
    command: 'het.pinBenchBaseline',
    promptNone: '这是一次"记账"（把最近一次结果钉成基线），没有要问 Copilot 的东西。',
    vscode: ['status', 'output'],
    onFail: {
      next: '还没有可存的结果：先跑一次 bench（或在「上板验证」里粘贴串口输出解析）。',
      needsHuman: false,
    },
    // 基线是**我这台机器/这块板**的对比基准 —— CI 里没有对应的 job（不编造）。
    ci: null,
    localOnly: true,
  },
  {
    // V3 · L6b / G8：扫描当前产物的导出符号（问 conan 定位包目录 → nm 读符号表）。
    id: 'scanAbiSymbols',
    name: '扫描导出符号',
    kind: 'task',
    idem: 'scanAbiSymbols',
    deadline: 'misc',
    status: 'quality',
    output: { domain: 'quality', focus: false },
    command: 'het.scanAbiSymbols',
    promptNone: '符号表是产物里的事实：直接把 nm 的读数摆出来，没有要问 Copilot 的东西。',
    vscode: ['output', 'status'],
    onFail: {
      next: '读不到产物：先构建一次（② 构建站）；缺 nm 就装 binutils（或交给 CI 做）。',
      needsHuman: false,
    },
    // 符号对比是**本地产物**的事：CI 里没有"比对你这次构建出来的符号表"的 job。
    ci: null,
    localOnly: true,
  },
  {
    id: 'pinAbiBaseline',
    name: '存为符号基线',
    kind: 'task',
    idem: 'pinAbiBaseline',
    deadline: 'misc',
    status: 'quality',
    output: { domain: 'quality', focus: false },
    command: 'het.pinAbiBaseline',
    promptNone: '这是一次"记账"（把上次扫描钉成基线），没有要问 Copilot 的东西。',
    vscode: ['output', 'status'],
    onFail: {
      next: '还没有可存的扫描结果：先点「扫描当前产物」。',
      needsHuman: false,
    },
    ci: null,
    localOnly: true,
  },
  {
    // V3 · L6e：**实测编译期成本**（仅头文件库的"对外成本"）。
    // 忙语义用任务名 `headerCost`（状态栏/chip 上写"编译期成本实测"），
    // 卡片按钮用入口名 `probeHeaderCost` —— 两份语义在这一处显式挂上。
    id: 'probeHeaderCost',
    name: '实测编译期成本',
    kind: 'task',
    idem: 'probeHeaderCost',
    busy: 'headerCost',
    deadline: 'misc',
    status: 'quality',
    output: { domain: 'quality', focus: false },
    command: 'het.probeHeaderCost',
    promptNone:
      '这是一次量数：编两个探针 TU（只 include 公开头 / 空）取中位。要问 Copilot 的东西在这之前（"这个头该不该瘦"），不是这一步。',
    vscode: ['output', 'status'],
    onFail: {
      next: '探针编不过时：把公开头需要的第三方 include 目录加进设置 het.header.extraIncludes（不动你的工程）。',
      needsHuman: false,
    },
    ci: null,
    localOnly: true,
  },
  {
    id: 'pinHeaderCostBaseline',
    name: '存为编译期基线',
    kind: 'task',
    idem: 'pinHeaderCostBaseline',
    deadline: 'misc',
    status: 'quality',
    output: { domain: 'quality', focus: false },
    command: 'het.pinHeaderCostBaseline',
    promptNone: '这是一次"记账"（把上次实测钉成基线），没有要问 Copilot 的东西。',
    vscode: ['output', 'status'],
    onFail: {
      next: '还没有可存的实测结果：先点「实测一次」。',
      needsHuman: false,
    },
    ci: null,
    localOnly: true,
  },
  {
    // V3 · L5b / G6：上游最新（显式触发的一次网络查询；结果落缓存，卡片读缓存）。
    id: 'checkDepUpdates',
    name: '查上游最新',
    kind: 'task',
    idem: 'checkDepUpdates',
    deadline: 'misc',
    status: 'build',
    output: { domain: 'build', focus: false },
    command: 'het.checkDepUpdates',
    promptNone: '它是查版本号（`conan search … -r conancenter`）后与 conandata 比对，不替你升级。',
    vscode: ['output', 'status'],
    onFail: {
      next: '在线查询失败：检查组网/镜像（`配置：网络与源`），或直接用 `conan search <pkg> -r conancenter` 复核。',
      needsHuman: false,
    },
    // 它是一次查询，不是流水线；升级本身由 `deps`/构建去跑。
    ci: null,
    localOnly: true,
  },
  {
    id: 'openDeps',
    name: '依赖管理器',
    kind: 'nav',
    idem: 'openDeps',
    deadline: 'misc',
    status: 'build',
    output: null,
    command: 'het.openDeps',
    slot: 'deps',
    prompt: {
      command: '/het-deps',
      expect: '预期：四桶归属判断 + 双写改动预览',
      tags: ['[pkg: <conan 名>]', '[ver: <版本>]', '[bucket: common|c|cpp|infra]', '[baremetal: allow|deny]'],
      required: ['[pkg', '[bucket'],
      hint: '帮我判断这个包该进哪个桶（四桶归属），并检查 baremetal 白名单；改了要双写 conandata.yml 与 metadata.json。',
    },
    vscode: ['status'],
    onFail: { next: '依赖列表读不出来：先确认 conandata.yml 与 metadata.json 都在，且没被手动改坏。', needsHuman: false },
    ci: { workflow: 'metadata-controller.yml', job: 'analyze' },
  },
  {
    id: 'benchmark',
    name: '上板验证',
    // 它打开的是**页内面板**（上板是分钟级动作，参数多，得在面板里看前置检查）
    kind: 'nav',
    idem: 'benchmark',
    deadline: 'board',
    status: 'build',
    output: null,
    command: 'het.benchmark',
    slot: 'bench',
    prompt: {
      command: '/het-board',
      expect: '预期：在板采集数据（或明确的"未连板/未烧录"说明）',
      tags: ['[target: <matrix id>]', '[mode: cross|on-board]', '[toolchain: <版本>]'],
      required: ['[target', '[mode'],
      hint: '按目标矩阵跑在板采集；没连板就只构建（--no-flash），别假装采到了数据。',
    },
    vscode: ['output', 'status', 'notifications'],
    onFail: { next: '上板失败：未连板/无自托管 runner 时走 CI `hetai-package-matrix`（输出里有定向提示）。', needsHuman: true },
    ci: { workflow: 'hetai-package-matrix.yml', job: 'build' },
  },
  {
    id: 'boardRun',
    name: '上板采集',
    kind: 'task',
    idem: 'boardRun',
    busy: 'board',
    deadline: 'board',
    status: 'build',
    output: { domain: 'build', focus: true },
    command: 'het.boardBuild',
    prompt: {
      command: '/het-board',
      expect: '预期：在板采集数据（或明确的"未连板/未烧录"说明）',
      tags: ['[target: <matrix id>]', '[mode: cross|on-board]', '[toolchain: <版本>]'],
      required: ['[target', '[mode'],
      hint: '按目标矩阵跑在板采集；没连板就只构建（--no-flash），别假装采到了数据。',
    },
    vscode: ['output', 'status', 'notifications'],
    onFail: { next: '上板失败：未连板/无自托管 runner 时走 CI `hetai-package-matrix`（输出里有定向提示）。', needsHuman: true },
    ci: { workflow: 'hetai-package-matrix.yml', job: 'build' },
  },

  // ── 模块文档 ────────────────────────────────────────────────────────────
  {
    id: 'moduleCopilot',
    name: 'AI 框架设计&实现',
    kind: 'copilot',
    idem: 'moduleCopilot',
    deadline: 'misc',
    status: 'docs',
    output: { domain: 'chat', focus: false },
    command: '/het-module',
    prompt: {
      command: '/het-module',
      expect: '预期：设计稿 → 接口设计 → 骨架计划 → diff 预览（不自动落盘）',
      tags: ['[design: workspace/design/*.md]', '[uml: *.puml]', '[module: <名>]', '[out: include/,src/]'],
      required: ['[design', '[uml', '[module'],
      hint:
        '我要给这个库加模块：先读设计稿（PRD + PlantUML 框图：`[workspace/design/*.md]`，没有就先问我要素），' +
        '把接口定下来（配对命名、ImportStart/End、双语注释），给出 include/ + src/ 骨架计划与 diff 预览，' +
        '**我确认后再写盘**，并告诉我该补哪些 GTest。',
    },
    vscode: ['chat', 'status'],
    onFail: { next: '若 Chat 没打开：在 Copilot Chat 里执行 `/het-module`；只想先出骨架可用「单模块微调（向导）」。', needsHuman: false },
    ci: null,
    localOnly: true,
  },
  {
    id: 'newModule',
    name: '单模块微调',
    kind: 'nav',
    idem: 'newModule',
    deadline: 'misc',
    status: 'docs',
    output: null,
    command: 'het.newModule',
    slot: 'moduleWizard',
    promptNone: '向导只出骨架（无 PRD/测试）：要设计稿驱动就走「AI 框架设计&实现」。',
    vscode: ['status'],
    onFail: { next: '向导打不开：确认当前是 fcpp 库（有 metadata.json）。', needsHuman: false },
    ci: null,
    localOnly: true,
  },
  {
    id: 'testgenCopilot',
    name: '生成测试',
    kind: 'copilot',
    idem: 'testgenCopilot',
    deadline: 'misc',
    status: 'docs',
    output: { domain: 'chat', focus: false },
    command: '/het-testgen',
    prompt: {
      command: '/het-testgen',
      expect: '预期：GTest 骨架（从代码 / 从蓝图）',
      tags: ['[mode: 从代码|从蓝图]', '[module: <名>]', '[design: workspace/design/*.md]', '[uml: *.puml]'],
      required: ['[mode', '[module'],
      hint: '先问我用「从代码」还是「从蓝图」，再生成 GTest 骨架（从蓝图时读 `[design: …]` 与 `[uml: …]`）。',
    },
    vscode: ['chat', 'status'],
    onFail: { next: '若 Chat 没打开：在 Copilot Chat 里执行 `/het-testgen`（可选从代码 / 从蓝图）。', needsHuman: false },
    ci: null,
    localOnly: true,
  },
  {
    id: 'docsCopilot',
    name: '补文档注释',
    kind: 'copilot',
    idem: 'docsCopilot',
    deadline: 'docs',
    status: 'docs',
    output: { domain: 'chat', focus: false },
    command: '/het-docs',
    prompt: {
      command: '/het-docs',
      expect: '预期：Doxygen 注释补全',
      tags: ['[scope: include/|src/|all]', '[lang: en+zh]'],
      required: ['[scope', '[lang'],
      hint: '给这次改动涉及的源码补 Doxygen 注释（中英双语）；只做注释，不顺手改行为。',
    },
    vscode: ['chat', 'status'],
    onFail: { next: '若 Chat 没打开：在 Copilot Chat 里执行 `/het-docs`；只想本地出 HTML 用「文档编译」。', needsHuman: false },
    ci: null,
    localOnly: true,
  },
  {
    id: 'docsRun',
    name: '编译文档',
    kind: 'task',
    idem: 'docsBuild',
    busy: 'docsBuild',
    deadline: 'docs',
    status: 'docs',
    output: { domain: 'docs', focus: true },
    command: 'het.docsRun',
    prompt: {
      command: '/het-docs',
      expect: '预期：本地 HTML（不经 Chat）',
      tags: ['[scope: all]', '[lang: en+zh]', '[build: 1]'],
      required: ['[scope'],
      hint: '注释补齐后再编译文档（本地出 HTML，Doxygen + Sphinx）。',
    },
    vscode: ['output', 'status'],
    onFail: { next: '文档编译失败：缺 doxygen/sphinx 时输出里会给安装指引；也可以 `/het-docs` 先补注释。', needsHuman: false },
    ci: { workflow: 'docs-build.yml', job: 'docs' },
  },

  // ── 质量安全 ────────────────────────────────────────────────────────────
  {
    id: 'quality',
    name: '质量门禁',
    kind: 'task',
    idem: 'quality',
    deadline: 'quality',
    status: 'quality',
    output: { domain: 'quality', focus: false },
    command: 'het.quality',
    slot: 'quality',
    prompt: {
      command: '/het-quality',
      expect: '预期：各门禁 ✓/✗ 结论 + 失败项处置',
      tags: ['[scope: <路径或 all>]', '[gates: format,tidy,schema,commitlint,gitleaks]'],
      required: ['[scope', '[gates'],
      hint: '按上面的 gate 列表跑质量门禁；哪一项失败就只修那一项，别顺手格式化整个仓库。',
    },
    vscode: ['terminal', 'status', 'notifications'],
    onFail: { next: '门禁失败：终端里有原话；缺工具时面板会写清"谁装、怎么装"。', needsHuman: true },
    ci: { workflow: 'security-linters.yml', job: 'quality-gates' },
  },

  // ── 交付发布 ────────────────────────────────────────────────────────────
  {
    id: 'commitCopilot',
    name: '生成提交',
    kind: 'copilot',
    idem: 'commitCopilot',
    deadline: 'misc',
    status: 'release',
    output: { domain: 'chat', focus: false },
    command: '/het-commit',
    prompt: {
      command: '/het-commit',
      expect: '预期：拆分提交预览（不 push）',
      tags: ['[scope: <改动范围>]', '[import: 📦|🛠️|🔥]'],
      required: ['[scope'],
      hint: '先把当前改动拆成几个规范的提交，给我逐条预览，**不要 push**。',
    },
    vscode: ['chat', 'scm', 'status'],
    onFail: { next: '若 Chat 没打开：在 Copilot Chat 里执行 `/het-commit`；不想用 Copilot 就走「手动提交」。', needsHuman: false },
    ci: null,
    localOnly: true,
  },
  {
    id: 'commitManual',
    name: '手动提交',
    kind: 'nav',
    idem: 'commitManual',
    deadline: 'misc',
    status: 'release',
    output: null,
    command: 'het.commit',
    slot: 'commit',
    promptNone: '手动提交是兜底路径（gitmoji 助手）：要 Copilot 拆分提交就用「智能提交」。',
    vscode: ['scm', 'status'],
    onFail: { next: '提交助手打不开：确认工作区是一个 git 仓库。', needsHuman: false },
    ci: null,
    localOnly: true,
  },
  {
    id: 'pushHint',
    name: '推送提示',
    kind: 'nav',
    idem: 'pushHint',
    deadline: 'misc',
    status: 'release',
    output: null,
    command: 'het.pushHint',
    promptNone: '它只把自查提示**写进终端**（不回车、不推送）：推送永远由你自己按。',
    vscode: ['terminal', 'status'],
    onFail: { next: '提示写不进去：直接自己看一眼 CI 门禁清单（预检面板里有）。', needsHuman: false },
    ci: null,
    localOnly: true,
  },
  {
    id: 'release',
    name: '发布中心',
    kind: 'nav',
    idem: 'release',
    deadline: 'misc',
    status: 'release',
    output: null,
    command: 'het.release',
    slot: 'release',
    promptNone: '发布中心是受控的本地流程（写 metadata + 📦 提交），没有 Copilot 出口；不确定就先跑「发布前检查」。',
    vscode: ['status'],
    onFail: { next: '打不开发布中心：先确认工程里有 metadata.json；发布本身要过 release-gate（先跑「发布前检查」）。', needsHuman: false },
    ci: { workflow: 'semver-release.yml', job: 'gate' },
  },
  {
    id: 'preflight',
    name: '运行预检',
    kind: 'nav',
    idem: 'preflight',
    deadline: 'quality',
    status: 'release',
    output: null,
    command: 'het.preflight',
    slot: 'preflight',
    prompt: {
      command: '/het-preflight',
      expect: '预期：三态预检摘要（✓/✗/– 各自要不要人）',
      tags: ['[version: <目标版本>]'],
      required: ['[version'],
      hint: '按上面版本跑发布前检查；✗/– 都要说清"要不要人介入、谁做"。',
    },
    vscode: ['status'],
    onFail: { next: '预检打不开：先确认 metadata.version 是合法 semver。', needsHuman: false },
    ci: { workflow: 'semver-release.yml', job: 'gate' },
  },
  {
    id: 'ci',
    name: 'CI 状态',
    kind: 'nav',
    idem: 'ci',
    deadline: 'misc',
    status: 'release',
    output: null,
    command: 'het.ci',
    slot: 'ci',
    prompt: {
      command: '/het-fix-ci',
      expect: '预期：根因定位 + 最小修复',
      tags: ['[ci: <run url>]', '[symptom: <一句话>]'],
      required: ['[ci', '[symptom'],
      hint: '这是本轮 CI 的失败链接与症状：先定位根因，再给最小修复，别顺手重构。',
    },
    vscode: ['status'],
    onFail: { next: '看不到 CI：确认仓库是 GitHub 且已登录（无凭据时会显式说明，而不是空白）。', needsHuman: false },
    ci: null,
    localOnly: true,
  },
  {
    id: 'audit',
    name: '生成审计',
    kind: 'task',
    idem: 'audit',
    deadline: 'misc',
    status: 'release',
    output: { domain: 'release', focus: false },
    command: 'het.audit',
    slot: 'audit',
    prompt: {
      command: '/het-audit',
      expect: '预期：工程域审计 + 模板差异清单',
      tags: ['[scope: all]', '[template: <上游 tag>]'],
      required: ['[scope'],
      hint: '生成工程域审计 + 模板差异清单；只列事实与建议，不要动我的代码。',
    },
    vscode: ['output', 'status'],
    onFail: { next: '审计失败：看一眼输出 tail；模板对比需要网络（内网请配镜像源）。', needsHuman: false },
    ci: null,
    localOnly: true,
  },

  // ── 导航（唯一的"打开驾驶舱"入口；chip 点击 / 命令面板都走它）────────────
  {
    id: 'dashboard',
    name: '驾驶舱',
    kind: 'nav',
    idem: 'dashboard',
    deadline: 'misc',
    status: 'env',
    output: null,
    command: 'het.dashboard',
    promptNone: '驾驶舱是这个扩展唯一的页签：打开它就是导航本身，没有 Copilot 出口。',
    vscode: ['status'],
    onFail: { next: '打不开驾驶舱：通常是宿主拒绝创建 webview（看看输出里的宿主报错）。', needsHuman: false },
    ci: null,
    localOnly: true,
  },
];

export function intentFor(id: string): Intent | undefined {
  return INTENTS.find((it) => it.id === id);
}

/** 按**忙语义/状态项**的 id 反查（`id` 与 `busy` 都算）。 */
export function intentForBusy(busyId: string): Intent | undefined {
  return INTENTS.find((it) => it.id === busyId || it.busy === busyId);
}

/** 动作 id → 命令 id（卡片/悬停点击走这里；未登记 = 返回 undefined，host 会显式报错）。 */
export function commandOf(intentId: string): string | undefined {
  return intentFor(intentId)?.command;
}

/** 按命令反查（诊断/门禁用）。 */
export function intentsUsingCommand(command: string): string[] {
  return INTENTS.filter((it) => it.command === command)
    .map((it) => it.id)
    .sort();
}

/** 一条 Intent"五件套"是否齐全（§3.4：缺一即门禁失败）。 */
export function intentGaps(it: Intent): string[] {
  const gaps: string[] = [];
  if (!it.id || !it.name || !it.command) {
    gaps.push('id/name/command 不能为空');
  }
  if (!it.idem) {
    gaps.push('缺幂等键（重复点击会排两个任务）');
  }
  if (!(DEADLINE_KINDS as readonly string[]).includes(it.deadline)) {
    gaps.push(`超时类别 ${it.deadline} 不在 core/deadlines.ts 的定稿表里`);
  }
  if (it.kind !== 'nav' && !it.output) {
    gaps.push('长动作/对话动作必须声明输出域');
  }
  if (it.kind === 'nav' && it.output) {
    gaps.push('导航动作不该写输出（它只开视图）');
  }
  if (!it.prompt && !it.promptNone) {
    gaps.push('既没有 prompt 又没有显式声明"无 prompt" —— 这就是"哑动作"');
  }
  if (it.prompt) {
    const missing = it.prompt.required.filter((tag) => !it.prompt!.tags.some((t) => t.startsWith(tag)));
    if (missing.length) {
      gaps.push(`必备 tag 没出现在预填里：${missing.join('、')}`);
    }
    if (!it.prompt.hint.trim()) {
      gaps.push('prompt 缺预填正文');
    }
  }
  if (!it.vscode.length || !it.vscode.includes('status')) {
    gaps.push('必须声明联动面，且三处状态项（status）对所有动作都是必需的');
  }
  if (it.vscode.includes('notifications') && !it.onFail.needsHuman) {
    gaps.push('声明了通知却不允许打扰用户（两边必须一致）');
  }
  if (!it.onFail.next.trim()) {
    gaps.push('失败时没有下一步（用户会卡住）');
  }
  if (it.kind === 'copilot' && !it.prompt) {
    gaps.push('Copilot 类动作必须有 prompt');
  }
  if (it.ci === null && !it.localOnly) {
    gaps.push('没有 CI 对应时必须显式声明 localOnly（区分"本地动作"与"忘了接"）');
  }
  return gaps;
}

/** CI 副标题（§5.2）：`消费依赖 · 产出包（CI: ci-build-test.yml › build-and-test）` 或"仅本地 · 无 CI 对应"。 */
export function ciSubtitle(it: Intent): string {
  if (!it.ci) {
    return '仅本地 · 无 CI 对应';
  }
  return `CI: ${it.ci.workflow} › ${it.ci.job}`;
}
