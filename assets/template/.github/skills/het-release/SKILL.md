---
name: het-release
description: 'Release & versioning for the fcpp template (semantic-release + Conventional Commits). Use when: users ask to release / publish / bump version / changelog. 发布/发版：semantic-release 自动发版，版本号由提交前缀驱动。'
argument-hint: "Target version / notes (optional) / 目标版本/说明（可选）"
user-invocable: true
---

# S2 · het-release — Release / Versioning（发布新版本）

> Facts: `.github/skills/_shared/gitmoji.md`、`metadata-contract.md`、`.github/misc/.releaserc.json`。

## Mental Model（心智模型）

> "The template uses semantic-release: the **commit prefix (feat/fix/perf) decides the version jump**; on release it generates CHANGELOG.md, rewrites the `version` in metadata.json, and creates a GitHub Release. All you do is write well-formed commit messages."
> 模板用 semantic-release 自动发版：提交前缀决定版本号怎么跳，发布时自动生成 CHANGELOG、回写 metadata 版本、打 tag 发 Release。

## Permission + Intent（许可与意图） the `workflow_triggers.release` switch is the standing permission (set once, leave it alone), and the release gitmoji is this push's intent. semantic-release then derives the version from the commit prefixes, rewrites `version` in metadata.json, generates CHANGELOG.md, tags, and creates a GitHub Release."
> 发布是“许可 + 意图”：`release` 开关是长期许可（开一次就不动），发布 emoji 是本次意图。版本号由提交前缀决定。

## Pre-flight Gate（发布前置门，逐条确认）

1. `metadata.json`: `workflow_triggers.release == true` —— 许可。**不需要**改 `build_type`。
2. Working tree clean and `main` == `origin/main`. 工作区干净、与远端同步。
3. Since the last tag there is at least one releasable commit (`feat`/`fix`/`perf`/`!`). 上次 tag 以来有可发布提交。
   **The emoji and the bump are two independent halves**: `(:package:):` only opens the gate. A push whose commits are all `chore`/`docs`/`ci` bumps nothing, so semantic-release logs *"There are no relevant changes, so no new version is released."* and exits clean — a silent no-op that looks like a green release. `(:package:):` may ride on an existing `feat`/`fix` commit instead of being a commit of its own. 发布 emoji 只是开门；没有 bump 型提交就静默什么都不发。
4. `build_type` is at the project default (`Debug`) —— see Fool-proofing. 见下“防呆”。

## 3-Step Checklist（三步操作清单）

1. Confirm the pre-flight gate above. 确认前置门。
2. Land the work with proper prefixes（用规范前缀落地改动）:
   - `feat(...)` → minor（次版本 +1）
   - `fix(...)` / `perf(...)` → patch（修订版 +1）
   - `BREAKING CHANGE`（`feat(...)!:` or footer）→ major（主版本 +1）
3. Commit with the release gitmoji and push to `main`; that push alone starts the release. 带发布 emoji 提交并推送，该次推送即触发发布。

## Baseline Tag（基线 tag —— 一次性，且只做一次）

With **no** tag at all, semantic-release forces its first release to **`1.0.0`**: `get-next-version.js` returns `FIRST_RELEASE` (`1.0.0` in `lib/definitions/constants.js`) and the commit prefixes do not matter for that first jump. A project that wants to stay on `0.x`, or whose `metadata.json` already declares a version, sets the baseline by hand **once**:

```bash
git tag -a v0.1.0 -m "tagged baseline matching metadata.json"   # tagFormat is v${version}; the number must equal metadata.json's version
git push origin v0.1.0
```

A tag push triggers nothing — the orchestrator is `on: push: branches: [main]`. After the tag exists, `semver.inc(lastRelease.version, type)` applies and every later release is a normal bump.
无 tag 时 semantic-release 强制首发 `1.0.0`，与提交前缀无关；要留在 0.x 就手工打一次基线 tag。**只做一次**，之后 tag 全部由 semantic-release 创建。

