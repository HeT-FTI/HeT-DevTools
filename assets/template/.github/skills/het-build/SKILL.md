---
name: het-build
description: 'Build, test and coverage for the fcpp template. Use when: users ask to build / compile / run tests / check coverage, or CI build fails. 构建/测试/覆盖率：帮库能构建、能测、能看覆盖率。'
argument-hint: "Build/test/coverage target (optional) / 构建/测试/覆盖率目标（可选）"
user-invocable: true
---

# S1 · het-build — Build / Test / Coverage（构建 / 测试 / 覆盖率）

> For CI/CD novices: plain language first. 面向 CI/CD 新手：先用大白话。Facts: `_shared/gitmoji.md`、`metadata-contract.md`、`test-conventions.md`。

## Mental Model（心智模型）

> "Write code → commit with `:building_construction:` (build) or `:beer:` (test) → GitHub runs `conan create` and GTest automatically → results on the Actions page, coverage in Artifacts."
> 写代码 → 提交带构建/测试 emoji → GitHub 自动构建并用 GTest 测试 → 结果在 Actions 页，覆盖率在 Artifacts。

## 3-Step Checklist（三步操作清单）

**Scenario A: build only（只要构建）**
1. `metadata.json`: `workflow_triggers.build = true`
2. Commit with `feat(:building_construction:): ...`
3. Actions → `Build CI` → the three `Build (<os>)` jobs: compile + link + run `main.cpp` only, in the build type metadata declares

**Scenario B: build + tests + coverage（构建 + 测试 + 覆盖率）**
1. `metadata.json`: `trigger_tests = true`、`activate_code_coverage = true`、`workflow_triggers.tests = true`
2. `build_type` decides the config this chain builds — nothing else does
3. Commit with `test(:beer:): ...`
4. Actions → `Tests` → both `Auto Testing (<os>)` legs run in parallel; download the canonical `Coverage-report` artifact → `coverage_report/index.html`, but read rates from `coverage_summary.json`（不是 HTML）。`Coverage-report-<os>-<ts>` 是各腿原始证据，`Reconcile coverage` 才是一致性门禁

**Scenario C: verify locally first (recommended)（本地先验证，推荐）**
```bash
conan create . -s build_type=Debug --build=missing                              # full test chain
conan create . -s build_type=Debug --build=missing -c user.het:run_tests=False # build chain only
```

## Related Metadata Switches（相关开关）

| Switch（开关） | Purpose（作用） | Default（模板默认） |
|------|------|------|
| `build_type` | The single build type every CI leg builds — gates nothing | Debug |
| `trigger_tests` | Run GTest | false |
| `activate_code_coverage` | Coverage report | false |
| `saving_tests_log` | Save test log | false |
| `workflow_triggers.build/tests` | CI master switch | false |

## Self-Help When Red（失败自救：红了先看 4 步）

1. Actions → red job → `Build the package and run main.cpp`（构建链）或 `Build and test with Conan`（测试链）。点红 job 看日志。
2. Common failures: dependency fetch / MSVC-vs-CMake generator floor / 55-min timeout. 常见失败：依赖拉不到、生成器版本不匹配、超时。
3. Fix and retry: push again or `Re-run failed jobs`. 改完重跑。
4. Deep troubleshooting → `het-fix-ci` (S6). 详细排障转交 S6。

## Adding Tests（怎么加测试）

- Unit tests: `test_package/test/unit/*.cpp` (GTest); stress: `test/stress/`. 单元测试放 unit，压力测试放 stress。
- `main.cpp` entry is auto-generated — do not hand-write. 入口自动生成，不用手写。
- Specs: `.github/skills/_shared/test-conventions.md`
- Auto-generate tests → `het-testgen` (N4). 想自动生成用 N4。

