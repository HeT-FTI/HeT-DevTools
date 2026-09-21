/**
 * T22：「CI 事实外泄」审计门禁（S1 / No-CI-Fact Rule）。
 *
 * 要防的是什么：**CI 的事实被写进产品代码**，于是产品表现得像"只在这台 CI 机器上能用"
 * （E1 的 `/usr/bin/gcc-13`、E2 的 `x86_64`、E3 的 `cmake 4.0.1/3.28` 都是这一类）。
 *
 * 门禁只认**"钉"的形态**，不认散文与注释 —— 这条边界是**量化**出来的，不是拍脑袋：
 *   · 扫描前**剥掉注释**：历史叙事（"过去写死过 /usr/bin/gcc-13"）是文档，不是事实；
 *   · 只匹配**字面量/路径**形态：`'/usr/bin/gcc-13'`、`'gcc-13'`、`'>= 3.28'`；
 *   · `src/test/**` 不扫：测试里写死期望值正是它的职责（断言必须能说出具体值）。
 *
 * **为什么不管 `x86_64` 与 `.conan2`**（v2 计划里点过名，这里收窄并留档）：
 *   · `x86_64` 现在多处是"宿主 uname → conan arch"的**映射表**，不是 pin（pin 在
 *     `laneProfile` 的探测/阶梯里）；拿它当门禁会产生大量误报 → 门禁会被关掉；
 *   · `.conan2` 现在由车道布局模块**有意**定为该名（与 CI 缓存布局对齐），且模板侧已
 *     改为从 `$CONAN_HOME` 派生（T10）——它不再是"外泄"，而是"协商好的契约"。
 *   这两类的真实保护是 T21 的 parity/探针测试：**盯"值从哪来"，而不是"字符串出现过"**。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** 允许出现 CI 基线的**归属模块**（pin 的唯一归宿）。 */
export const PIN_OWNER_FILES = [
  'src/core/laneProfile.ts', // 编译器阶梯 + CMake 底线
  'src/core/toolchainManifest.ts', // 清单（版本语义）
  'src/core/lanePython.ts', // docs 解释器下限
];

export interface PinPattern {
  id: string;
  re: RegExp;
  why: string;
}

export const PIN_PATTERNS: PinPattern[] = [
  {
    id: 'ci-compiler-path',
    re: /\/usr\/bin\/(?:gcc|g\+\+|gcov)-13\b/gu,
    why: 'CI 机器的绝对编译器路径（E1）：产品里出现即等于"只在那台机器上能用"',
  },
  {
    id: 'baseline-compiler-literal',
    re: /(['"])(?:gcc|g\+\+|gcov)-13\1/gu,
    why: 'gcc-13 基线的字面量：只能由 laneProfile 的阶梯给出',
  },
  {
    id: 'duplicated-floor',
    re: /(['"])>=\s*(?:3\.28|3\.10)\1/gu,
    why: '版本下限被抄成字面量（CMake 3.28 / Python 3.10）：应从归属模块派生',
  },
];

export interface PinFinding {
  file: string;
  line: number;
  pattern: string;
  text: string;
  why: string;
}

/**
 * 剥掉注释（保留行号，便于定位）。
 * 已知局限：不处理字符串里的 `//`（本仓库没有这种写法，若将来出现，门禁会**多报**而不是漏报 —— 偏安全）。
 */
export function stripComments(text: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const rawLine of text.split('\n')) {
    let line = rawLine;
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) {
        out.push('');
        continue;
      }
      line = line.slice(end + 2);
      inBlock = false;
    }
    // 行内块注释（同一行可能有多个）
    for (;;) {
      const start = line.indexOf('/*');
      if (start === -1) {
        break;
      }
      const end = line.indexOf('*/', start + 2);
      if (end === -1) {
        line = line.slice(0, start);
        inBlock = true;
        break;
      }
      line = line.slice(0, start) + line.slice(end + 2);
    }
    const lineComment = line.indexOf('//');
    if (lineComment !== -1) {
      line = line.slice(0, lineComment);
    }
    out.push(line);
  }
  return out.join('\n');
}

/** 扫描一份源码文本（`file` 用仓库相对 posix 路径）。 */
export function scanSource(file: string, text: string): PinFinding[] {
  const rel = file.split(sep).join('/');
  if (PIN_OWNER_FILES.includes(rel) || rel.startsWith('src/test/')) {
    return [];
  }
  const findings: PinFinding[] = [];
  const lines = stripComments(text).split('\n');
  for (const [i, line] of lines.entries()) {
    for (const p of PIN_PATTERNS) {
      p.re.lastIndex = 0;
      if (p.re.test(line)) {
        findings.push({ file: rel, line: i + 1, pattern: p.id, text: line.trim(), why: p.why });
      }
    }
  }
  return findings;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walk(p, acc);
    } else if (name.endsWith('.ts')) {
      acc.push(p);
    }
  }
  return acc;
}

/** 扫描整棵树（默认 `src`）；返回命中与统计。 */
export function auditTree(root = 'src'): { findings: PinFinding[]; scanned: number; skipped: number } {
  const files = walk(root);
  const findings: PinFinding[] = [];
  let skipped = 0;
  for (const f of files) {
    const rel = relative('.', f).split(sep).join('/');
    const text = readFileSync(f, 'utf8');
    const hit = scanSource(rel, text);
    if (PIN_OWNER_FILES.includes(rel) || rel.startsWith('src/test/')) {
      skipped += 1;
    }
    findings.push(...hit);
  }
  return { findings, scanned: files.length, skipped };
}

/** 给人看的报告（门禁失败时打印它）。 */
export function formatReport(findings: PinFinding[]): string {
  if (findings.length === 0) {
    return '✔ audit:pins —— 没有发现外泄的 CI 事实';
  }
  const lines = ['✘ audit:pins —— 发现外泄的 CI 事实（应改为从归属模块派生）：', ''];
  for (const f of findings) {
    lines.push(`  ${f.file}:${f.line}  [${f.pattern}]`);
    lines.push(`      ${f.text}`);
    lines.push(`      ↳ ${f.why}`);
  }
  lines.push('');
  lines.push(`  归属模块（允许出现）：${PIN_OWNER_FILES.join('、')}`);
  return lines.join('\n');
}
