// 行尾归一：**产物生成阶段**把文本文件钉死成 LF。
//
// 为什么不让 git 去管（`.gitattributes` 与 `core.autocrlf=false` 都已试过、都不够）：
// 2026-09-15 实测 —— 同一个提交在 ubuntu/macos 上打出的 vsix 里，内置模板是 LF，
// 而 windows 那份是 CRLF（`core.autocrlf=true` 的检出后果）。更细的事实（run 34951716427）：
// 那次 CI 里 `git config --global core.autocrlf false` **确实生效**（`--show-origin` 能看到
// `C:/Users/runneradmin/.gitconfig core.autocrlf=false`），属性判定也正确
// （`git check-attr` → `text: set` / `eol: lf`），可**检出后仍有 132/155 个模板文件带 CR**。
// 而"只换 `\r\n`"的归一没改动任何文件 —— 说明那些 CR **不是** `\r\n` 形态。
//
// 结论：**不要跟构建机的行尾设置搏斗**，也不要假设 CR 只有一种形态：
// 在把模板装进 vsix 之前，自己把**任何** CR 形态归一成 LF，并**每次把统计打出来**
// （下次再出问题，日志里直接有"是什么形态"的答案，而不是再猜一轮）。
//
// 形态：CRLF（`\r\n`，DOS）、LFCR（`\n\r`，反向）、单独 CR（`\r`，老 Mac 终止符）。
// 含 NUL 字节的一律当二进制跳过（PNG/JPG/TTF/PDF 都在此列）。幂等。
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 扫一遍 `root` 下的文本文件，找出所有带 CR 的（**只读**，用于门禁断言）。
 * @param {string} root
 * @returns {{ found: string[], stats: { files: number, binary: number, crlf: number, lfcr: number, loneCr: number }, sample?: Buffer }}
 */
export function scanCr(root) {
  return scan(root, false);
}

/**
 * 就地归一 `root` 下所有文本文件的行尾为 LF（幂等）。
 * @param {string} root
 * @returns {{ changed: string[], stats: { files: number, binary: number, crlf: number, lfcr: number, loneCr: number } }}
 */
export function normalizeLfInPlace(root) {
  const r = scan(root, true);
  return { changed: r.found, stats: r.stats };
}

/**
 * @param {string} root
 * @param {boolean} fix 是否就地改写
 */
function scan(root, fix) {
  /** @type {string[]} */
  const found = [];
  const stats = { files: 0, binary: 0, crlf: 0, lfcr: 0, loneCr: 0 };
  /** @type {Buffer | undefined} */
  let sample;
  /** @param {string} dir @param {string} rel */
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, r);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      stats.files += 1;
      const buf = readFileSync(abs);
      if (buf.includes(0)) {
        stats.binary += 1; // 二进制：一概不碰
        continue;
      }
      const text = buf.toString('utf8');
      const crlf = (text.match(/\r\n/gu) ?? []).length;
      const lfcr = (text.match(/\n\r/gu) ?? []).length;
      const crs = (text.match(/\r/gu) ?? []).length;
      const loneCr = crs - crlf - lfcr;
      if (crlf > 0) {
        stats.crlf += 1;
      }
      if (lfcr > 0) {
        stats.lfcr += 1;
      }
      if (loneCr > 0) {
        stats.loneCr += 1;
      }
      if (crs === 0) {
        continue; // 本来就干净
      }
      const lf = Buffer.from(text.replace(/\r\n/gu, '\n').replace(/\n\r/gu, '\n').replace(/\r/gu, '\n'), 'utf8');
      if (lf.equals(buf)) {
        continue; // 有 CR 但形态不必改（不会发生，留作保险）
      }
      sample = sample ?? buf.subarray(0, 48);
      found.push(r);
      if (fix) {
        writeFileSync(abs, lf);
      }
    }
  };
  walk(root, '');
  return { found, stats, sample };
}
