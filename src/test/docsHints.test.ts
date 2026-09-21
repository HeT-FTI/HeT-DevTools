import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './support/htmlFacts';
import { docsFailureHint } from '../core/docsHints';

describe('docs failure hints', () => {
  it('explains a missing python dependency with the exact pip command', () => {
    const hint = docsFailureHint({
      tail: "File \"docs/build.py\", line 3, in <module>\n    import numpy as np\nModuleNotFoundError: No module named 'numpy'",
      python: '/tmp/het-conan/bin/python',
      platform: 'linux',
    });
    assert.ok(hint, 'hint expected');
    assert.match(hint!, /缺 Python 依赖：numpy/u);
    assert.match(hint!, /\/tmp\/het-conan\/bin\/python -m pip install numpy sphinx sphinx-intl sphinx-rtd-theme/u);
    assert.match(hint!, /toolchain": "managed/u, 'must offer the managed-lane way out');
  });

  it('names every missing module it recognises', () => {
    const hint = docsFailureHint({
      tail: 'ModuleNotFoundError: No module named "sphinx"\nNo module named sphinx_rtd_theme',
      python: 'python3',
    });
    assert.match(hint!, /sphinx-rtd-theme/u);
    assert.match(hint!, /sphinx/u);
  });

  it('switches to brew wording on macOS for system tools', () => {
    const hint = docsFailureHint({ tail: 'FileNotFoundError: [Errno 2] doxygen', python: 'python3', platform: 'darwin' });
    assert.ok(hint, 'hint expected');
    assert.match(hint!, /brew install doxygen/u);
  });

  it('uses apt wording elsewhere', () => {
    const hint = docsFailureHint({ tail: 'doxygen: not found\ndot: not found', python: 'python3', platform: 'linux' });
    assert.match(hint!, /sudo apt-get install -y doxygen graphviz/u);
  });

  it('speaks Windows on Windows: winget/choco, NEVER sudo apt', () => {
    const hint = docsFailureHint({
      tail: "doxygen: is not recognized as an internal or external command",
      python: 'D:\\a\\_temp\\het-conan\\Scripts\\python',
      platform: 'win32',
    });
    assert.ok(hint, 'hint expected');
    assert.match(hint!, /winget install Doxygen\.Doxygen/u, 'winget is what a Windows user recognises');
    assert.match(hint!, /choco install -y doxygen\.install/u, 'choco fallback for windows');
    assert.doesNotMatch(hint!, /sudo apt-get/u, 'never tell a Windows user to run apt');
  });

  it('stays silent for unrelated failures (caller keeps the generic message)', () => {
    assert.strictEqual(docsFailureHint({ tail: 'WARNING: document isn\'t included in any toctree', python: 'python3' }), undefined);
    assert.strictEqual(docsFailureHint({ tail: '', python: null }), undefined);
  });

  it('回溯里出现过 doxygen 不等于「缺 doxygen」（实测过的误判）', () => {
    // 真实 CI 尾巴：模板 v0.1.2 的 docs/build.py 在 Windows 上因路径分隔符误判（见 run 35480007485）。
    // 回溯里有 `self.doxygen_automation()` —— 以前的实现会因此报「缺系统工具：doxygen」，
    // 把真原因盖掉，让用户去装一个已经装好的工具。
    const tail = [
      '[docs] python docs/build.py',
      'Traceback (most recent call last):',
      '  File "docs/build.py", line 358, in __init__',
      '    self.doxygen_automation()',
      '  File "docs/build.py", line 362, in doxygen_automation',
      '    self._validate_doc_sources()',
      'RuntimeError: documentation completeness check failed:',
      '  - dox/demos\\tutorial.dox: the tutorial belongs in demos/',
    ].join('\n');
    assert.strictEqual(
      docsFailureHint({ tail, python: 'D:\\a\\_temp\\het-conan\\Scripts\\python', platform: 'win32' }),
      undefined,
      '没有「没找到」的信号时不许说缺工具 —— 真原因要留给通用话术（带 tail）',
    );
    // 光有函数名、没有信号同样不许报
    assert.strictEqual(docsFailureHint({ tail: 'in doxygen_automation()', python: 'python3' }), undefined);
  });

  it('真有信号时照旧报工具缺失（别为了修误判把真话也修没了）', () => {
    assert.match(
      docsFailureHint({ tail: 'doxygen: command not found', python: 'python3', platform: 'linux' })!,
      /缺系统工具：doxygen/u,
    );
    assert.match(
      docsFailureHint({ tail: 'FileNotFoundError: [WinError 2] dot', python: 'python3', platform: 'win32' })!,
      /缺系统工具：graphviz/u,
    );
  });
});

describe('文档前置探测与执行同源（F.34）', () => {
  const read = (p: string): string => readFileSync(join('src', p), 'utf8');

  it('不许再有"只认 python 不认 python3"的探测（Ubuntu 默认没有 python 命令）', () => {
    // 先剥注释：`// … which('python') …` 这种说明文字会自伤（F.29 的教训）
    const ext = stripComments(read('extension.ts'));
    const bad = [...ext.matchAll(/which\('python'\)/gu)].length;
    assert.strictEqual(
      bad,
      0,
      "探测/执行都要用 `findPython()`（它按平台试 python3/python/py）—— " +
        '否则 Ubuntu/Mint 上会出现"系统里有 python 却报 ✗"（2026-09-20 同事实测）',
    );
    assert.ok(ext.includes('findPython('), 'docs 探测与执行都要走 findPython()');
  });

  it('findPython 的候选顺序按平台区分（Windows 有 py 启动器，POSIX 上 python3 优先）', () => {
    const src = read('utils/exec.ts');
    assert.match(src, /'python', 'python3', 'py'/u, 'Windows：python → python3 → py');
    assert.match(src, /'python3', 'python'/u, 'POSIX：python3 → python');
  });
});
