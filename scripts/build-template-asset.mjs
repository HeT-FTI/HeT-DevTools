// Bundles the fcpp reference template (workspace/fcpp) into assets/template
// so packaged vsix installs can create new projects fully offline.
// Excludes version-control + build noise only (template is ~2 MB).
// Usage: node scripts/build-template-asset.mjs   (also run by `npm run package`)
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeLfInPlace } from './lf.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'workspace', 'fcpp');
const dest = join(root, 'assets', 'template');

/**
 * 产物确定性：不管检出/打包机的行尾配置是什么，进 vsix 的模板一律是 LF。
 * 2026-09-15 实测：`.gitattributes`（`text eol=lf`）与 `git config --global core.autocrlf false`
 * 都没能挡住 Windows runner 把模板检出成 CRLF（155/158 个文件），三份 vsix 因此逐字节不同。
 * 与其跟构建机的 git 配置搏斗，不如在打包前把这件事做死（见 `lf.mjs`）。
 */
const applyLf = (dir) => {
  const { changed, stats } = normalizeLfInPlace(dir);
  // **每次都打**：下次行尾再出问题，日志里直接有"是什么形态"，不用再猜一轮。
  console.log(
    `[asset] 行尾检查：${stats.files} 个文件（二进制 ${stats.binary}）；` +
      `CRLF ${stats.crlf}、反向 LFCR ${stats.lfcr}、单独 CR ${stats.loneCr} → 归一 ${changed.length} 个`,
  );
  if (changed.length > 0) {
    console.warn('[asset] 已把上述文件从 CR 归一为 LF（本机检出的行尾设置不对；产物已由我们自己保证一致）');
    console.warn(`[asset]   例：${changed.slice(0, 3).join('、')}`);
  }
  return changed.length;
};

if (!existsSync(join(src, 'metadata.json'))) {
  // workspace/fcpp is the maintainer's local reference copy (gitignored — the
  // repo never commits it). On a fresh clone / CI the source is absent; the
  // COMMITTED assets/template snapshot is then authoritative for packaging.
  if (existsSync(join(dest, 'metadata.json'))) {
    console.warn('[asset] workspace/fcpp 源缺失（CI/浅克隆）→ 沿用已提交的内置模板 assets/template。');
    console.warn('[asset] 注意：本地改动 workspace/fcpp 后需运行 npm run asset 并提交 assets/template 以保持同步。');
    applyLf(dest);
    process.exit(0);
  }
  console.error(`[asset] template source missing: ${src}`);
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });

const excludedPath = (p) => {
  const norm = p.replace(/\\/g, '/');
  return (
    norm.includes('/.git/') ||
    norm.includes('/.vscode-test/') ||
    norm.includes('/node_modules/') ||
    norm.includes('/docs/sphinx/build/') ||
    norm.includes('/docs/doxygen/build/') ||
    norm.includes('/benchmark/build/')
  );
};
const excludedBase = new Set(['out', 'build', '.git', '.vscode-test', 'node_modules']);

cpSync(src, dest, {
  recursive: true,
  filter: (p) => {
    if (excludedPath(p)) {
      return false;
    }
    const base = p.split(/[\\/]/).pop() ?? '';
    return !excludedBase.has(base);
  },
});

if (!existsSync(join(dest, 'metadata.json'))) {
  console.error('[asset] bundled template missing metadata.json after copy');
  process.exit(1);
}
applyLf(dest);
console.log('[asset] bundled template ready at ' + dest);
