/**
 * **CI 总编排的事实与落点对账**（V3 计划 §7.1 · L4 / G10）—— 纯函数，**不 import vscode**。
 *
 * 痛点原文（G10）：**「总编排不可见」** —— 模板里的 `ci-orchestrator.yml` 是"一次 push 到底
 * 会跑哪些 job、按什么顺序"的**唯一答案**，但在整个扩展源码里 **0 引用**：
 * 用户看得到单个动作映射到哪个 job（Intent 表），却看不到这台机器整体的编排。
 *
 * 这里做两件事：
 * 1. **解析**入口 workflow（job 清单 + 触发事件）→ ⑦ 发布站「CI 总编排」卡的那一行事实；
 * 2. **落点对账表**（`WORKFLOW_SURFACES`）：模板里**每一个** workflow 文件都必须写明
 *    "它在界面上由谁呈现" —— 新增一个 workflow 忘了登记 → 门禁红（G10 的可测形式）。
 */
import { parseWorkflowYaml } from './ciStatus';

export interface WorkflowJobFact {
  id: string;
  /** `name:` 那行的展示名（有的 job 不写）。 */
  name?: string;
}

export interface OrchestratorFacts {
  /** 文件名（如 `ci-orchestrator.yml`）。 */
  file: string;
  /** workflow 的 `name:`。 */
  name: string;
  /** 触发事件（去重、保序）。 */
  triggers: string[];
  /** job 清单（**保序**：文件里的顺序就是编排顺序，正是用户要看的东西）。 */
  jobs: WorkflowJobFact[];
}

/**
 * 解析 `jobs:` 段下的 job（两个空格的键），并抓每个 job 的 `name:`。
 *
 * 为什么不用现成 YAML 库：这里只读"用户仓库里已经存在的那份文件"，
 * 加一个依赖只为读两个字段不划算；认不出就返回空，`orchestratorFactOf` 会如实说"读不到"。
 */
