/**
 * 5 段 × 卡片的静态定义（纯数据，**不 import vscode**）。
 *
 * 用途：
 * 1. 生成页面（shell 用）；
 * 2. **"信息不丢"校验** —— 旧 UI 的 11 个 tab 必须每张都在新页面上有归属（`tabsCovered()`）；
 * 3. 单测断言（段 id 唯一、每张卡恰好一个主按钮来源、懒加载标记合理）。
 *
 * ## E 块：术语与层级定稿（计划 §5.1）
 *
 * rail 只有 5 项，**四个字、不带"与"**：环境车道 / 构建验证 / 模块文档 / 质量安全 / 交付发布。
 * 齿轮（设置）**不进 rail 计数**，它就叫"设置"—— 不叫"更多"，也不是一个"其他"垃圾桶。
 *
 * 上一版有 5 段但名字不对，还多了一段 "现在怎么样"（只读摘要）：那 6 张卡是**同一份事实的
 * 第四遍**（L1 吸顶、chip 悬停、执行段里的卡各说一遍），而且"现在"本身在术语黑名单里。
 * E 块把它整段删掉 —— 看结论看吸顶/悬停，要动手就去对应段（执行入口始终只有一份）。
 */
import { LEGACY_TAB_IDS, type CardRow, type LegacyTabId, type SectionId } from './model';

export interface SectionDef {
  id: SectionId;
  /** rail 上的序号（1..5）。齿轮段不给序号 —— 它不在 rail 计数里。 */
  order: number;
  /** 段名 = §5.1 定稿名（rail、悬停行、Slot 标题共用同一串字）。 */
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
  /** 这张卡是否默认折叠（§6：只展开第 1 段）。 */
  foldedByDefault: boolean;
  cards: CardRow[];
}

function card(row: CardRow): CardRow {
  return row;
}

