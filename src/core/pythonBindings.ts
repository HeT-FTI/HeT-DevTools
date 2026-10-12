/**
 * Python 绑定对账（V3 · L6c / G9）—— **纯函数**（不 import vscode，读的是快照里的文本）。
 *
 * 要解决的真问题：`@exporter` 把"这是公开 API"写在了头文件里，但 Python 侧**没有任何东西
 * 强制你把它绑出去** —— 新加一个公开类、忘了写绑定，编译、单测、覆盖率全绿，只有用户
 * `import` 之后才发现少了个名字。
 *
 * 三件事一次说清，而且**每一件都能从文件里读到**（不猜、不联网）：
 *
 * 1. **模块名**：CMake 把产物改名成 `PYTHON_MODULE_NAME`（模板 = `<LIB_NAME>_python`），
 *    而 `PYBIND11_MODULE(<名字>, m)` 决定 `.so` 里的 `PyInit_<名字>` 入口 —— 两者
 *    不一致时 **import 直接失败**（`ImportError: dynamic module does not define module
 *    export function`），而本地构建一路绿灯。名字只从这两个文件里读，有一处读不到就不判。
 * 2. **公开 API 绑没绑**：`include/` 里带 `@exporter` 的实体，逐个看它有没有出现在
 *    **注册位**（`&符号` / `py::class_<类型>`）。`@attacher` 的块是"实现"不是"声明"
 *    （模板里 `Person::greet` 就是），跳过 —— 否则会把方法名当成公开 API 去误报。
 * 3. **只被"提到"**：名字在绑定文件里出现过、但看不到注册位（比如被自己的包装函数包了
 *    一层）→ **不敢当已绑**，如实说"只被提到"（黄）。既不许猜成已绑，也不许直接判红。
 *
 * 只查一个方向（公开 API → 绑定）。反查不做：Python 名字可以**故意**和 C++ 不同名
 * （模板里 `Color<int>` 就叫 `ColorInt`），按名字反查只会误报。
 */
/** 绑定文件的**模板约定**路径（CMake 里读不到 `PYTHON_BINDINGS_SOURCE` 时才会用到）。 */
export const CONVENTION_BINDINGS = 'api/python_bindings.cpp';

/** `include/` 里带 `@exporter` 的公开实体。 */
export interface ExportedEntity {
  name: string;
  kind: 'class' | 'function';
  /** 声明所在的头文件（相对路径）—— 红的时候要能一指头点过去。 */
  file: string;
  line: number;
}

export interface PyBindAudit {
  /** 要对的绑定文件（来自 CMake 的 `PYTHON_BINDINGS_SOURCE`，读不到才退回约定路径）。 */
  bindingsFile: string;
  /** 路径是不是 CMake 给的（false = 按约定找的，报告里得说清楚）。 */
  fromCmake: boolean;
  /** 绑定文件在不在。 */
  present: boolean;
  /** `PYBIND11_MODULE(<名字>, m)` 里的名字（读不到就没有）。 */
  moduleName?: string;
  /** CMake 把产物改名成什么（`PYTHON_MODULE_NAME` 能 resolve 出来时才有）。 */
  cmakeModule?: string;
  /** 公开 API（`include/` 里带 `@exporter`，按名字去重、按名字排序）。 */
  entities: ExportedEntity[];
  /** 出现在注册位的名字。 */
  bound: string[];
  /** 只在绑定文件里"被提到"、没有注册位的名字。 */
  mentioned: string[];
  /** 绑定文件里**根本没出现**的名字。 */
  missing: string[];
}

