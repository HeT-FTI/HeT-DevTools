/**
 * 卡片注册表 + 站分组（V3 · L2 结构重排）。
 *
 * **分组不写在这里**：唯一来源是 `spine.ts` 的 `SPINE_STATIONS`（动作序列 8 站 +
 * 设置段）。本文件只负责三件事：
 * 1. 24 张卡的静态定义（唯一来源）；
 * 2. 把卡按站分好（渲染 / 悬停 / 深链 / Slot 标题共用同一份）；
 * 3. "信息不丢"校验（旧 UI 的 11 个 tab 必须每张都有归属）。
 *
 * 归属规则见 `spine.ts` 的注释：模块两卡排在 ② 构建站最前面（8 站里没有"改码"站），
 * 交叉编译归 ⑧ 交付，覆盖率归 ③ 测试，上板归 ⑧ 交付（以前它在"设置"段里）。
 */
import { LEGACY_TAB_IDS, SECTION_IDS, type CardRow, type LegacyTabId, type SectionId } from './model';
import { NON_SPINE_CARD_IDS, SPINE_STATIONS } from './spine';

/** 卡片声明的恒等包装（保留：将来要在这里加默认值/校验时只改一处）。 */
function card(row: CardRow): CardRow {
  return row;
}

export interface SectionDef {
  id: SectionId;
  /** rail 序号（1..8）。设置段不给序号 —— 它不在 rail 计数里。 */
  order: number;
  /** 组名 = 站名（rail、悬停行、Slot 标题共用同一串字）。 */
  label: string;
  /**
   * rail 上的**图标 + 等长短名**（实测反馈：`12345` 看不出是什么）。
   *
   * 规矩：短名一律**两个汉字**（rail 是竖排窄栏，字数不齐就会参差），
   * 图标用 emoji（彩色、一眼可辨，且与卡片里的 codicon 单色风格不冲突）。
   */
  rail: string;
  railLabel: string;
  /** codicon 后缀（单色，克制策略）。 */
  icon: string;
  hint: string;
  /** 齿轮段（设置）：有正文、有卡片，但**不占 rail 格子**。 */
  gear?: boolean;
  /** 这一段是否默认折叠（手风琴：默认只开 `ready` 一站）。 */
  foldedByDefault: boolean;
  cards: CardRow[];
}

