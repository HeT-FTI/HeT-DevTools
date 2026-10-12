/**
 * **Git 事实**（V3 计划 §7.1 · L4 / G3）—— 纯函数，**不 import vscode**。
 *
 * 痛点原文（§6 表格 G3）：**「提交不闭环：分支 / ahead / PR / CI 回执要出门看」**。
 * 以前 ⑥ 提交站只有一句话「N 个文件未提交」—— 于是"我提交到哪了、推没推、离远端差几个"
 * 全靠切窗口 `git status -sb`。
 *
 * 这里只做一件事：把 `git status --porcelain=v2 --branch` 的**原始输出**变成
 * "用户此刻关心的那一行" —— 并用同一个函数喂卡片与发布前检查（**一处口径，两处显示**）。
 *
 * 硬约束：
 * 1. **一条命令**（`--porcelain=v2 --branch`）同时给出分支 / 上游 / ahead-behind / 脏文件数，
 *    比原来"先 `--porcelain` 再猜分支"少一次子进程；
 * 2. **不知道就不说**：没有上游时**不许**说"已同步"（那只是没得比），要如实写"本地分支"；
 * 3. 文案只回答"下一步该不该动手"，不解释 git 原理（P7）。
 */
import type { CiLastRun } from './ciFacts';

/** 一次 git 探测的全部事实（`repo:false` = 连仓都不是）。 */
export interface GitFacts {
  /** 是不是 git 仓库（false = 外面根本没有仓）。 */
  repo: boolean;
  /** 当前分支；detached HEAD 时为 null。 */
  branch: string | null;
  /** HEAD 是否游离（游离状态提交会丢，必须显式提醒）。 */
  detached: boolean;
  /** 上游（如 `origin/main`）；null = **没设上游**（不是"落后 0"）。 */
  upstream: string | null;
  /** 相对上游领先的提交数（没上游时不参与判断）。 */
  ahead: number;
  /** 相对上游落后的提交数。 */
  behind: number;
  /** 未提交（含未跟踪）文件数。 */
  dirty: number;
}

/** 默认值：能调到 git 命令就说明**有仓**，其余一律"不知道"。 */
const BASE: GitFacts = {
  repo: true,
  branch: null,
  detached: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  dirty: 0,
};

/** `git status --porcelain=v2 --branch` 的解析（认不出的行一律忽略，**不猜**）。 */
export function parseStatusV2(stdout: string): GitFacts {
  const out: GitFacts = { ...BASE };
  let dirty = 0;
  for (const raw of stdout.split(/\r?\n/u)) {
    const line = raw.trimEnd();
    if (line === '') {
      continue;
    }
    if (line.startsWith('# branch.head ')) {
      const v = line.slice('# branch.head '.length).trim();
      if (v === '(detached)') {
        out.detached = true;
      } else if (v !== '') {
        out.branch = v;
      }
      continue;
    }
    if (line.startsWith('# branch.upstream ')) {
      const v = line.slice('# branch.upstream '.length).trim();
      if (v !== '') {
        out.upstream = v;
      }
      continue;
    }
    if (line.startsWith('# branch.ab ')) {
      const m = /^\+\s*(\d+)\s+-\s*(\d+)$/u.exec(line.slice('# branch.ab '.length).trim());
      if (m) {
        out.ahead = Number(m[1]);
        out.behind = Number(m[2]);
      }
      continue;
    }
    if (line.startsWith('#')) {
      continue; // 其它头行（branch.oid / stash 计数…）
    }
    // 变更行：`1 `(改动) / `2 `(重命名) / `u `(冲突) / `? `(未跟踪)
    if (/^[12u?] /u.test(line)) {
      dirty += 1;
    }
  }
  out.dirty = dirty;
  return out;
}

export interface GitFactView {
  state: 'ok' | 'warn' | 'idle';
  /** L2 一行事实（先说分支，再说"还差什么"）。 */
  fact: string;
  /** 需要动手时的下一步（含可复制命令）。 */
  next?: string;
}

/**
 * 事实 → 卡片那一行。
 *
 * 取值顺序是**刻意的**：先看"根本没仓 / 游离（会丢东西）"，再看"本地的还没提交"，
 * 最后才是"提交了但没推 / 落后了"。一次只给**一个**下一步 —— 一次交代一件事。
 */
export function gitFactOf(input: Partial<GitFacts> = {}): GitFactView {
  const f: GitFacts = { ...BASE, ...input };
  if (!f.repo) {
    return {
      state: 'idle',
      fact: '不是 git 仓库',
      next: '需要你执行：git init（提交与 CI 都依赖仓库）',
    };
  }
  if (f.detached) {
    return {
      state: 'warn',
      fact: 'HEAD 游离（不在任何分支上）',
      next: '需要你执行：git switch -c <分支名>（游离状态下提交会丢）',
    };
  }
  const branch = f.branch ?? '当前分支';
  const dirtyText = f.dirty > 0 ? `${f.dirty} 个文件未提交` : '工作区干净';
  if (!f.upstream) {
    return {
      state: f.dirty > 0 ? 'warn' : 'idle',
      fact: `${branch} · 本地分支 · ${dirtyText}`,
      next: f.dirty > 0
        ? '需要你执行：⑥站「智能提交」生成拆分提交预览（不 push）'
        : `这是本地分支（没有上游）：要交付得先 git push -u origin ${branch}`,
    };
  }
  const rel = f.ahead > 0
    ? `领先 ${f.upstream} ${f.ahead}`
    : f.behind > 0
      ? `落后 ${f.upstream} ${f.behind}`
      : '';
  const fact = rel === '' ? `${branch} · ${dirtyText}` : `${branch} · ${dirtyText} · ${rel}`;
  if (f.dirty > 0) {
    return {
      state: 'warn',
      fact,
      next: '需要你执行：⑥站「智能提交」生成拆分提交预览（不 push）',
    };
  }
  if (f.ahead > 0) {
    return {
      state: 'warn',
      fact,
      next: `需要你执行：git push（${f.ahead} 个提交只在本地）—— 扩展不代推`,
    };
  }
  if (f.behind > 0) {
    return {
      state: 'warn',
      fact,
      next: `需要你执行：git pull --rebase（落后 ${f.behind} 个提交）`,
    };
  }
  return { state: 'ok', fact };
}

