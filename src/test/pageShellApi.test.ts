import * as assert from 'node:assert';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { apiCalls, stripComments } from './support/htmlFacts';

export { apiCalls, stripComments };

/**
 * F.29 的**类级**门禁：`acquireVsCodeApi()` 只允许出现在 `features/ui.ts` 的 `pageShell` 里。
 *
 * 一个文档里只能取一次 VS Code API，第二次会抛错并把那段 script 里后面的代码全部带走。
 * 这些面板全都用 `pageShell` 生成整页 HTML —— 如果它们各自再取一次，就是在赌"谁先跑":
 * 只要哪天有个片段 HTML 自带脚本、或者脚本顺序一变，页面按钮就会整批失效（质量面板那次）。
 * 规则很简单：**面板只发消息**（用 pageShell 提供的全局 `send()`），不碰 API。
 *
 * 例外只有一处：驾驶舱（cockpit）自建完整文档，不经过 pageShell（它自己内置唯一脚本）。
 * 所以列成白名单单独断言"恰好一次"。
 */
/**
 * 数"真的调用了"几次 —— 注释里提到 `acquireVsCodeApi()` 不算（我们特意在注释里
 * 写下了这条不变式）。实现在 `./support/htmlFacts`（先剥注释再数）。
 */

describe('webview 取 API 的纪律（F.29）', () => {
  const read = (rel: string): string => readFileSync(join('src', rel), 'utf8');

  const panelFiles = readdirSync('src/features', { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => `features/${d.name}/panel.ts`)
    .filter((rel) => {
      try {
        return read(rel).length > 0;
      } catch {
        return false;
      }
    });

  it('所有 panel.ts 都不许自己取 API（走 pageShell 的 send()）', () => {
    assert.ok(panelFiles.length >= 10, `应当扫到全部面板，实际 ${panelFiles.length} 个`);
    for (const rel of panelFiles) {
      const src = read(rel);
      assert.strictEqual(
        apiCalls(src),
        0,
        `${rel} 不能再取 API：pageShell 已经取过，第二次会抛错（改用 send()）`,
      );
      assert.ok(
        !src.includes('vscode.postMessage('),
        `${rel} 的页面脚本必须用 send()，不要直接用 vscode.postMessage()`,
      );
    }
  });

  it('pageShell 是唯一取 API 的地方，并暴露 send()', () => {
    const ui = read('features/ui.ts');
    assert.strictEqual(apiCalls(ui), 1, 'ui.ts 里恰好调用一次');
    assert.ok(/function send\(msg\)\s*\{[^}]*vscode\.postMessage\(msg\)/.test(ui), 'pageShell 暴露 send(msg)');
  });

  it('旧 cockpit 渲染器已归档（src 里不再有自建文档的 webview）', () => {
    assert.ok(
      !existsSync(join('src', 'features', 'cockpit', 'webview', 'render.ts')),
      '旧渲染器已移入 _archive/，不该还在 src 里',
    );
    const shell = read('features/cockpit/singlepage/shell.ts');
    assert.strictEqual(apiCalls(shell), 0, '单页壳交给 pageShell 取 API（自己不许取）');
    assert.ok(shell.includes('pageShell('), '整页走 pageShell');
  });
});
