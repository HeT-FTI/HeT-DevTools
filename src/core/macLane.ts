/**
 * T07: macOS managed lane — pure helpers (POSIX, user-level, no root).
 *
 * Design parity with the Linux/WSL lanes:
 *   CLT (xcode-select) → private venv (conan/cmake/ninja, ~/.het-fti/managed-env)
 *   → GENERATED conan profile pinned to the resolved Apple clang + host arch
 *   → private CONAN_HOME → `conan create`.
 *
 * Capability contract (maintainer decision): macOS is **limited support** —
 * build / test / docs are committed; coverage is NOT (Apple clang emits no GNU
 * gcov data; the template instruments with -fprofile-instr-generate, i.e.
 * profraw, which lcov cannot consume). The llvm-cov adapter stays on the
 * roadmap (T20) — until then the contract reports lcov as `unsupported`.
 *
 * Never touches the user's conda envs, never uses root, never guesses a
 * compiler: CLT missing → guide (`xcode-select --install`), not a silent
 * fallback.
 *
 * Pure (no vscode/fs/exec): the execution layer lives in features/env/macLane.
 */
import { posix } from 'node:path';
import { LaneCompiler, LaneFacts, parseLaneFacts } from './laneProfile';
import { LaneMirror, mirrorShellExports } from './laneMirror';
import { wslLaneLayout } from './wslLane';

export interface MacFacts extends LaneFacts {
  /** `xcode-select -p` output ('' = Command Line Tools missing). */
  devDir: string;
  /** `command -v python3` ('' = absent). */
  python: string;
  /** Docs-stack probes (brew-provided on macOS). */
  doxygen?: string;
  dot?: string;
  make?: string;
}

/** Probe script (runs with the LOCAL bash on macOS). Line-oriented `lane_*`. */
export function macFactsScript(): string {
  return [
    'set -u',
    `printf 'lane_arch_raw:%s\\n' "$(uname -m 2>/dev/null || echo unknown)"`,
    // CLT presence gates everything: `xcrun` only resolves inside the dev dir.
    'dev="$(xcode-select -p 2>/dev/null || true)"',
    `printf 'mac_dev_dir:%s\\n' "\${dev:--}"`,
    'if [ -n "${dev:-}" ]; then',
    '  cc="$(xcrun --find clang 2>/dev/null || echo -)"',
    '  cxx="$(xcrun --find clang++ 2>/dev/null || echo -)"',
    '  if [ "$cc" != "-" ] && [ "$cxx" != "-" ]; then',
    "    cv=\"$(clang --version 2>/dev/null | head -1 | sed -n 's/.*version \\([0-9][0-9.]*\\).*/\\1/p')\"",
    `    printf 'lane_cc:%s\\n' "$cc"`,
    `    printf 'lane_cxx:%s\\n' "$cxx"`,
    '    printf \'lane_cc_name:Apple clang\\n\'',
    `    printf 'lane_cc_version:%s\\n' "\${cv:--}"`,
    '    printf \'lane_cc_baseline:native\\n\'',
    '  fi',
    'fi',
    `printf 'lane_python:%s\\n' "$(command -v python3 2>/dev/null || echo -)"`,
    `printf 'lane_doxygen:%s\\n' "$(command -v doxygen 2>/dev/null || echo -)"`,
    `printf 'lane_dot:%s\\n' "$(command -v dot 2>/dev/null || echo -)"`,
    `printf 'lane_make:%s\\n' "$(command -v make 2>/dev/null || echo -)"`,
    // lcov is intentionally NOT probed as a requirement: Apple clang has no GNU
    // gcov data, so the contract reports it as unsupported (limited support).
  ].join('\n');
}

/** Parse the macOS probe output (lane_* keys + mac_* extras). */
export function parseMacFacts(text: string): MacFacts {
  const base = parseLaneFacts(text);
  const kv: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const i = raw.indexOf(':');
    if (i > 0) {
      const key = raw.slice(0, i).trim();
      const value = raw.slice(i + 1).trim();
      if (value && value !== '-') {
        kv[key] = value;
      }
    }
  }
  const facts: MacFacts = { ...base, devDir: kv['mac_dev_dir'] ?? '', python: kv['lane_python'] ?? '' };
  if (kv['lane_doxygen']) {
    facts.doxygen = kv['lane_doxygen'];
  }
  if (kv['lane_dot']) {
    facts.dot = kv['lane_dot'];
  }
  if (kv['lane_make']) {
    facts.make = kv['lane_make'];
  }
  return facts;
}

/** Lane compiler facts derived from the CLT probe (never guessed). */
export function macCompiler(facts: MacFacts): LaneCompiler | undefined {
  if (!facts.compiler) {
    return undefined;
  }
  return { ...facts.compiler, libcxx: 'libc++', baseline: 'native' };
}

/** Actionable guidance when the CLT (or python3) is missing — no root needed. */
export function macGuide(problem: 'clt' | 'python'): string {
  if (problem === 'clt') {
    return [
      'macOS 托管车道需要 Xcode Command Line Tools（提供 clang 与 python3）：',
      '  xcode-select --install   （图形界面确认一次，约 5–10 分钟）',
      '装好后重新运行「一键准备环境」即可（车道会自建私有 venv + 生成式 profile）。',
    ].join('\n');
  }
  return [
    'macOS 托管车道需要 python3（Xcode CLT 自带）：',
    '  xcode-select --install   或   brew install python',
    '装好后重新运行「一键准备环境」即可。',
  ].join('\n');
}

/** Docs toolchain note: doxygen/graphviz come from Homebrew on macOS (optional). */
export function macDocsGuide(missing: string[]): string {
  const pkgs = missing.includes('doxygen') || missing.includes('graphviz') ? 'doxygen graphviz' : 'doxygen graphviz make';
  return [
    `文档链缺少：${missing.join('、')}（不影响构建/测试）。`,
    `  brew install ${pkgs}   （Sphinx 由车道 venv 自备，无需 brew）`,
  ].join('\n');
}

/**
 * Idempotent docs-stack bootstrap (user level): pip sphinx/numpy into the lane
 * venv, then REPORT the brew-provided system tools (never auto-installs them —
 * macOS has no passwordless root by design).
 */
export function macLaneDocsEnsureCommand(home: string, pipPackages: readonly string[], opts: { mirror?: LaneMirror } = {}): string {
  const l = wslLaneLayout(home);
  const venvBin = posix.join(l.venv, 'bin');
  return [
    'set -e',
    ...mirrorShellExports(opts.mirror),
    `export PATH="${venvBin}:$PATH"`,
    `if [ ! -x "${posix.join(venvBin, 'sphinx-build')}" ]; then`,
    `  "${posix.join(venvBin, 'pip')}" install --disable-pip-version-check -q ${pipPackages.join(' ')}`,
    'fi',
    `echo docs_sphinx:$([ -x "${posix.join(venvBin, 'sphinx-build')}" ] && sphinx-build --version | head -1 || echo -)`,
    'echo docs_doxygen:$(command -v doxygen >/dev/null 2>&1 && doxygen --version || echo -)',
    'echo docs_dot:$(command -v dot >/dev/null 2>&1 && dot -V 2>&1 | head -1 || echo -)',
    'echo docs_make:$(command -v make >/dev/null 2>&1 && make --version | head -1 || echo -)',
  ].join('\n');
}
