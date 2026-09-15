import * as assert from 'node:assert';
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
});