/** 24 张卡：每张只声明"它是什么"，归属由 `spine.ts` 决定。 */
const CARDS: CardRow[] = [
  card({
        id: 'health',
        tab: 'overview',
        label: '环境体检',
        sub: '体检分（护栏：工具链 · 托管车道 · 覆盖率探针）—— 结论一句话，逐项明细在 Slot 里',
        state: 'idle',
        fact: '—',
        action: { id: 'health', label: '重新体检', kind: 'action' },
        stage: 'inline',
        lazy: false,
        show: 'always',
      }),
      card({
        id: 'templateSync',
        tab: 'overview',
        // V3 · L5b / G5："模板/CI 演进后本库落后"以前只是① 就绪站里一行**静态文字**
        // （不参与站状态：落后 60 个提交时那一站仍然是灰的）。现在它是一张卡 ——
        // 落后时整站变黄，并把入口指向**真的会生成同步计划**的那个动作。
        label: '模板同步',
        sub: '模板/CI 演进后，本库落后多少、怎么对',
        state: 'idle',
        fact: '—',
        action: { id: 'templateUpdate', label: '检查模板更新', kind: 'action' },
        stage: 'panel',
        lazy: true,
        show: 'always',
      }),
      card({
        id: 'env',
        tab: 'overview',
        label: '环境',
        sub: 'provider 与就绪情况：缺什么、谁装、要不要人介入',
        state: 'idle',
        fact: '—',
        extra: [{ id: '/het-setup', label: '让 Copilot 讲清楚', kind: 'copilot' }],
        stage: 'inline',
        lazy: false,
        show: 'always',
      }),
      card({
        id: 'lane',
        tab: 'overview',
        label: '托管环境',
        sub: '隔离车道（私有 venv + 私有 CONAN_HOME）：准备 / 移除都不动系统环境',
        state: 'idle',
        fact: '—',
        action: { id: 'envPrepare', label: '同意并准备', kind: 'action' },
        secondary: { id: 'envRemove', label: '移除…', kind: 'action' },
        stage: 'output',
        lazy: false,
        show: 'always',
      }),
      card({
        id: 'tools',
        tab: 'overview',
        // V3 · L2d（§4.5 / G13）：路径与来源早就探测到了，但**一处渲染都没有** ——
        // 用户想确认"我用的是哪套、装在哪"只能去导诊断文件。这张卡就是那个缺口。
        label: '工具链',
        // 术语黑名单不许出现"工具"这类泛指词 —— 直接把具体名字写出来。
        sub: 'conan/cmake/ninja… 装在哪、来自哪个环境',
        state: 'idle',
        fact: '—',
        action: { id: 'openTools', label: '看工具链一览', kind: 'action' },
        stage: 'panel',
        lazy: true,
        show: 'always',
      }),
      card({
        id: 'network',
        tab: 'settings',
        label: '网络与源',
        sub: 'pip / apt / rootfs / gh 加速的镜像口径（企业内网镜像）',
        state: 'idle',
        fact: '—',
        stage: 'inline',
        lazy: true,
        show: 'always',
      }),
      card({
        id: 'deps',
        tab: 'deps',
        label: '依赖（conandata · metadata）',
        // §6.0：原文案把"四个归属桶""有界选择器""命中计数"这些**内部机制**讲给了用户；
        // 用户只关心"两个文件必须一致"。
        sub: '依赖清单：两个文件必须一致，一个包只归一个桶',
        state: 'idle',
        fact: '—',
        action: { id: 'openDeps', label: '打开依赖管理器', kind: 'action' },
        // V3 · L5b / G6：上游最新**只能靠一次真实的网络查询** → 做成显式动作（不自动打网络）
        secondary: { id: 'checkDepUpdates', label: '查上游最新', kind: 'action' },
        stage: 'panel',
        lazy: true,
        show: 'always',
      }),
      card({
        id: 'buildTest',
        tab: 'buildTest',
        label: '编译打包（消费依赖 · main.cpp）',
        sub: 'conan create：装好 cmake/conan 后编译并打包本包（产出物导向）',
        state: 'idle',
        fact: '—',
        action: { id: 'build', label: '编译打包', kind: 'action' },
        stage: 'output',
        lazy: false,
        show: 'always',
      }),
      card({
        id: 'newLibAudit',
        tab: 'release',
        // V3 · L5 / G4：模板的 `.github/misc/Codegen-Starter.txt` SECTION 7 是一份 23 条
        // 的新库合同，但它只写在文档里 —— 漏掉的那几条（LICENSE 被改过、头文件少了守卫、
        // 某个头文件没单测）要等到 CI 红或发布之后才发现。这张卡把它变成逐条自检。
        label: '新库自检',
        sub: '模板生成契约逐项自检（交付前）',
        state: 'idle',
        fact: '—',
        action: { id: 'newLibAudit', label: '开始自检', kind: 'action' },
        stage: 'panel',
        lazy: true,
        show: 'always',
      }),
      card({
        id: 'pythonBindings',
        tab: 'release',
        // V3 · L6c / G9：`@exporter` 把"这是公开 API"写在了头文件里，Python 侧却
        // 没有任何东西强制你绑出去 —— 新加一个公开类、忘了写绑定，编译/单测/覆盖率全绿，
        // 只有用户 import 之后才发现少了个名字。这张卡逐个对账，另外盯住模块名
        // （`PYBIND11_MODULE` 与 CMake 产物名不一致时 import 直接失败，本地也一路绿灯）。
        label: 'Python 绑定',
        sub: '公开 API 是否都已绑定（未绑就红）',
        state: 'idle',
        fact: '—',
        action: { id: 'openPythonBindings', label: '打开绑定文件', kind: 'action' },
        stage: 'panel',
        lazy: true,
        // 能力事实（§5.2）：没开 Python 绑定的库不给看（metadata.enable_python_bindings）
        show: ['python-bindings'],
      }),
      card({
        id: 'crossBuild',
        tab: 'buildTest',
        label: '交叉编译（目标架构 · 不跑测试）',
        sub: '目标只来自 .hetai/build-matrix.yml：按 arch/os 生成 conan profile，出目标架构的包 + readelf 架构报告',
        state: 'idle',
        fact: '—',
        action: { id: 'crossBuild', label: '交叉编译', kind: 'action' },
        stage: 'output',
        // 懒加载：这一段默认折叠，展开时才会渲染出这张卡的动作按钮
        lazy: true,
        // 能力事实（§5.2）：只有真有目标矩阵（`.hetai/build-matrix.yml`）才需要这张卡 ——
        // 单目标桌面库看它只会问"我又不交叉编译，为什么给我看这个"。
        show: ['cross-target'],
      }),
      card({
        id: 'testFull',
        tab: 'buildTest',
        label: '全量测试（full-test-automation）',
        sub: '与 CI 同一条链：conan create + GTest/CTest + 覆盖率报告（本机等价复现）',
        state: 'idle',
        fact: '—',
        action: { id: 'test', label: '全量测试', kind: 'action' },
        stage: 'output',
        lazy: false,
        show: 'always',
      }),
      card({
        id: 'coverageDetail',
        tab: 'buildTest',
        label: '覆盖率',
        sub: '行/函数覆盖率报告（metadata 开关决定是否采集）',
        state: 'idle',
        fact: '—',
        action: { id: 'openCoverageReport', label: '打开报告', kind: 'action' },
        stage: 'external',
        lazy: true,
        // 能力事实：只有 `metadata.activate_code_coverage = true` 才有这张卡（§5.2）
        show: ['coverage'],
      }),
      card({
        id: 'moduleAgent',
        tab: 'moduleTest',
        label: 'AI 框架设计&实现',
        sub: '输入：PRD + 设计框图（PlantUML）；产物：接口设计 + include/src 骨架 + GTest 清单；落盘：你确认 diff 之后才写入',
        state: 'idle',
        fact: '预期：设计稿 → 接口设计 → 骨架计划 → diff 预览（不自动落盘）',
        action: { id: '/het-module', label: '和 Copilot 一起设计', kind: 'copilot' },        stage: 'chat',
        lazy: true,
        show: 'always',
      }),
      card({
        id: 'moduleWizard',
        tab: 'moduleTest',
        label: '单模块微调（向导）',
        sub: '输入：模块名/命名前缀；产物：include + src 骨架（无 PRD、无测试）；落盘：先看命名规范再生成',
        state: 'idle',
        fact: '—',
        action: { id: 'newModule', label: '打开向导', kind: 'action' },
        stage: 'panel',
        lazy: false,
        show: 'always',
      }),
      card({
        id: 'perfBaseline',
        tab: 'moduleTest',
        // V3 · L6a / G7：跑完 bench 只看到一串数字，没人记得上次是多少 —— "变慢了没有"
        // 永远答不上来。这张卡把"基线 + 最近一次"摆在一起（原始值，不替用户判快慢）。
        label: '性能基线',
        sub: '与你自己钉住的那次结果比（原始值）',
        state: 'idle',
        fact: '—',
        // §F.38：同一个动作只许出现在一个段 —— 跑 bench 的入口在 ⑧ 交付站的「上板验证」，
        // 所以这里用 **jump**（导航过去），不复制一个按钮。
        action: { id: 'pinBaseline', label: '存为基线', kind: 'action' },
        secondary: { id: 'deliver', label: '去上板验证…', kind: 'jump' },
        stage: 'panel',
        lazy: true,
        // 能力事实（§5.2）：没有 bench 入口的库（没有 benchmark/script/run_bench.py）不给看
        show: ['perf-baseline'],
      }),
      card({
        id: 'testgen',
        tab: 'moduleTest',
        label: '测试生成（Copilot）',
        sub: '输入：目标源码或测试蓝图；产物：GTest 骨架',
        state: 'idle',
        fact: '预期：GTest 骨架（从代码 / 从蓝图）',
        action: { id: '/het-testgen', label: '生成测试', kind: 'copilot' },
        stage: 'chat',
        lazy: true,
        show: 'always',
      }),
      card({
        id: 'docsAuthoring',
        tab: 'docs',
        label: '文档注释补全（Copilot）',
        sub: '输入：改动涉及的源码；产物：Doxygen 注释（只补注释，不改行为）',
        state: 'idle',
        fact: '预期：Doxygen 注释补全',
        action: { id: '/het-docs', label: '补注释', kind: 'copilot' },
        stage: 'chat',
        lazy: true,
        show: 'always',
      }),
      card({
        id: 'docsBuild',
        tab: 'docs',
        label: '文档编译（本地出 HTML）',
        sub: 'Doxygen + Sphinx 在车道 venv 里跑，产物落 docs/（不经 Chat）',
        state: 'idle',
        fact: '预期：本地 HTML（不经 Chat）',
        action: { id: 'docsRun', label: '编译文档', kind: 'action' },
        stage: 'output',
        lazy: true,
        show: 'always',
      }),
      card({
        id: 'quality',
        tab: 'quality',
        label: '质量门禁',
        sub: '格式 · 静态检查 · schema · 提交规范 · 密钥扫描（MegaLinter 需要 Docker）',
        state: 'idle',
        fact: '—',
        action: { id: 'quality', label: '运行质量门禁', kind: 'action' },
        stage: 'panel',
        lazy: true,
        show: 'always',
      }),
      card({
        id: 'abiSymbols',
        tab: 'quality',
        // V3 · L6b / G8：共享库的对外承诺是**符号表** —— 改名/改签名/删符号会让
        // 已经编译好的下游链不上或运行时炸，而源码 diff 里看起来"只是改了个名"。
        label: '导出符号',
        sub: '共享库的符号表对比（改名 = 破坏）',
        state: 'idle',
        fact: '—',
        action: { id: 'scanAbiSymbols', label: '扫描当前产物', kind: 'action' },
        secondary: { id: 'pinAbiBaseline', label: '存为基线', kind: 'action' },
        stage: 'output',
        lazy: true,
        // 共享库（ABI 是它的承诺）与 C 接口（同样要求符号稳定）；纯头文件库没有符号可谈
        show: ['shared-abi', 'c-abi'],
      }),
      card({
        id: 'headerCost',
        tab: 'quality',
        // V3 · L6e：仅头文件库**没有符号表**（ABI 那套对它没意义），它真正的对外成本是
        // "别人 include 你一下要花多久" —— 这个数字涨上去，下游每次编译都要多等，
        // 而没有任何一条 CI 会在意它。量与比的办法：探针 TU（含/不含）各跑 5 次取中位，
        // 报**差值**（扣掉进程启动那一份），并且连编译器/标准一起记（换一套就不比）。
        label: '编译期成本',
        sub: '别人 include 你一下要花多久',
        state: 'idle',
        fact: '—',
        action: { id: 'probeHeaderCost', label: '实测一次', kind: 'action' },
        secondary: { id: 'pinHeaderCostBaseline', label: '存为基线', kind: 'action' },
        stage: 'output',
        lazy: true,
        // 能力事实（§5.2）：只有仅头文件产物才谈"include 成本"
        show: ['header-only'],
      }),
      card({
        id: 'commit',
        tab: 'commit',
        label: '智能提交（Copilot）',
        sub: '输入：当前改动；产物：拆分提交预览（**不 push** —— 越权的事不做）',
        state: 'idle',
        fact: '预期：拆分提交预览（不 push）',
        action: { id: '/het-commit', label: '生成提交', kind: 'copilot' },
        // §19.1 ③ 的 Phase 1 形态：只把自查提示写进终端（**不回车**，不自动 push）
        extra: [{ id: 'pushHint', label: '推送提示', kind: 'action' }],
        stage: 'chat',
        lazy: true,
        show: 'always',
      }),
      card({
        id: 'commitManual',
        tab: 'commit',
        label: '手动提交（兜底）',
        sub: 'Copilot 不可用时的 gitmoji 提交助手（同一套规范）',
        state: 'idle',
        fact: '—',
        action: { id: 'commitManual', label: '打开提交助手', kind: 'action' },
        stage: 'panel',
        lazy: true,
        show: 'always',
      }),
      card({
        id: 'release',
        tab: 'release',
        // §11.2 走查：卡片名必须说“这一个按钮到底干什么” ——
        // 以前叫「运行预检 / 发布」，但那个按钮只跑预检（发布中心是另一个入口）。
        label: '发布前检查',
        // §6.0：原文案写的是"与 CI 的哪一个 job 同一套门禁"——那是实现细节；
        // 用户只需知道"发布前要跑它、与 CI 同一条链"。
        sub: '发布前的就绪检查（与 CI 同一条链）',
        state: 'idle',
        fact: '—',
        action: { id: 'preflight', label: '运行预检', kind: 'action' },
        secondary: { id: 'release', label: '发布中心…', kind: 'action' },
        stage: 'panel',
        lazy: true,
        show: 'always',
      }),
      card({
        id: 'ci',
        tab: 'collab',
        label: 'CI',
        sub: '看本轮 push 的 workflow / job 真身与结论',
        state: 'idle',
        fact: '—',
        action: { id: 'ci', label: '打开 CI 状态', kind: 'action' },
        stage: 'external',
        lazy: true,
        show: 'always',
      }),
      card({
        id: 'orchestrator',
        tab: 'collab',
        // V3 · L4 / G10：模板里的 `ci-orchestrator.yml` 是"一次 push 会跑哪些 job、按什么顺序"
        // 的唯一答案，此前在扩展源码里 **0 引用** —— 用户看得到单个动作对应哪个 job，
        // 却看不到整台机器怎么编排。这张卡补的就是这个视角（事实来自真实文件解析）。
        label: 'CI 总编排',
        sub: 'push 后一次跑完的 job 清单与顺序',
        state: 'idle',
        fact: '—',
        action: { id: 'openOrchestrator', label: '打开编排文件', kind: 'action' },
        stage: 'panel',
        lazy: true,
        show: 'always',
      }),
      card({
        id: 'audit',
        tab: 'collab',
        // §11.2 走查：它只生成**一份报告**（结构/metadata/工具链/CI/Git → 结论），
        // 以前的名字里带着“/ 模板”却根本没碰模板 —— 那是另一个入口的事。
        label: '工程审计',
        // §6.0：原文案把报告**内部的章节**全枚举了一遍（用户点开就知道）。压到一句话。
        sub: '这个库的体检报告（结构 / 依赖 / CI / Git）',
        state: 'idle',
        fact: '—',
        action: { id: 'audit', label: '生成审计', kind: 'action' },
        stage: 'panel',
        lazy: true,
        show: 'always',
      }),
      card({
        id: 'settings',
        tab: 'settings',
        label: 'metadata 表单',
        // §6.0：删掉“（双写一致性有门禁）”——那是维护者关心的事。
        sub: 'metadata.json / conandata.yml 字段级编辑',
        state: 'idle',
        fact: '—',
        action: { id: 'openSettings', label: '打开设置面板', kind: 'action' },
        stage: 'panel',
        lazy: true,
        show: 'always',
      }),
      card({
        id: 'board',
        tab: 'bench',
        // §11.2 走查：动作名与 Intent 对齐（“上板验证”，不是内部词 bench）
        label: '上板验证（真机采集）',
        // §6.0 第 2 条：工具清单（JLink/OpenOCD/ADB/SSH）是**条件性知识** —— 真接着板子的人
        // 才知道自己要哪个；没板子的人每次都被灌一遍。所以它只留在面板/后续的探针事实里。
        sub: '真机烧录/部署 + 在板采集（只真机）',
        state: 'idle',
        fact: '—',
        action: { id: 'benchmark', label: '打开上板面板', kind: 'action' },
        stage: 'panel',
        lazy: true,
        // 能力事实：裸机白名单是"这是嵌入式产物"的唯一现有信号（能力缺失时卡片隐藏，
        // 且会在站内给一行"按产物事实隐藏"的解释）。
        show: ['baremetal'],
      }),
];

