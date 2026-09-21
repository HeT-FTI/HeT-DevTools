# Contributing to this project（贡献指南）

## 提交规范（Commit Conventions — canonical form）

提交信息是**双通道**：conventional 前缀驱动版本号（semantic-release），emoji 驱动附加 CI 流水线（见 `.github/skills/_shared/gitmoji.md`）。

**Canonical form**: `<type>(<emoji|scope>)?!?: <description>`

| type | 用途 | 示例 |
|---|---|---|
| `feat` / `fix` / `perf` | 版本号变更（minor/patch） | `feat(:fire:): cross-compile support` |
| `docs` / `test` / `build` / `ci` / `refactor` / `style` / `chore` | 不触发版本变更 | `chore(release): 1.0.0 [skip ci]` |

- 破坏性变更：`feat!:` 或正文含 `BREAKING CHANGE:` → major。
- **CI 门禁强制**：`ci-orchestrator.yml` 的 `commit-lint` job 在 push/PR 上校验；本地自查 `npx commitlint --config .github/misc/commitlint.config.js --from HEAD~1 --to HEAD`。
- ⚠️ `.github/misc/commitlint.config.js` 与 `.github/misc/.releaserc.json` 的 `headerPattern` 必须同步修改，否则会出现"门禁通过但版本不自增"。

## PR 流程

1. 从 `main` 拉分支，按 canonical form 拆分提交。
2. 保证 `commit-lint`、`schema-check`、`build`、`tests`（PR 上 shift-left 强制）全绿。
3. 填写 PR 模板自检清单；`CODEOWNERS` 评审人为必审。
4. 合并到 `main` 后，release 由 `(:package:):` + Release 配置 + 开关触发（semantic-release）。

## 本地开发（Local Setup）

```bash
# 构建环境
source ~/venv/build/bin/activate
# node 工具（commitlint/ajv/semantic-release）
npm ci --no-audit --no-fund
# 第一道闸（一次性）
pip install pre-commit && pre-commit install --config .github/misc/.pre-commit-config.yaml

# 质量自查
# 注：clang-format 需 >= 19，建议 `pip install clang-format==23.1.0`
npx ajv validate -s .github/misc/metadata.schema.json -d metadata.json --spec=draft7
find include src -type f \( -name '*.c' -o -name '*.h' \) -exec clang-format --dry-run --Werror --style=file:.github/misc/.clang-format-c {} +
find include src -type f \( -name '*.cpp' -o -name '*.hpp' \) -exec clang-format --dry-run --Werror --style=file:.github/misc/.clang-format-cpp {} +
clang-tidy --config-file=.github/misc/.clang-tidy src/*.cpp -- -std=c++17 -Iinclude
# MegaLinter SAST（会拦 CI，镜像 megalinter job；需 Docker/Podman）
# 版本已固定为 v8.8.0，与 CI action（oxsecurity/megalinter@e08c2b05...）一致
bash .github/misc/run-megalinter.sh          # 或 npm run lint:megalinter；--fix 自动修复

# 构建 + 测试
conan create . -s build_type=Debug --build=missing
```

## 工程契约（Contracts）

- `metadata.json`：单一真源，schema 见 `.github/misc/metadata.schema.json`；字段语义见 `.github/skills/_shared/metadata-contract.md`。
- 代码规范：`.github/misc/.clang-format-c`（`.c/.h`）、`.github/misc/.clang-format-cpp`（`.hpp/.cpp`）、`.github/misc/.clang-tidy`（WarningsAsErrors）与 `.github/skills/_shared/code-conventions.md`。
- 测试体系：`test_package/test/{unit,stress}/`，GTest 只进 test_package（见 `test-conventions.md`）。

## 仓库布局（Repository Layout）

| 位置 | 内容 | 原因 |
|---|---|---|
| `.github/workflows/` | CI 流水线 | 所有 workflow |
| `.github/misc/` | CI 调用的工具配置（clang-format 双配置、clang-tidy、gitleaks、commitlint、releaserc、schema、mega-linter、pre-commit、labels） | 保持根目录干净；流水线显式传路径 |
| `.github/` | `CODEOWNERS`、`CONTRIBUTING.md`、PR 模板、dependabot | GitHub 约定位置 |
| 根目录 | `package.json`/`package-lock.json`（npm）、`conanfile.py`/`conandata.yml`/`metadata.json`（conan）、`CMakeLists.txt`（cmake）、`Doxyfile`（`docs/build.py` 硬引用）、`.editorconfig`/`.gitignore`（编辑器框架自动发现）、`.vscode/`、`.devcontainer/` | 框架/规范强制根目录 |

> 注：`.clang-format` 不再放在根目录（clang-format 内置映射无法让 `.h` 走 C）；编辑器经 `.vscode/settings.json` 显式指向 `.github/misc/.clang-format-cpp`，C 家族的正确性以 CI 门禁为准。`node_modules/` 是 `npm install`/`npm ci` 的本地依赖缓存目录，不入库（`.gitignore`）。

## 回退（Rollback）

- 撤销远端分支/tag：`git push origin --delete <branch> <tag>`
- 本地回退到整改前：`git checkout main && git branch -D <branch> && git tag -d <tag>`
- CI 红定位：Actions UI 或 `gh run list`（需 `gh auth login`）
