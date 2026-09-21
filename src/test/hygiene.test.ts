/**
 * **产物卫生门禁**（F 块 P0 + C5：插件不许在用户工程里留东西）。
 *
 * 两条都是实测反馈的直接产物：
 *   1. **环境诊断会落进工程根目录** —— 于是 `git status` 里冒出插件产物，用户以为是自己
 *      的改动（"建个新工程就带脏东西"）。诊断属于**扩展自己的数据**，只能进 `globalStorage`；
 *   2. **生成的 `conanfile.py` 里出现过 NUL 字节** —— 文本文件里混进 `\x00` 会让编辑器/
 *      编译器/CI 都给出莫名其妙的报错，而根因藏在字节层，查起来极慢。模板资产是唯一来源，
 *      所以门禁直接扫它（任何文本文件带 NUL 就红）。
 */
import * as assert from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walk(p, out);
    } else {
      out.push(p);
    }
  }
  return out;
}

const TEXT_EXT = new Set([
  '.py', '.txt', '.md', '.yml', '.yaml', '.json', '.cmake', '.cpp', '.hpp', '.h',
  '.c', '.cc', '.in', '.sh', '.bat', '.ps1', '.toml', '.cfg', '.rst', '.puml',
  '.xml', '.conf', '.feature',
]);
const TEXT_NAME = new Set([
  'CMakeLists.txt', 'Makefile', 'Dockerfile', 'LICENSE', 'NOTICE', '.gitattributes',
  '.gitignore', '.clang-format', '.clang-tidy', '.editorconfig',
]);

function isTextLike(file: string): boolean {
  const base = file.split(/[\\/]/u).pop() ?? '';
  return TEXT_EXT.has(base.slice(base.lastIndexOf('.'))) || TEXT_NAME.has(base);
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
}

describe('F/C5 产物卫生：诊断不落工程 + 模板文本无 NUL', () => {
  it('环境诊断写到扩展存储，不写进用户工程（写盘点附近不许出现 workspaceFolders）', () => {
    const src = stripComments(readFileSync('src/extension.ts', 'utf8'));
    const at = src.indexOf('dumpFileName()');
    assert.ok(at > 0, '找不到 dump 落盘处 —— 门禁自身失效');
    const around = src.slice(Math.max(0, at - 400), at + 200);
    assert.ok(!/workspaceFolders/u.test(around), '诊断文件不许写到工作区根目录（会在用户工程里留产物）');
    assert.ok(/globalStorageUri/u.test(around), '诊断要写到扩展自己的 globalStorage');
  });

  it('模板资产的文本文件里没有 NUL 字节（G8：新建工程不该出现 NUL 文件）', () => {
    const files = walk('assets/template').filter(isTextLike);
    assert.ok(files.length >= 100, `扫到的模板文本文件太少（${files.length}）→ 门禁自身失效`);
    const bad = files.filter((f) => readFileSync(f).includes(0));
    assert.deepStrictEqual(
      bad.map((f) => f.split(/[\\/]/u).join('/')),
      [],
      '这些模板文本文件含 NUL —— 会被原样写进用户工程',
    );
  });

  it('二进制图片不算违规（门禁要有分寸：只扫文本）', () => {
    const binary = walk('assets/template').filter(
      (f) => !isTextLike(f) && readFileSync(f).includes(0),
    );
    assert.ok(binary.length >= 1, '模板里本来就有图片（它们带 NUL 是正常的）');
  });
});