const CARD_BY_ID = new Map(CARDS.map((c) => [c.id, c]));

function cardsOf(ids: readonly string[]): CardRow[] {
  return ids.map((id) => CARD_BY_ID.get(id)).filter((c): c is CardRow => c !== undefined);
}

/** 手风琴的默认开站（`model.ts` 的 `DEFAULT_OPEN` 与此保持一致，单测对账）。 */
const DEFAULT_OPEN_ID: SectionId = 'ready';

/**
 * 页面上真正的分组 = 8 站（`SPINE_STATIONS`）+ 设置段。
 *
 * 站名/图标/提示全部取自 `spine.ts`，这里**不重复定义**任何分组知识。
 */
export const SECTIONS: SectionDef[] = [
  ...SPINE_STATIONS.map((s) => ({
    id: s.id as SectionId,
    order: s.order,
    label: s.label,
    rail: s.rail,
    railLabel: s.railLabel,
    icon: s.icon,
    hint: s.hint,
    foldedByDefault: s.id !== DEFAULT_OPEN_ID,
    cards: cardsOf(s.cards),
  })),
  {
    // 齿轮：**不进 rail 计数**。它就叫"设置"，不叫"更多"。
    id: 'settings',
    order: 0,
    label: '设置',
    rail: '⚙️',
    railLabel: '设置',
    icon: 'settings-gear',
    // §6.0 的同一类问题（L4 截图时又看到一处）：这句还写着"上板" —— 但上板卡在 L2
    // 已经归到 ⑧ 交付站了，齿轮段里只剩 metadata 表单。站头写的必须就是它**里面**的东西。
    hint: 'metadata 表单',
    gear: true,
    foldedByDefault: true,
    cards: cardsOf(NON_SPINE_CARD_IDS),
  },
];

