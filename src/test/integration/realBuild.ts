/**
 * P2 cross-platform REAL host — macOS native / Linux extension-host run.
 *
 * Opens a REAL project copied from the COMMITTED assets/template (present on
 * fresh clones/CI — workspace/fcpp is gitignored) with coverage disabled, then
 * drives the actual toolchain loop through host commands on the HOST platform:
 *   provider decision (macos-native / linux-managed|linux-native) →
 *   `het.test` (REAL conan create + GTest) → asserts.
 *
 * The point: a genuine macos-native build (Apple clang via conan detect) and a
 * genuine Linux build must succeed through the extension — CI-only evidence,
 * since this box is Windows. Run with:  npm run test:real
 * (workflows: .github/workflows/env-fresh-{linux,windows,macos}.yml)
 */
import * as assert from 'node:assert';
import { writeFileSync, readFileSync, readdirSync, accessSync, existsSync, constants as fsConsts } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { EXTENSION_ID, discoveredIds, hetExtension } from '../hostExtension';

interface ProviderPlan {
  provider?: string;
  coverage?: string;
  reason?: string;
}

/**
 * T23/CI switches (set by scripts/run-real.mjs + .github/workflows/env-fresh-{linux,windows,macos}.yml):
 *   HET_REAL_TOOLCHAIN=system   → fixture uses metadata.toolchain=system
 *   HET_REAL_EXPECT=blocked     → the managed lane must REFUSE with guidance
 *   HET_REAL_EXPECT_PROVIDER=x  → the provider id must equal x exactly
 *   HET_REAL_EXPECT_AFTER_SWITCH=ok → after het.useSystemToolchain, build must pass
 */
const MODE_SYSTEM = process.env.HET_REAL_TOOLCHAIN === 'system';
const EXPECT_BLOCKED = process.env.HET_REAL_EXPECT === 'blocked';
const EXPECT_PROVIDER = (process.env.HET_REAL_EXPECT_PROVIDER ?? '').trim();
const EXPECT_AFTER_SWITCH = process.env.HET_REAL_EXPECT_AFTER_SWITCH === 'ok';

/** Recursive, bounded search for a file/dir below `root` (skips node_modules). */
function findUnder(root: string, targetName: string, wantFile: boolean, depth = 0): string | null {
  if (depth > 9) {
    return null;
  }
  let entries: import('node:fs').Dirent[] = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) {
      continue;
    }
    const p = join(root, e.name);
    if (e.name === targetName) {
      if (!wantFile || e.isFile()) {
        try {
          accessSync(p, fsConsts.R_OK);
          return p;
        } catch {
          return null;
        }
      }
    }
    if (e.isDirectory()) {
      const sub = findUnder(p, targetName, wantFile, depth + 1);
      if (sub) {
        return sub;
      }
    }
  }
  return null;
}

/** Parse genhtml index.html line coverage % (same rule as coverage/report). */
function readCoveragePct(reportDir: string): string {
  try {
    const html = readFileSync(join(reportDir, 'index.html'), 'utf8');
    const m = /(\d+(?:\.\d+)?)\s*%\s*<\/td>\s*<td class="headerCovTableEntryLo">/u.exec(html) ?? /lines:.*?(\d+(?:\.\d+)?)%/u.exec(html);
    return m?.[1] ?? '?';
  } catch {
    return '?';
  }
}

/**
 * Bounded recursive search for a DIRECTORY named `coverage_report` holding
 * index.html (mirrors features/coverage/report.ts — coverage_report is a
 * folder, never a file, so the generic wantFile walker cannot match it).
 */
function findCovReportIndex(root: string, extraRoots: string[] = [], depth = 0): string | null {
  const idx = join(root, 'coverage_report', 'index.html');
  if (existsSync(idx)) {
    return idx;
  }
  if (depth > 9) {
    return null;
  }
  let entries: import('node:fs').Dirent[] = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) {
      continue;
    }
    const p = join(root, e.name);
    if (e.isDirectory()) {
      const sub = findCovReportIndex(p, [], depth + 1);
      if (sub) {
        return sub;
      }
    }
  }
  for (const extra of extraRoots) {
    if (extra && extra !== root) {
      const sub = findCovReportIndex(extra, [], 0);
      if (sub) {
        return sub;
      }
    }
  }
  return null;
}

