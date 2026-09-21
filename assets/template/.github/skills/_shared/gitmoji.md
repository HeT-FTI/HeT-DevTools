# fcpp Private Gitmoji Trigger Superset — Cheat Sheet（私有 gitmoji 触发超集速查表）

> Fact source: emoji parsing in `.github/workflows/metadata-controller.yml`. All skills reference this table, never copy it. 所有技能引用本表，不复制。

## Trigger Table（触发表：提交信息带 emoji → 触发对应流水线）

| I want CI to...（我想让 CI 做什么） | Put in commit message（提交信息里写） | Trigger condition（触发条件） | metadata switch（开关） |
|------|------|------|------|
| Build（构建） | `:building_construction:` | push + `workflow_triggers.build=true` | `workflow_triggers.build` |
| Tests GTest+coverage（测试） | `:beer:` | push + `trigger_tests=true` + `workflow_triggers.tests=true` | `trigger_tests` / `activate_code_coverage` |
| Release（发布） | `(:package:):` | push + `workflow_triggers.release=true` | `workflow_triggers.release` |
| Docs（文档） | `:book:` | push + `workflow_triggers.docs=true` | `workflow_triggers.docs` |
| Quality/security（质量/安全） | `:shield:` | push with emoji, or **any PR** (shift-left) + `workflow_triggers.security_scan=true` | `workflow_triggers.security_scan` |
| Online cross-compile（在线交叉编译验证） | `:hammer_and_wrench:` | push + `workflow_triggers.cross_compile=true` | `workflow_triggers.cross_compile` |
| hetai cross-compile/board（上板） | `:fire:` (or `🔥`) | push（`hetai-package-matrix.yml` separate check） | self-hosted, no switch |

## General Rules（通用规则）

- **Soft rule（软性规则）**: an emoji anywhere in the message is grep-matched (`grep -q`) — even in the description it triggers. 换句话说：提交正文里**写出**某个 emoji 也会触发对应流水线。emoji 出现在任意位置即可触发。
- **Permission + intent（许可 + 意图）**: a `workflow_triggers.*` switch only grants *permission*; the gitmoji states *intent*. Switches are independent of each other and of `build_type` — `build_type` is a declared project state and gates nothing. 开关给许可、emoji 给意图；开关互不影响，`build_type` 不参与门控。
- `:hammer_and_wrench:` is **decoupled**: it starts only the cross-compile pipeline, no other emoji
  starts it, and it is deliberately excluded from the PR shift-left set. `:fire:` remains the
  self-hosted on-board route. 在线与上板两条路线互不触发。
- **Canonical form（规范写法，推荐）**: emoji in the **parentheses right after the commit word**（放在主 commit 词后的括号里）:
  `<type>(<emoji>): <description>`
  e.g. `feat(:fire:): cross-compile support`, `test(:beer:): vector add cases`, `chore(:package:): prepare release`.
- **Placement is free; the *set* is what counts（位置随意，看的是集合）**: only *which* emojis appear decides the pipelines — the controller greps the whole message. A long trigger name eats the header budget (`fix(:building_construction:): ` is 31 of 72 characters), so when the description needs the room put a **short non-triggering** emoji in the parentheses and move the pipeline emoji(s) to the body:

      fix(:bug:): replace the banned printf in the _Generic test

      Requests :building_construction: for this push.

  长 emoji 吃掉标题预算；需要篇幅时括号里放短的无触发 emoji，把要触发的 emoji 搬到正文。
- **The parenthesis emoji never reaches the changelog（括号里的 emoji 不进 changelog）**: `.releaserc.json` names that capture group `emoji` instead of `scope`, so release notes render `* <subject>` with no emoji prefix. Naming it `scope` made every entry print `**:beer::**`. Triggering is grep-based, not parser-based — this changes nothing about which pipelines run.
- Versioning is driven by `commit-analyzer` (semantic-release) reading the **conventional prefix** (feat/fix/...), orthogonal to the emoji. 版本由 conventional 前缀决定，与 emoji 正交。

## Full Sweep（全量 / 全量测试）

"全量" / "全量测试" / "走一遍全量" = **every online pipeline except auto-release**: build + tests + docs + security + cross-compile. It never drags in `:package:` (release) or `:fire:` (the self-hosted board route). 全量 = 除自动发版与上板外的全部在线流水线。

Triggers are grep-matched across **every** commit message in the push, so one push can request several pipelines at once. For a sweep, keep the emoji that fits the change in the parentheses and list the rest on a body line:

    feat(:building_construction:): add a C11 _Generic exercise to the C line

    Requests the full sweep too: :beer: :book: :shield: :hammer_and_wrench:

This is the only sanctioned use of emojis inside a body. 主 emoji 放括号、其余写正文，是正文里唯一允许出现 emoji 的场合。

若括号里放的是**无触发** emoji（如 `:wrench:`），正文列表必须补上 `:building_construction:` —— 全量集合恰好是这五个：

    :building_construction: :beer: :book: :shield: :hammer_and_wrench:

If the parenthesised emoji triggers nothing, the body list must carry `:building_construction:` too; those
five emojis *are* the sweep set. 括号里是触发 emoji 时它顶替 `:building_construction:`；否则正文要补齐。

## Conventional Type → Emoji Map（类型 → emoji 映射，`het-commit` N5 使用）

| Type（类型） | Purpose（用途） | Suggested emoji（建议 emoji） |
|------|------|------|
| feat | new feature | ✨ (add `:building_construction:`/`:fire:` if you need that pipeline) |
| fix | fix | 🐛 |
| perf | performance | ⚡ |
| docs | docs | 📖（trigger `:book:` semantics with `:book:`） |
| test | tests | 🧪（trigger tests with `:beer:`） |
| build | build | 🏗️（trigger build with `:building_construction:`） |
| ci | CI config | 🔧 |
| refactor | refactor | ♻️ |
| style | style | 🎨 |
| chore | misc | 🔩 |

## BREAKING CHANGE Syntax（语法）

- Form 1（方式一）: `<type>(<emoji>)!: description`, e.g. `feat(:fire:)!: breaking API`. 
- Form 2（方式二）: body contains `BREAKING CHANGE: description`.
- Both → major version by `commit-analyzer`. 判定为主版本 +1。

