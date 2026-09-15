// 行尾归一：**产物生成阶段**把文本文件钉死成 LF。
//
// 为什么不让 git 去管（`.gitattributes` + `core.autocrlf=false` 都已试过）：
// 2026-09-15 实测 —— 同一个提交在 ubuntu/macos 上打出的 vsix 里，内置模板是 LF，
// 而 windows 那份 155/158 个文件是 CRLF（`core.autocrlf=true` 的检出后果），
// 于是"同一个交付物"在不同机器上不一致，而 Windows 的检出配置又是我们控制不了的
// （每个人的机器、每个 runner 镜像都可能不同）。
//
// 结论：**不要跟构建机的环境配置搏斗** —— 在把模板装进 vsix 之前，自己保证它是 LF。
// 这里只处理"看起来是文本"的文件（含 NUL 字节的一律当二进制跳过，PNG/JPG/TTF/PDF 都在此列），
// 只把 `\r\n` 换成 `\n`，不动单独的 `\r`，幂等。
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 就地归一 `root` 下所有文本文件的行尾为 LF。
 * @param {string} root
 * @returns {string[]} 被改动的文件（相对 `root` 的路径），空数组 = 本来就干净
 */
export function normalizeLfInPlace(root) {
  /** @type {string[]} */
  const changed = [];
  /** @param {string} dir @param {string} rel */
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, r);
      } else if (entry.isFile()) {
        const buf = readFileSync(abs);
        if (buf.includes(0)) {
          continue; // 二进制（PNG/JPG/TTF/PDF…）：一概不碰
        }
        if (!buf.includes(13)) {
          continue; // 没有 CR：本来就干净
        }
        const lf = Buffer.from(buf.toString('utf8').replace(/\r\n/gu, '\n'), 'utf8');
        if (!lf.equals(buf)) {
          writeFileSync(abs, lf);
          changed.push(r);
        }
      }
    }
  };
  walk(root, '');
  return changed;
}