export async function run(): Promise<void> {
  console.log('[real][STEP 1/6] provider decision — capability-first, must match this host');
  console.log('[real] starting on ' + process.platform);
  const ext = hetExtension();
  assert.ok(ext, `extension must be discovered — expected id "${EXTENSION_ID}"; discovered: ${discoveredIds()}`);
  console.log('[real] extension id: ' + ext!.id);
  await ext.activate();

  // Provider decision must match the real host (heuristic, capability-first).
  const plan = (await vscode.commands.executeCommand('het.getProvisionPlan', true)) as ProviderPlan | null;
  assert.ok(plan && plan.provider, 'provision plan must resolve on the real host');
  const expected =
    process.platform === 'darwin'
      ? ['macos-native']
      : process.platform === 'linux'
        ? ['linux-managed', 'linux-native']
        : ['win-wsl2', 'win-wsl2-pending', 'win-wsl-required'];
  assert.ok(expected.includes(plan!.provider ?? ''), `provider ${plan!.provider} not expected on ${process.platform} (${expected.join('/')})`);
  if (EXPECT_PROVIDER) {
    assert.strictEqual(plan!.provider, EXPECT_PROVIDER, `job requires provider=${EXPECT_PROVIDER}`);
  }
  console.log(`[real] provider=${plan!.provider} coverage=${plan!.coverage} · ${plan!.reason ?? ''}`);

  await vscode.commands.executeCommand('het.refresh');
  console.log('[real][STEP 2/6] project detection (fixture from assets/template)');
  const name = await vscode.commands.executeCommand<string | null>('het.getCurrentProject');
  assert.strictEqual(name, 'fcpp', 'expected the template project (fcpp), got: ' + name);

  // Dashboard opens without throwing (light UI sanity on the host).
  await vscode.commands.executeCommand('het.dashboard');
  await new Promise((r) => setTimeout(r, 400));

  console.log('[real][STEP 3/6] build & test — het.test drives the REAL conan create + GTest');
  console.log('[real] running het.test (REAL conan create + gtest)…');
  await vscode.commands.executeCommand('het.test');

  const buildOk = await vscode.commands.executeCommand<boolean | null>('het.getBuildOk');
  const lastError = (await vscode.commands.executeCommand<string>('het.getLastBuildError')) ?? '';

  // BLOCKED mode (fresh Windows without WSL2): the managed lane must REFUSE with
  // the actionable contract instead of falling back to a native conan sniff.
  if (EXPECT_BLOCKED) {
    console.log('[real][B1/4] managed lane must REFUSE (no usable WSL2 lane) — asserting the guidance text');
    assert.notStrictEqual(buildOk, true, 'managed build must NOT succeed without a WSL2 lane');
    assert.ok(/WSL2/.test(lastError), 'blocked build must explain the WSL2 requirement');
    assert.ok(/toolchain/.test(lastError), 'blocked build must offer the toolchain=system path');
    assert.ok(!/找不到 conan/.test(lastError), 'must not surface the old native-sniff error');
    console.log('[real][B2/4] guidance verified:\n' + lastError.split('\n').slice(0, 3).join('\n'));
    console.log('[real][B3/4] switching to the native toolchain via het.useSystemToolchain…');
    await vscode.commands.executeCommand('het.useSystemToolchain');
    const projRoot = join(ext.extensionPath, 'out', 'real-proj');
    const meta = JSON.parse(readFileSync(join(projRoot, 'metadata.json'), 'utf8')) as { toolchain?: string; activate_code_coverage?: boolean };
    assert.strictEqual(meta.toolchain, 'system', 'the explicit switch must persist toolchain=system');
    if (process.platform !== 'linux') {
      assert.strictEqual(meta.activate_code_coverage, false, 'the switch must also disable coverage on MSVC/Apple-clang hosts');
    }
    if (EXPECT_AFTER_SWITCH) {
      console.log('[real][B4/4] rebuild on the host toolchain…');
      await vscode.commands.executeCommand('het.test');
      assert.strictEqual(await vscode.commands.executeCommand<boolean | null>('het.getBuildOk'), true, 'system build after the switch must succeed');
    }
    const blockedEvidence = `platform=${process.platform} provider=${plan!.provider} mode=blocked switched=system\n`;
    writeFileSync(join(__dirname, '..', 'real-evidence.txt'), blockedEvidence, 'utf8');
    console.log('[real] PASS (blocked-guidance) ' + blockedEvidence.trim());
    return;
  }

  if (buildOk !== true) {
    // A lane/provision failure happens BEFORE conan prints anything, so the
    // conan tail alone is useless — surface the extension's own error, the
    // resolved plan and the lane status (this is the CI debug contract).
    console.log('[real][FAIL 1/4] het.getLastBuildError:');
    console.log(lastError || '(empty — the build may have been blocked before the toolchain layer)');
    console.log('[real][FAIL 2/4] provision plan: ' + JSON.stringify(plan));
    const lane = await vscode.commands.executeCommand('het.getLinuxLane', true).then(
      (v) => v,
      (e) => `(het.getLinuxLane threw: ${String(e)})`,
    );
    console.log('[real][FAIL 3/4] linux lane status: ' + JSON.stringify(lane));
    const tail = (await vscode.commands.executeCommand<string>('het.getLastConanOutput')) ?? '';
    console.log('[real][FAIL 4/4] conan output tail:\n' + tail.slice(-4000));
  }
  assert.strictEqual(buildOk, true, 'REAL conan create should succeed through the extension');

  const summary = (await vscode.commands.executeCommand('het.getTestSummary')) as
    | { passed: number; failed: number; skipped: number }
    | null;
  assert.ok(summary, 'gtest summary must be present');
  assert.ok(summary.passed > 0, 'at least one gtest case should pass');
  assert.strictEqual(summary.failed, 0, 'no gtest failures expected');

  // Linux: the managed lane runs coverage inside conan create (fixture keeps
  // activate_code_coverage=true on Linux) — the report must exist. coverage_report
  // is a DIRECTORY under <root>/test_package/test/export/coverage/ (in-place)
  // or under the lane conan cache; search both (report.ts semantics).
  if (process.platform === 'linux' && plan?.provider === 'linux-managed' && !MODE_SYSTEM) {
    console.log('[real][STEP 4/6] coverage report — the lane must have run lcov/genhtml');
    const proj = join(ext.extensionPath, 'out', 'real-proj');
    const laneCache = join(process.env.HOME ?? '', '.het-fti', 'managed-env', '.conan2', 'p');
    const covIndex = findCovReportIndex(proj, [laneCache]);
    if (!covIndex) {
      const tail = (await vscode.commands.executeCommand<string>('het.getLastConanOutput')) ?? '';
      console.log('[real] coverage missing — conan output tail:\n' + tail.slice(-12000));
    }
    assert.ok(covIndex, 'Linux lane coverage_report/index.html must exist after the real build');
    console.log('[real] coverage report: ' + covIndex);
    const pct = readCoveragePct(covIndex.slice(0, covIndex.lastIndexOf('/')));
    console.log('[real] coverage lines pct ≈ ' + pct);
  }

  // Decision 3: docs through the real host on BOTH platforms. het.docs opens
  // the panel; het.docsRun drives the SAME runner headlessly (lane/native).
  //
  // HONEST SCOPE (platform matrix, plan §5): docs are committed on the Linux
  // lane / Linux native / macOS lane. **Windows + toolchain=system (MSVC) is
  // ⛔**: docs there are best-effort, and the contract that matters is "fail
  // with an actionable hint instead of a bare traceback" — not "succeed".
  // Until 2026-09-15 this assertion demanded success everywhere, which made the
  // windows-system job red for a capability the product never promised.
  const docsCommitted = !(process.platform === 'win32' && MODE_SYSTEM);
  console.log(`[real][STEP 5/6] docs — het.docsRun drives doxygen + sphinx (committed=${docsCommitted})`);
  console.log('[real] running het.docsRun (REAL docs build)…');
  const docsResult = (await vscode.commands.executeCommand('het.docsRun')) as { ok: boolean; message: string } | undefined;
  const projRoot = join(ext.extensionPath, 'out', 'real-proj');
  const doxHtml = findUnder(join(projRoot, 'docs', 'doxygen'), 'docs.html', true) ?? findUnder(join(projRoot, 'docs', 'doxygen'), 'index.html', true);
  const sphHtml = findUnder(join(projRoot, 'docs', 'sphinx'), 'index.html', true);
  console.log(`[real] docs result=${JSON.stringify(docsResult)} doxygen=${!!doxHtml} sphinx=${!!sphHtml}`);
  if (!docsResult || docsResult.ok !== true) {
    const tail = await vscode.commands
      .executeCommand<string>('het.getLastDocsOutput')
      .then((v) => v ?? '', () => '');
    console.log('[real] docs output tail:\n' + tail.slice(-3000));
  }
  let docsEvidence = 'ok';
  if (docsCommitted) {
    assert.ok(docsResult && docsResult.ok === true, 'het.docs should succeed on the real host');
    assert.ok(doxHtml, 'doxygen artifact (docs.html) must exist after the real docs build');
    assert.ok(sphHtml, 'sphinx artifact (index.html) must exist after the real docs build');
  } else if (docsResult?.ok === true) {
    // An equipped Windows host may legitimately produce docs — then prove it.
    console.log('[real] docs succeeded on Windows/MSVC (host is equipped)');
    assert.ok(doxHtml && sphHtml, 'a successful docs run must leave both artifacts');
    docsEvidence = 'ok-equipped';
  } else {
    // Not promised here → the promise is the GUIDANCE, not the artifact.
    const msg = docsResult?.message ?? '';
    console.log('[real][D1/2] docs not committed on Windows/MSVC — asserting actionable guidance');
    assert.ok(
      /pip install|"toolchain": "managed"|toolchain.*managed/u.test(msg),
      'an uncommitted docs run must still tell the user HOW to fix it (pip/apt/brew or switch back to managed), got: ' + msg,
    );
    console.log('[real][D2/2] guidance verified:\n' + msg.split('\n').slice(0, 3).join('\n'));
    docsEvidence = 'unsupported-honest';
  }

  const evidence = `platform=${process.platform} provider=${plan!.provider} mode=${MODE_SYSTEM ? 'system' : 'managed'} docs=${docsEvidence} buildOk=${buildOk} passed=${summary.passed} failed=${summary.failed} skipped=${summary.skipped}\n`;
  writeFileSync(join(__dirname, '..', 'real-evidence.txt'), evidence, 'utf8');
  console.log('[real][STEP 6/6] evidence written');
  console.log('[real] PASS ' + evidence.trim());
  console.log(`[real] OK — REAL ${process.platform} build + tests + docs verified through the extension host`);
}
