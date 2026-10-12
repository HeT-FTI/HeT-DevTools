/**
 * **新库自检**（V3 计划 §7.1 · L5 / G4）—— 纯函数，**不 import vscode**。
 *
 * 痛点原文：**「库契约靠人记」**。模板里有 `.github/misc/Codegen-Starter.txt`，它的
 * **SECTION 7 — GENERATION CHECKLIST** 是新库"做完没做完"的合同（23 条，见下面 `source`）。
 * 但这份合同只写在文档里：没有人会去逐条对照，漏掉的那几条（LICENSE 被改过、
 * 头文件少了 ImportStart 守卫、某个头文件没有单测）要等到 CI 红或者发布之后才发现。
 *
 * 这里把合同变成**可执行的自检**：
 * 1. 合同条目**逐条登记**在 `NEW_LIB_CHECKS`（`source` 就是模板里那一条的原文）——
 *    与模板文件**逐条对账**的门禁在 `test/newLibAudit.test.ts`：模板加一条、代码少一条，
 *    当场红；
 * 2. 能机器判的给 `evaluate`（读文件/读 metadata），判不了的**显式标 `why`**
 *    （`–` 必须说清为什么判不了，不许假装绿）。
 */
import type { FcppMetadata } from '../types';
import { baseName, splitPath } from '../utils/paths';

export interface NewLibCheck {
  /** 稳定 id（面板/日志用）。 */
  id: string;
  /** 模板 §7 里那一条的原文（规范化空白后）——与模板逐条对账的唯一依据。 */
  source: string;
  /** 面板上那一行的标题（人话）。 */
  title: string;
  /** 判不了的原因（判得了的不写）。 */
  why?: string;
  /** 判据（判不了的没有）。 */
  evaluate?: (s: LibSnapshot) => { ok: boolean | undefined; detail: string };
}

/** 判定需要的事实：**只放读到的**（读不到的东西不许出现在这里，否则就是编造）。 */
export interface LibSnapshot {
  /** 相对路径 → 文本内容（只收集判定要用到的文件）。 */
  files: Readonly<Record<string, string>>;
  /** 全部相对路径（目录以 `/` 结尾，与 `readdir` 的递归结果一致）。 */
  paths: readonly string[];
  metadata?: FcppMetadata;
  /** `conandata.yml` 解析出的 `pkg/version` 列表。 */
  conandata?: readonly string[];
  /** CI 里**专门装过系统头**的包名（从 workflow 里解析，如 zlib/pcre2/eigen/etl）。 */
  ciInstalled?: readonly string[];
  /** 模板自带的 LICENSE / NOTICE 原文（用来判"未经改动"）。 */
  templateLicense?: string;
  templateNotice?: string;
  /** 模板自己的项目名（判"旧名字有没有残留"）。 */
  templateName?: string;
  /** 本会话最近一次构建的结论（`undefined` = 本会话还没构建过）。 */
  buildOk?: boolean;
}

const has = (s: LibSnapshot, p: string): boolean => s.paths.includes(p);
const text = (s: LibSnapshot, p: string): string | undefined => s.files[p];

/** 某个目录下的文件（按扩展名过滤）。 */
function filesIn(s: LibSnapshot, dir: string, re: RegExp): string[] {
  return s.paths.filter((p) => p.startsWith(`${dir}/`) && re.test(p) && !p.endsWith('/'));
}

const GUARD = /Conan::Import(Start|End)/u;

/** 正则转义（头文件名里可能有 `.` 等元字符）。 */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * `metadata.json` 的依赖是**按桶**存的（`{common: {ZLIB: ["ZLIB::ZLIB"]}, c: {...}}`），
 * 桶名不是包名 —— 这里把真正的包名（桶里的键）拍平出来。
 */
export function dependencyNames(metadata: LibSnapshot['metadata']): string[] {
  const deps = (metadata?.dependencies ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  for (const [, v] of Object.entries(deps)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...Object.keys(v as Record<string, unknown>));
    } else {
      // 兼容旧形状：`{pkg: version}`
      out.push(...Object.keys(deps));
      break;
    }
  }
  return [...new Set(out)];
}

