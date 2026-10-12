/**
 * host 侧事实 → 单页模型的纯映射（**不 import vscode**，可直接单测）。
 *
 * 分工：controller/adapter 负责"取数"（健康分、环境、构建、测试、覆盖率、文档…），
 * 本文件只负责"摆到 L1/L2 上"，并把"是否需人工介入"翻译成人话（材料第 1 条）。
 * 没有的事实一律留 `—`/`idle`，**不编造**（宁可空，不可假）。
 */
import { SECTIONS } from './sections';
import { copilotEntryForCard } from './copilotEntry';
import { spineFrom, visibleCards } from './spine';
import { deriveCapabilities } from '../../../core/capability';
import { gitFactOf, type GitFacts } from '../../../core/gitFacts';
import { depEvolution, type DeclaredDep } from '../../../core/depEvolution';
import { perfFact, type BenchRun } from '../../../core/perfBaseline';
import { abiFact, type AbiSnapshot } from '../../../core/abiSymbols';
import { headerCostFact, type HeaderCostRun } from '../../../core/headerCost';
import type { FcppMetadata } from '../../../types';
import {
  DEFAULT_FOLDED,
  type CardRow,
  type CardState,
  type SectionId,
  type SinglePageModel,
} from './model';
import type { CockpitState } from '../state';
import type { PreflightSummary } from '../../../core/preflightSummary';
import type { CiLastRun } from '../../../core/ciFacts';

