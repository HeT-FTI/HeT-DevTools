---
name: het-module
description: 'Add a new module/API to the fcpp library (paired naming, module annotations, ImportStart/End markers, bilingual docs). Use when: add a module / new API / new feature / header+source. 新增模块/API：按配对命名与注解规范创建 include/src 并衔接测试。'
argument-hint: "Module name & description (optional) / 模块名与功能描述（可选）"
user-invocable: true
---

# N2 · het-module — Add a Module / API（新增模块 / API）

> For developers. Facts: `.github/skills/_shared/code-conventions.md`、`metadata-contract.md`、`test-conventions.md`。

## Mental Model（心智模型）

> "Adding a module = create a paired pair (`include/x.hpp` + `src/x.cpp`) + write annotations + bilingual docs + hook up tests. Wrong annotations make module generation **fail silently** — get the spec right the first time."
> 新增模块 = 配对文件 + 注解 + 双语文档 + 衔接测试；注解写错模块生成会静默失败。

## Steps（新建模块步骤）

**① Create the pair（建配对文件）** — `include/<module>.hpp` + `src/<module>.cpp` (`.h`/`.c` for C).

**② Header skeleton（头文件骨架，含模块标记）**
```cpp
// Conan::ImportStart
#pragma once
#include <cstdint>
// Conan::ImportEnd

/**
 * @brief [en] Adds two float arrays element-wise
 * @brief [zh] 两个浮点数组逐元素相加
 * @since 1.0
 * @exporter
 */
void mymod_vec_add_f32(const float* a, const float* b, float* y, uint32_t n);
```

**③ Source skeleton（实现文件骨架）**
```cpp
// Conan::ImportStart
#include <mymod.hpp>
// Conan::ImportEnd
void mymod_vec_add_f32(...) { ... }
```

## Spec Checklist（规范清单，写错会踩坑）

- [ ] Pairing: `.h`↔`.c`, `.hpp`↔`.cpp` one-to-one. 配对一一对应。
- [ ] `// Conan::ImportStart` / `// Conan::ImportEnd` wrap the include area. 包裹 include 区。
- [ ] Export symbols with `@exporter` (or `@attacher`). 导出符号加注解。
- [ ] Bilingual `[en]`/`[zh]` comments; `@since` for version filter. 双语注释 + 版本标注。
- [ ] **2 blank lines between global objects** (module generation splits on this). 全局对象间 2 空行。
- [ ] Follow clang-format / clang-tidy (WarningsAsErrors). 遵循格式与静态检查。
- [ ] New third-party dep → `het-deps` (N1). 需要新依赖交给 N1。
- [ ] Baremetal-only code guarded by `#ifndef __ARM_EABI__`. 裸机专属代码加保护。

## Follow-up（衔接）

1. After creating, call `het-testgen` (N4) for unit tests (incl. coverage). 建议补测试。
2. Verify build via `het-build` (S1) `conan create`. 验证构建。
3. With `generate_modules_inplace=true`, the recipe auto-generates `.ixx/.cppm` — control visibility with `@exporter`/`@attacher`. 模块自动生成时用注解控制可见性。

## Self-Help When Red（失败自救）

1. Module silently not generated: check `@exporter` inside a **multi-line Doxygen comment** and 2 blank lines. 检查注解与空行。
2. Header not scanned: confirm under `include/`, suffix `.h`/`.hpp`. 确认位置与后缀。
3. Wrong tree: `.dox`/`.cxx` are doc-only and belong in `docs/doxygen/dox/`, never in `include/`/`src/`. 文档专属后缀放错目录。
4. Baremetal OS-dep error: dep not in `baremetal_white_list`. 检查裸机白名单。

