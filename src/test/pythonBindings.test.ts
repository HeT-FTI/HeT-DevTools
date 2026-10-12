/**
 * V3 · L6c / G9 门禁：**Python 绑定漂移**。
 *
 * 计划 §6 表格 G9 的验收原文：「`api/python_bindings.cpp` 的注册名 vs 公开 API
 * （`include/` 里带 `@exporter` 的声明）→ 未绑定就红」。
 *
 * 这里盯五件事：
 *   1. 公开实体只认 `@exporter`（`@attacher` 是"实现"，不许当声明）；
 *   2. 注册位只认 `&符号` / `py::class_<类型>` —— **Python 名字写在字符串里，不算证据**；
 *   3. 未绑 → 红、只被"提到" → 黄、扫不到 `@exporter` → 白（不许编造）；
 *   4. 模块名（`PYBIND11_MODULE`）与 CMake 产物名不一致 → 红（import 会失败）；
 *   5. **拿模板本体跑一遍**（`assets/template`）—— 单测里的夹具形状必须与真工程一致。
 */
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  auditPythonBindings,
  bindingsSourceFrom,
  boundNames,
  cmakeModuleNameOf,
  cppText,
  entityOfDecl,
  exporterEntities,
  pyBindFact,
} from '../core/pythonBindings';
import { collectPyBindFiles } from '../core/libSnapshot';
import { INTENTS } from '../core/intents';
import { singlePageModelFrom } from '../features/cockpit/singlepage/modelFrom';
import { initialCockpitState } from '../features/cockpit/state';

const TPL = join('assets', 'template');

/** 模板本体（真实文件）—— 单测与预览用同一份读法（`collectPyBindFiles`）。 */
async function templateFiles(): Promise<Record<string, string>> {
  return collectPyBindFiles(TPL);
}

/** 一份最小可判的工程：一个公开类 + 一个公开函数 + 一份绑定。 */
function project(over: { header?: string; bindings?: string; cmake?: string } = {}): Record<string, string> {
  const cmake =
    over.cmake ??
    ['file(READ "${CMAKE_CURRENT_SOURCE_DIR}/metadata.json" METADATA_JSON)',
      'set(LIB_NAME "${PROJECT_NAME_VALUE}")',
      'if(ENABLE_PYBIND)',
      '  set(PYTHON_MODULE_NAME "${LIB_NAME}_python")',
      '  set(PYTHON_BINDINGS_SOURCE "${CMAKE_CURRENT_SOURCE_DIR}/api/python_bindings.cpp")',
      'endif()'].join('\n');
  return {
    'CMakeLists.txt': cmake,
    'include/mylib.hpp':
      over.header ??
      ['/**',
        ' * @brief the color',
        ' * @exporter',
        ' */',
        'class Color {};',
        '',
        '/**',
        ' * @brief solve',
        ' * @exporter',
        ' */',
        'double solve(double x);',
        ''].join('\n'),
    'api/python_bindings.cpp':
      over.bindings ??
      ['#include <pybind11/pybind11.h>',
        '#include "mylib.hpp"',
        'PYBIND11_MODULE(mylib_python, m) {',
        '  py::class_<Color>(m, "Color");',
        '  m.def("solve", &solve, "doc");',
        '}'].join('\n'),
  };
}

