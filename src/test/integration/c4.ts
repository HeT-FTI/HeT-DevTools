/**
 * C4 end-to-end check (development-plan Checkpoint C4).
 *
 * Two-phase, fully offline:
 *   Phase "init"  — empty workspace → `het.newProjectDirect` bootstraps a real
 *                   project from a local template copy (HET_TEMPLATE_LOCAL).
 *   Phase "check" — the new project workspace → template update check (after
 *                   the runner advanced the local template) → full audit →
 *                   Phase-4 panels smoke (benchmark / CI / docs / quality).
 *
 * Run with:  npm run test:c4
 */
import * as assert from 'node:assert';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';

import { EXTENSION_ID } from '../hostExtension';
const phase = process.env.HET_C4_PHASE ?? 'init';
const NEW_PROJECT = process.env.HET_C4_DEST ?? '';
const TPL = process.env.HET_TEMPLATE_LOCAL ?? '';

export async function run(): Promise<void> {
  console.log(`[c4] phase=${phase} starting`);
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(ext, 'extension must be discovered');
  await ext.activate();

  if (phase === 'init') {
    assert.ok(NEW_PROJECT.length > 0 && TPL.length > 0, 'env must point at dest + local template');
    const r = (await vscode.commands.executeCommand('het.newProjectDirect', {
      name: 'mylib2',
      description: 'C4 demo library from template',
      dest: NEW_PROJECT,
      gitAuthor: { name: 'C4 Init', email: 'c4@example.invalid' },
      confirmed: true,
    })) as { ok: boolean; message: string; root?: string };
    console.log('[c4] init result: ' + r.message);
    assert.strictEqual(r.ok, true, 'template init must succeed');
    assert.strictEqual(r.root, NEW_PROJECT);
    assert.ok(existsSync(join(NEW_PROJECT, 'metadata.json')), 'metadata.json must exist');
    assert.ok(existsSync(join(NEW_PROJECT, '.het', 'template-ref.json')), 'template marker must exist');
    assert.ok(existsSync(join(NEW_PROJECT, '.github', 'workflows')), 'template .github must be copied');
    assert.ok(existsSync(join(NEW_PROJECT, 'benchmark', 'platform', 'bench_config.json')), 'benchmark assets copied');
    const marker = JSON.parse(readFileSync(join(NEW_PROJECT, '.het', 'template-ref.json'), 'utf8'));
    assert.ok(marker.repo && marker.ref && marker.label, 'marker must carry repo/ref/label');
    const meta = JSON.parse(readFileSync(join(NEW_PROJECT, 'metadata.json'), 'utf8'));
    assert.strictEqual(meta.name, 'mylib2');
    console.log('[c4] init OK — project bootstrapped (locked local template ref ' + marker.ref.slice(0, 12) + ')');
    // evidence for the init phase
    writeFileSync(join(NEW_PROJECT, '.het', 'c4-init-evidence.txt'), `initOk=true name=${meta.name}\n`, 'utf8');
    return;
  }

  // ---- phase "check": run against the freshly-initialized project ----
  assert.ok(NEW_PROJECT.length > 0 && TPL.length > 0, 'env must be set');
  const name = await vscode.commands.executeCommand<string | null>('het.getCurrentProject');
  assert.strictEqual(name, 'mylib2', 'workspace must be the new project');

  // 1) template update check → plan file (template advanced by the runner)
  const markerTxt = readFileSync(join(NEW_PROJECT, '.het', 'template-ref.json'), 'utf8');
  const markerJson = JSON.parse(markerTxt) as { ref: string };
  const { execFileSync } = await import('node:child_process');
  let tplHead = '';
  try {
    tplHead = execFileSync('git', ['-C', TPL, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    /* ignore */
  }
  console.log(`[c4] marker.ref=${markerJson.ref.slice(0, 12)} tpl.head=${tplHead.slice(0, 12)}`);
  await vscode.commands.executeCommand('het.templateUpdate');
  const planFile = join(NEW_PROJECT, 'workspace', 'template-sync-plan.md');
  console.log('[c4] plan exists at ' + planFile + ' => ' + existsSync(planFile));
  const { readdirSync } = await import('node:fs');
  const listWorkspace = (dir: string): void => {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    console.log('[c4] workspace/ contains: ' + names.join(', '));
  };
  listWorkspace(join(NEW_PROJECT, 'workspace'));
  assert.ok(existsSync(planFile), 'sync plan must be generated when template moved');
  const plan = readFileSync(planFile, 'utf8');
  assert.ok(plan.includes('落后 1 个提交'), 'plan should list exactly one new upstream commit');

  // 2) full audit → workspace/audit-report.md (chat-referenceable)
  await vscode.commands.executeCommand('het.audit');
  const auditFile = join(NEW_PROJECT, 'workspace', 'audit-report.md');
  assert.ok(existsSync(auditFile), 'audit report must exist');
  const audit = readFileSync(auditFile, 'utf8');
  for (const h of ['# mylib2 — 项目审计报告', '## 2. 健康评分明细', '## 8. CI 与安全配置', '## 10. 结论与建议']) {
    assert.ok(audit.includes(h), `audit missing ${h}`);
  }

  // 3) Phase-4 panels open without throwing (benchmark / CI / docs / quality)
  for (const cmd of ['het.benchmark', 'het.ci', 'het.docs', 'het.quality', 'het.preflight', 'het.dashboard']) {
    await vscode.commands.executeCommand(cmd);
    await new Promise((r) => setTimeout(r, 300));
  }

  const evidence = 'initOk=true templateUpdate=true(behind1) auditOk=true panelsOk=true\n';
  writeFileSync(join(NEW_PROJECT, '.het', 'c4-evidence.txt'), evidence, 'utf8');
  console.log('[c4] PASS ' + evidence.trim());
  console.log('[c4] OK - template init → update notice → audit → panels verified offline');

  const holdMs = Number(process.env.HET_C4_HOLD_MS ?? 0);
  if (holdMs > 0) {
    console.log(`[c4] holding ${Math.round(holdMs / 1000)}s so you can watch the window…`);
    await new Promise((resolve) => setTimeout(resolve, holdMs));
    console.log('[c4] auto-exit now');
  }
}