/** doc 块**后面**那段声明（到第一个 `;` / `{` 为止）—— 函数定义体不进解析。 */
function declAfterDoc(rest: string): string {
  const t = rest.replace(/^\s+/u, '');
  const cut = t.search(/[;{]/u);
  return cut === -1 ? t.slice(0, 160) : t.slice(0, cut);
}

/** 声明里的实体名：先认 class/struct/…，再认函数（取"括号配对到声明末尾"的那个标识符）。 */
export function entityOfDecl(decl: string): { name: string; kind: 'class' | 'function' } | undefined {
  const cls = /\b(?:class|struct|union|enum(?:\s+class)?)\s+([A-Za-z_]\w*)/u.exec(decl);
  if (cls) {
    return { name: cls[1], kind: 'class' };
  }
  // 函数：从左往右找第一个"右括号之后只剩限定符 / 尾置返回类型"的标识符 ——
  // 否则 `std::function<int(int)> f()` 这类声明会解析出 `int`。
  for (const m of decl.matchAll(/([A-Za-z_]\w*)\s*\(/gu)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let i = open; i < decl.length; i += 1) {
      if (decl[i] === '(') {
        depth += 1;
      } else if (decl[i] === ')') {
        depth -= 1;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close === -1) {
      continue;
    }
    const tail = decl
      .slice(close + 1)
      .replace(/\s*(?:const|noexcept|override|final|volatile|mutable|&&|&)\s*/gu, '')
      .trim();
    if (tail === '' || tail.startsWith('->')) {
      return { name: m[1], kind: 'function' };
    }
  }
  return undefined;
}

/** `include/` 里的公开实体（只认 `@exporter`；带 `@attacher` 的块是"实现"，跳过）。 */
export function exporterEntities(files: Readonly<Record<string, string>>): ExportedEntity[] {
  const byName = new Map<string, ExportedEntity>();
  const paths = Object.keys(files)
    .filter((p) => p.startsWith('include/') && /\.(h|hpp|hh|hxx)$/u.test(p))
    .sort();
  const re = /\/\*\*[\s\S]*?\*\//gu;
  for (const p of paths) {
    const text = files[p] ?? '';
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      const doc = m[0];
      if (!/@exporter\b/u.test(doc) || /@attacher\b/u.test(doc)) {
        continue;
      }
      const ent = entityOfDecl(declAfterDoc(text.slice(m.index + doc.length)));
      if (ent === undefined || byName.has(ent.name)) {
        continue;
      }
      byName.set(ent.name, { ...ent, file: p, line: text.slice(0, m.index).split('\n').length });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 绑定文件的"只剩 C++"版本：注释与**字符串字面量**都抹掉。
 *
 * 抹字符串是关键：`m.def("test_sum_int", …)` 里的 `test_sum_int` 是 **Python 名字**，
 * 不能当成"C++ 里提到过 test_sum"的证据（否则改个 Python 名就会让对账失真）。
 */
export function cppText(raw: string): string {
  return raw
    .replace(/\/\*[\s\S]*?\*\//gu, ' ')
    .replace(/\/\/[^\n]*/gu, ' ')
    .replace(/"(?:\\.|[^"\\\n])*"/gu, ' ')
    .replace(/'(?:\\.|[^'\\\n])*'/gu, ' ');
}

/** 去掉模板实参（`Color<int>` → `Color`、`etl::Foo<int>` → `etl::Foo`）。 */
function stripAngles(s: string): string {
  let depth = 0;
  let out = '';
  for (const ch of s) {
    if (ch === '<') {
      depth += 1;
      continue;
    }
    if (ch === '>') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0) {
      out += ch;
    }
  }
  return out;
}

/** 绑定文件里**真正注册**了什么：`&符号` 与 `py::class_<类型>`（`py::enum_` / `py::exception` 同理）。 */
export function boundNames(clean: string): Set<string> {
  const out = new Set<string>();
  for (const m of clean.matchAll(/&\s*([A-Za-z_]\w*)/gu)) {
    out.add(m[1]);
  }
  for (const m of clean.matchAll(/py::(?:class_|enum_|exception)<([^,]*?)[>,]/gu)) {
    const ids = stripAngles(m[1]).match(/[A-Za-z_]\w*/gu);
    const last = ids?.[ids.length - 1];
    if (last !== undefined) {
      out.add(last);
    }
  }
  return out;
}

/** 把 `${VAR}` 换掉；换不干净（有认不出的变量）就返回 undefined —— 宁可"不判"。 */
function subst(raw: string, vars: Readonly<Record<string, string | undefined>>): string | undefined {
  const out = raw.replace(/\$\{(\w+)\}/gu, (_all, key: string) => vars[key] ?? `\${${key}}`);
  return out.includes('${') ? undefined : out;
}

/** CMake 指明的绑定源文件（相对工程根）。读不到 / resolve 不了 → undefined（不猜）。 */
export function bindingsSourceFrom(cmake: string | undefined): string | undefined {
  if (cmake === undefined) {
    return undefined;
  }
  const raw = /\bset\(\s*PYTHON_BINDINGS_SOURCE\s+"([^"]*)"/u.exec(cmake)?.[1];
  if (raw === undefined) {
    return undefined;
  }
  const rel = raw.replace(/^\$\{CMAKE_CURRENT_SOURCE_DIR\}\//u, '').replace(/^\.\//u, '');
  return rel.includes('${') || rel.startsWith('/') || rel.includes('..') ? undefined : rel;
}

/**
 * CMake 会把产物改名成什么（`PYTHON_MODULE_NAME`）：`LIB_NAME` 与 `PYTHON_MODULE_NAME`
 * 两级都要 resolve 得动才给值 —— 有一级是认不出的变量就返回 undefined（那就不判这条）。
 */
export function cmakeModuleNameOf(cmake: string | undefined, projectName: string | undefined): string | undefined {
  if (cmake === undefined) {
    return undefined;
  }
  const libRaw = /\bset\(\s*LIB_NAME\s+"([^"]*)"/u.exec(cmake)?.[1];
  const lib =
    libRaw === undefined
      ? undefined
      : subst(libRaw, {
          PROJECT_NAME_VALUE: projectName,
          PROJECT_NAME: projectName,
          CMAKE_PROJECT_NAME: projectName,
        });
  const raw = /\bset\(\s*PYTHON_MODULE_NAME\s+"([^"]*)"/u.exec(cmake)?.[1];
  if (raw === undefined) {
    return undefined;
  }
  return subst(raw, {
    LIB_NAME: lib,
    PROJECT_NAME_VALUE: projectName,
    PROJECT_NAME: projectName,
    CMAKE_PROJECT_NAME: projectName,
  });
}

