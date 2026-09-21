/**
 * 路径字符串助手（纯函数，不 import vscode）。
 *
 * 存在的理由（§F.46 —— CI 上真实翻过一次车）：
 *   · 我们在 Linux / macOS 上写测试，路径是 `/a/b/c`；Windows runner 上是 `C:\a\b\c`。
 *   · `'C:\\a\\b\\main.cpp'.split('/')` 返回**整个字符串**（没有分隔符可切），
 *     于是"取文件名"在 Windows 上静默拿到全路径，断言就只在 Windows 上红。
 *   · `node:path.basename` 也不行：它是**平台相关**的 —— Linux 上跑 `basename('C:\\a\\b')`
 *     一样拿不到 `b`。所以"跨平台取名字"必须自己按两种分隔符都切。
 *
 * 规矩：任何"路径 → 名字/比较"的地方都用这里的函数，不许写 `split('/')`。
 * （唯一例外是 tar 条目名 —— tar 规范里**规定**用 `/`，见 `core/templateTarball.ts`。）
 */

/** 同时按 `/` 与 `\` 切分（连续分隔符不产生空段）。 */
export function splitPath(p: string): string[] {
  return p.split(/[\\/]+/u).filter((s) => s.length > 0);
}

/** 取最后一段（`C:\a\b\main.cpp` / `/a/b/main.cpp` 都给 `main.cpp`）。 */
export function baseName(p: string): string {
  return splitPath(p).at(-1) ?? '';
}

/** 取目录部分（没有目录时给空串）。 */
export function dirName(p: string): string {
  const parts = splitPath(p);
  return parts.slice(0, -1).join('/');
}

/**
 * 统一成 `/` 分隔（比较/展示用）。
 *
 * 只做分隔符归一 —— **不做**大小写归一（`C:\A` 与 `c:\a` 在 Windows 上其实相同，
 * 但那是另一回事，需要时在调用点显式 `toLowerCase()`，别偷偷混进来）。
 */
export function normalizeSlashes(p: string): string {
  return p.replace(/\\/gu, '/');
}
