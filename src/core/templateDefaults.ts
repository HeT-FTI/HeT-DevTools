/**
 * Single source of truth for the fcpp template origin (maintainer-locked, D-8).
 * Only this file is allowed to know the concrete template location — do not
 * hardcode the ref anywhere else. TEMPLATE_REF accepts a tag or a commit hash.
 */
export const TEMPLATE_REPO = 'https://github.com/HeT-FTI/fcpp';

/**
 * D-E3 canonical release tag — **空串 = 上游还没给当前 pin 的那个提交打 tag**。
 *
 * 2026-09-20：上游修了 Windows 文档构建（`docs/build.py` 路径分隔符），修复提交是 `6278d01`，
 * 而且**没有追加 tag** —— `v0.1.2` 仍然指着更早的 `cae2f5a7`（内容比我们的 pin **旧**）。
 *
 * 为什么不能"tag 照旧填 `v0.1.2`"：`tarballPlanFor()` 只有**一条** sha256 —— 链首去下旧 tag 的
 * tarball 必然校验失败（还得白下一轮所有候选）才退到固定哈希。规矩是：
 * **tag 与 pin 同内容才当锚点**；不同内容（或没有 tag）就让链首退到固定哈希。
 * 配合 `TEMPLATE_TAG_COMMIT`：只有它 === `TEMPLATE_REF` 时 tag 才会被排进链。
 * 上游哪天给 `6278d01`（或其后继）打了 tag，把这两个常量填回即可。
 */
export const TEMPLATE_TAG = '';

/** `TEMPLATE_TAG` 指向的提交；与 `TEMPLATE_REF` 相等 = tag 与 pin 同内容，tag 才能排链首。 */
export const TEMPLATE_TAG_COMMIT = '';

/**
 * 固定哈希 pin（D-E3 主体锚点）：确定性、与 CI 一致。
 *
 * 2026-09-20 更新：`6278d01b548cb148df2f521b0579fb09f6240d26`
 * · = `v0.1.2` 那个提交 **+1 步**（只改了 `docs/build.py`，+5/-2）
 * · 修的是 Windows 上文档构建**必失败**：`_file_collector`/`_walk_files` 给出 `\`，
 *   而检查用字面量 `'/demos/'` 判断 → 假失败（上游 `fix(:book:): keep collected relative paths POSIX…`）
 * · **为什么用哈希而不是等新 tag**：上游已改走在线发版，修复先在 main 上、暂无新 tag；
 *   本库支持纯哈希 pin（`refKindOf()` → `commit` → codeload `…/tar.gz/<sha>`）
 */
export const TEMPLATE_REF = '6278d01b548cb148df2f521b0579fb09f6240d26';

/**
 * `TEMPLATE_REF` 的 codeload tarball 校验值（G17）。
 *
 * 实测（2026-09-20）：`https://codeload.github.com/HeT-FTI/fcpp/tar.gz/6278d01…`
 * · 3,028,271 字节 · **两次下载 sha256 一致**（所以能钉死）
 * · 经 `gh-proxy.com` 前缀取到的字节**完全相同**（同一条 sha 覆盖所有加速候选）
 * · 解压后顶层目录是**完整 40 位 sha**（`fcpp-6278d01b548…/`）；用短哈希请求才是 `fcpp-<sha7>/`
 *   → 所以按"唯一顶层目录"剥一层，不许硬编码名字
 *
 * 换 pin 时必须同时更新 `TEMPLATE_REF` / 本值 / `TEMPLATE_TARBALL_BYTES`（有 tag 时还要
 * `TEMPLATE_TAG(_COMMIT)`）—— 门禁 `templateTarball.test.ts` 盯住这几个的自洽性。
 */
export const TEMPLATE_TARBALL_SHA256 = '209740a46869e239996d443bd65ea945caa832debe87c067c361ae6dbf8aab1d';

/** tarball 的期望字节数（只用于进度与日志；sha256 才是判据）。 */
export const TEMPLATE_TARBALL_BYTES = 3028271;

/**
 * 内置快照的版本（`assets/template/metadata.json`）。
 *
 * §11 兜底第 3 级：在线全失败时用它建工程（离线可用、秒建）。
 *
 * 2026-09-20：快照已**重刷到同一个 pin**（`6278d01`）—— 上游并没有改 `metadata.json` 的 version，
 * 所以这里仍是 `0.1.2`，但**内容与在线 pin 逐字节等价**（"内置快照 == 在线获取"这条承诺依旧成立）。
 * 刷快照的动作写在计划 §11 里，换版本时一并更新本常量。
 */
export const TEMPLATE_SNAPSHOT_VERSION = '0.1.2';

/**
 * Maintainer-only dev/offline override: absolute path to a local fcpp checkout.
 * Empty string = use the GitHub upstream. Never shipped as a user default.
 */
export const TEMPLATE_LOCAL_PATH = '';
