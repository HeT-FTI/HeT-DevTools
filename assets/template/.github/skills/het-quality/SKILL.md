---
name: het-quality
description: 'Quality & security gates for the fcpp template (native clang-format/clang-tidy/gitleaks gates + a blocking MegaLinter SAST layer). Use when: code fails format/tidy/security scan, or quality CI is red. 质量/安全门禁：原生 gate 必过（WarningsAsErrors），MegaLinter SAST 同样拦提交。'
argument-hint: "Scope (optional) / 检查范围（可选）"
user-invocable: true
---

# S4 · het-quality — Quality / Security Gates（质量与安全门禁）

> Facts: `.github/skills/_shared/code-conventions.md`、`.github/misc/.mega-linter.yml`、`.github/misc/.clang-tidy`、`.github/misc/.clang-format-c(-cpp)`。质量门禁共两层，**两层都会拦**：确定性原生 gate（`security-linters.yml` 的 quality-gates job），加 MegaLinter（megalinter job，两个 step 都是 `continue-on-error: false`）。

## Mental Model（心智模型）

> "On `:shield:` (or any PR) the native quality gates run: clang-format (dual C/C++ configs), clang-tidy (WarningsAsErrors), gitleaks (secrets). MegaLinter SAST (semgrep/checkov/devskim) **blocks as well** — a devskim or semgrep finding fails the job just like a warning. **Warning = failure**, so lint locally first."
> `:shield:`（或任何 PR）触发原生质量门禁（format/tidy/gitleaks，warning 即失败）；MegaLinter SAST（semgrep/checkov/devskim）**同样会拦**。本地先自查。

## 3-Step Checklist（三步操作清单）

1. Lint locally（本地自查）:
   ```bash
   find include src -type f \( -name '*.c' -o -name '*.h' \) -exec clang-format --dry-run --Werror --style=file:.github/misc/.clang-format-c {} +
   find include src -type f \( -name '*.cpp' -o -name '*.hpp' \) -exec clang-format --dry-run --Werror --style=file:.github/misc/.clang-format-cpp {} +
   clang-tidy --config-file=.github/misc/.clang-tidy src/*.cpp -- -std=c++17 -Iinclude
   # SAST — mirrors CI `megalinter` job (also blocking); requires Docker/Podman + Node
   # version pinned to v8.8.0 (same as the pinned CI action) so results match CI
   bash .github/misc/run-megalinter.sh   # or: npm run lint:megalinter  (--fix to auto-fix)
   ```
2. Commit with `ci(:shield:): ...` (or open a PR — quality gates run on every PR).
3. Actions → `Security Scan / Quality Gates` and `Security Scan / MegaLinter` jobs — **both** must be green; the SAST detail is in the `MegaLinter reports` artifact.

## What Is Checked（检查内容一览）

| Check（检查） | Tool（工具） | Scope（范围） |
|------|------|------|
| Format | clang-format (C right-aligned / C++ left-aligned, 120 cols) | include/ + src/ |
| Static analysis | clang-tidy (bugprone/performance, WarningsAsErrors) | .h/.c/.hpp/.cpp |
| Secrets | gitleaks (allowlist `.github/misc/.gitleaks.toml`) | repo (infra exempt) |
| SAST (blocking) | semgrep / checkov / devskim (MegaLinter) | include/ + src/ + infra |
| Banned C functions | devskim — the printf family and friends | **include/ + src/ only**; `test_package/` is ignored |

## Self-Help When Red（失败自救）

1. Format: `clang-format -i <file>` auto-fix. 格式问题直接自动修。
2. clang-tidy warning: fix per hints (cannot silence). 按提示改代码。
3. gitleaks: check you did not commit a secret; infra files are exempt. 检查是否误提交密钥。
4. Report location: Quality Gates fail at the failing step (format/tidy/gitleaks); MegaLinter also turns the job red (detail in the artifact). 两层任一红都会让 job 变红。
5. `Banned C function detected` (devskim): rewrite the call — `fputs` instead of the printf family — it only scans include/ + src/. 被点名的禁用函数换掉即可。
6. Deep troubleshooting → `het-fix-ci` (S6).

