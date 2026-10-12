/**
 * **宿主自证**（集成测试共用）：本次运行到底跑在什么上下文里。
 *
 * 背景（用户实测反馈）：开发用的"本机"其实是一台 **被 Remote-SSH 连进来的服务器**，
 * 用户的 VS Code 客户端是通过 SSH 访问它的。所以集成测试的结论必须**自带上下文**，
 * 不能用"我说是本地就是本地"来交差。每条结论都要能回答：
 *   · 跑在什么宿主上（版本 / 桌面还是 web / 是不是远端扩展宿主）；
 *   · 被测扩展来自哪里（我们这份开发目录，还是市场装的那份）；
 *   · 工作区是哪个夹具。
 *
 * 同时：**证据必须落盘**。VS Code CLI 会忽略它不认识的参数并以 0 退出 —— 只看退出码
 * 会把"用例根本没跑"当成通过。驱动脚本因此校验证据文件是否存在、内容是否自洽。
 */
import * as assert from 'node:assert';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';

import { EXTENSION_ID } from '../../hostExtension';

/** 宿主环境快照（键名直接写进证据文件，前缀 `host.`）。 */
export function hostProvenance(): Record<string, string> {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  return {
    vscode: vscode.version,
    appName: vscode.env.appName,
    appHost: vscode.env.appHost,
    uiKind: vscode.env.uiKind === vscode.UIKind.Desktop ? 'Desktop' : 'Web',
    remoteName: vscode.env.remoteName ?? '(none)',
    machineId: vscode.env.machineId.slice(0, 8),
    extensionPath: ext?.extensionPath ?? '(missing)',
    workspace: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath).join(',') || '(none)',
  };
}

export interface HostExpectation {
  /** 用例名（`c6` / `c8`），只用于报错信息。 */
  tag: string;
  /**
   * 工作区路径必须命中的片段之一（夹具目录名）。
   * 允许传多个：有的用例会分阶段换工作区（c6：空目录 → mini-fcpp）。
   */
  workspaceContains: readonly string[];
}

/**
 * 宿主自证的硬断言：不成立就**不该拿这次结论去交差**（宁可红，也不要一条"不知道跑在哪"的绿）。
 */
export function assertHostIsTrustworthy(expect: HostExpectation): Record<string, string> {
  const p = hostProvenance();
  assert.strictEqual(
    p.remoteName,
    '(none)',
    `[${expect.tag}] 本次跑在远端宿主上（remoteName=${p.remoteName}）—— 结论不能代表本地桌面行为`,
  );
  assert.strictEqual(p.uiKind, 'Desktop', `[${expect.tag}] 集成测试必须在桌面宿主里跑（web 宿主的页签/命令语义不同）`);
  assert.match(p.appHost, /desktop|electron/u, `[${expect.tag}] 意外的 appHost：${p.appHost}`);
  assert.ok(p.extensionPath !== '(missing)', `[${expect.tag}] 被测扩展必须被加载`);
  assert.ok(
    p.extensionPath.includes('HeT-DevTools'),
    `[${expect.tag}] 被测扩展不是我们这份开发目录：${p.extensionPath}（可能是市场装的那份）`,
  );
  assert.ok(
    expect.workspaceContains.some((part) => p.workspace.includes(part)),
    `[${expect.tag}] 工作区不是预期夹具（${expect.workspaceContains.join(' | ')}）：${p.workspace}`,
  );
  return p;
}

/** 自证打印（让 CI 日志自己说明"跑在哪"）。 */
export function logProvenance(tag: string, p: Record<string, string>): void {
  console.log(`[${tag}] 宿主自证：VS Code ${p.vscode} · ${p.appHost} · uiKind=${p.uiKind} · remote=${p.remoteName}`);
  console.log(`[${tag}] 被测扩展：${p.extensionPath}`);
  console.log(`[${tag}] 工作区：${p.workspace}`);
}

/**
 * 证据落盘（`out/<name>-evidence.txt`）：驱动脚本据此判定"用例真的跑过"，
 * 并把宿主上下文一并记下来（含 `host.vscode=` 供驱动回验版本）。
 */
export function writeEvidence(name: string, lines: readonly string[], provenance: Record<string, string>): void {
  writeFileSync(
    join(__dirname, '..', name + '-evidence.txt'),
    [...lines, `end=${new Date().toISOString()}`, ...Object.entries(provenance).map(([k, v]) => `host.${k}=${v}`)].join(
      '\n',
    ) + '\n',
    'utf8',
  );
}