export interface PyBindInputs {
  files: Readonly<Record<string, string>>;
  /** `metadata.name`（CMake 的 `${PROJECT_NAME_VALUE}` 就是它）。读不到则不判模块名。 */
  projectName?: string;
}

/** 一次对账：公开实体 × 绑定文件。**读不到的东西不放**（判定侧会如实说读不到）。 */
export function auditPythonBindings(input: PyBindInputs): PyBindAudit {
  const cmake = input.files['CMakeLists.txt'];
  const fromCmake = bindingsSourceFrom(cmake);
  const bindingsFile = fromCmake ?? CONVENTION_BINDINGS;
  const raw = input.files[bindingsFile];
  const entities = exporterEntities(input.files);
  const clean = raw === undefined ? '' : cppText(raw);
  const bound = raw === undefined ? new Set<string>() : boundNames(clean);
  const tokens = new Set(clean.match(/[A-Za-z_]\w*/gu) ?? []);
  const moduleName = raw === undefined ? undefined : /\bPYBIND11_MODULE\s*\(\s*([A-Za-z_]\w*)/u.exec(clean)?.[1];
  const cmakeModule = cmakeModuleNameOf(cmake, input.projectName);
  return {
    bindingsFile,
    fromCmake: fromCmake !== undefined,
    present: raw !== undefined,
    ...(moduleName !== undefined ? { moduleName } : {}),
    ...(cmakeModule !== undefined ? { cmakeModule } : {}),
    entities,
    bound: entities.filter((e) => bound.has(e.name)).map((e) => e.name),
    mentioned: entities.filter((e) => !bound.has(e.name) && tokens.has(e.name)).map((e) => e.name),
    missing: entities.filter((e) => !bound.has(e.name) && !tokens.has(e.name)).map((e) => e.name),
  };
}

export interface PyBindView {
  state: 'ok' | 'warn' | 'fail' | 'idle';
  fact: string;
  next?: string;
}

/** 名字串：最多列 3 个（界面一行读得完），多的写"等 N 个"。 */
function nameList(names: readonly string[], max = 3): string {
  if (names.length <= max) {
    return names.join('、');
  }
  return `${names.slice(0, max).join('、')} 等 ${names.length} 个`;
}

/**
 * 一行文案（三态 + 两种"读不到"）：
 * · 绑定文件不在 → **红**（metadata 开了绑定时，CMake 会直接 FATAL_ERROR）；
 * · `include/` 里一个 `@exporter` 都没有 → 白（没有可对账的名字，不是绑定失败）；
 * · 模块名和 CMake 产物名不一致 → **红**（import 会失败）；
 * · 有公开 API 没出现在绑定文件里 → **红**；
 * · 只被提到、没看到注册 → **黄**（可能包了一层，让人去确认，不替人下结论）；
 * · 其余 → 绿。
 */
export function pyBindFact(a: PyBindAudit): PyBindView {
  if (!a.present) {
    return {
      state: 'fail',
      fact: `没找到 ${a.bindingsFile}`,
      next: a.fromCmake
        ? `需要你执行：补上 ${a.bindingsFile}（CMake 的 PYTHON_BINDINGS_SOURCE 指的就是它；开了 Python 绑定时缺了它构建会失败）`
        : `需要你执行：确认绑定文件放在哪（CMakeLists.txt 里没有 PYTHON_BINDINGS_SOURCE 可依据）`,
    };
  }
  if (a.entities.length === 0) {
    return {
      state: 'idle',
      fact: '公开 API 一个 @exporter 都没有，没有可对账的名字',
      next: '需要你执行：给公开符号补 @exporter（文档系统的挂点也靠它）',
    };
  }
  const mismatch =
    a.moduleName !== undefined && a.cmakeModule !== undefined && a.moduleName !== a.cmakeModule;
  const modLabel = mismatch
    ? `模块名 ${a.moduleName} ≠ 产物名 ${a.cmakeModule}`
    : a.moduleName !== undefined
      ? `模块 ${a.moduleName}`
      : '没读到 PYBIND11_MODULE';
  const verdict =
    a.missing.length > 0
      ? `未绑 ${a.missing.length}（${nameList(a.missing)}）`
      : a.mentioned.length > 0
        ? `${a.mentioned.length} 个只被提到、没看到注册`
        : '全部已绑';
  const steps: string[] = [];
  if (mismatch) {
    steps.push(
      `把 PYBIND11_MODULE 的名字改成 ${a.cmakeModule}（或改 CMake 的 PYTHON_MODULE_NAME）—— 不一致时产物里没有 PyInit_${a.cmakeModule}，import 会失败`,
    );
  }
  if (a.missing.length > 0) {
    steps.push(`在 ${a.bindingsFile} 里注册：${nameList(a.missing)}`);
  }
  if (!mismatch && a.missing.length === 0 && a.mentioned.length > 0) {
    steps.push(`确认 ${nameList(a.mentioned)} 是不是被自己包了一层；没有的话补 py::class_<> / &符号`);
  }
  const state = mismatch || a.missing.length > 0 ? 'fail' : a.mentioned.length > 0 ? 'warn' : 'ok';
  return {
    state,
    fact: `${modLabel} · 公开 API ${a.entities.length} 个 · ${verdict}`,
    // 非绿一律先说人该干什么（与全局约定一致：红/黄都要能看出要不要人介入）
    ...(steps.length > 0 ? { next: `需要你执行：${steps.join('；')}` } : {}),
  };
}