/**
 * CMake 侧的包名与 conan 侧的包名**写法不同**（`ZLIB`↔`zlib`、`Eigen3`↔`eigen`、
 * `GTest`↔`gtest`）—— 比较时忽略大小写，并允许一方是另一方的前缀。
 */
export function pkgMatches(metaName: string, conanName: string): boolean {
  const a = metaName.toLowerCase();
  const b = conanName.toLowerCase();
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/** 逐条自检（顺序 = 模板 §7 的顺序，面板也照这个顺序显示）。 */
export const NEW_LIB_CHECKS: readonly NewLibCheck[] = [
  {
    id: 'cppstd',
    source: 'metadata.json "build_cppstd" is "17" and "build_cstd" is "11".',
    title: 'C++17 / C11 标准写死在 metadata',
    evaluate: (s) => {
      const m = s.metadata;
      if (!m) {
        return { ok: undefined, detail: '读不到 metadata.json' };
      }
      const cpp = String(m.build_cppstd ?? '');
      const c = String(m.build_cstd ?? '');
      return {
        ok: cpp === '17' && c === '11',
        detail: `build_cppstd=${cpp || '(缺)'} · build_cstd=${c || '(缺)'}`,
      };
    },
  },
  {
    id: 'team-license',
    source: 'metadata.json "team" is "HeT-FTI" and "license" is "Apache-2.0".',
    title: 'team=HeT-FTI · license=Apache-2.0',
    evaluate: (s) => {
      const m = s.metadata;
      if (!m) {
        return { ok: undefined, detail: '读不到 metadata.json' };
      }
      const team = String(m.team ?? '');
      const license = String(m.license ?? '');
      return {
        ok: team === 'HeT-FTI' && license === 'Apache-2.0',
        detail: `team=${team || '(缺)'} · license=${license || '(缺)'}`,
      };
    },
  },
  {
    id: 'no-inplace-modules',
    source: 'metadata.json "generate_modules_inplace" is false.',
    title: 'generate_modules_inplace=false（模块不写回本仓）',
    evaluate: (s) => {
      const v = s.metadata?.generate_modules_inplace;
      if (v === undefined) {
        return { ok: undefined, detail: 'metadata 里没有这个字段' };
      }
      return { ok: v === false, detail: `generate_modules_inplace=${String(v)}` };
    },
  },
  {
    id: 'metadata-consistent',
    source: 'metadata.json is consistent with all other Section 1 values.',
    title: 'metadata 与"生成时填的 Section 1"一致',
    why: 'Section 1 是给人填的填写区（[FILL]），扩展读不到那份填写记录 —— 只能人对照一遍',
  },
  {
    id: 'conandata-deps',
    source: 'conandata.yml lists every dependency from Section 3.',
    title: 'conandata 覆盖 metadata 里的全部依赖（两份清单一致）',
    evaluate: (s) => {
      const want = dependencyNames(s.metadata);
      if (want.length === 0) {
        return { ok: undefined, detail: '读不到 metadata.dependencies（还没声明依赖？）' };
      }
      if (s.conandata === undefined) {
        return { ok: undefined, detail: '读不到 conandata.yml' };
      }
      const have = s.conandata.map((r) => splitPath(r)[0]?.trim() ?? '').filter((n) => n !== '');
      const missing = want.filter((w) => !have.some((h) => pkgMatches(w, h)));
      return {
        ok: missing.length === 0,
        detail: missing.length === 0 ? `${want.length} 个依赖两边都在` : `conandata 里找不到：${missing.join('、')}`,
      };
    },
  },
  {
    id: 'include-guard',
    source: 'Every header in include/ has the Conan::ImportStart/End guard.',
    title: 'include/ 每个头文件都有 ImportStart/End 守卫',
    evaluate: (s) => {
      const headers = filesIn(s, 'include', /\.(h|hpp|hh|hxx)$/u);
      if (headers.length === 0) {
        return { ok: undefined, detail: 'include/ 下没有头文件' };
      }
      const bad = headers.filter((p) => {
        const t = text(s, p) ?? '';
        return !(GUARD.test(t) && /ImportStart/u.test(t) && /ImportEnd/u.test(t));
      });
      return {
        ok: bad.length === 0,
        detail: bad.length === 0 ? `${headers.length} 个头文件都带守卫` : `缺守卫：${bad.join('、')}`,
      };
    },
  },
  {
    id: 'src-guard',
    source: 'Every source in src/ has the Conan::ImportStart/End guard.',
    title: 'src/ 每个源文件都有 ImportStart/End 守卫',
    evaluate: (s) => {
      const srcs = filesIn(s, 'src', /\.(c|cc|cpp|cxx)$/u);
      if (srcs.length === 0) {
        return { ok: undefined, detail: 'src/ 下没有源文件' };
      }
      const bad = srcs.filter((p) => {
        const t = text(s, p) ?? '';
        return !(/ImportStart/u.test(t) && /ImportEnd/u.test(t));
      });
      return {
        ok: bad.length === 0,
        detail: bad.length === 0 ? `${srcs.length} 个源文件都带守卫` : `缺守卫：${bad.join('、')}`,
      };
    },
  },
  {
    id: 'doxygen-tags',
    source: 'Every public symbol has Doxygen docstring with @exporter or @attacher.',
    title: '公开符号带 @exporter / @attacher（文档系统的挂点）',
    evaluate: (s) => {
      const all = [...filesIn(s, 'include', /\.(h|hpp|hh|hxx)$/u), ...filesIn(s, 'src', /\.(c|cc|cpp|cxx)$/u)];
      if (all.length === 0) {
        return { ok: undefined, detail: '没有任何头/源文件可查' };
      }
      const tagged = all.filter((p) => /@(exporter|attacher)\b/u.test(text(s, p) ?? ''));
      // "每个公开符号"是语义判断；这里只如实报"哪些文件里出现过标签"。
      return {
        ok: tagged.length > 0 ? true : false,
        detail: tagged.length > 0 ? `${tagged.length}/${all.length} 个文件里出现过标签` : '一处 @exporter/@attacher 都没有',
      };
    },
  },
  {
    id: 'bench-all-apis',
    source: 'test_package/main.cpp benchmarks ALL public APIs with timing output.',
    title: 'main.cpp 对公开 API 给计时输出',
    evaluate: (s) => {
      const main = text(s, 'test_package/main.cpp');
      if (main === undefined) {
        return { ok: undefined, detail: '没有 test_package/main.cpp' };
      }
      const timing = /(BENCHMARK|chrono|steady_clock|elapsed|ms\b)/u.test(main);
      return {
        ok: timing,
        detail: timing ? '有计时/基准输出（"覆盖了全部 API"要人看一眼）' : '没看到任何计时/基准输出',
      };
    },
  },
  {
    id: 'unit-per-header',
    source: 'At least one unit test file exists per header in test_package/test/unit/.',
    title: '每个头文件都被单测覆盖（有单测 include 它）',
    evaluate: (s) => {
      const headers = filesIn(s, 'include', /\.(h|hpp|hh|hxx)$/u);
      if (headers.length === 0) {
        return { ok: undefined, detail: 'include/ 下没有头文件' };
      }
      // 判据是**真的覆盖**：某个测试文件里 include 了这个头文件。
      // （按文件名去猜是错的：模板自己的单测叫 req.cpp/noreq.cpp，与头文件不同名。）
      const tests = [
        ...filesIn(s, 'test_package/test/unit', /\.(c|cc|cpp|cxx)$/u),
        ...filesIn(s, 'test_package/test/stress', /\.(c|cc|cpp|cxx)$/u),
      ].map((p) => text(s, p) ?? '');
      if (tests.length === 0) {
        return { ok: undefined, detail: 'test_package/test/ 下还没有测试文件' };
      }
      const uncovered = headers.filter((p) => {
        const name = baseName(p);
        return !tests.some((t) => new RegExp(`#\\s*include\\s*[<"][^>"]*${escapeRe(name)}[>"]`, 'u').test(t));
      });
      return {
        ok: uncovered.length === 0,
        detail:
          uncovered.length === 0
            ? `${headers.length} 个头文件都被单测引到了`
            : `没有单测引用：${uncovered.map((p) => baseName(p)).join('、')}`,
      };
    },
  },
  {
    id: 'stress-tests',
    source: 'Stress test files exist for performance-critical paths in test/stress/.',
    title: '压测文件在位（性能关键路径）',
    evaluate: (s) => {
      if (!s.paths.some((p) => p.startsWith('test_package/'))) {
        return { ok: undefined, detail: '没有 test_package/ 目录（不是模板生成的库？）' };
      }
      const stress = filesIn(s, 'test_package/test/stress', /\.(c|cc|cpp|cxx)$/u);
      return {
        ok: stress.length > 0,
        detail: stress.length > 0 ? `${stress.length} 个压测文件` : '没有压测文件（"哪条路径算关键"要人定）',
      };
    },
  },
  {
    id: 'mainpage',
    source: 'docs/doxygen/dox/mainpage.dox is rewritten for the new project.',
    title: 'mainpage.dox 已改成本项目（不留模板原文）',
    evaluate: (s) => {
      const p = 'docs/doxygen/dox/mainpage.dox';
      const t = text(s, p);
      if (t === undefined) {
        return { ok: undefined, detail: `没有 ${p}` };
      }
      const stale = s.templateName ? new RegExp(`\\b${s.templateName}\\b`, 'iu').test(t) : false;
      return { ok: !stale, detail: stale ? `里面还写着模板自己的名字「${s.templateName}」` : '没看到模板残留' };
    },
  },
  {
    id: 'demos-include',
    source: 'docs/doxygen/dox/demos/ holds a tutorial .dox with @example, and every file it @include-s exists.',
    title: 'demo 教程的 @include 目标都真实存在',
    evaluate: (s) => {
      if (!s.paths.some((p) => p.startsWith('docs/'))) {
        return { ok: undefined, detail: '没有 docs/ 目录（不是模板生成的库？）' };
      }
      const doxes = filesIn(s, 'docs/doxygen/dox/demos', /\.dox$/u);
      if (doxes.length === 0) {
        return { ok: false, detail: 'demos/ 下没有 .dox 教程' };
      }
      const withExample = doxes.filter((p) => /@example\b/u.test(text(s, p) ?? ''));
      const missing: string[] = [];
      for (const p of doxes) {
        for (const m of (text(s, p) ?? '').matchAll(/@include\s+(\S+)/gu)) {
          const target = m[1].replace(/["{}]/gu, '');
          if (!s.paths.some((x) => x.endsWith(target) || x === target)) {
            missing.push(target);
          }
        }
      }
      if (missing.length > 0) {
        return { ok: false, detail: `@include 指向的文件不存在：${[...new Set(missing)].join('、')}` };
      }
      return {
        ok: withExample.length > 0,
        detail: withExample.length > 0 ? `${withExample.length} 个 .dox 带 @example` : '没有 .dox 带 @example',
      };
    },
  },
  {
    id: 'index-concise',
    source: 'index.rst is concise (mini-paper style: background → method → quick start → results → license), readable in under 2 minutes.',
    title: 'index.rst 精炼（背景→方法→快速开始→结果→license）',
    why: '"精炼 / 两分钟读完"是人的判断 —— 机器只能报行数，不能替你读',
  },
  {
    id: 'index-split',
    source: 'Long content is split into separate .rst files, not crammed in index.rst.',
    title: '长内容拆进独立 .rst（不塞在 index.rst 里）',
    why: '"多长算长"是编辑判断；拆得好不好只有人看得出来',
  },
  {
    id: 'sphinx-locales',
    source: 'For each non-English doc_language: .po files exist under docs/sphinx/locales/<lang>/LC_MESSAGES/ with FILLED translations.',
    title: '每个非英文 doc_language 都有 .po 译文',
    evaluate: (s) => {
      const langs = (s.metadata?.doc_languages ?? []).filter((l) => l !== 'en');
      if (langs.length === 0) {
        return { ok: undefined, detail: '没有非英文 doc_language（本项不适用）' };
      }
      // 目录名可能是 `zh` 也可能是 `zh_CN` —— 按语言前缀匹配（两种都算到位）。
      const missing = langs.filter(
        (l) =>
          !s.paths.some((p) => {
            if (!p.endsWith('.po') || !/^docs\/sphinx\/locales\//u.test(p)) {
              return false;
            }
            const seg = splitPath(p)[3] ?? '';
            return seg === l || seg.startsWith(`${l}_`);
          }),
      );
      return {
        ok: missing.length === 0,
        detail: missing.length === 0 ? `${langs.join('、')} 都有 .po` : `缺：${missing.join('、')}`,
      };
    },
  },
  {
    id: 'title-card',
    source: 'docs/images/ALL_title_card.png exists (placeholder or real artwork).',
    title: 'docs/images/ALL_title_card.png 在位',
    evaluate: (s) => {
      if (!s.paths.some((p) => p.startsWith('docs/'))) {
        return { ok: undefined, detail: '没有 docs/ 目录（不是模板生成的库？）' };
      }
      const hasCard = has(s, 'docs/images/ALL_title_card.png');
      return { ok: hasCard, detail: hasCard ? '在位' : '文件不在' };
    },
  },
  {
    id: 'readme',
    source: 'README.md is updated with new project information.',
    title: 'README 已写上本项目（不是模板原文）',
    evaluate: (s) => {
      const t = text(s, 'README.md');
      if (t === undefined) {
        return { ok: undefined, detail: '没有 README.md' };
      }
      const name = String(s.metadata?.name ?? '');
      if (name === '') {
        return { ok: undefined, detail: '读不到 metadata.name，没法判' };
      }
      return { ok: t.includes(name), detail: t.includes(name) ? `README 里出现了「${name}」` : `README 里没看到「${name}」` };
    },
  },
  {
    id: 'license-notice',
    source: 'LICENSE and NOTICE are UNCHANGED from the template.',
    title: 'LICENSE / NOTICE 与模板逐字一致',
    evaluate: (s) => {
      if (s.templateLicense === undefined || s.templateNotice === undefined) {
        return { ok: undefined, detail: '拿不到模板自带的 LICENSE/NOTICE（扩展内置模板缺失）' };
      }
      const same = (p: string, want: string): boolean => (text(s, p) ?? '').trim() === want.trim();
      const lic = same('LICENSE', s.templateLicense);
      const notice = same('NOTICE', s.templateNotice);
      return {
        ok: lic && notice,
        detail: `${lic ? 'LICENSE 一致' : 'LICENSE 被改过'} · ${notice ? 'NOTICE 一致' : 'NOTICE 被改过'}`,
      };
    },
  },
  {
    id: 'no-old-name',
    source: 'No package-name literal left outside metadata.json.',
    title: '模板旧名没有残留（metadata.json 之外）',
    evaluate: (s) => {
      const tpl = s.templateName;
      if (!tpl) {
        return { ok: undefined, detail: '拿不到模板项目名' };
      }
      const re = new RegExp(`\\b${tpl}\\b`, 'iu');
      // `.github/**` 不算：那是模板自己的机械文件（skills/CI 文档里提到模板仓是正常的）。
      const hits = Object.entries(s.files)
        .filter(([p]) => !p.startsWith('.github/'))
        .filter(([p]) => !p.endsWith('Codegen-Starter.txt'))
        .filter(([, t]) => re.test(t))
        .map(([p]) => p);
      return {
        ok: hits.length === 0,
        detail:
          hits.length === 0
            ? `没有「${tpl}」残留（.github/ 里的模板说明不查）`
            : `还留着：${hits.slice(0, 5).join('、')}${hits.length > 5 ? ` 等 ${hits.length} 个文件` : ''}`,
      };
    },
  },
  {
    id: 'releaserc',
    source: '.github/misc/.releaserc.json needs no repositoryUrl edit (derived from git remote).',
    title: 'release 配置不需要手改仓库地址',
    evaluate: (s) => {
      const t = text(s, '.github/misc/.releaserc.json') ?? text(s, '.releaserc.json');
      if (t === undefined) {
        return { ok: undefined, detail: '没有 .releaserc.json（本项不适用）' };
      }
      return {
        ok: !/repositoryUrl/u.test(t),
        detail: /repositoryUrl/u.test(t) ? '里面写了 repositoryUrl（发布时可能推到错的仓库）' : '没有写死仓库地址',
      };
    },
  },
  {
    id: 'pybind-bindings',
    source: 'If pybind11 enabled: api/python_bindings.cpp binds all public APIs.',
    title: '开了 pybind11 就绑定了公开 API',
    evaluate: (s) => {
      if (s.metadata?.enable_python_bindings !== true) {
        return { ok: undefined, detail: '没开 pybind11（本项不适用）' };
      }
      const t = text(s, 'api/python_bindings.cpp');
      if (t === undefined) {
        return { ok: false, detail: '开了 pybind11 但没有 api/python_bindings.cpp' };
      }
      const binds = (t.match(/\bpy::(class_|def|enum_|module)\b/gu) ?? []).length;
      return {
        ok: binds > 0,
        detail: binds > 0 ? `${binds} 处 py:: 绑定（"是否覆盖全部公开 API"要人对照）` : '文件里没有任何 py:: 绑定',
      };
    },
  },
  {
    id: 'builds',
    source: 'The whole project builds: conan create . -s build_type=Debug --build=missing',
    title: '整个工程能构建（conan create … Debug --build=missing）',
    evaluate: (s) => {
      if (s.buildOk === undefined) {
        return { ok: undefined, detail: '本会话还没构建过 → 点「编译打包」（② 构建站）跑一次' };
      }
      return { ok: s.buildOk, detail: s.buildOk ? '最近一次 conan create 成功' : '最近一次构建失败（看「构建」输出）' };
    },
  },
];

export interface NewLibResult {
  id: string;
  title: string;
  ok: boolean | undefined;
  detail: string;
  /** 判不了的如实说明（`–` 必须说原因，§19.2）。 */
  why?: string;
}

/**
 * 每一条"怎么补"（红项必须有下一步，§19.2）。
 *
 * 与 `NEW_LIB_CHECKS` 分开放的理由：这张表是**动作话术**，不是判据；门禁只对账条款
 * （`source`），不把话术钉死。但两者必须**一一对应**（`test/newLibAudit.test.ts` 断言：
 * 每条机器可判的条款都有补法、每条补法都指向真实条款）。
 */
export const FIX_BY_ID: Readonly<Record<string, string>> = {
  cppstd: '把 metadata.json 的 build_cppstd 改成 "17"、build_cstd 改成 "11"（团队标准，不要改别的）',
  'team-license': 'metadata.json 里 team 填 HeT-FTI、license 填 Apache-2.0',
  'no-inplace-modules': 'metadata.json 的 generate_modules_inplace 设为 false（模块不写回本仓）',
  'conandata-deps': '在依赖管理器里补齐（它会同时改 conandata.yml 与 metadata.json，两份必须一致）',
  'include-guard': '给每个头文件补上 Conan::ImportStart / Conan::ImportEnd 注释守卫（模板里的头文件就是范例）',
  'src-guard': '给每个源文件补上 Conan::ImportStart / Conan::ImportEnd 守卫',
  'doxygen-tags': '给公开符号的 Doxygen 注释加 @exporter（导出）或 @attacher（挂接）标注',
  'bench-all-apis': '在 test_package/main.cpp 里给公开 API 加计时输出（模板的 main.cpp 有现成写法）',
  'unit-per-header': '在 test_package/test/unit/ 下加单测，并在里面 include 上缺的那个头文件',
  'stress-tests': '在 test_package/test/stress/ 下加压测文件（先确认哪条路径是性能关键）',
  mainpage: '把 docs/doxygen/dox/mainpage.dox 改成本项目的介绍（模板原文里的项目名要清掉）',
  'demos-include': '补齐 @include 指向的文件，或修掉写错的路径；教程 .dox 要有 @example',
  'sphinx-locales': '为每个非英文 doc_language 在 docs/sphinx/locales/<lang>/LC_MESSAGES/ 下补 .po 并填译文',
  'title-card': '把 title card 放进 docs/images/ALL_title_card.png（先用占位图也行）',
  readme: 'README 里写上本项目的信息（名字、一句话说明、快速开始）',
  'license-notice': '把 LICENSE / NOTICE 恢复成模板原样（这两个文件按约定不改）',
  'no-old-name': '把残留的模板旧名换成 metadata.json 里的项目名（或直接删掉那句）',
  releaserc: '把 .releaserc.json 里的 repositoryUrl 删掉（它从 git remote 推导）',
  'pybind-bindings': '在 api/python_bindings.cpp 里为公开 API 补 py:: 绑定（或关掉 enable_python_bindings）',
  builds: '点「编译打包」（② 构建站）跑一次 conan create，按输出里的第一条错误修',
};

/** 红项的下一步（找不到补法就退回它自己的 detail —— 也不许空着）。 */
export function fixOf(id: string, fallback: string): string {
  return FIX_BY_ID[id] ?? fallback;
}

/** 跑一遍自检（顺序 = 合同顺序）。 */
export function auditNewLib(s: LibSnapshot): NewLibResult[] {
  // 一份**什么都没读到**的快照（没打开工程/读不到目录）：全部如实标 `–`。
  // 这时给任何红/绿都是在编造 —— "读不到"和"没做"是两件事。
  if (s.paths.length === 0 && Object.keys(s.files).length === 0) {
    const why = '没读到工程文件（工作区里打开的是库根目录 —— 含 metadata.json 的那一层 —— 吗？）';
    return NEW_LIB_CHECKS.map((c) => ({
      id: c.id,
      title: c.title,
      ok: undefined,
      detail: why,
      ...(c.why ? { why: c.why } : {}),
    }));
  }
  return NEW_LIB_CHECKS.map((c) => {
    if (!c.evaluate) {
      return { id: c.id, title: c.title, ok: undefined, detail: c.why ?? '需要人工判定', ...(c.why ? { why: c.why } : {}) };
    }
    let r: { ok: boolean | undefined; detail: string };
    try {
      r = c.evaluate(s);
    } catch (err) {
      r = { ok: undefined, detail: `判定出错：${err instanceof Error ? err.message : String(err)}` };
    }
    return { id: c.id, title: c.title, ok: r.ok, detail: r.detail };
  });
}

/**
 * 自检结果 → 卡片一行（三态齐，§19.2）：`✓ 16 · ✗ 2 · – 5`。
 *
 * 全绿时**不啰嗦**：`23 项全过`；有红项时点名第一个红项并给下一步。
 */
export function newLibAuditFact(results: readonly NewLibResult[]): { state: 'ok' | 'warn' | 'fail' | 'idle'; fact: string; next?: string } {
  if (results.length === 0) {
    return { state: 'idle', fact: '—' };
  }
  const ok = results.filter((r) => r.ok === true).length;
  const fail = results.filter((r) => r.ok === false);
  const na = results.filter((r) => r.ok === undefined).length;
  const total = results.length;
  if (fail.length === 0 && na === 0) {
    return { state: 'ok', fact: `${total} 项全过` };
  }
  const bits = [`✓ ${ok}`];
  if (fail.length > 0) {
    bits.push(`✗ ${fail.length}`);
  }
  if (na > 0) {
    bits.push(`– ${na}`);
  }
  const first = fail[0];
  // 有红项才点名（"✗ 4 · 头文件缺守卫"）；只有 `–` 时不追加废话 —— `– 23` 已经说清，
  // 具体哪几条在面板里（P7：同一件事不写两遍）。
  return {
    state: fail.length > 0 ? 'fail' : 'warn',
    fact: first ? `${bits.join(' · ')} · ${first.title}` : bits.join(' · '),
    next: first ? `需要你执行：${fixOf(first.id, first.detail)}` : '点开看是哪几项要人判定',
  };
}

/**
 * 从 `security-linters.yml` 里读出"CI 给哪些包装了系统头"（G6 的事实来源）。
 *
 * 两种形态都是真实存在的：① python 字典 `mapping = {'zlib': 'zlib1g-dev', …}`；
 * ② 单独的安装步骤（如 ETL 是 header-only，自己 curl）。
 */
export function ciInstalledPackages(workflowText: string): string[] {
  const out = new Set<string>();
  for (const m of workflowText.matchAll(/['"]([a-z0-9_.+-]+)['"]\s*:\s*['"][^'"]+['"]/gu)) {
    out.add(m[1]);
  }
  // 形如 `d['requirements'] if r.startswith('etl/')` —— 说明这个包由该步骤处理
  for (const m of workflowText.matchAll(/startswith\(\s*['"]([a-z0-9_.+-]+)\//gu)) {
    out.add(m[1]);
  }
  return [...out].sort();
}
