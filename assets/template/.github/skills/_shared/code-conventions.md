# fcpp C/C++ Code Conventions（模板私有代码规范）

> Fact source: module generation in `conanfile.py`, `.github/misc/.clang-format-c`, `.github/misc/.clang-format-cpp`, `.github/misc/.clang-tidy`, `.github/misc/Codegen-Starter.txt`. CI 调用的工具配置统一放 `.github/misc/`；根目录仅保留框架自动发现必需的文件（见 `.github/CONTRIBUTING.md` 布局节）。

## File Organization（文件组织）

1. **Pairing（配对约定）**: every `.h` ↔ `.c`, `.hpp` ↔ `.cpp` one-to-one. 一一对应。
2. **Suffix roles（后缀分工）**: `.h/.c` = C, `.hpp/.cpp` = C++, `.dox` = pure docs, `.cxx` = examples. 后缀分工。
3. Public headers in `include/`, implementations in `src/`, Python bindings in `api/python_bindings.cpp`.
4. **Doc-only suffixes（文档专属后缀）**: `.dox` and `.cxx` belong to the documenting system only. They live **exclusively** under `docs/doxygen/dox/` (`mainpage.dox`, `demos/*.dox`, `demos/*.cxx`) as hand-written standalone files, and are **never** written as a docstring inside a file under `include/` or `src/` — those two trees carry `.h/.c/.hpp/.cpp` only. `mainpage`/`demo` have no `include/`-or-`src/` counterpart by design. A complete doc set is a landing page plus a tutorial; one `.dox` may pull in 0..N `.cxx`, no pairing required (`het-docs`). 文档专属后缀只放 `docs/doxygen/dox/`，`include/`、`src/` 里不得出现；完备 = 主页 + 教程。

## Module Annotations（模块生成注解）

In Doxygen comments of `include/` + `src/`:
- **`@exporter`**: export this symbol into the generated C++ module. 导出符号。
- **`@attacher`**: attach to the module (not forced export). 附加符号。
```cpp
/**
 * @brief vector add
 * @exporter
 */
void fcpp_vec_add_f32(const float*, const float*, float*, uint32_t);
```

## Module Boundary Markers（模块边界标记）

Wrap the `#include` area with `// Conan::ImportStart` / `// Conan::ImportEnd`; these are converted to `import` when generating modules. 包裹 include 区，生成模块时转为 import。
```cpp
// Conan::ImportStart
#pragma once
#include <cstdint>
// Conan::ImportEnd
```

## Layout Rules（排版规则）

1. **2 blank lines between global objects** (module generation splits on this). 全局对象间强制 2 空行。
2. Multi-line Doxygen `/** ... */` before functions/classes/variables. 声明前用多行 Doxygen。
3. C headers are auto-wrapped with `extern "C"` by the recipe — do not hand-write. C 头自动包 extern "C"。

## Comment Language Spec（注释语言规范）

- Bilingual tags: `@brief [en] English` / `@brief [zh] 中文`. 双语标签。
- Version tag: `@since <version>` → filtered by docs/build.py per version. 版本标注。
- Active languages come from `doc_languages` in metadata. 生效语言由 metadata 决定。

## Format / Static Checks（格式化/静态检查）

- 语言族分流（私有约定，见 `conanfile.py` syntax guide #9）：`.c`/`.h` → C（`.github/misc/.clang-format-c`，`PointerAlignment: Right`）；`.hpp`/`.cpp` → C++（`.github/misc/.clang-format-cpp`，`PointerAlignment: Left`、`Standard: c++17`）。**clang-format 内置扩展映射把 `.h` 当 C++，门禁必须显式 `--style=file:` 把 `.h` 路由到 C 配置**。120 cols; no include sort; no comment reflow; `MaxEmptyLinesToKeep: 3` 保护空行规则。
- 空行分段：全局对象间 2 空行（`\n\n\n`），模块生成 `_get_export_objects` 按 `split('\n\n')` 切分（`conanfile.py`，含 TODO）；2~3 空行均兼容，超过 3 个是违规。
- 宏命名规则由 clang-tidy `cppcoreguidelines-macro-usage` 强制（`^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$`），不在 `.clang-format` 中。
- `.clang-tidy`: `bugprone-*` + `performance-*` + `cppcoreguidelines-avoid-magic-numbers`; **WarningsAsErrors: '*'**. warning 即失败；`HeaderFilterRegex: "^(include|src)/"` 锚定仓库路径。
- Local check（本地自查）:
  ```bash
  find include src -type f \( -name '*.c' -o -name '*.h' \) -exec clang-format --dry-run --Werror --style=file:.github/misc/.clang-format-c {} +
  find include src -type f \( -name '*.cpp' -o -name '*.hpp' \) -exec clang-format --dry-run --Werror --style=file:.github/misc/.clang-format-cpp {} +
  clang-tidy --config-file=.github/misc/.clang-tidy src/*.cpp -- -std=c++17 -Iinclude
  ```

## Baremetal Constraints（裸机约束）

- Target-side (main package) deps filtered by `baremetal_white_list`（默认 etl/ArduinoJson）.
- OS-dependent libs (zlib/pcre2/eigen/gtest/pybind11) filtered in baremetal cross-build. 依赖 OS 的库被过滤。
- Guard desktop-only code with `#ifndef __ARM_EABI__` (see `cpptest.cpp`). 桌面专属代码加保护。

