/**
 * C7 template-acquisition path check (marketplace-readiness E2).
 *
 * Forces the "recommended online pin" clone to be UNAVAILABLE
 * (HET_FORCE_TEMPLATE_OFFLINE=1 → tryRemote fails deterministically, exactly
 * like a machine with no network to GitHub) and asserts the extension:
 *   - transparently falls back to the local candidate chain (workspace/fcpp →
 *     assets/template);
 *   - records the local ref in `.het/template-ref.json`;
 *   - surfaces the human "已自动回退到本地模板" note;
 *   - completes quickly (no hang → the verify-style watchdog would not trip).
 *
 * Run with:  npm run test:c7
 */
import * as assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';

import { EXTENSION_ID } from '../hostExtension';
const DEST = process.env.HET_C7_DEST ?? '';

export async function run(): Promise<void> {
  console.log('[c7] starting (forced-offline online pin → local fallback)');
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(ext, 'extension must be discovered');
  await ext.activate();
  assert.ok(DEST.length > 0, 'HET_C7_DEST must be set');
  assert.strictEqual(process.env.HET_FORCE_TEMPLATE_OFFLINE, '1', 'host must force the online pin offline');

  const startedAt = Date.now();
  const r = (await vscode.commands.executeCommand('het.newProjectDirect', {
    name: 'netproj',
    description: 'C7 offline-fallback demo',
    dest: DEST,
    gitAuthor: { name: 'C7 Init', email: 'c7@example.invalid' },
    confirmed: true,
  })) as { ok: boolean; message: string; root?: string };
  const elapsedMs = Date.now() - startedAt;

  console.log('[c7] init result: ' + r.message);
  assert.strictEqual(r.ok, true, 'project must still be created while the online pin is unavailable');
  assert.ok(/回退|本地模板|offline|fallback/i.test(r.message), 'human fallback note must be present: ' + r.message);
  assert.strictEqual(r.root, DEST);
  assert.ok(existsSync(join(DEST, 'metadata.json')), 'metadata.json must exist');
  const marker = JSON.parse(readFileSync(join(DEST, '.het', 'template-ref.json'), 'utf8')) as { repo?: string; ref?: string; label?: string };
  assert.ok(marker.ref && marker.ref.length >= 7, 'marker must carry the local template HEAD');
  assert.ok(marker.label && /本地|开发副本|内置模板/i.test(marker.label), 'marker label must say a local source: ' + marker.label);
  // The forced failure must be fast (a real network timeout would be slow) —
  // this is the property that keeps the zero-manual watchdog from false-killing.
  assert.ok(elapsedMs < 60_000, `fallback must complete quickly (took ${elapsedMs}ms)`);
  console.log(`[c7] OK — offline fallback green in ${elapsedMs}ms (ref ${marker.ref.slice(0, 12)} @ ${marker.label})`);
}
