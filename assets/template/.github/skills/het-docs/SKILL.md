---
name: het-docs
description: 'Documentation generation for the fcpp template (Doxygen + Sphinx, bilingual en/zh). Use when: users ask how docs are generated, bilingual docs, doxygen/sphinx. 文档生成：多语言多版本文档流水线。'
argument-hint: "Docs scope (optional) / 文档范围（可选）"
user-invocable: true
---

# S3 · het-docs — Documentation Generation（文档自动生成）

> One entry for the whole docs pipeline: Doxygen API docs + Sphinx pages, bilingual (en/zh) and multi-version. Deep domain guides load on demand from `references/`. 文档流水线唯一入口；Doxygen 与 Sphinx 的深度指南在 `references/` 按需加载。

## Mental Model（心智模型）

> "Doxygen + Sphinx generate docs automatically: write `[en]`/`[zh]` tags in comments, commit with `:book:`, and GitHub runs `docs/build.py` to produce multi-language, multi-version API docs. Good comments → docs for free."
> 在注释里写好 `[en]`/`[zh]` 标记，提交带 `:book:`，GitHub 自动跑 `docs/build.py` 生成多语言多版本文档。

## Two Domains, One Pipeline（两大领域，同一条流水线）

| Domain（领域） | What it produces（产出） | Deep guide（深度指南） |
|------|------|------|
| **Doxygen** | API docs from code annotations（代码注解出 API 文档） | [doxygen.md](./references/doxygen.md) |
| **Sphinx** | Tutorial/manual pages + i18n (en/zh)（教程页 + 翻译） | [sphinx.md](./references/sphinx.md) |

- Both are built by `python ./docs/build.py` in one flow. 两条都由 build.py 一条流水线产出。
- Newbies only need this entry; the model loads the right reference when the task involves annotations (Doxygen) or RST / translation (Sphinx). 新手只用本入口；涉及注解加载 doxygen.md，涉及 RST/翻译加载 sphinx.md。
- **Doc-only files（文档专属文件）**: `.dox` and `.cxx` are documentation-only and live **only** under `docs/doxygen/dox/` — `mainpage.dox` plus `demos/*.dox` + `demos/*.cxx`, all hand-written standalone files. They are never docstrings inside `include/` or `src/`. 文档专属后缀只放 `docs/doxygen/dox/`。
- **Complete = landing page + tutorial（完备 = 主页 + 教程）**: `mainpage.dox` and `demos/tutorial.dox` are **hard requirements**; example code in the tutorial is **soft** (0..N `.cxx`, no pairing). `docs/build.py` fails the build when a property breaks — details in [doxygen.md](./references/doxygen.md). 主页与教程为硬约束，示例代码为软约束。

## 3-Step Checklist（三步操作清单）

1. Write bilingual tags in comments（注释里标语言）— detail in [doxygen.md](./references/doxygen.md):
   ```c
   /** @brief [en] the C function */
   /** @brief [zh] 测试用C函数 */
   ```
2. Commit with `docs(:book:): ...`. 按规范格式提交。
3. `metadata.json`: `workflow_triggers.docs = true`（模板默认已开启）→ Actions → `Docs` workflow.

## Related Switches（相关开关）

- `doc_languages`（默认 en/zh）→ `docs/build.py` 语言过滤；`doc_versions`（默认 1.0/2.0）→ 按 `@since` 版本过滤。
- `workflow_triggers.docs` — CI master switch（模板默认 `true`，提交带 `:book:` 即构建文档）。

## Local Build（本地生成）

```bash
python ./docs/build.py
```
Needs: doxygen、graphviz、sphinx、sphinx-intl、sphinx-rtd-theme、numpy。

## Artifacts（产物）

- Doxygen HTML per language/version; Sphinx + i18n (`docs/sphinx/locales/`); entry `index.html`. 多语言多版本 HTML + i18n。

## Self-Help When Red（失败自救）

1. Doxygen side: tag typo / language not enabled → [doxygen.md](./references/doxygen.md). 注解侧问题查 doxygen.md。
2. Sphinx side: page missing / translation not showing → [sphinx.md](./references/sphinx.md). Sphinx/翻译侧查 sphinx.md。
3. Missing deps: run `python ./docs/build.py` locally first. 本地先跑排查。
4. Deep troubleshooting → `het-fix-ci` (S6).

