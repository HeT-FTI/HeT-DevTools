import * as assert from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep, win32 } from 'node:path';
import { baseName, dirName, normalizeSlashes, splitPath } from '../utils/paths';

/**
 * §F.46：**跨平台路径**（CI 上真的翻过车）。
 *
 * 事故回顾：`'C:\\…\\test\\unit\\main.cpp'.split('/')` 在 Windows 上返回整个字符串
 * （没有 `/` 可切），于是"取文件名"的断言只在 Windows 上红 —— Linux/macOS 全绿。
 * 规矩：路径 → 名字/比较一律走 `utils/paths`，并且**用 Windows 形状的字符串单测它**
 * （不必真在 Windows 上跑）。
 */
const WIN = win32.join('C:', 'Users', 'runner', 'AppData', 'Local', 'Temp', 'het', 'test', 'unit', 'main.cpp');
const POSIX = '/home/runner/work/het/test/unit/main.cpp';

const read = (p: string): string => readFileSync(p, 'utf8');
const ALL_TS: string[] = [];
(function walk(dir: string): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walk(p);
    } else if (name.endsWith('.ts')) {
      ALL_TS.push(p);
    }
  }
})(join('src'));

describe('§F.46 跨平台路径助手（Windows 形状也要对）', () => {
  it('baseName：两种分隔符都能取到文件名', () => {
    assert.strictEqual(baseName(WIN), 'main.cpp');
    assert.strictEqual(baseName(POSIX), 'main.cpp');
    assert.strictEqual(baseName('main.cpp'), 'main.cpp');
    assert.strictEqual(baseName('C:\\a\\b\\'), 'b', '尾部分隔符不算名字');
    assert.strictEqual(baseName(''), '');
  });

  it('splitPath / dirName / normalizeSlashes：形状稳定，连续分隔符不产生空段', () => {
    assert.deepStrictEqual(splitPath('C:\\\\a//b\\\\c'), ['C:', 'a', 'b', 'c']);
    assert.strictEqual(dirName(WIN), 'C:/Users/runner/AppData/Local/Temp/het/test/unit');
    assert.strictEqual(dirName('main.cpp'), '');
    assert.strictEqual(normalizeSlashes(WIN), WIN.replace(/\\/gu, '/'));
    assert.strictEqual(normalizeSlashes(POSIX), POSIX);
  });

  it('"两边都归一"才对得上：不归一就只在 Windows 红（事故的最小复现）', () => {
    const root = win32.join('C:', 'tmp', 'het-inject');
    const file = win32.join(root, 'test', 'unit', 'ucov_a.cpp');
    // 错的写法（Linux 绿、Windows 红）
    assert.notDeepStrictEqual(file.split('/').pop(), 'ucov_a.cpp');
    // 对的写法：同一套归一函数
    const rel = normalizeSlashes(file).slice(normalizeSlashes(root).length);
    assert.strictEqual(rel, '/test/unit/ucov_a.cpp');
    assert.strictEqual(baseName(rel), 'ucov_a.cpp');
  });

  it('门禁：源码里不许再出现 split(\'/\')（唯一豁免是 tar 条目名 —— 协议规定用 /）', () => {
    // 两处**必须**保留这个写法，各自有理由：
    //   · templateTarball：tar 条目名按规范就是 `/`（不是文件系统路径）；
    //   · 本文件：上面那条"事故最小复现"要真的把错写法跑一遍，否则这条门禁自己也会骗人。
    const allowed = new Set([join('src', 'core', 'templateTarball.ts'), join('src', 'test', 'paths.test.ts')]);
    const bad: string[] = [];
    for (const f of ALL_TS) {
      if (allowed.has(f)) {
        continue;
      }
      const text = read(f)
        .replace(/\/\*[\s\S]*?\*\//gu, '')
        .replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
      if (/\.split\(\s*'\/'\s*\)/u.test(text)) {
        bad.push(f);
      }
    }
    assert.deepStrictEqual(
      bad,
      [],
      `这些文件在用 split('/') 切路径（Windows 上会静默拿到整串）：\n${bad.join('\n')}\n→ 改用 utils/paths 的 baseName/normalizeSlashes`,
    );
    // 豁免名单必须"自我清理"：名单里的每个文件都得真的还在用这个写法（用完就该删）
    for (const f of allowed) {
      assert.ok(read(f).includes("split('/')"), `${f} 已经不用 split('/') 了 —— 请把它从豁免名单删掉`);
    }
  });

  it('门禁：路径 → 名字的地方用的是 baseName（不许 node:path 的 basename 或手写切分）', () => {
    const users = ALL_TS.filter((f) => !f.includes(`${sep}test${sep}`) && read(f).includes('baseName('));
    assert.ok(users.includes(join('src', 'core', 'injectedFiles.ts')), '注入文件清理要走 baseName');
    // `basename`（node:path）是平台相关的：Linux 上跑 basename('C:\\a\\b') 拿不到 b，别用它处理
    // 「可能是另一种分隔符」的输入。
    for (const f of ALL_TS) {
      if (f.includes(`${sep}test${sep}`)) {
        continue;
      }
      assert.ok(
        !/\bbasename\(/u.test(read(f)) || read(f).includes('node:path'),
        `${f} 用了平台相关的 basename —— 跨平台输入请用 utils/paths`,
      );
    }
  });
});
