/**
 * 5 段 × 卡片的静态定义（纯数据，**不 import vscode**）。
 *
 * 用途：
 * 1. 生成页面（shell 用）；
 * 2. **"信息不丢"校验** —— 旧 UI 的 11 个 tab 必须每张都在新页面上有归属（`tabsCovered()`）；
 * 3. 单测断言（段 id 唯一、每张卡恰好一个主按钮来源、懒加载标记合理）。
 */
import { LEGACY_TAB_IDS, type CardRow, type LegacyTabId, type SectionId } from './model';

export interface SectionDef {
  id: SectionId;
  /** rail 上的序号（1..5）与标题。 */
  order: number;
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
  /** 这张卡是否默认折叠（§6：只展开段 1）。 */
  foldedByDefault: boolean;
  cards: CardRow[];
}

function card(row: CardRow): CardRow {
  return row;
}

/** 25 张卡（覆盖旧 11 个 tab；见每个 `tab` 字段）。段 1 只读、执行入口唯一（§F.38）。 */
export const SECTIONS: SectionDef[] = [
  {
    id: 'now',
    order: 1,
    label: '现在怎么样',
    rail: '🩺',
    railLabel: '现在',
    icon: 'pulse',
    hint: '只读摘要：看结果、不执行 —— 要动手去对应段（按钮只在执行段里有一份）',
    foldedByDefault: false,
    cards: [
      card({ id: 'health', tab: 'overview', label: '健康分', state: 'idle', fact: '—', action: { id: 'health', label: '重新体检', kind: 'action' }, stage: 'inline', lazy: false }),
      card({
        id: 'env',
        tab: 'overview',
        label: '环境',
        state: 'idle',
        fact: '—',
        // §F.38（实测反馈第 6 条）：段 1 **只读**。执行入口只在执行段里有一份 ——
        // 同一个动作用两个名字出现在两段，就是"这两个到底有什么区别"的来源。
        // 保留一个解释入口（Copilot 答疑）因为它不重复任何动作。
        extra: [
          { id: 'build', label: '去准备环境', kind: 'jump' },
          { id: '/het-setup', label: '让 Copilot 讲清楚', kind: 'copilot' },
        ],
        stage: 'inline',
        lazy: false,
      }),
      card({ id: 'build', tab: 'overview', label: '构建结果', state: 'idle', fact: '—', extra: [{ id: 'build', label: '去构建', kind: 'jump' }], stage: 'output', lazy: false }),
      card({ id: 'test', tab: 'overview', label: '测试结果', state: 'idle', fact: '—', extra: [{ id: 'build', label: '去测试', kind: 'jump' }], stage: 'output', lazy: false }),
      card({ id: 'coverage', tab: 'overview', label: '覆盖率', state: 'idle', fact: '—', extra: [{ id: 'build', label: '去测试', kind: 'jump' }], stage: 'inline', lazy: true }),
      card({ id: 'docs', tab: 'overview', label: '文档', state: 'idle', fact: '—', extra: [{ id: 'code', label: '去编译文档', kind: 'jump' }], stage: 'inline', lazy: true }),
    ],
  },
  {
    id: 'build',
    order: 2,
    label: '构建与验证',
    rail: '🔨',
    railLabel: '构建',
    icon: 'beaker',
    hint: 'conan create · GTest/CTest · 覆盖率 · 托管环境',
    foldedByDefault: true,
    cards: [
      // 实测反馈第 6 条："构建"与"构建并测试"到底有什么区别？—— 拆成两张卡，
      // 各自**只有一个动作**，并用 `sub` 静态说明它跑的是哪条链（不再靠猜）。
      card({
        id: 'buildTest',
        tab: 'buildTest',
        label: '构建（消费依赖 · main.cpp）',
        sub: 'conan create：装好 cmake/conan 后，编译并打包本包（可执行 main.cpp）',
        state: 'idle',
        fact: '—',
        action: { id: 'build', label: '构建', kind: 'action' },
        stage: 'output',
        lazy: false,
      }),
      card({
        id: 'testFull',
        tab: 'buildTest',
        label: '测试及验证（full-test-automation）',
        sub: '与 CI 同一条链：conan create + GTest/CTest + 覆盖率报告（本机等价复现）',
        state: 'idle',
        fact: '—',
        action: { id: 'test', label: '构建并测试', kind: 'action' },
        stage: 'output',
        lazy: false,
      }),
      card({ id: 'coverageDetail', tab: 'buildTest', label: '覆盖率详情', state: 'idle', fact: '—', action: { id: 'openCoverageReport', label: '打开报告', kind: 'action' }, stage: 'external', lazy: true }),
      card({ id: 'lane', tab: 'overview', label: '托管环境', state: 'idle', fact: '—', action: { id: 'envPrepare', label: '同意并准备', kind: 'action' }, secondary: { id: 'envRemove', label: '移除…', kind: 'action' }, stage: 'output', lazy: false }),
    ],
  },
  {
    id: 'code',
    order: 3,
    label: '代码与文档',
    rail: '📄',
    railLabel: '代码',
    icon: 'symbol-method',
    hint: '模块 · 测试生成 · 文档 · 质量 · 依赖',
    foldedByDefault: true,
    cards: [
      card({ id: 'docsAuthoring', tab: 'docs', label: '文档注释补全（Copilot）', state: 'idle', fact: '预期：Doxygen 注释补全', action: { id: '/het-docs', label: '补注释', kind: 'copilot' }, stage: 'chat', lazy: true }),
      card({ id: 'docsBuild', tab: 'docs', label: '文档编译（本地出 HTML）', state: 'idle', fact: '预期：本地 HTML（不经 Chat）', action: { id: 'docsRun', label: '编译文档', kind: 'action' }, stage: 'output', lazy: true }),
      // §F.44（实测反馈第 3 条）：主路径改成 **Copilot 协作**（PRD → 接口 → 骨架计划 →
      // diff 预览 → 确认后写盘），向导降级为"单模块微调"（只出骨架，不含 PRD/测试）。
      card({
        id: 'moduleAgent',
        tab: 'moduleTest',
        label: '新增模块 / API（Copilot，项目级）',
        sub: '与 Copilot 协作：先定 PRD 与接口 → 生成 include/src 骨架计划 → 预览 diff → 你确认后写入，并衔接 /het-testgen',
        state: 'idle',
        fact: '预期：PRD → 接口设计 → 骨架计划 → diff 预览',
        action: { id: '/het-module', label: '和 Copilot 一起加模块', kind: 'copilot' },
        stage: 'chat',
        lazy: true,
      }),
      card({
        id: 'moduleWizard',
        tab: 'moduleTest',
        label: '单模块微调（向导）',
        sub: '只生成 include/ + src/ 骨架（无 PRD、无测试）——适合小改动或先看命名规范',
        state: 'idle',
        fact: '—',
        action: { id: 'newModule', label: '打开向导', kind: 'action' },
        stage: 'panel',
        lazy: false,
      }),
      card({ id: 'testgen', tab: 'moduleTest', label: '测试生成（Copilot）', state: 'idle', fact: '预期：GTest 骨架（从代码 / 从蓝图）', action: { id: '/het-testgen', label: '生成测试', kind: 'copilot' }, stage: 'chat', lazy: true }),
      card({ id: 'quality', tab: 'quality', label: '质量', state: 'idle', fact: '—', action: { id: 'quality', label: '检查', kind: 'action' }, stage: 'panel', lazy: true }),
      card({ id: 'deps', tab: 'deps', label: '依赖', state: 'idle', fact: '—', action: { id: 'openDeps', label: '打开面板', kind: 'action' }, stage: 'panel', lazy: true }),
    ],
  },
  {
    id: 'deliver',
    order: 4,
    label: '交付',
    rail: '📦',
    railLabel: '交付',
    icon: 'rocket',
    hint: '提交 · 发布/Preflight · CI · 审计',
    foldedByDefault: true,
    cards: [
      card({
        id: 'commit',
        tab: 'commit',
        label: '智能提交（Copilot）',
        state: 'idle',
        fact: '预期：拆分提交预览（不 push）',
        action: { id: '/het-commit', label: '生成提交', kind: 'copilot' },
        // §19.1 ③ 的 Phase 1 形态：只把自查提示写进终端（**不回车**，不自动 push）
        extra: [{ id: 'pushHint', label: '推送提示', kind: 'action' }],
        stage: 'chat',
        lazy: true,
      }),
      card({ id: 'commitManual', tab: 'commit', label: '手动提交（兜底）', state: 'idle', fact: '—', action: { id: 'commitManual', label: '打开提交助手', kind: 'action' }, stage: 'panel', lazy: true }),
      card({ id: 'release', tab: 'release', label: '发布 / Preflight', state: 'idle', fact: '—', action: { id: 'preflight', label: '运行预检', kind: 'action' }, stage: 'panel', lazy: true }),
      card({ id: 'ci', tab: 'collab', label: 'CI', state: 'idle', fact: '—', action: { id: 'ci', label: '打开 CI', kind: 'action' }, stage: 'external', lazy: true }),
      card({ id: 'audit', tab: 'collab', label: '审计 / 模板', state: 'idle', fact: '—', action: { id: 'audit', label: '生成审计', kind: 'action' }, stage: 'panel', lazy: true }),
    ],
  },
  {
    id: 'config',
    order: 5,
    label: '配置',
    rail: '⚙️',
    railLabel: '配置',
    icon: 'settings-gear',
    hint: 'metadata · 网络与源 · 上板',
    foldedByDefault: true,
    cards: [
      card({ id: 'settings', tab: 'settings', label: 'metadata 表单', state: 'idle', fact: '—', action: { id: 'openSettings', label: '打开设置面板', kind: 'action' }, stage: 'panel', lazy: true }),
      card({ id: 'network', tab: 'settings', label: '网络与源', state: 'idle', fact: '—', stage: 'inline', lazy: false }),
      card({ id: 'board', tab: 'bench', label: '上板（bench）', state: 'idle', fact: '—', action: { id: 'benchmark', label: '打开上板面板', kind: 'action' }, stage: 'panel', lazy: true }),
    ],
  },
];