export function sectionDef(id: SectionId): SectionDef | undefined {
  return SECTIONS.find((s) => s.id === id);
}

/** 全部卡片（唯一来源；`SECTIONS` 只是它的分组投影）。 */
export function allCards(): CardRow[] {
  return CARDS;
}

/**
 * 旧 tab id → 它现在归属的组（深链继续可用：老链接不用改）。
 *
 * **平局规则**（c10 在真宿主里抽出来的）：同一个旧 tab 可能被多张卡承载
 * （`settings` 既在网络与源卡上、也在 metadata 表单卡上），按"哪张卡先声明"回答
 * 会把 `het.dashboard 'settings'` 深链到**就绪站** —— 用户看到的却是另一个组。
 * 所以：**旧 tab 名与组名同名时，优先落到那个组**（组名是用户看得到的词）。
 */
export function sectionForTab(tab: string): SectionId | undefined {
  if ((SECTION_IDS as readonly string[]).includes(tab)) {
    return tab as SectionId;
  }
  const card = CARDS.find((c) => c.tab === tab);
  return card ? cardSection(card.id) : undefined;
}

/** 卡片 id → 所在组（供 host 侧定位要更新哪一段）。 */
export function cardSection(cardId: string): SectionId | undefined {
  return SECTIONS.find((s) => s.cards.some((c) => c.id === cardId))?.id;
}

