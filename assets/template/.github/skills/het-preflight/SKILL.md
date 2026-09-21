---
name: het-preflight
description: 'Pre-release gate for the fcpp template (quality, tests/coverage, docs, audit, version). Use when: pre-release check / release gate / can we release / run before release. 发版前检查门：质量、测试覆盖率、文档、审计、版本号全流程门禁。'
argument-hint: "Target version (optional) / 目标版本（可选）"
user-invocable: true
---

# N7 · het-preflight — Pre-Release Gate（发版前检查门）

> For developers: fixed gate before `(:package:):` release — all green, then release. 发版前把门禁逐项过一遍，全绿才发。

## Gate Checklist（门禁清单，按顺序执行）

| # | Check（检查） | How（执行方式） | Pass（通过标准） |
|---|------|------|------|
| 1 | Code quality | local clang-tidy + clang-format (see `het-quality` S4) | no warning (WarningsAsErrors) |
| 2 | Tests + coverage | `conan create . -s build_type=Debug` (with `activate_code_coverage`) | all pass, coverage met |
| 3 | Docs | `python ./docs/build.py` | no error, en/zh pages |
| 4 | Audit | `het-audit` (N6) | no blocking issues |
| 5 | Version | confirm semantic-release will bump as expected (feat→minor/fix→patch/BREAKING→major) | matches plan |
| 6 | metadata switches | `workflow_triggers.release=true` (the switch is permission; the release gitmoji is intent) | ready |

## After the Gate（门禁通过后）

1. Commit with proper prefixes (see `het-commit` N5); for release add the release gitmoji. 规范提交 + 带发布 emoji。
2. Hand over to `het-release` (S2): semantic-release generates CHANGELOG.md, rewrites metadata version, tags and releases. 交给 S2。

## Quick Script（本地快速跑一遍）

```bash
# 1) quality
find include src -type f \( -name '*.c' -o -name '*.h' \) -exec clang-format --dry-run --Werror --style=file:.github/misc/.clang-format-c {} +
find include src -type f \( -name '*.cpp' -o -name '*.hpp' \) -exec clang-format --dry-run --Werror --style=file:.github/misc/.clang-format-cpp {} +
clang-tidy --config-file=.github/misc/.clang-tidy src/*.cpp -- -std=c++17 -Iinclude
# 2) tests + coverage
conan create . -s build_type=Debug --build=missing
# 3) docs
python ./docs/build.py
# 4) audit → het-audit (N6)
```

## Failure Handling（失败处理）

- Any red check → route to its skill (quality/build/docs/audit), fix, re-run this gate. 定位到对应技能修复后重跑。
- Version not as expected → check recent commit prefixes. 检查最近提交前缀。

