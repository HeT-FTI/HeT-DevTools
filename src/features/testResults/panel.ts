import * as vscode from 'vscode';
import { GTestRunSummary, GTestResult } from '../../core/gtestRunner';
import { esc, pageShell } from '../ui';
import { showDetailPanel } from '../detail/host';

export interface TestResultsPanelDeps {
  runTests: () => void;
  openFile: (file: string, line: number) => void;
}

export function showTestResultsPanel(
  context: vscode.ExtensionContext,
  summary: GTestRunSummary,
  deps: TestResultsPanelDeps,
): vscode.WebviewPanel {
  // §D：细节面板共用一个页签（切视图换内容）——实现原样搬进来，只把"谁来持有面板"交给 host。
  return showDetailPanel(context, { id: 'testResults', title: 'HeT DevTools — 测试结果' }, (panel) => {
    panel.webview.html = buildHtml(summary);

    const sub = panel.webview.onDidReceiveMessage((message: { type: string; command?: string; file?: string; line?: number }) => {
      if (message.type === 'command' && message.command === 'het.test') {
        deps.runTests();
      } else if (message.type === 'openfile' && message.file && typeof message.line === 'number') {
        deps.openFile(message.file, message.line);
      }
    });

    return sub;
  });
}

function statusIcon(status: GTestResult['status']): string {
  if (status === 'passed') {
    return '<span class="ok">✔</span>';
  }
  return status === 'failed' ? '<span class="fail">✖</span>' : '<span class="warn">–</span>';
}

function resultRow(t: GTestResult): string {
  const failure =
    t.status === 'failed'
      ? `<div class="detail">${esc(t.failureMessage ?? '测试失败')}</div>
         ${t.failureFile ? `<div class="suggest">@ ${esc(t.failureFile)}:${t.failureLine}</div>` : ''}
         ${t.failureFile ? `<button onclick="open('${esc(t.failureFile)}', ${t.failureLine ?? 1})">定位到失败源码</button>` : ''}`
      : '';
  return `<div class="row">${statusIcon(t.status)} <span class="title">${esc(t.suite)}.${esc(t.name)}</span>
    ${typeof t.durationMs === 'number' ? `<span class="tag">${t.durationMs} ms</span>` : ''}</div>${failure}`;
}

function buildHtml(summary: GTestRunSummary): string {
  if (summary.empty) {
    return pageShell(
      'HeT DevTools — 测试结果',
      `<h1>测试结果</h1>
       <div class="card">未捕获到 GTest 用例输出。可能原因：
         <ul><li>metadata.json 中 <code>trigger_tests</code> 为 false</li>
         <li>test_package/test/unit 下尚无测试</li>
         <li>构建/测试未实际执行（构建失败）</li></ul>
         <button onclick="post('het.test')">▶ 重新构建并测试</button>
       </div>`,
    );
  }

  const bySuite = new Map<string, GTestResult[]>();
  for (const t of summary.tests) {
    const list = bySuite.get(t.suite) ?? [];
    list.push(t);
    bySuite.set(t.suite, list);
  }

  const suiteHtml = [...bySuite.entries()]
    .map(
      ([suite, tests]) => `
    <h2>${esc(suite)} <span class="tag">${tests.length} 用例</span></h2>
    <div class="card">${tests.map(resultRow).join('')}</div>`,
    )
    .join('');

  return pageShell(
    'HeT DevTools — 测试结果',
    `<h1>测试结果</h1>
     <div class="card">
       <span class="ok">✔ 通过 ${summary.passed}</span> &nbsp;
       <span class="fail">✖ 失败 ${summary.failed}</span> &nbsp;
       <span class="warn">– 跳过 ${summary.skipped}</span>
       <span style="margin-left:auto"></span>
       <button onclick="post('het.test')">▶ 重新构建并测试</button>
     </div>
     ${suiteHtml}
     <script>
       function post(cmd) { send({ type: 'command', command: cmd }); }
       function open(file, line) { send({ type: 'openfile', file: file, line: line }); }
     </script>`,
  );
}

