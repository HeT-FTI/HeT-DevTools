/**
 * host 侧事实 → 单页模型的纯映射（**不 import vscode**，可直接单测）。
 *
 * 分工：controller/adapter 负责"取数"（健康分、环境、构建、测试、覆盖率、文档…），
 * 本文件只负责"摆到 L1/L2 上"，并把"是否需人工介入"翻译成人话（材料第 1 条）。
 * 没有的事实一律留 `—`/`idle`，**不编造**（宁可空，不可假）。
 */
import { SECTIONS } from './sections';
import { copilotEntryForCard } from './copilotEntry';
import {
  DEFAULT_FOLDED,
  type CardRow,
  type CardState,
  type L1Item,
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
   * **仓库级忙状态**（`core/status.ts`）：吸顶右侧 / chip / HUD 都读它。
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
  deps?: { direct?: number; indirect?: number };
  commit?: { dirty?: number };
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
}

/** 空事实（首屏/未取到数时用）。 */
export const EMPTY_FACTS: SinglePageFacts = {};

function pct(v: number | null | undefined): string {
  return typeof v === 'number' ? `${v.toFixed(1)}%` : '—';
}

function l1From(f: SinglePageFacts): L1Item[] {
  const build = f.build;
  const buildState: CardState =
    build?.ok === true ? 'ok' : build?.ok === false ? 'fail' : 'idle';
  const test = f.test;
  const testState: CardState =
    test?.failed && test.failed > 0 ? 'fail' : typeof test?.passed === 'number' ? 'ok' : 'idle';
  const covState: CardState = f.coverage?.pct == null ? 'idle' : f.coverage.pct > 0 ? 'ok' : 'warn';
  const envState: CardState =
    f.env?.ready === true ? 'ok' : f.env && f.env.ready === false ? 'warn' : 'idle';
  return [
    { id: 'build', label: '构建', value: build?.ago ?? (build?.ok === true ? '通过' : '—'), state: buildState },
    {
      id: 'test',
      label: '测试',
      value:
        typeof test?.passed === 'number' ? `${test.passed}/${test.passed + (test.failed ?? 0)}` : '—',
      state: testState,
    },
    { id: 'coverage', label: '覆盖率', value: pct(f.coverage?.pct), state: covState },
    { id: 'env', label: '环境', value: f.env?.label ?? f.env?.provider ?? '—', state: envState },
  ];
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
    // 段 1 是**只读摘要**、段 2 才是执行区（§F.38）——结果要同时喂给两张卡，
    // 否则执行卡永远显示 `—`，用户就会以为"构建没生效"。
    const patch: Partial<CardRow> = {
      state: f.build.ok === true ? 'ok' : f.build.ok === false ? 'fail' : 'idle',
      fact: f.build.ok === true ? `${f.build.ago ?? '最近'} · ${f.build.buildType ?? 'Release'}` : f.build.ok === false ? '上次失败' : '—',
    };
    put('build', patch);
    put('buildTest', patch);
  }
  if (f.test) {
    const failed = f.test.failed ?? 0;
    const patch: Partial<CardRow> = {
      state: failed > 0 ? 'fail' : typeof f.test.passed === 'number' ? 'ok' : 'idle',
      fact:
        typeof f.test.passed === 'number'
          ? `${f.test.passed}/${f.test.passed + failed} · ${failed} failed`
          : '—',
    };
    put('test', patch);
    put('testFull', patch);
  }
  if (f.coverage) {
    put('coverage', {
      state: f.coverage.pct == null ? 'idle' : 'ok',
      fact: f.coverage.pct == null ? '—' : `${pct(f.coverage.pct)} · 行覆盖`,
    });
    put('coverageDetail', {
      state: f.coverage.pct == null ? 'idle' : 'ok',
      fact: f.coverage.pct == null ? '—' : `${pct(f.coverage.pct)} · ${f.coverage.at ?? '上次构建'}`,
    });
  }
  if (f.docs) {
    const missing = f.docs.missingTool;
    put('docs', {
      state: missing ? 'warn' : f.docs.pages == null ? 'idle' : 'ok',
      fact: missing ? `缺 ${missing}` : f.docs.pages == null ? '—' : `${f.docs.pages} 页 · ${f.docs.at ?? '已生成'}`,
      ...(missing ? { next: `需要你执行：安装 ${missing}（或在托管车道里一键准备）` } : {}),
    });
    put('docsBuild', {
      state: missing ? 'warn' : f.docs.pages == null ? 'idle' : 'ok',
      fact: missing ? `缺 ${missing}` : f.docs.pages == null ? '—' : `${f.docs.pages} 页`,
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
    put('deps', {
      state: 'ok',
      fact: `直接 ${f.deps.direct ?? 0} · 间接 ${f.deps.indirect ?? 0}`,
    });
  }
  if (f.commit) {
    put('commit', {
      state: (f.commit.dirty ?? 0) > 0 ? 'warn' : 'ok',
      fact: (f.commit.dirty ?? 0) > 0 ? `${f.commit.dirty} 个文件未提交` : '工作区干净',
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
  put('buildTest', {
    state: f.build?.ok === true ? 'ok' : f.build?.ok === false ? 'fail' : 'idle',
    fact: f.build?.ok === true ? `最近：通过 · ${f.build.ago ?? ''}`.trim() : f.build?.ok === false ? '最近：失败' : '—',
  });
  put('settings', {
    state: 'idle',
    fact: 'metadata.json 表单',
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
  const cards: CardRow[] = SECTIONS.flatMap((s) => s.cards).map((def) => ({ ...def, ...(patch[def.id] ?? {}) }));
  return {
    l1: l1From(facts),
    cards,
    busy: facts.status?.text ?? state.top.running,
    folded,
    templateBehind: facts.template?.behind ?? state.top.templateBehind ?? 0,
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