export function sectionDef(id: SectionId): SectionDef | undefined {
  return SECTIONS.find((s) => s.id === id);
}

export function allCards(): CardRow[] {
  return SECTIONS.flatMap((s) => s.cards);
}

/** 卡片 id → 所在段（供 host 侧定位要更新哪一段）。 */
/** 旧 tab id → 它现在归属的段（深链继续可用：老链接不用改）。 */
export function sectionForTab(tab: string): SectionId | undefined {
  for (const s of SECTIONS) {
    if (s.cards.some((c) => c.tab === tab)) {
      return s.id;
    }
  }
  return undefined;
}

export function cardSection(cardId: string): SectionId | undefined {
  return SECTIONS.find((s) => s.cards.some((c) => c.id === cardId))?.id;
}

/** 旧 UI 的 11 个 tab（或：`model.ts › LEGACY_TAB_IDS`；旧 UI 已归档，这串 id 只用于"信息不丢"校验）。 */
export const LEGACY_TABS: readonly LegacyTabId[] = LEGACY_TAB_IDS;

/** 新页面覆盖了哪些旧 tab（应等于 `LEGACY_TABS` —— 单测断言）。 */
export function tabsCovered(): LegacyTabId[] {
  return [...new Set(allCards().map((c) => c.tab))];
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