/** 旧 UI 的 11 个 tab（旧 UI 已归档，这串 id 只用于"信息不丢"校验）。 */
export const LEGACY_TABS: readonly LegacyTabId[] = LEGACY_TAB_IDS;

/** 新页面覆盖了哪些旧 tab（应等于 `LEGACY_TABS` —— 单测断言）。 */
export function tabsCovered(): LegacyTabId[] {
  return [...new Set(CARDS.map((c) => c.tab))];
}

/** rail 上**计数**的组（齿轮不算：§5.1 的"齿轮不进 rail 计数"）。 */
export function railSections(): SectionDef[] {
  return SECTIONS.filter((s) => !s.gear);
}

/** rail 上一格显示的内容：图标 + 短名。 */
export function railLabelOf(def: SectionDef): string {
  return `${def.rail} ${def.railLabel}`;
}

/**
 * rail 宽度 = **最长的一格** + 内边距（实测反馈第 2 条：宽度要跟着标签走）。
 *
 * 计量规则：文字按字面长度算，图标一律按 **2 个字宽** 折算（emoji + 间隙；不按码位数
 * 记账 —— `⚙️` 带变体选择符会多一个码位，那样宽度就会"偷偷"变，门禁也断言不了）。
 */
export function railWidthCss(): string {
  const longest = Math.max(...SECTIONS.map((d) => [...d.railLabel].length));
  return `calc(${longest + 2}em + 18px)`;
}
