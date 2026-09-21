# Doxygen Domain Guide（Doxygen 领域指南）

> Loaded on demand when the task involves code annotations / Doxygen. 涉及代码注解/Doxygen 时按需加载。
> Facts: `.github/skills/_shared/code-conventions.md`（注解规范）、`Doxyfile`、`docs/doxygen/dox/`。

## Annotation Tags（注释标签速查）

| You want（你想） | Write（写法） |
|------|------|
| English comment | `@brief [en] ...` |
| Chinese comment | `@brief [zh] ...` |
| Version filter | `@since 1.0` |
| Export to C++ module | `@exporter` |
| Attach to module | `@attacher` |
| Main-page bilingual section | `@section intro_sec [en] ...` / `@section intro_sec [zh] ...` |

Example from the template（模板实例，`src/ctest.c`）:
```c
/**
 * @brief [en] the C function
 * @brief [zh] 测试用C函数
 * @exporter
 */
void test_c_compiler();
```

## Language / Version Filtering（语言与版本过滤）

- `docs/build.py` filters comments by `[en]`/`[zh]` tags → one Doxygen build per active language（`doc_languages`）. 按语言标签过滤生成多语言。
- `@since <version>` filters objects per doc version（`doc_versions`）; objects with `@since <= target` are kept. 按 @since 版本过滤。
- Main page: `docs/doxygen/dox/mainpage.dox` uses `@section xxx [en] ... / [zh] ...`. 主页双语章节写法。

## Module Visibility（模块可见性）

- `@exporter`: export the symbol into the generated C++ module. 导出符号。
- `@attacher`: attach without forcing export. 附加符号。
- Must be inside a **multi-line Doxygen comment**; global objects separated by **2 blank lines**. 必须在多行 Doxygen 注释内；全局对象间 2 空行。
- Full spec: `.github/skills/_shared/code-conventions.md`.

## Doc-only Files（文档专属文件）

- `.dox` and `.cxx` are **documentation-only** suffixes. They live **only** under `docs/doxygen/dox/`. 文档专属后缀只放该目录。
- Hand-written standalone files live there — none of them has an `include/`-or-`src/` counterpart by design: 均为手写独立文件，不作为 docstring 存在于 include/src：

  | Path | Role | Constraint |
  |------|------|------|
  | `docs/doxygen/dox/mainpage.dox` | Landing page, via `@mainpage` | **hard** |
  | `docs/doxygen/dox/demos/` | Example catalogue directory | **hard** |
  | `docs/doxygen/dox/demos/tutorial.dox` | Tutorial page, via `@example` | **hard** |
  | `docs/doxygen/dox/demos/*.cxx` | Example code, pulled in by a tutorial's `@include` | **soft**, 0..N |

- **What "complete" means in fcpp**: a landing page **and** a tutorial that teaches how to use the library. A tutorial without example code is complete — example code is optional. 完备 = 主页 + 教程；示例代码可有可无。
- **One `.dox` may pull in many `.cxx`** (several `@include` lines in one tutorial). No 1:1 pairing is required. 一个 dox 可对应多个 cxx，不必配对。
- `.cxx` is soft only until a tutorial references it: after `@include`/`@example` it is that tutorial's hard dependency. 一旦被引用即转为硬依赖。
- Wiring: `.dox` files must be reachable by Doxygen's `INPUT`; `@example X` only matches a file sitting **directly** under a listed `EXAMPLE_PATH` (unlike `@include` it ignores `EXAMPLE_RECURSIVE`), which is why `docs/build.py` derives `EXAMPLE_PATH` from where tutorials actually are. `.dox` 进 INPUT；`@example` 只认 EXAMPLE_PATH 的直属目录。
- `include/` and `src/` carry `.h/.c/.hpp/.cpp` only. include/src 不得出现 .dox/.cxx。

## Completeness Gate（完备性校验）

`docs/build.py` fails the build (non-zero exit → red CI) when one of these breaks. It asserts
**properties, not paths**: `doc_doxygen_folders` alone decides where docs live, so moving a file
around inside the scanned tree stays green. 只校验性质，不校验路径。

| Checked | When |
|------|------|
| at least one `.dox` is scanned | before Doxygen |
| exactly one `@mainpage` — 0 means no landing page, >1 means Doxygen silently keeps whichever it scans first | before Doxygen |
| at least one `@example` tutorial, living under `demos/` | before Doxygen |
| every `@include` / `@example` target resolves inside the scanned tree | before Doxygen |
| the leaf's `index.html` still carries the mainpage `@section` ids | after every (language, version) build |
| the leaf produced a `*-example.html` | after every (language, version) build |

## Doxyfile Notes（Doxyfile 关键点）

- `doc_doxygen_folders` / `doc_doxygen_suffix` in metadata drive what Doxygen scans. The suffix list applies to **every** folder, so it cannot by itself keep a stray `.dox`/`.cxx` out of `include/`/`src/` — the layout rule above is the real guard. metadata 驱动扫描范围；后缀表对每个目录统一生效，布局约束需另行保证。
- **There is no `MAIN_PAGE` option**: the landing page comes from `mainpage.dox`'s `@mainpage`. A `MAIN_PAGE` line is silently ignored (and warns). 没有 MAIN_PAGE 配置项。
- `CLANG_ASSISTED_PARSING = NO` on purpose: `INPUT` is the generated mirror, not the real build context, so the clang probe only reported missing Conan headers the docs job never installs. 该开关已关闭。
- `docs/build.py` **mirrors** each scanned folder into the leaf (`include/`, `src/`, `dox/`) instead of flattening it, and `STRIP_FROM_PATH` hides the mirror's own name — so the published docs get real Directory pages and two same-named files can no longer overwrite each other. 按目录镜像复制，不再平铺。
- Images: `docs/images/` with `IN:`/`OUT:`/`ALL:` prefix routing (see `docs/build.py`). 图片按 IN/OUT/ALL 前缀路由。

## Pitfalls（易踩坑）

1. Tag typo: must be exactly `[en]`/`[zh]` and the language must be in `doc_languages`. 标签拼写或语言未启用。
2. `@exporter` outside a multi-line Doxygen comment → module silently not generated. 注解位置不对 → 模块静默失败。
3. New API without `@since` → not shown in earlier doc versions. 新 API 缺 @since 不会出现在旧版本文档。
4. Iterate with `python ./docs/build.py` locally, faster than CI. 本地迭代更快。
5. A `.dox`/`.cxx` created under `include/` or `src/` — they are doc-only and belong in `docs/doxygen/dox/`. 文档专属后缀放错目录。
6. A second `@mainpage` block — Doxygen would keep whichever it scans first; the build fails instead. 两个主页会直接构建失败。
7. The tutorial placed outside `demos/`, or an `@include` whose target is missing — both fail the completeness gate. 教程位置错误或引用缺失都会失败。