## Fool-proofing（防呆：Agent 负责的不变量）

Model B **decouples `build_type` from releasing entirely**, so the classic "flipped it to Release and forgot to flip back → the test pipeline is stuck" failure mode is **structurally gone**: there is nothing to flip. The fool-proofing below guards that fact instead of re-introducing the ritual.
Model B 下 `build_type` 与发布完全解耦，“改过去忘了改回来”这个故障模式已在结构上消除。防呆是守住这个事实。

| When（时机） | Action（动作） |
|------|------|
| Before（发布前） | If `build_type` is `Release` (left over from the old flow), set it back to the project default `Debug` and say so — that is cleanup, **not** a release step. 历史遗留的 `Release` 请改回 `Debug`，属清理而非发布步骤。 |
| Before（发布前） | Assert `workflow_triggers.release == true`；if false, enable only that switch — do not touch other switches in the release commit. 只开这一个开关，不要顺手改其他。 |
| Before（发布前） | Do **not** hand-make a tag to *trigger* a release: semantic-release owns release tags. The one exception is the **baseline** tag above, and that happens once. 不要手工 tag 来触发发布；唯一例外是上面的基线 tag，且只做一次。 |
| After（发布后） | Verify: `Release` workflow succeeded, a new tag exists, and `metadata.json` changed **only** in `version`. 校验发布成功、tag 产生、仅 version 变化。 |
| After（发布后） | Assert `build_type` is still the project default; if the release flow changed it, restore it and report. 断言 `build_type` 仍为项目默认，被意外改写则翻回并报告。 |

> Rule of thumb（口诀）: **`build_type` 是“项目默认构建类型”的不变量，不是发布开关。** The agent keeps it invariant (checking before and after); nobody should touch it in order to release. If you ever feel the need to set it to `Release` to make a release work, the wiring has regressed — fix the wiring, not metadata. 如果你觉得“必须把它改成 Release 才能发版”，那是接线退化了，应当修接线。

## Version Rules（版本号规则速查）

| Commit prefix（提交前缀） | Version change（版本变化） | Example |
|------|------|------|
| `feat` | minor +1 | 1.0.0 → 1.1.0 |
| `fix` / `perf` | patch +1 | 1.0.0 → 1.0.1 |
| `!` or `BREAKING CHANGE` | major +1 | 1.0.0 → 2.0.0 |

## Artifacts（产物）

- tag + GitHub Release — created by semantic-release, never by hand. tag 与 Release 由 semantic-release 创建。
- `CHANGELOG.md` (auto-generated)
- `metadata.json` `version` rewritten（由 `.releaserc.json` 的 `prepareCmd` 回写）

## Self-Help When Red（失败自救）

1. Actions → `Release` workflow → `Release Gate` **and** `Release` step logs. 看 gate 与 Release 两步日志。
2. The gate prints two notices — read them to see which half is missing. gate 会打印两个 notice，直接指出缺哪一半：
   - `workflow_triggers.release = false` → 许可没开
   - `release gitmoji present = false` → 本次推送没带发布 emoji
3. `should_release = true` but nothing released → no releasable commit prefix since the last tag (`chore`/`ci`/`docs` do not release). 没有可发布前缀。
4. Needs `GITHUB_TOKEN` write permission. 需要写权限的 token。
5. First release of a repo with **no tags yet**: semantic-release starts the versioning at `1.0.0`, so `metadata.json`'s `version` will jump there rather than continue the current value. To keep a lower baseline, declare an existing release first (see `het-guide`). 无历史 tag 时首个版本从 `1.0.0` 起算。

> The legacy commit-base-versioning mechanism has been removed (2026-08); semantic-release is the only versioning path. 旧版 commit-base-versioning 已移除，semantic-release 是唯一版本机制。

## Related（关联）

- Auto commit → `het-commit` (N5); pre-release gate → `het-preflight` (N7). 自动提交用 N5，发版门禁用 N7。