/** host 侧已知的事实（全部可选；缺项 = 未知）。 */
export interface SinglePageFacts {
  health?: { score: number | null; issues?: number };
  /**
   * **仓库级忙状态**（`core/status.ts`）：吸顶右侧 / chip 都读它。
   * 与 `state.top.running`（log 抽屉的"正在跑"）刻意分开：文档构建会同时有两者，
   * 谁先结束都不该把另一个清掉 —— 模型里取"有值的那一个"。
   */
  status?: { action: string; text: string } | null;
  env?: {
    /** 例如 `linux-managed` / `win-wsl2`。 */
    provider?: string;
    label?: string;
    ready?: boolean;
    /** 缺系统包时能不能自动装（ADR-8）。 */
    selfHeal?: boolean;
    /** 需要人工介入时的一句话（含可复制命令）。 */
    next?: string;
  };
  build?: { ok: boolean | null; ago?: string; buildType?: string };
  test?: { passed?: number; failed?: number; skipped?: number };
  coverage?: { pct: number | null; at?: string };
  docs?: { pages?: number | null; missingTool?: string; at?: string };
  /** 质量门禁：就绪工具数 / 总数 / 失败项名。 */
  quality?: { ready?: number; total?: number; failing?: string };
  /**
   * 依赖事实（V3 · L5b / G6）。
   *
   * **以前这里没人喂** —— 卡片上的"直接/间接"是 L1 时写死的两个数字，界面上从没出现过
   * 真值。现在只喂**取得到的**：`declared` 来自依赖管理器的 `listDependencies()`，
   * 缺口/新版由 `core/depEvolution.ts` 从真实文件与缓存算。
   *
   * "间接依赖数"**没有事实来源**，所以不再显示（P7：没有来源的数字不进界面）。
   */
  deps?: {
    declared?: readonly DeclaredDep[];
    conandataText?: string;
    ciWorkflowText?: string;
    srcFiles?: Readonly<Record<string, string>>;
    latest?: Readonly<Record<string, string>>;
    latestAt?: string;
  };
  commit?: Partial<GitFacts>;
  /**
   * ⑧ 交付站的「新库自检」（V3 · L5 / G4）：模板生成契约的逐条判定结果（`✓/✗/–` 三态）。
   * 不给 = 还没跑过（卡停在默认 `—`，不编造）。
   */
  newLibAudit?: { state: 'ok' | 'warn' | 'fail' | 'idle'; fact: string; next?: string };
  /**
   * ⑧ 交付站的「Python 绑定」（V3 · L6c / G9）：公开 API（`include/` 里带 `@exporter`）
   * 与 `api/python_bindings.cpp` 的对账结果。不给 = 还没读到那些文件（卡停在 `—`）。
   */
  pythonBindings?: { state: 'ok' | 'warn' | 'fail' | 'idle'; fact: string; next?: string };
  /**
   * ⑧ 交付站的「交叉编译」（V3 · L6d）：**多目标全绿了吗** —— 目标来自
   * `.hetai/build-matrix.yml`，结果来自本地账本。不给 = 没有矩阵文件（单目标库，卡停在 `—`）。
   */
  matrix?: { state: 'ok' | 'warn' | 'fail' | 'idle'; fact: string; next?: string };
  /**
   * ⑤ 质量站的「编译期成本」（V3 · L6e，仅头文件库）：基线 + 最近一次实测。
   * 不给 = 还没实测过/没基线 → 卡片如实说"还没实测过（不等于成本为零）"。
   */
  headerCost?: { baseline?: HeaderCostRun; now?: HeaderCostRun; costPct: number };
  /**
   * ⑤ 质量站的「导出符号」（V3 · L6b / G8）：符号基线 + 最近一次扫描。
   * 不给 = 还没扫过/没钉基线 → 卡片如实说"符号基线未设"。
   */
  abi?: { baseline?: AbiSnapshot; now?: AbiSnapshot };
  /**
   * ③ 测试站的「性能基线」（V3 · L6a / G7）：基线 + 最近一次跑的结果（都是原始值）。
   * 不给 = 还没跑过/没钉基线 → 卡片如实说"基线未设"（**不给空表**）。
   */
  perf?: { baseline?: BenchRun; run?: BenchRun; regressPct: number };
  /**
   * ⑦ 发布站的「CI 总编排」（V3 · L4 / G10）：入口 workflow 的真实解析结果。
   * 不给 = 没读到那个文件 → 卡上一行如实说"非模板项目或还没同步"。
   */
  orchestrator?: { fact: string; next?: string };
  /** 发布/Preflight：三态摘要（§19.2）—— ✗/– 都要能看出"要不要人介入"。 */
  release?: { notReady?: number; summary?: PreflightSummary };
  ci?: { lastRun?: CiLastRun; branch?: string; fact?: string; next?: string };
  network?: { profile?: 'auto' | 'cn' | 'global' | 'custom'; summary?: string };
  /** 上板：`fact` 里**必须**能看出"是否 flash"（§19.3 的安全项）。 */
  board?: { mode?: string; collected?: boolean; fact?: string; next?: string };
  /**
   * 最近一次 Copilot 入口的回执（§8 Phase 1）：只回执"我发了哪条、打开没打开"，
   * **不解析 Copilot 的结果**（没有稳定 API）。
   */
  copilot?: { card?: string; ok?: boolean; at?: string; command?: string };
  /** 模板落后上游多少提交（§11 联动；0/未给 = 不提示）。 */
  template?: { behind?: number };
  /**
   * 工具链事实（V3 · L2d）：由 `discoverTools()` 的一次探测结果算出。
   * 不给 = 还没探测（卡上就没有事实，**不编造**）。
   */
  tools?: { total: number; ready: number; missing: string[]; summary: string };
  /**
   * 产物事实来源（V3 §5.2）：**只用来推导能力，不直接上界面**。
   *
   * 不给 = 未知 → 与能力相关的卡**一张都不隐藏**（读不到 metadata 不是"没有能力"）。
   */
  metadata?: FcppMetadata;
  /** 其它**产物**事实（文件系统读取的结果；读不到就不给）。 */
  artifacts?: { cHeader?: boolean; benchmark?: boolean; buildMatrix?: boolean };
}

/** 空事实（首屏/未取到数时用）。 */
export const EMPTY_FACTS: SinglePageFacts = {};

function pct(v: number | null | undefined): string {
  return typeof v === 'number' ? `${v.toFixed(1)}%` : '—';
}

