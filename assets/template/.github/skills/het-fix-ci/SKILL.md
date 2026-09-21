---
name: het-fix-ci
description: 'CI/CD troubleshooting for the fcpp template. Use when: CI is red / workflow failed / build or test fails / unknown where the problem is. CI 排障：定位并修复模板流水线常见失败。'
argument-hint: "Failure link or symptom / 失败链接或症状"
user-invocable: true
---

# S6 · het-fix-ci — CI Troubleshooting（CI 排障）

> For CI/CD novices: locate the failure by pipeline, don't guess. 按流水线定位失败，不要瞎猜。

## 3-Step Locate（三步定位法）

1. **Actions page**: GitHub → Actions → red workflow → red job → failing step log. 看 Actions 页定位红 job 与步骤。
2. **Match symptom** with the failure signature table below. 对号入座。
3. **Fix & rerun**: push again or `Re-run failed jobs`. 修复后重跑。

## Failure Signature Table（各流水线失败签名表）

### Build / Tests（构建/测试）
| Symptom（症状） | Cause（原因） | Fix（修复） |
|------|------|------|
| `conan create` timeout | deps compile too slow (55 min) | raise timeout / pre-cache |
| deps not found | network / bad version | check `conandata.yml` / `--build=missing` |
| Windows build odd | shared forced to static | expected, not an error |
| `Could not create named generator Visual Studio 18 2026` | `cmake_version` is below the 4.2 floor, so CMake cannot name the generator Conan derives for msvc 195 | raise `metadata.json` `cmake_version` — the recipe now rejects that pair up front with this very message |
| coverage artifact missing | switches off, **or** the run was build-only | check `trigger_tests`/`activate_code_coverage`; a `-c user.het:run_tests=False` run produces none by design |
| `Reconcile coverage` red: legs instrumented different translation units | one toolchain skipped a source file, so one report is incomplete | read the `::error::` line: it names the file per leg. A missing file on **both** legs is a build-config problem, on **one** it is a toolchain problem |
| `Reconcile coverage` red: expected a summary from every leg | an `Auto Testing` leg produced no `coverage_summary.json` | look at that leg first; reconcile only runs when both legs succeeded |
| `Auto Testing (windows-latest)` fails at configure | the test chain has no MSVC coverage backend | Windows is intentionally not in this chain — do not add it until coverage is implemented for MSVC |
| coverage gate red in `Tests` | the report was produced but the summary is absent or 0% | the gate reads `coverage_summary.json`; 0% means no test reached the library |

### Release（发布）
| Symptom | Cause | Fix |
|------|------|------|
| version not bumped | no conventional prefix | use `feat/fix/perf` |
| not triggered | `workflow_triggers.release` off, or this push carries no release gitmoji | read the two gate notices |

### Docs（文档）
| Symptom | Cause | Fix |
|------|------|------|
| missing deps | doxygen/graphviz not installed | run `python ./docs/build.py` locally |
| language missing | tag not in `doc_languages` | check `[en]`/`[zh]` |

### Quality / Security（质量/安全）
| Symptom | Cause | Fix |
|------|------|------|
| format red | clang-format violation | `clang-format -i` |
| clang-tidy warning | WarningsAsErrors | fix code |
| secret alert | secret committed | check gitleaks report |
| devskim `Banned C function detected` | a banned function (e.g. the printf family) in include/ + src/ | rewrite with `fputs`-style calls; MegaLinter scans only those two roots |

### Board（上板）
| Symptom | Cause | Fix |
|------|------|------|
| baremetal build fails | dep not in `baremetal_white_list` | adjust whitelist |
| flash fails | flash_tool / device wrong | check `bench_config.json` |
| not triggered | needs self-hosted runner | check runner |

## General Checklist（通用排查清单）

1. **gitmoji not triggered**: emoji spelling? Use canonical `type(:emoji:): description`（emoji 放括号）；`workflow_triggers.*` = true?
2. **Switches off**: `workflow_triggers` all false → turn on first. 开关没开。
3. **Cross Compile red**: the emoji is `:hammer_and_wrench:` (not `:fire:`, which is the
   self-hosted board route). The leg prints the generated profile first (a wrong `arch` or
   `-mcpu` shows up there), then the apt toolchain package, then Class/Machine.
   在线交叉编译腿失败：先看你打出的 profile，再看工具链包名与产物架构。
4. **Artifacts not found**: download from the bottom **Artifacts** area. 产物在 Actions 页底部 Artifacts。
5. **Reproduce locally**: `conan create . -s build_type=Debug --build=missing` is faster than CI. 本地复现更快。

## Route to Specific Skills（定位后转交）

- Build/test → `het-build` (S1); release → `het-release` (S2); docs → `het-docs` (S3); quality → `het-quality` (S4); board → `het-board` (S5).