/** 发布前检查的一条 item（结构与 `features/preflight/html.ts` 的 `PreflightItem` 相同）。 */
export interface GateItem {
  label: string;
  ok: boolean | undefined;
  detail: string;
  required: boolean;
}

/**
 * 交付前强制门禁第 1 条：**提交必须已经推出去**（G3）。
 *
 * 为什么设为 `required`：本地分支没上游时，CI / PR / 发版**全都无从谈起** ——
 * 这不是"建议"，是"发布的前置条件"。`detail` 里给可复制命令，所以它红得有理有据。
 */
export function gitGateItem(input: Partial<GitFacts> = {}): GateItem {
  const f: GitFacts = { ...BASE, ...input };
  const label = '已推送（无未推提交）';
  if (!f.repo) {
    return { label, ok: undefined, detail: '不是 git 仓库 → 无法判断是否已推送', required: false };
  }
  const branch = f.branch ?? '<分支>';
  if (!f.upstream) {
    return {
      label,
      ok: false,
      detail: `本地分支 ${branch} 没有上游：发布前先 git push -u origin ${branch}`,
      required: true,
    };
  }
  if (f.ahead === 0 && f.behind === 0) {
    return { label, ok: true, detail: `${branch} · 与 ${f.upstream} 同步`, required: true };
  }
  const bits = [
    f.ahead > 0 ? `未推 ${f.ahead}` : '',
    f.behind > 0 ? `落后 ${f.behind}` : '',
  ].filter((s) => s !== '');
  return {
    label,
    ok: false,
    detail: `${branch} · ${bits.join(' · ')}（${f.ahead > 0 ? `git push` : `git pull --rebase`}）`,
    required: true,
  };
}

/** PR 回执（`gh pr list --head <分支>` 取到的**真实**结果；取不到就是 undefined）。 */
export interface PrFacts {
  number: number;
  /** `OPEN` / `MERGED` / `CLOSED`（gh 的原始 state）。 */
  state: string;
  url?: string;
}

export interface ReceiptInput {
  /** gh CLI 在不在（不在的话 detail 要说清"为什么没取到"）。 */
  ghPresent: boolean;
  /** 远端仓库是否已知（没有 origin 就没有 PR/CI 可谈）。 */
  hasRemote: boolean;
  branch?: string | null;
  /**
   * 该分支的 PR：**三态**——
   * · 对象 = 真取到了；· `null` = 查过了，这个分支上确实没有；
   * · `undefined` = **还没查**（不许写成"没有 PR"，那是编造）。
   */
  pr?: PrFacts | null;
  /** 取 PR 失败的原因（网络/权限），只用于 detail。 */
  prError?: string;
  /** 缓存的 CI 三态（卡片/面板刷过才有）。 */
  ci?: CiLastRun;
  /** CI 那次运行的人话时间。 */
  ciAt?: string;
}

/**
 * 交付前强制门禁第 2 条：**PR / CI 回执**（G3 的后半句 + G10）。
 *
 * 判红的标准很窄，只认两件真事：**CI 上次是红的** / **PR 被关掉且没合**。
 * 其余一律 `–` 并写清原因（没装 gh、没登录、还没跑过）—— `–` 不是绿。
 */
export function receiptItem(input: ReceiptInput): GateItem {
  const label = 'PR / CI 回执';
  if (!input.hasRemote) {
    return { label, ok: undefined, detail: '没有 origin 远端 → 没有 PR / CI 可看', required: false };
  }
  const bits: string[] = [];
  if (input.pr) {
    bits.push(`PR #${input.pr.number} ${input.pr.state.toLowerCase()}`);
  } else if (input.pr === null) {
    bits.push(`PR：${input.branch ? `分支 ${input.branch}` : '当前分支'}上还没有 PR`);
  } else if (input.prError) {
    bits.push(`PR：取不到（${input.prError}）`);
  } else if (!input.ghPresent) {
    bits.push('PR：本机没有 gh CLI');
  } else {
    bits.push('PR：还没查过（点「运行预检」会查一次）');
  }
  if (input.ci) {
    const icon = input.ci === 'ok' ? '✓' : input.ci === 'fail' ? '✗' : '⟳';
    bits.push(`CI 上次 ${icon}${input.ciAt ? ` · ${input.ciAt}` : ''}`);
  } else {
    bits.push('CI：还没取过（打开「CI」拉一次）');
  }
  const state = input.pr?.state.toUpperCase();
  let ok: boolean | undefined;
  if (input.ci === 'fail' || state === 'CLOSED') {
    ok = false;
  } else if (input.ci === 'ok' && input.pr?.state.toUpperCase() === 'MERGED') {
    ok = true;
  }
  return { label, ok, detail: bits.join(' · '), required: false };
}