/** 事实 → 每张卡的補丁（只覆盖有值的字段）。 */
function cardPatch(f: SinglePageFacts): Record<string, Partial<CardRow>> {
  const out: Record<string, Partial<CardRow>> = {};
  const put = (id: string, patch: Partial<CardRow>): void => {
    out[id] = { ...(out[id] ?? {}), ...patch };
  };
  if (f.health) {
    put('health', {
      state: f.health.score == null ? 'idle' : f.health.score >= 80 ? 'ok' : f.health.score >= 60 ? 'warn' : 'fail',
      fact: f.health.score == null ? '—' : `${f.health.score} · ${f.health.issues ?? 0} 项建议`,
    });
  }
  if (f.env) {
    const state: CardState = f.env.ready === true ? 'ok' : f.env.ready === false ? 'warn' : 'idle';
    put('env', {
      state,
      fact: `${f.env.label ?? f.env.provider ?? '—'} · 自愈${f.env.selfHeal === true ? '可用' : f.env.selfHeal === false ? '不可用' : '未知'}`,
      ...(f.env.next ? { next: f.env.next } : {}),
    });
  }
  if (f.build) {
    // E 块删掉了"只读摘要段"里那张同名卡：结果现在**只喂给执行卡**（一个事实一个地方），
    // 否则用户会看到两张卡一个说"通过"一个还停在 `—`。
    put('buildTest', {
      state: f.build.ok === true ? 'ok' : f.build.ok === false ? 'fail' : 'idle',
      fact:
        f.build.ok === true
          ? `${f.build.ago ?? '最近'} · ${f.build.buildType ?? 'Release'}`
          : f.build.ok === false
            ? '上次失败'
            : '—',
    });
  }
  if (f.test) {
    const failed = f.test.failed ?? 0;
    put('testFull', {
      state: failed > 0 ? 'fail' : typeof f.test.passed === 'number' ? 'ok' : 'idle',
      fact:
        typeof f.test.passed === 'number'
          ? `${f.test.passed}/${f.test.passed + failed} · ${failed} failed`
          : '—',
    });
  }
  if (f.coverage) {
    put('coverageDetail', {
      state: f.coverage.pct == null ? 'idle' : 'ok',
      fact: f.coverage.pct == null ? '—' : `${pct(f.coverage.pct)} · ${f.coverage.at ?? '上次构建'}`,
    });
  }
  if (f.docs) {
    const missing = f.docs.missingTool;
    put('docsBuild', {
      state: missing ? 'warn' : f.docs.pages == null ? 'idle' : 'ok',
      fact: missing ? `缺 ${missing}` : f.docs.pages == null ? '—' : `${f.docs.pages} 页 · ${f.docs.at ?? '已生成'}`,
      ...(missing ? { next: `需要你执行：安装 ${missing}（或在托管车道里一键准备）` } : {}),
    });
  }
  if (f.quality) {
    const ready = f.quality.ready ?? 0;
    const total = f.quality.total ?? 0;
    put('quality', {
      state: f.quality.failing ? 'fail' : ready > 0 && ready === total ? 'ok' : 'idle',
      fact: `${f.quality.failing ? `✗ ${f.quality.failing} · ` : ''}工具 ${ready}/${total} 就绪`,
    });
  }
  if (f.deps) {
    // 组成一行只在这里（`core/depEvolution.ts` 是纯函数）—— 卡片与依赖面板、
    // 工程审计读的是同一批事实，不各算一套。
    const ev = depEvolution(f.deps);
    put('deps', {
      state: ev.state,
      fact: ev.fact,
      ...(ev.next ? { next: ev.next } : {}),
    });
  }
  if (f.commit) {
    // V3 · L4 / G3：以前只写"N 个文件未提交"，"推没推、离远端差几个"要出门看。
    // 现在一行由 `gitFactOf` 统一产出（发布前检查用的是**同一条规则**，不各说一套）。
    const view = gitFactOf(f.commit);
    put('commit', {
      state: view.state,
      fact: view.fact,
      ...(view.next ? { next: view.next } : {}),
    });
  }
  if (f.release) {
    const s = f.release.summary;
    const notReady = f.release.notReady ?? 0;
    put('release', {
      state: s ? (s.fail > 0 ? 'fail' : s.na > 0 ? 'warn' : 'ok') : notReady > 0 ? 'warn' : 'ok',
      fact: s ? s.fact : notReady > 0 ? `${notReady} 项未就绪` : '预检就绪',
      ...(s?.next ? { next: s.next } : {}),
    });
  }
  if (f.ci) {
    const run = f.ci.lastRun;
    put('ci', {
      state: run === 'ok' ? 'ok' : run === 'fail' ? 'fail' : run === 'running' ? 'running' : 'idle',
      fact:
        f.ci.fact ??
        `上次 ${run === 'ok' ? '绿' : run === 'fail' ? '红' : run === 'running' ? '在跑' : '—'} · ${f.ci.branch ?? 'main'}`,
      ...(f.ci.next ? { next: f.ci.next } : {}),
    });
  }
  if (f.network) {
    put('network', {
      state: 'ok',
      fact: f.network.summary ?? (f.network.profile === 'cn' ? '国内源' : f.network.profile === 'global' ? '国际源' : '自动'),
    });
  }
  if (f.board) {
    put('board', {
      state: f.board.collected ? 'ok' : 'idle',
      fact: f.board.fact ?? `${f.board.mode ?? '--no-flash'} · ${f.board.collected ? '已采集' : '未采集'}`,
      ...(f.board.next ? { next: f.board.next } : {}),
    });
  }
  put('lane', {
    state: f.env?.ready === true ? 'ok' : f.env?.ready === false ? 'warn' : 'idle',
    fact: f.env?.provider ?? '—',
    ...(f.env?.next ? { next: f.env.next } : {}),
  });
  if (f.tools) {
    // 事实就是那一行摘要（含"缺谁"）—— 全绿时不啰嗦。
    const missing = f.tools.missing.length;
    put('tools', {
      state: f.tools.total === 0 ? 'idle' : missing > 0 ? 'warn' : 'ok',
      ...(f.tools.summary ? { fact: f.tools.summary } : {}),
      ...(missing > 0 ? { next: `需要你处理：${f.tools.missing.join(' ')}（点开看路径与来源）` } : {}),
    });
  }
  if (f.newLibAudit) {
    put('newLibAudit', {
      state: f.newLibAudit.state,
      fact: f.newLibAudit.fact,
      ...(f.newLibAudit.next ? { next: f.newLibAudit.next } : {}),
    });
  }
  if (f.pythonBindings) {
    put('pythonBindings', {
      state: f.pythonBindings.state,
      fact: f.pythonBindings.fact,
      ...(f.pythonBindings.next ? { next: f.pythonBindings.next } : {}),
    });
  }
  if (f.matrix) {
    // 「交叉编译」卡的事实从 `—` 换成矩阵汇总（多目标工程的"全绿了吗"就在这里）
    put('crossBuild', {
      state: f.matrix.state,
      fact: f.matrix.fact,
      ...(f.matrix.next ? { next: f.matrix.next } : {}),
    });
  }
  if (f.headerCost) {
    const view = headerCostFact(f.headerCost);
    put('headerCost', {
      state: view.state,
      fact: view.fact,
      ...(view.next ? { next: view.next } : {}),
    });
  }
  if (f.abi) {
    const view = abiFact(f.abi);
    put('abiSymbols', {
      state: view.state,
      fact: view.fact,
      ...(view.next ? { next: view.next } : {}),
    });
  }
  if (f.perf) {
    const view = perfFact(f.perf);
    put('perfBaseline', {
      state: view.state,
      fact: view.fact,
      ...(view.next ? { next: view.next } : {}),
    });
  }
  if (f.orchestrator) {
    put('orchestrator', {
      state: 'idle',
      fact: f.orchestrator.fact,
      ...(f.orchestrator.next ? { next: f.orchestrator.next } : {}),
    });
  }
  put('settings', {
    // 不写静态 fact：它只会把副标题再说一遍（"metadata.json 表单" vs
    // "metadata.json / conandata.yml 字段级编辑"）。这张卡没有动态状态，
    // 事实格就应该是空的（§6.0 第 6 条：零信息的格子不渲染）。
    state: 'idle',
  });
  put('commitManual', {
    state: 'idle',
    fact: '仅在你不想用 Copilot 时',
  });
  put('audit', {
    state: 'idle',
    fact: '审计报告 / 模板同步',
  });
  // Copilot 卡片的"预期产物"是静态定义（sections.ts，有门禁与 COPILOT_ENTRIES 对齐）；
  // 只有在真点过之后才被回执覆盖 —— 不编造、不覆盖预期。
  // 只覆盖"主按钮就是该 Copilot 入口"的卡片：像环境卡那样把入口放在次级按钮上的，
  // 它的 fact 是**运行时事实**（车道/自愈），不能被"已打开 Chat"覆盖掉。
  if (f.copilot?.card) {
    const target = f.copilot.card;
    const def = SECTIONS.flatMap((s) => s.cards).find((c) => c.id === target);
    const isPrimary = def?.action?.kind === 'copilot' && copilotEntryForCard(target)?.command === def.action.id;
    if (isPrimary) {
      const ok = f.copilot.ok !== false;
      const at = f.copilot.at;
      const cmd = f.copilot.command ?? '入口命令';
      put(target, {
        state: ok ? 'ok' : 'warn',
        // §19.1 ①：必须让用户看到"插件到底发了什么"（命令 + 时间）
        fact: ok ? (at ? `已发送 ${cmd} · ${at}` : `已发送 ${cmd}`) : `未能自动打开 Chat（${cmd}）`,
        ...(ok ? {} : { next: `需要你执行：在 Copilot Chat 里手动执行 ${cmd}` }),
      });
    }
  }
  put('moduleWizard', { state: 'idle', fact: '生成成对文件骨架' });
  return out;
}