describe('L6c · Python 绑定对账（G9）', () => {
  it('公开实体只认 `@exporter`：`@attacher`（实现）不算，重复名字去重', () => {
    const src = [
      '/** @exporter */',
      'class Person {};',
      '',
      '/**',
      ' * @attacher',
      ' */',
      'std::string Person::greet() const { return ""; };',
      '',
      '/** @exporter */',
      'template <typename T> class Color {};',
      '',
      '/** @exporter */',
      'template class Color<int>;',
      '',
      '/** @brief not exported */',
      'void hidden();',
      '',
    ].join('\n');
    const ents = exporterEntities({ 'include/mylib.hpp': src });
    assert.deepStrictEqual(
      ents.map((e) => e.name),
      ['Color', 'Person'],
      '`Person::greet` 是 @attacher 的实现、`hidden` 没有标签 → 都不该出现；`Color<int>` 与 `Color` 同名只留一条',
    );
    assert.deepStrictEqual(ents.map((e) => e.kind), ['class', 'class']);
    assert.deepStrictEqual(ents.map((e) => e.line), [9, 1], '要能指回头文件里的行');
    // 只扫 include/：src/ 里的 @exporter（实现文件）不参与
    assert.deepStrictEqual(exporterEntities({ 'src/x.c': '/** @exporter */\nvoid f(void);\n' }), []);
    // 一个块**同时**带两个标签：`@attacher` 是"挂在已有符号上的实现" → 不当公开声明
    // （宁可少报一条，也不把实现名当成公开 API 去误报）
    assert.deepStrictEqual(
      exporterEntities({ 'include/x.hpp': '/**\n * @exporter\n * @attacher\n */\nvoid impl();\n' }),
      [],
    );
  });

  it('函数名解析：`std::function<int(int)> f()` 不许解析成 `int`', () => {
    assert.deepStrictEqual(entityOfDecl('void test_hello()'), { name: 'test_hello', kind: 'function' });
    assert.deepStrictEqual(entityOfDecl('template <typename T> auto test_sum(const std::vector<T>& vec) '), {
      name: 'test_sum',
      kind: 'function',
    });
    assert.deepStrictEqual(entityOfDecl('std::function<int(int)> f()'), { name: 'f', kind: 'function' });
    assert.deepStrictEqual(entityOfDecl('class Color '), { name: 'Color', kind: 'class' });
    assert.strictEqual(entityOfDecl('#define FOO 1'), undefined);
  });

  it('注册位只认 `&符号` 与 `py::class_<类型>` —— **字符串里的 Python 名字不算证据**', () => {
    const clean = cppText(
      [
        '// &commented_out 只是注释',
        '/* py::class_<Ghost>(m, "Ghost"); */',
        'PYBIND11_MODULE(mylib_python, m) {',
        '  m.def("solve", &solve, "doc");',
        '  py::class_<Color>(m, "Color");',
        '  py::class_<etl::Matrix<int>>(m, "Matrix");',
        '  py::enum_<Mode>(m, "Mode");',
        '}',
      ].join('\n'),
    );
    const names = boundNames(clean);
    assert.ok(names.has('solve') && names.has('Color') && names.has('Mode'));
    assert.ok(names.has('Matrix'), '`py::class_<etl::Matrix<int>>` 要认出来的是 Matrix（去掉命名空间与模板实参）');
    assert.ok(!names.has('commented_out'), '注释里的 & 不算');
    assert.ok(!names.has('Ghost'), '被注释掉的注册不算');
    // 光有 Python 名字（字符串）不足以证明 C++ 符号绑过
    assert.ok(!boundNames(cppText('m.def("EigenHelper", &helper);')).has('EigenHelper'));
  });

  it('字符串里的名字不算"提到"：Python 名可以不与 C++ 同名', () => {
    const files = project({
      header: '/** @exporter */\nclass EigenHelper {};\n',
      bindings: ['PYBIND11_MODULE(mylib_python, m) {', '  m.def("EigenHelper", &helper);', '}'].join('\n'),
    });
    const a = auditPythonBindings({ files, projectName: 'mylib' });
    assert.deepStrictEqual(a.mentioned, [], '`"EigenHelper"` 是 **Python 名字**（字符串），不是"C++ 里提到过"');
    assert.deepStrictEqual(a.missing, ['EigenHelper'], 'C++ 那个类确实没绑（真正的符号是 helper）');
    assert.strictEqual(pyBindFact(a).state, 'fail');
  });

  it('CMake 是"路径与模块名"的**唯一来源**：认不出的变量就不判（不猜）', () => {
    const cm = [
      'set(LIB_NAME "${PROJECT_NAME_VALUE}")',
      'set(PYTHON_MODULE_NAME "${LIB_NAME}_python")',
      'set(PYTHON_BINDINGS_SOURCE "${CMAKE_CURRENT_SOURCE_DIR}/api/python_bindings.cpp")',
    ].join('\n');
    assert.strictEqual(bindingsSourceFrom(cm), 'api/python_bindings.cpp');
    assert.strictEqual(cmakeModuleNameOf(cm, 'mylib'), 'mylib_python');
    // 有一级认不出 → 不给值（宁可不判，也不猜）
    assert.strictEqual(cmakeModuleNameOf('set(PYTHON_MODULE_NAME "${MYSTERY}_python")', 'mylib'), undefined);
    assert.strictEqual(bindingsSourceFrom('set(PYTHON_BINDINGS_SOURCE "${SOME_DIR}/x.cpp")'), undefined);
    assert.strictEqual(bindingsSourceFrom(undefined), undefined);
    assert.strictEqual(cmakeModuleNameOf(undefined, 'mylib'), undefined);
  });

  it('**拿模板本体跑**：3 个公开 API 全部已绑（模块 fcpp_python 与 CMake 一致）', async () => {
    const files = await templateFiles();
    const a = auditPythonBindings({ files, projectName: 'fcpp' });
    assert.strictEqual(a.bindingsFile, 'api/python_bindings.cpp', '路径来自 CMake 的 PYTHON_BINDINGS_SOURCE');
    assert.strictEqual(a.fromCmake, true);
    assert.strictEqual(a.present, true);
    assert.strictEqual(a.moduleName, 'fcpp_python');
    assert.strictEqual(a.cmakeModule, 'fcpp_python');
    assert.deepStrictEqual(a.entities.map((e) => e.name), ['Color', 'Person', 'test_sum'], 'include/cpptest.hpp 里带 @exporter 的实体');
    assert.deepStrictEqual(a.missing, []);
    assert.deepStrictEqual(a.mentioned, []);
    const view = pyBindFact(a);
    assert.strictEqual(view.state, 'ok');
    assert.match(view.fact, /模块 fcpp_python · 公开 API 3 个 · 全部已绑/u);
    assert.strictEqual(view.next, undefined, '绿的时候不啰嗦"下一步"');
  });

  it('漂移：新加了公开 API 没绑 → **红**，而且指名道姓 + 指路', async () => {
    const files = await templateFiles();
    const a = auditPythonBindings({
      files: {
        ...files,
        'include/cpptest.hpp': `${files['include/cpptest.hpp']}\n/**\n * @brief 新加的公开类\n * @exporter\n */\nclass EigenHelper {};\n`,
      },
      projectName: 'fcpp',
    });
    const view = pyBindFact(a);
    assert.deepStrictEqual(a.missing, ['EigenHelper']);
    assert.strictEqual(view.state, 'fail');
    assert.match(view.fact, /未绑 1（EigenHelper）/u);
    assert.match(view.next ?? '', /在 api\/python_bindings\.cpp 里注册：EigenHelper/u);
  });

  it('模块名不一致 → **红**：产物里没有 `PyInit_<名字>`，import 必然失败', async () => {
    const files = await templateFiles();
    const a = auditPythonBindings({
      files: {
        ...files,
        'api/python_bindings.cpp': files['api/python_bindings.cpp'].replace(
          'PYBIND11_MODULE(fcpp_python, m)',
          'PYBIND11_MODULE(fcpp_python_x, m)',
        ),
      },
      projectName: 'fcpp',
    });
    const view = pyBindFact(a);
    assert.strictEqual(view.state, 'fail');
    assert.match(view.fact, /模块名 fcpp_python_x ≠ 产物名 fcpp_python/u);
    assert.match(view.next ?? '', /PyInit_fcpp_python/u);
    // 名字对不上时**不许**同时说"全部已绑"骗人 —— 绑定数照报，但判决是红
    assert.deepStrictEqual(a.missing, []);
  });

  it('只被"提到"（包了一层）→ 黄：不猜成已绑、也不冤判成未绑', () => {
    const files = project({
      header: '/** @exporter */\ndouble solve(double x);\n',
      bindings: ['PYBIND11_MODULE(mylib_python, m) {', '  m.def("solve", [](double x) { return solve(x); });', '}'].join('\n'),
    });
    const a = auditPythonBindings({ files, projectName: 'mylib' });
    assert.deepStrictEqual(a.missing, []);
    assert.deepStrictEqual(a.mentioned, ['solve']);
    const view = pyBindFact(a);
    assert.strictEqual(view.state, 'warn');
    assert.match(view.fact, /1 个只被提到、没看到注册/u);
    assert.match(view.next ?? '', /是不是被自己包了一层/u);
  });

  it('绑定文件不在 → **红**（CMake 会直接失败，不是"没这回事"）', () => {
    const files = project();
    delete files['api/python_bindings.cpp'];
    const a = auditPythonBindings({ files, projectName: 'mylib' });
    assert.strictEqual(a.present, false);
    const view = pyBindFact(a);
    assert.strictEqual(view.state, 'fail');
    assert.match(view.fact, /没找到 api\/python_bindings\.cpp/u);
    assert.match(view.next ?? '', /PYTHON_BINDINGS_SOURCE/u);
  });

  it('没有可对账的公开 API（一处 @exporter 都没有）→ 白，不许当绑定失败', () => {
    const files = project({ header: 'double solve(double x);\n' });
    const view = pyBindFact(auditPythonBindings({ files, projectName: 'mylib' }));
    assert.strictEqual(view.state, 'idle');
    assert.match(view.fact, /@exporter/u);
    assert.match(view.next ?? '', /补 @exporter/u);
  });

  it('非绿一律先说人该干什么（`需要你执行：` —— 与全局约定一致）', () => {
    const cases: Array<Record<string, string>> = [
      project({ header: '/** @exporter */\nvoid init();\n' }), // 未绑
      project({ header: '/** @exporter */\ndouble solve(double x);\n', bindings: 'PYBIND11_MODULE(mylib_python, m) {\n  m.def("solve", [](double x) { return solve(x); });\n}' }), // 只被提到
      project({ header: 'double solve(double x);\n' }), // 没有可对账的
      (() => {
        const f = project();
        delete f['api/python_bindings.cpp'];
        return f;
      })(), // 绑定文件不在
    ];
    for (const files of cases) {
      const view = pyBindFact(auditPythonBindings({ files, projectName: 'mylib' }));
      assert.notStrictEqual(view.state, 'ok', '这几个都是非绿态');
      assert.match(view.next ?? '', /^需要你执行：/u, `${view.state} 的下一步必须是"人该干什么"：${view.next}`);
    }
    // 绿的时候不给"下一步"（不啰嗦）
    const okView = pyBindFact(auditPythonBindings({ files: project(), projectName: 'mylib' }));
    assert.strictEqual(okView.state, 'ok');
    assert.strictEqual(okView.next, undefined);
  });

  it('**卡片映射**：事实进 ⑧ 交付站的「Python 绑定」卡（只在 metadata 开了绑定时出现）', () => {
    const files = project({
      header: '/** @exporter */\ndouble solve(double x);\n/** @exporter */\nvoid init();\n',
    });
    const view = pyBindFact(auditPythonBindings({ files, projectName: 'mylib' }));
    const model = singlePageModelFrom(initialCockpitState(), {
      metadata: { name: 'mylib', enable_python_bindings: true },
      pythonBindings: { state: view.state, fact: view.fact, ...(view.next ? { next: view.next } : {}) },
    });
    const card = model.cards.find((c) => c.id === 'pythonBindings');
    assert.ok(card, '开了 Python 绑定的库必须有这张卡');
    assert.strictEqual(card?.state, 'fail');
    assert.match(card?.fact ?? '', /未绑 1（init）/u);
    assert.strictEqual(model.spine?.find((s) => s.id === 'deliver')?.cards.includes('pythonBindings'), true);

    // 没开绑定：能力显隐把它藏起来（而且要说得出"去哪了"）
    const off = singlePageModelFrom(initialCockpitState(), { metadata: { name: 'mylib' }, artifacts: {} });
    assert.ok(!off.cards.some((c) => c.id === 'pythonBindings'));
  });

  it('**接线门禁**：读真文件（收集器）→ 纯核心判定 → 事实真的喂进单页模型', () => {
    const ext = readFileSync(join('src', 'extension.ts'), 'utf8');
    // 只看**这两段**：别处也有 readText/文件探测 —— 全局 includes 会被它们蒙过去。
    // ① 判定的单点函数（读 → 判 → 文案）
    const fnStart = ext.indexOf('async function pythonBindingsView');
    assert.ok(fnStart > 0, '对账的单点函数得在（卡片与会话读同一份事实）');
    const fn = ext.slice(fnStart, ext.indexOf('\n}', fnStart));
    assert.ok(fn.includes('collectPyBindFiles(root)'), '要用**同一个收集器**读工程（单测/预览/扩展一份读法）');
    assert.ok(fn.includes('auditPythonBindings({'), '判定要走纯核心');
    assert.ok(fn.includes('pyBindFact('), '文案要走同一个三态函数');
    assert.ok(fn.includes('projectName'), '模块名要拿 metadata.name 去 resolve（不然两级变量都对不上）');
    // ② 喂事实那一段（不许自己另算一份）
    const feedStart = ext.indexOf('// V3 · L6c / G9');
    assert.ok(feedStart > 0, 'L6c 喂事实的那段得在');
    const feed = ext.slice(feedStart, ext.indexOf('facts.pythonBindings = {', feedStart) + 40);
    assert.ok(feed.includes('pythonBindingsView()'), '喂的就是那个函数的结果');
    assert.ok(feed.includes('facts.pythonBindings = {'), '事实要真的喂进单页模型');
    // 只读打开绑定文件的那条命令：卡片得能点到"对账的另一半"
    assert.ok(ext.includes("registerCommand('het.openPythonBindings'"), '打开绑定文件的命令得注册');
    assert.ok(
      INTENTS.some((i) => i.command === 'het.openPythonBindings'),
      '命令必须在 Intent 表里（否则卡片上的按钮点了没反应）',
    );
    // CMake 是路径的唯一来源：命令侧也不许写死路径
    const cmdStart = ext.indexOf("registerCommand('het.openPythonBindings'");
    const cmd = ext.slice(cmdStart, ext.indexOf('}),', cmdStart));
    assert.ok(cmd.includes('bindingsSourceFrom'), '命令侧也要问 CMake（不许写死 api/python_bindings.cpp）');
  });
});