/** 21 张卡（覆盖旧 11 个 tab；见每个 `tab` 字段）。执行入口只有一个（§F.38 的收敛版）。 */
export const SECTIONS: SectionDef[] = [
  {
    id: 'env',
    order: 1,
    label: '环境车道',
    rail: '🧭',
    railLabel: '环境',
    icon: 'server-environment',
    hint: 'provider · 工具链 · 托管车道 · 构建缓存治理',
    foldedByDefault: false,
    cards: [
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
      }),
    ],
  },
  {
    id: 'build',
    order: 2,
    label: '构建验证',
    rail: '🔨',
    railLabel: '构建',
    icon: 'beaker',
    hint: '消费依赖 · 编译打包 · 交叉编译 · 全量测试 · 覆盖率',
    foldedByDefault: true,
    cards: [
      card({
        id: 'deps',
        tab: 'deps',
        label: '依赖（conandata · metadata）',
        sub: '四桶归属与双写；大集合走有界选择器（每页 20/50 + 命中计数）',
        state: 'idle',
        fact: '—',
        action: { id: 'openDeps', label: '打开依赖管理器', kind: 'action' },
        stage: 'panel',
        lazy: true,
      }),
      // 实测反馈第 6 条："构建"与"构建并测试"到底有什么区别？—— 两张卡各自**只有一个动作**，
      // 并用 `sub` 静态说明它跑的是哪条链（不再靠猜）。
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
      }),
    ],
  },
  {
    id: 'module',
    order: 3,
    label: '模块文档',
    rail: '📄',
    railLabel: '模块',
    icon: 'symbol-method',
    hint: 'AI 框架设计&实现 · 单模块微调 · 测试生成 · Doxygen',
    foldedByDefault: true,
    cards: [
      // §5.1 / C6：模块入口 = **AI 框架设计&实现**（输入设计稿 → 主导核心架构实现），
      // 所以卡片必须写清"输入 / 产物 / 谁落盘"，设计稿路径作为**回填 tag** 进预填。
      card({
        id: 'moduleAgent',
        tab: 'moduleTest',
        label: 'AI 框架设计&实现',
        sub: '输入：PRD + 设计框图（PlantUML）；产物：接口设计 + include/src 骨架 + GTest 清单；落盘：你确认 diff 之后才写入',
        state: 'idle',
        fact: '预期：设计稿 → 接口设计 → 骨架计划 → diff 预览（不自动落盘）',
        action: { id: '/het-module', label: '和 Copilot 一起设计', kind: 'copilot' },        stage: 'chat',
        lazy: true,
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
      }),
    ],
  },
  {
    id: 'quality',
    order: 4,
    label: '质量安全',
    rail: '🛡️',
    railLabel: '质量',
    icon: 'shield',
    hint: 'format/tidy/schema/commitlint/gitleaks/MegaLinter',
    foldedByDefault: true,
    cards: [
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
      }),
    ],
  },
  {
    id: 'deliver',
    order: 5,
    label: '交付发布',
    rail: '📦',
    railLabel: '交付',
    icon: 'rocket',
    hint: '提交 · 预检 · 发布 · CI · 审计',
    foldedByDefault: true,
    cards: [
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
      }),
      card({
        id: 'release',
        tab: 'release',
        label: '运行预检 / 发布',
        sub: '与 CI `semver-release › release-gate` 同一套门禁',
        state: 'idle',
        fact: '—',
        action: { id: 'preflight', label: '运行预检', kind: 'action' },
        stage: 'panel',
        lazy: true,
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
      }),
      card({
        id: 'audit',
        tab: 'collab',
        label: '审计 / 模板',
        sub: '工程域体检报告 + 模板落后上游多少提交',
        state: 'idle',
        fact: '—',
        action: { id: 'audit', label: '生成审计', kind: 'action' },
        stage: 'panel',
        lazy: true,
      }),
    ],
  },
  {
    // 齿轮：**不进 rail 计数**（§5.1）。它就叫"设置"，不叫"更多"。
    id: 'settings',
    order: 6,
    gear: true,
    label: '设置',
    rail: '⚙️',
    railLabel: '设置',
    icon: 'settings-gear',
    hint: 'metadata 表单 · 上板',
    foldedByDefault: true,
    cards: [
      card({
        id: 'settings',
        tab: 'settings',
        label: 'metadata 表单',
        sub: 'metadata.json / conandata.yml 的字段级编辑（双写一致性有门禁）',
        state: 'idle',
        fact: '—',
        action: { id: 'openSettings', label: '打开设置面板', kind: 'action' },
        stage: 'panel',
        lazy: true,
      }),
      card({
        id: 'board',
        tab: 'bench',
        label: '上板（bench）',
        sub: '真机烧录/部署 + 在板采集（Cortex-M: JLink/OpenOCD；Cortex-A: ADB/SSH）',
        state: 'idle',
        fact: '—',
        action: { id: 'benchmark', label: '打开上板面板', kind: 'action' },
        stage: 'panel',
        lazy: true,
      }),
    ],
  },
];

export function sectionDef(id: SectionId): SectionDef | undefined {
  return SECTIONS.find((s) => s.id === id);
}

export function allCards(): CardRow[] {
  return SECTIONS.flatMap((s) => s.cards);
}

/** 旧 tab id → 它现在归属的段（深链继续可用：老链接不用改）。 */
export function sectionForTab(tab: string): SectionId | undefined {
  for (const s of SECTIONS) {
    if (s.cards.some((c) => c.tab === tab)) {
      return s.id;
    }
  }
  return undefined;
}

/** 卡片 id → 所在段（供 host 侧定位要更新哪一段）。 */
export function cardSection(cardId: string): SectionId | undefined {
  return SECTIONS.find((s) => s.cards.some((c) => c.id === cardId))?.id;
}

/** 旧 UI 的 11 个 tab（或：`model.ts › LEGACY_TAB_IDS`；旧 UI 已归档，这串 id 只用于"信息不丢"校验）。 */
export const LEGACY_TABS: readonly LegacyTabId[] = LEGACY_TAB_IDS;

/** 新页面覆盖了哪些旧 tab（应等于 `LEGACY_TABS` —— 单测断言）。 */
export function tabsCovered(): LegacyTabId[] {
  return [...new Set(allCards().map((c) => c.tab))];
}

/** rail 上**计数**的段（齿轮不算：§5.1 的"齿轮不进 rail 计数"）。 */
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
