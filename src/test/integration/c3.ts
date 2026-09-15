/**
 * C3 end-to-end check (development-plan Checkpoint C3).
 *
 * Runs inside the extension host against a real fcpp working copy that also
 * carries the template's `.github` (gates configs, prepared by run-c3.mjs).
 * Demonstrates, with NO command-line from the user:
 *   1. All Phase-3 panels open (docs / quality / commit / release / preflight).
 *   2. Quality gate: deliberately unformatted file → clang-format red → fix → green
 *      (same args & parsers the G-11 panel uses).
 *   3. Commit assistant core: canonical dual-channel message passes commitlint and
 *      produces a real, conforming git commit in the fixture.
 *
 * Run with:  npm run test:c3
 */
import * as assert from 'node:assert';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { run as execRun, which } from '../../utils/exec';
import {
  clangFormatCheckArgs,
  clangFormatFixArgs,
  parseClangFormatOutput,
  lintCommitHeader,
  collectHeaders,
} from '../../core/qualityGates';
import { composeHeader } from '../../core/commitAssistant';

import { EXTENSION_ID } from '../hostExtension';
const PANELS = [
  'het.docs',
  'het.quality',
  'het.commit',
  'het.release',
  'het.preflight',
  'het.dashboard',
  'het.openSettings',
  'het.coverage',
  'het.openDeps',
  'het.newModule',
  'het.generateTests',
];

export async function run(): Promise<void> {
  console.log('[c3] starting');
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(ext, 'extension must be discovered');
  await ext.activate();
  await vscode.commands.executeCommand('het.refresh');

  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  assert.ok(root.length > 0, 'workspace folder must be the c3 fixture');

  // ---- 1. Phase-3 panels open without throwing ----
  for (const cmd of PANELS) {
    await vscode.commands.executeCommand(cmd);
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log('[c3] Phase-3 panels opened without throwing');

  // ---- 2. quality gate: red → fix → green (same code path as G-11) ----
  const fmt = await which('clang-format');
  assert.ok(fmt, 'clang-format must be on PATH');
  console.log('[c3] clang-format = ' + fmt);
  const probe = join(root, 'include', 'zz_fmtprobe.h');
  writeFileSync(probe, '#pragma once\nvoid zz_fmtprobe_init(void){int x=0;(void)x;}\n', 'utf8');
  try {
    const dry = await execRun(fmt, clangFormatCheckArgs(probe, 'c'), { cwd: root });
    const red = parseClangFormatOutput(`${dry.stdout}\n${dry.stderr}`);
    console.log(`[c3] dry code=${dry.code} violations=${red.length}`);
    assert.ok(dry.code !== 0 || red.length > 0, 'misformatted file must fail the dry-run');
    let fix = await execRun(fmt, clangFormatFixArgs(probe, 'c'), { cwd: root });
    if (fix.code !== 0) {
      // transient retry (e.g. file watcher/AV contention in the host window)
      console.log(`[c3] fix attempt1 code=${fix.code} raw=${JSON.stringify((fix.stdout + fix.stderr).slice(0, 300))}`);
      await new Promise((r) => setTimeout(r, 600));
      fix = await execRun(fmt, clangFormatFixArgs(probe, 'c'), { cwd: root });
    }
    console.log(`[c3] fix code=${fix.code} raw=${JSON.stringify((fix.stdout + fix.stderr).slice(0, 300))}`);
    assert.strictEqual(fix.code, 0, `clang-format -i must succeed: ${fix.stdout}${fix.stderr}`);
    const re = await execRun(fmt, clangFormatCheckArgs(probe, 'c'), { cwd: root });
    const recheck = parseClangFormatOutput(`${re.stdout}\n${re.stderr}`);
    assert.strictEqual(re.code, 0, 'fixed file must pass the dry-run');
    assert.strictEqual(recheck.length, 0, 'no violations after fix');
    console.log('[c3] quality gate: red → fix → green OK');
  } finally {
    rmSync(probe, { force: true });
  }

  // ---- 3. commit assistant core: canonical message + real conforming commit ----
  const message = composeHeader('test', ':beer:', false, 'c3 demo vector cases');
  const lint = lintCommitHeader(message);
  assert.deepStrictEqual(lint.errors, [], 'composed header must pass commitlint');
  const git = await which('git');
  assert.ok(git, 'git must be on PATH');
  writeFileSync(join(root, 'include', 'zz_c3_demo.cpp.txt'), 'placeholder\n', 'utf8'); // not compiled: .txt
  const rel = 'include/zz_c3_demo.cpp.txt';
  const add = await execRun(git, ['-C', root, 'add', '--', rel]);
  assert.strictEqual(add.code, 0, 'git add must succeed');
  const c = await execRun(git, ['-C', root, 'commit', '-m', message]);
  assert.strictEqual(c.code, 0, `git commit must succeed: ${c.stdout}\n${c.stderr}`);
  const log = await execRun(git, ['-C', root, 'log', '--format=%s', '-n', '3']);
  const headers = collectHeaders(log.stdout);
  assert.ok(headers.includes(message), 'the conforming commit must be in the log');
  const allConform = headers.every((h) => lintCommitHeader(h).ok);
  assert.strictEqual(allConform, true, 'every recent header must pass commitlint');
  console.log(`[c3] commit assistant: "${message}" conforms and committed`);

  // ---- evidence ----
  const evidence = `panels=${PANELS.length} formatRedToGreen=true commitlintPass=true header=${message}\n`;
  writeFileSync(join(__dirname, '..', 'c3-evidence.txt'), evidence, 'utf8');
  console.log('[c3] PASS ' + evidence.trim());
  console.log('[c3] OK - docs/quality/commit/release/preflight panels + gates verified through the extension host');

  const holdMs = Number(process.env.HET_C3_HOLD_MS ?? 0);
  if (holdMs > 0) {
    console.log(`[c3] holding ${Math.round(holdMs / 1000)}s so you can watch the window…`);
    await new Promise((resolve) => setTimeout(resolve, holdMs));
    console.log('[c3] auto-exit now');
  }
}
