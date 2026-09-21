import { pathExists } from '../utils/fs';
import { join } from 'node:path';

/**
 * New-module wizard core (development-plan T-2.4 / G-08).
 * Generates the fcpp-paired file skeleton (include/ + src/) with:
 *  - `// Conan::ImportStart / ImportEnd` wrappers
 *  - bilingual `@brief [en]/[zh]`, `@since`, `@exporter` doc comments
 *  - two blank lines between global objects
 *  - `.h/.c` for C, `.hpp/.cpp` for C++
 * Pure logic — no VS Code imports.
 */

export type ModuleLanguage = 'cpp' | 'c';

export interface ModulePlanInput {
  /** Lowercase snake/identifier, e.g. "mymod". */
  moduleName: string;
  description: string;
  language: ModuleLanguage;
  since: string;
  /** Optional raw declarations appended to the header (no #include lines). */
  extraDeclarations?: string[];
}

export interface PlannedFile {
  relPath: string;
  content: string;
}

export interface ModulePlan {
  ok: boolean;
  issues: string[];
  files: PlannedFile[];
}

const NAME_RE = /^[a-z][a-z0-9_]*$/;

/** 只保留真正的声明行（丢掉空行、`#include`/`#define` 等预处理行）。 */
function declLines(lines: readonly string[]): string[] {
  return lines.filter((l) => l.trim().length > 0 && !l.trim().startsWith('#'));
}

function declBody(lines: readonly string[]): string {
  return declLines(lines).join('\n\n\n'); // three blank lines = separate global objects per convention
}

/** 内置标量返回类型：占位返回值用 `0`（比 `{}` 更直白）。 */
const SCALAR_RETURN_RE =
  /^(void|bool|_Bool|char|signed char|unsigned char|short|unsigned short|int|unsigned int|long|unsigned long|long long|unsigned long long|float|double|long double|size_t|ssize_t|std::size_t|u?int\d+_t)\b/u;

/** 形如 `int foo(int a, int b);` 的函数原型（含返回类型与参数表）。 */
const FUNCTION_DECL_RE = /^([A-Za-z_][\w:\s<>,[\]*&]*?)\s+([A-Za-z_]\w*)\s*\(([^;]*)\)\s*;$/u;

/**
 * 把一条**函数原型**变成实现桩（源码文件里要用的那个函数体）。
 *
 * 实测反馈第 3 条（bug-v2 第 2 项）：额外公开声明以前**只写进头文件**，`src/` 里没有对应
 * 实现 —— 于是"接口在头里、链接不到"，看起来就像"声明丢了"。这里按返回类型给一个**能编译**
 * 的占位返回值，并显式写 `TODO`。
 *
 * 非函数声明（变量/宏/typedef）照旧只有头文件那一份，不需要实现。
 */
export function stubForDeclaration(decl: string, language: ModuleLanguage): string | null {
  const one = decl.replace(/\s+/gu, ' ').trim().replace(/\s*;$/u, ';');
  const m = FUNCTION_DECL_RE.exec(one);
  if (!m) {
    return null;
  }
  const [, retRaw, name, params] = m;
  const ret = retRaw.trim();
  const body: string[] = ['{', '    // TODO: 实现（当前返回值仅为占位，编译得过但语义未定）'];
  if (!/^void\b/u.test(ret)) {
    let stub: string;
    if (/^(bool|_Bool)\b/u.test(ret)) {
      stub = 'return false;';
    } else if (ret.includes('*')) {
      stub = language === 'cpp' ? 'return nullptr;' : 'return 0;';
    } else if (SCALAR_RETURN_RE.test(ret)) {
      stub = 'return 0;'; // 标量：0 比 `{}` 更直白（读者立刻知道"这是占位"）
    } else {
      // 结构体/类/别名：C++ 用 `{}`，C 用复合字面量 `(type){0}`（C99），都能编译。
      stub = language === 'cpp' ? 'return {};' : `return (${ret}){0};`;
    }
    body.push(`    ${stub}`);
  }
  body.push('}');
  return `${ret} ${name}(${params.trim()}) ${body.join('\n')}`;
}

export function planModuleFiles(input: ModulePlanInput): ModulePlan {
  const issues: string[] = [];
  const raw = input.moduleName.trim();
  const name = raw.toLowerCase();
  const desc = input.description.trim();
  const since = input.since.trim() || '1.0';

  if (!NAME_RE.test(raw)) {
    issues.push('模块名须为小写标识符（字母开头，仅 a-z/0-9/_，如 mymod）');
  }
  if (desc.length === 0) {
    issues.push('请填写一句话说明（将写入双语注释）');
  }
  if (issues.length > 0) {
    return { ok: false, issues, files: [] };
  }

  const isCpp = input.language === 'cpp';
  const [headerSuffix, sourceSuffix] = isCpp ? ['hpp', 'cpp'] : ['h', 'c'];
  const includeGuard = isCpp ? '#pragma once\n#include <cstdint>' : '#pragma once';

  const headerDoc = `/**
 * @brief [en] ${desc}
 * @brief [zh] ${desc}
 * @since ${since}
 * @exporter
 */`;

  const decls = input.extraDeclarations?.filter((d) => d.trim().length > 0) ?? [];
  const initDecl = `void ${name}_init(void);`;

  const headerBody = [
    `// Conan::ImportStart`,
    includeGuard,
    `// Conan::ImportEnd`,
    ``,
    headerDoc,
    initDecl,
  ].join('\n');

  // 额外公开声明：放在"额外公开接口"分隔线下，**不再重复插入一遍文件级 doc 块**
  // （重复的 @brief/@since 块会被 doxygen 当成第二个实体，观感也很乱）。
  const extra = declBody(decls);
  const headerContent = extra
    ? `${headerBody}\n\n\n// ---------------------------------------------------------------------------\n// 额外公开接口（由新增模块向导写入；实现桩在同名源文件里）\n// ---------------------------------------------------------------------------\n${extra}`
    : headerBody;

  const srcDoc = `/**
 * @brief [en] ${desc} — implementation
 * @brief [zh] ${desc} — 实现
 * @since ${since}
 */`;
  // §F.44：额外声明的**函数原型**必须在源文件里有实现（否则"接口在头里、链接不到"）。
  const stubs = declLines(decls)
    .map((d) => stubForDeclaration(d, input.language))
    .filter((x): x is string => x !== null);
  const sourceContent = [
    `// Conan::ImportStart`,
    `#include <${name}.${headerSuffix}>`,
    `// Conan::ImportEnd`,
    ``,
    srcDoc,
    ...stubs.flatMap((st) => [st, ``]),
    `void ${name}_init(void) {`,
    `    // TODO: implement`,
    `}`,
  ].join('\n');

  return {
    ok: true,
    issues: [],
    files: [
      { relPath: `include/${name}.${headerSuffix}`, content: `${headerContent}\n` },
      { relPath: `src/${name}.${sourceSuffix}`, content: `${sourceContent}\n` },
    ],
  };
}

/** Detect an existing pair so the wizard can warn before writing. */
export async function hasPair(root: string, moduleName: string): Promise<boolean> {
  for (const suffix of ['hpp', 'cpp', 'h', 'c']) {
    if (await pathExists(join(root, 'include', `${moduleName}.${suffix}`))) {
      return true;
    }
    if (await pathExists(join(root, 'src', `${moduleName}.${suffix}`))) {
      return true;
    }
  }
  return false;
}
