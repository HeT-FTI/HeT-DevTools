/**
 * Turn a raw `docs/build.py` failure tail into an ACTIONABLE hint.
 *
 * Policy (same as the lane/contract cards): a missing *prerequisite* must come
 * back as a concrete path the user can execute, never as a bare traceback in the
 * output channel. Background: the `linux-system` env-fresh job set up a host
 * python with conan but WITHOUT the docs dependencies, and `toolchain=system`
 * correctly refused to install anything — the user-visible result was
 * `ModuleNotFoundError: No module named 'numpy'` plus a generic message.
 *
 * Pure logic (no `vscode`) so it is unit-tested.
 */

const DOCS_PIP = 'numpy sphinx sphinx-intl sphinx-rtd-theme';

/** Python modules whose absence we can explain (regex → package name). */
const PY_MODULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/No module named ['"]?numpy\b/iu, 'numpy'],
  [/No module named ['"]?sphinx_rtd_theme\b/iu, 'sphinx-rtd-theme'],
  [/No module named ['"]?sphinx_intl\b/iu, 'sphinx-intl'],
  [/No module named ['"]?sphinx\b/iu, 'sphinx'],
];

export interface DocsHintInput {
  /** Tail of the docs run output (stdout + stderr). */
  tail: string;
  /** Interpreter that ran `docs/build.py` (null/undefined when none was found). */
  python?: string | null;
  platform?: NodeJS.Platform | string;
}

/**
 * 「真的没找到」的信号 —— 必须是 shell / 解释器**自己说出来的**，而不是「输出里提到了这个词」。
 *
 * 为什么必须有这道闸（实测，`env-fresh · windows` run 35480007485）：模板的
 * `docs/build.py` 在 Windows 上因路径分隔符误判而失败（上游已在 `6278d01` 修掉），它的回溯里赫然有
 * `self.doxygen_automation()` → 仅凭「tail 里出现 doxygen」就断言「缺系统工具 doxygen」，
 * 等于把**真原因**（一条 `RuntimeError: documentation completeness check failed`）盖掉，
 * 让用户去装一个已经装好的工具。
 */
const MISSING_SIGNAL =
  /not recognized as an internal or external command|is not recognized as the name of a cmdlet|command not found|:\s*not found\b|No such file or directory|\[Errno 2\]|\[WinError 2\]|FileNotFoundError|Executable not found|not found in PATH|which: no /iu;

/**
 * Actionable guidance for a FAILED docs run, or `undefined` when the tail does
 * not look like a missing-prerequisite problem (caller keeps its generic text).
 */
export function docsFailureHint(input: DocsHintInput): string | undefined {
  const tail = input.tail ?? '';
  const py = input.python && input.python.trim().length > 0 ? input.python : 'python3';

  const missing = [...new Set(PY_MODULES.filter(([re]) => re.test(tail)).map(([, name]) => name))];
  // 工具缺失必须「有信号」——见 MISSING_SIGNAL 的注释；另外用词边界，别被
  // `doxygen_automation` 这类函数名骗到（`_` 是词字符，`\bdoxygen\b` 不会命中）。
  const signalled = MISSING_SIGNAL.test(tail);
  const needsDoxygen = signalled && /\bdoxygen\b/iu.test(tail);
  const needsGraphviz = signalled && /graphviz|\bdot\b/iu.test(tail);
  const needsMake = signalled && /\bmake\b/iu.test(tail);
  if (missing.length === 0 && !needsDoxygen && !needsGraphviz && !needsMake) {
    return undefined;
  }

  const lines: string[] = ['文档生成失败：宿主缺少文档前置（当前是本机工具链，扩展不会替你安装）。'];
  if (missing.length > 0) {
    lines.push(`  · 缺 Python 依赖：${missing.join(' / ')}`);
    lines.push(`  · 补齐：${py} -m pip install ${DOCS_PIP}`);
  }
  if (needsDoxygen || needsGraphviz || needsMake) {
    const tools = [needsDoxygen && 'doxygen', needsGraphviz && 'graphviz', needsMake && 'make'].filter(Boolean) as string[];
    lines.push(`  · 缺系统工具：${tools.join(' / ')}`);
    // Platform-aware, "what a Windows/macOS user would actually type":
    // suggesting `sudo apt-get` on Windows is not a recognisable instruction.
    lines.push(`  · 补齐：${installHint(tools, input.platform)}`);
  }
  lines.push('  · 或把工程的 metadata.json 改回 "toolchain": "managed" —— 托管车道会自动准备上面这些。');
  return lines.join('\n');
}

/** The command a user of THIS platform would recognise (winget/choco · brew · apt). */
export function installHint(tools: readonly string[], platform?: NodeJS.Platform | string): string {
  const wants = (t: string): boolean => tools.includes(t);
  if (platform === 'win32') {
    const winget = [wants('doxygen') && 'winget install Doxygen.Doxygen', wants('graphviz') && 'winget install Graphviz.Graphviz']
      .filter(Boolean)
      .join(' && ');
    const choco = `choco install -y ${[wants('doxygen') && 'doxygen.install', wants('graphviz') && 'graphviz', wants('make') && 'make'].filter(Boolean).join(' ')}`;
    return `${winget || choco}（没装 winget 就用：${choco}）`;
  }
  if (platform === 'darwin') {
    return `brew install ${tools.map((t) => (t === 'graphviz' ? 'graphviz' : t)).join(' ')}`;
  }
  return `sudo apt-get install -y ${tools.map((t) => (t === 'graphviz' ? 'graphviz' : t)).join(' ')}`;
}
