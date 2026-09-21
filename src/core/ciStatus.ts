/**
 * CI status helpers (development-plan T-4.2 / G-19).
 * Pure logic — no VS Code imports. Parses the git remote origin and the local
 * `.github/workflows/*.yml` so the panel stays useful even fully offline.
 */

export interface RepoIdentity {
  owner: string;
  repo: string;
}

/** Parse `git remote get-url origin` → owner/repo (https, ssh, git@). */
export function parseRemoteOrigin(url: string): RepoIdentity | null {
  const u = url.trim();
  const m = u.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (m) {
    return { owner: m[1], repo: m[2] };
  }
  return null;
}

export interface LocalWorkflow {
  file: string;
  name: string;
  on: string[];
}

/**
 * Lightweight YAML reader for workflow files: extracts top-level `name:` and
 * the triggers under `on:` (inline mapping or list form). Enough for the UI.
 */
export function parseWorkflowYaml(fileName: string, text: string): LocalWorkflow {
  const nameMatch = /^name:\s*(.+?)\s*$/m.exec(text);
  const name = nameMatch ? nameMatch[1].trim() : fileName.replace(/\.ya?ml$/i, '');
  const on: string[] = [];
  const lines = text.split(/\r?\n/);
  let inOn = false;
  let sawList = false;
  for (const raw of lines) {
    const line = raw.replace(/\s*#.*$/, '');
    if (/^on:\s*(.*)$/.test(line)) {
      inOn = true;
      sawList = false;
      const inline = /^on:\s*(.+?)\s*$/.exec(line)?.[1]?.trim();
      if (inline && inline !== '') {
        if (inline.startsWith('[')) {
          for (const t of inline.slice(1, -1).split(',')) {
            const v = t.trim().replace(/^['"]|['"]$/g, '');
            if (v) {
              on.push(v);
            }
          }
        } else {
          on.push(inline);
        }
      }
      continue;
    }
    if (inOn) {
      if (/^\S/.test(line)) {
        inOn = false;
        continue;
      }
      const evt = /^\s{2,}([\w-]+):\s*$/.exec(line);
      if (evt) {
        on.push(evt[1]);
        sawList = true;
        continue;
      }
      if (sawList) {
        const item = /^\s{4,}-\s+(.+?)\s*$/.exec(line);
        if (item) {
          const v = item[1].trim().replace(/^['"]|['"]$/g, '');
          if (v) {
            on.push(v);
          }
          continue;
        }
      }
    }
  }
  return { file: fileName, name, on };
}

/**
 * 「拿不到远端 CI 状态」的**明确解释**（实测反馈：面板只写"无法访问 GitHub"，看不出
 * 是没装 gh、没登录、还是真断网，于是没法行动）。
 *
 * 输入是探取的原始事实（gh 在不在 / 退出码 / stderr / 抛出的错误），输出是
 * "为什么 + 怎么办"两行，纯函数、可单测。
 */
export interface CiFetchFacts {
  /** gh CLI 是否可用（`which gh`）。 */
  ghPresent: boolean;
  /** `gh api` 的退出码（抛异常时为 null）。 */
  code?: number | null;
  stderr?: string;
  /** `run()` 抛出的错误消息（超时/无法启动）。 */
  error?: string;
}

export interface CiFetchExplanation {
  /** 一句话"为什么"。 */
  reason: string;
  /** 可照做的下一步（1..3 条，含可复制命令）。 */
  fix: string[];
  /** 是否属于"凭据/权限"问题（面板可据此把登录入口摆前）。 */
  authRelated: boolean;
}

export function explainCiFetchFailure(facts: CiFetchFacts): CiFetchExplanation {
  const err = (facts.stderr ?? '').replace(/\s+/gu, ' ').trim();
  const head = err.split(' ').slice(0, 8).join(' ');
  if (!facts.ghPresent) {
    return {
      reason: '本机没有 gh CLI，扩展读不到 GitHub Actions 的远端运行状态。',
      fix: [
        '装 gh：https://cli.github.com（也可用包管理器：`brew install gh` / `winget install GitHub.cli`）',
        '登录：`gh auth login`（私有仓库必须；公开仓库只读也要它来做请求）',
      ],
      authRelated: true,
    };
  }
  if (facts.error) {
    return {
      reason: `调用 gh 失败/超时：${facts.error}`,
      fix: [
        '网络受限时可先只本地看工作流清单（面板下半部分），CI 详情去浏览器打开',
        '配代理或走公司镜像后点「🔄 刷新」',
      ],
      authRelated: false,
    };
  }
  const code = facts.code ?? null;
  if (code === 401 || code === 403) {
    return {
      reason: `gh 返回 ${code}：凭据无效或权限不足（token 过期 / 缺 repo、workflow 权限）。${head}`.trim(),
      fix: [
        '重新登录：`gh auth login`（或 `gh auth refresh -s repo,workflow`）',
        '在 VS Code 里退出并重新登录 GitHub 账户',
      ],
      authRelated: true,
    };
  }
  if (code === 404) {
    return {
      reason: `gh 返回 404：仓库不可见或名字不对（私有仓库需先登录；也可能是 origin 指到了别的组织）。${head}`.trim(),
      fix: [
        '确认 origin 指向的 owner/repo 与 GitHub 上一致',
        '私有仓库：`gh auth login` 后再点「🔄 刷新」',
      ],
      authRelated: true,
    };
  }
  return {
    reason: code === null || code === 0
      ? 'gh 没有返回运行数据（仓库可能还没有任何 Actions 运行）。'
      : `gh 返回 ${code}：读取 Actions 状态失败。${head}`.trim(),
    fix: [
      '仓库刚创建时先推一次提交触发 workflow，再点「🔄 刷新」',
      '连续失败时用 `gh api repos/<owner>/<repo>/actions/runs` 在终端里复核',
    ],
    authRelated: false,
  };
}