/**
 * 组装单页模型：静态定义（SECTIONS）+ 事实补丁 + 折叠状态 + 顶部状态。
 *
 * `folded === undefined` = 用默认（只展开段 1）；持久化数据由 controller 读出来传进来。
 */
export function singlePageModelFrom(
  state: CockpitState,
  facts: SinglePageFacts = EMPTY_FACTS,
  folded: SectionId[] = DEFAULT_FOLDED,
): SinglePageModel {
  const patch = cardPatch(facts);
  const all: CardRow[] = SECTIONS.flatMap((s) => s.cards).map((def) => ({ ...def, ...(patch[def.id] ?? {}) }));
  // 能力事实（§5.2）：未给 metadata = undefined（未知）→ `visibleCards` 不隐藏任何卡。
  const caps = deriveCapabilities({
    metadata: facts.metadata,
    hasCHeader: facts.artifacts?.cHeader,
    hasBenchmark: facts.artifacts?.benchmark,
    hasBuildMatrix: facts.artifacts?.buildMatrix,
  });
  const cards = visibleCards(all, caps);
  // V3 · L5b / G5：「模板同步」卡的事实来自这个数（它不属于"产物能力"，也不该由 host 再写一遍）。
  // 落后 → warn ⇒ ① 就绪站的站状态（聚合卡的）跟着变黄 —— 这就是"落后时必须看得出来"。
  // **没查过就不是"一致"**：`undefined` 时如实留 idle + 一行"还没查过"（不编造）。
  const behindKnown = facts.template?.behind ?? state.top.templateBehind;
  const templateBehind = behindKnown ?? 0;
  const syncCard = cards.find((c) => c.id === 'templateSync');
  if (syncCard) {
    if (behindKnown === undefined) {
      syncCard.state = 'idle';
      syncCard.fact = '—';
      syncCard.next = '需要你执行：点「检查模板更新」读一次（本会话还没查过）';
    } else if (behindKnown > 0) {
      syncCard.state = 'warn';
      syncCard.fact = `落后上游 ${behindKnown} 个提交`;
      syncCard.next = '需要你执行：点「检查模板更新」生成同步计划（只读对比，绝不自动合入）';
    } else {
      syncCard.state = 'ok';
      syncCard.fact = '与模板一致';
      syncCard.next = undefined;
    }
  }
  return {
    cards,
    busy: facts.status?.text ?? state.top.running,
    folded,
    templateBehind,
    caps,
    spine: spineFrom(cards),
  };
}

/** 段是否有"红项"（rail 上打点用）。 */
export function sectionsWithProblems(model: SinglePageModel): SectionId[] {
  const bad = new Set<SectionId>();
  for (const def of SECTIONS) {
    for (const c of def.cards) {
      const live = model.cards.find((x) => x.id === c.id);
      if (live && (live.state === 'fail' || live.state === 'warn')) {
        bad.add(def.id);
      }
    }
  }
  return [...bad];
}
