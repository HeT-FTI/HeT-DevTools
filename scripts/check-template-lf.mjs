// 打包门禁：**进 vsix 的模板不允许还有 CR**（在 `npm run package` 之后跑）。
//
// 为什么用 Node 而不是 `grep -rlI $'\r'`：上一轮的 grep 判据在 Windows 上给出的结论
// 自相矛盾 —— `git config --show-origin` 显示 `core.autocrlf=false` 已生效、
// `git check-attr` 说 `eol: lf`，可 grep 却报 132/155 个文件"带 CR"，而只换 `\r\n`
// 的归一一个文件都没动。判据必须建立在**我们自己读到的字节**上，而不是 shell 里
// 一个可能被转义/展开成别的东西的模式。所以：同一个 `lf.mjs`（只读扫描）+ 出错时
// 打印十六进制现场。
//
// 注意：这不是"修复"步骤 —— 修在 `npm run asset`（`build-template-asset.mjs`）；
// 这里只断言结果，因此必须只读。
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanCr } from './lf.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = process.argv[2] ?? join(root, 'assets', 'template');

const { found, stats, sample } = scanCr(dir);
console.log(
  `[gate] 模板行尾：${stats.files} 个文件（二进制 ${stats.binary}）；` +
    `CRLF ${stats.crlf}、反向 LFCR ${stats.lfcr}、单独 CR ${stats.loneCr} → 需归一 ${found.length} 个`,
);
if (found.length > 0) {
  console.error('::error::模板资源里仍有 CR —— 打包出的 vsix 会因打包平台而异：');
  for (const f of found.slice(0, 10)) {
    console.error(`::error::  ${f}`);
  }
  if (sample) {
    console.error(`[gate] 第一个文件的前 ${sample.length} 字节：${sample.toString('hex')}`);
  }
  process.exit(1);
}
console.log(`[gate] OK：${dir} 全部为 LF`);