export function parseWorkflowJobs(text: string): WorkflowJobFact[] {
  const lines = text.split(/\r?\n/u).map((l) => l.replace(/\s*#.*$/u, ''));
  const out: WorkflowJobFact[] = [];
  let inJobs = false;
  for (const line of lines) {
    if (/^jobs:\s*$/u.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) {
      continue;
    }
    if (/^\S/u.test(line)) {
      break; // 回到顶层键 → jobs 段结束
    }
    const job = /^ {2}([a-z][a-z0-9_-]*):\s*$/u.exec(line);
    if (job) {
      out.push({ id: job[1] });
      continue;
    }
    const name = /^ {4}name:\s*(.+?)\s*$/u.exec(line);
    if (name && out.length > 0 && out[out.length - 1].name === undefined) {
      out[out.length - 1] = { ...out[out.length - 1], name: name[1] };
    }
  }
  return out;
}

/** 入口 workflow 文件 → 事实（`text` 为 null = 用户仓库里没有这个文件）。 */
export function parseOrchestrator(text: string, file = 'ci-orchestrator.yml'): OrchestratorFacts {
  const head = parseWorkflowYaml(file, text);
  return { file, name: head.name, triggers: head.on, jobs: parseWorkflowJobs(text) };
}

/**
 * 事实 → 卡片那一行。
 *
 * `state` 恒为 `idle`：这是**静态知识**（编排长什么样），不是一次运行的结果 ——
 * 给绿色会让人以为"CI 已经过了"。
 */
export function orchestratorFactOf(o: OrchestratorFacts | null): { state: 'idle'; fact: string; next?: string } {
  if (!o || o.jobs.length === 0) {
    return {
      state: 'idle',
      fact: '—',
      next: '没读到入口 workflow（.github/workflows/ci-orchestrator.yml）：非模板项目或还没同步',
    };
  }
  const triggers = o.triggers.slice(0, 2).join('/') || '（无触发事件）';
  const first = o.jobs[0];
  return {
    state: 'idle',
    fact: `${o.jobs.length} 个 job · ${triggers}`,
    next: `第一个 job：${first.name ?? first.id}（点开看完整顺序）`,
  };
}

/**
 * **落点对账表**：模板里每个 workflow 文件 → 界面上由谁呈现（G10 的门禁来源）。
 *
 * `surface` 的三种写法：
 * · `intent:<id>` —— 有动作 Intent 映射到它的 job（`ci.workflow` 必须等于本行 file）；
 * · `card:<id>`   —— 由某张卡呈现（如本次新增的「CI 总编排」）；
 * · `'none'`      —— **确实不该有界面落点**（纯仓库机器），`note` 必须写清为什么。
 *
 * `surface: null` 必须带 `pending`（哪个块来补）—— 只许**变短**，不许静默积压。
 */
export const WORKFLOW_SURFACES: readonly {
  file: string;
  surface: string | null;
  note: string;
  pending?: 'L5' | 'L6';
}[] = [
  { file: 'ci-orchestrator.yml', surface: 'card:orchestrator', note: '⑦ 发布站「CI 总编排」卡（L4 新增 —— 此前 0 引用）' },
  { file: 'ci-build-test.yml', surface: 'intent:build', note: '② 构建站「编译打包」的 CI 对应' },
  { file: 'cross-compile.yml', surface: 'intent:crossBuild', note: '⑧ 交付站「交叉编译」的 CI 对应' },
  { file: 'full-test-automation.yml', surface: 'intent:test', note: '③ 测试站「全量测试」的 CI 对应' },
  { file: 'metadata-controller.yml', surface: 'intent:openDeps', note: '② 构建站「依赖」的 CI 对应（metadata 分析）' },
  { file: 'hetai-package-matrix.yml', surface: 'intent:benchmark', note: '⑧ 交付站「上板验证」的 CI 对应' },
  { file: 'docs-build.yml', surface: 'intent:docsRun', note: '④ 文档站「编译文档」的 CI 对应' },
  { file: 'security-linters.yml', surface: 'intent:quality', note: '⑤ 质量站「质量门禁」的 CI 对应（同时是依赖系统头映射的事实来源）' },
  { file: 'semver-release.yml', surface: 'intent:release', note: '⑦ 发布站「发布中心」的 CI 对应（自动发版）' },
  // L5b 更正：这个文件**不是**模板同步（名字误导）—— 它是 labels.yml 的自动标注 workflow。
  // 与其为了凑"每个 workflow 都有卡"而编一个入口，不如如实登记"它不该有"（P7）。
  { file: 'sync-template.yml', surface: 'none', note: '其实是 labels.yml 的自动标注 workflow（名字有误导）；纯仓库机器，没有面向用户的动作' },
];

/**
 * 对账：模板里的文件清单 vs 表。返回问题清单（空 = 绿）。
 *
 * 三种病：**漏登记**（新 workflow 没人管）/ **幽灵条目**（文件已删、表还留着）/
 * **未落地还想蒙混**（`surface: null` 却没写是哪个块来补）。
 */
export function surfaceViolations(templateFiles: readonly string[]): string[] {
  const bad: string[] = [];
  const known = new Set(WORKFLOW_SURFACES.map((s) => s.file));
  for (const f of templateFiles) {
    if (!known.has(f)) {
      bad.push(`${f}：模板里有这个 workflow，但没登记"它在界面上由谁呈现"（G10）`);
    }
  }
  const onDisk = new Set(templateFiles);
  for (const s of WORKFLOW_SURFACES) {
    if (!onDisk.has(s.file)) {
      bad.push(`${s.file}：对账表里的条目在模板里已经不存在了（幽灵条目）`);
    }
    if (s.surface === null && !s.pending) {
      bad.push(`${s.file}：还没落地就必须写明由哪个块补（pending）`);
    }
  }
  return bad;
}
