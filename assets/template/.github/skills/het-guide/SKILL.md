---
name: het-guide
description: 'Onboarding & routing for the fcpp template. Use when: new users ask what this project can do automatically, where to start, how CI triggers work, or which skill to use. 新手导航/入口：项目能自动做什么、从哪开始、CI 怎么触发、该用哪个技能。'
argument-hint: "Tell me what you want to do / 告诉我你想做什么"
user-invocable: true
---

# S0 · het-guide — IaC Commander / Onboarding（指挥官/入口）

> Plain language first, file paths second. 面向 CI/CD 新手：先大白话，再给路径。

## Mental Model（心智模型）

> "This is a C/C++ library template. Push code → the system reads the `metadata.json` switches and auto-runs build / test / docs / release. Put an emoji in the commit message to request a pipeline. You don't need to know workflow / orchestrator terms."
> 这是一个 C/C++ 库模板：提交代码后按 `metadata.json` 开关自动跑构建/测试/文档/发版；提交信息带 emoji 即可点名触发。

## Routing Table（路由表：意图 → 技能）

| User intent（用户意图） | Skill | What it does（作用） |
|--------|-------|------|
| Build / compile / test / coverage（构建/编译/测试/覆盖率） | `het-build` (S1) | Build, test, coverage |
| Release / new version / changelog（发布/新版本） | `het-release` (S2) | Release a new version |
| Docs / bilingual docs（文档/中英文文档） | `het-docs` (S3) | Auto docs |
| Quality / security / lint（质量/安全） | `het-quality` (S4) | Pass quality gates |
| Board / cross-compile / baremetal（上板/交叉编译/裸机） | `het-board` (S5) | Cross-compile & run on board |
| CI red / errors（CI 红了/报错） | `het-fix-ci` (S6) | Troubleshoot |
| Deps / module / setup / tests / commit / audit / preflight / patent（依赖/模块/环境/测试/提交/审计/门禁/专利） | Dev skills（二期） | `het-deps` · `het-module` · `het-setup` · `het-testgen` · `het-commit` · `het-audit` · `het-preflight` · `het-patent` |

## Trigger Cheat Sheet（触发速查表）

| I want（我想） | Put in commit message（提交信息里写） | It runs（它会） |
|------|------------|------|
| Build（构建） | `feat(:building_construction:): ...` | Build matrix |
| Tests（测试） | `test(:beer:): ...` | GTest + coverage |
| Release（发版） | `chore(:package:): ...` | Auto release + version bump |
| Docs（文档） | `docs(:book:): ...` | Bilingual docs |
| Quality / security（质量/安全） | `ci(:shield:): ...` | Native gates (format/tidy/gitleaks) + MegaLinter SAST — both block |
| Board（上板） | `feat(:fire:): ...` | Cross-compile + board transfer |

> Canonical form: `type(:emoji:): description`. Prerequisite: the matching `workflow_triggers.*` must be `true` in `metadata.json`. 规范格式 `type(:emoji:): 描述`；前提是对应开关为 true（模板默认 build/tests/docs/security_scan/cross_compile 已开启，release 需自行打开；cross_compile 可单独用 `:hammer_and_wrench:` 触发）。

## Newbie 3 Steps（新手三步走：从零到发版）

1. Open `metadata.json`, adjust `workflow_triggers.*` (build/tests/docs/security/cross_compile are on by default; enable release when needed). 按需调整开关（build/tests/docs/security 默认开启）。
2. Write code, commit with `feat(:building_construction:): description`. 用规范格式提交。
3. Check the GitHub **Actions** page; artifacts are in the bottom **Artifacts** area. 看 Actions 页，产物在 Artifacts。

## Usage Principles（使用原则）

1. Read-only: this skill only navigates and explains. 只读导航，不做修改。
2. Explain what will happen before giving steps. 先讲清会发生什么，再给操作。
3. Any metadata / commit / release change needs a plan and confirmation first. 涉及修改先给计划并确认。

## Related Files（关联文件）

- Fact sources（事实源）：`.github/skills/_shared/gitmoji.md`、`.github/skills/_shared/metadata-contract.md`
- Generation blueprint（生成蓝图）：`.github/misc/Codegen-Starter.txt`
- CI: `.github/workflows/ci-orchestrator.yml`、`metadata-controller.yml`

