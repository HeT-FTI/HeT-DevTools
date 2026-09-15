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
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, readdirSync, accessSync, existsSync, constants as fsConsts } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { EXTENSION_ID, discoveredIds, hetExtension } from '../hostExtension';
import { decodeWslOutput, parseWslList } from '../../core/wslHost';
import { laneOwnerMarkerPath } from '../../core/wslDistro';

interface ProviderPlan {
  provider?: string;
  coverage?: string;
  reason?: string;
  /** T17：Windows 无发行版时的"自建"提议（代价 + 发行版名）。 */
  setup?: { kind?: string; distro?: string; costText?: string };
  note?: string;
}

/**
 * T23/CI switches (set by scripts/run-real.mjs + .github/workflows/env-fresh-{linux,windows,macos}.yml):
 *   HET_REAL_TOOLCHAIN=system   → fixture uses metadata.toolchain=system
 *   HET_REAL_EXPECT=blocked     → the managed lane must REFUSE with guidance
 *   HET_REAL_EXPECT_PROVIDER=x  → the provider id must equal x exactly
 *   HET_REAL_EXPECT_AFTER_SWITCH=ok → after het.useSystemToolchain, build must pass
 *   HET_REAL_WSL_IMPORT=1       → Windows self-provision scenario (plan/cost → real
 *                                 import attempt → 0 intrusion → teardown round trip)
 */
const MODE_SYSTEM = process.env.HET_REAL_TOOLCHAIN === 'system';
const EXPECT_BLOCKED = process.env.HET_REAL_EXPECT === 'blocked';
const WSL_IMPORT = process.env.HET_REAL_WSL_IMPORT === '1';
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

/**
 * 0 侵入的一致性判据：直接用**真实的** `wsl.exe` 读发行版集合（不经产品代码）。
 * 无发行版时 `wsl -l -q` 以非 0 退出并把提示写到 stderr —— 那是"空列表"，不是故障。
 */
function realWslList(): string[] {
  try {
    return parseWslList(decodeWslOutput(String(execFileSync('wsl.exe', ['-l', '-q'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))));
  } catch (err) {
    const e = err as { stdout?: unknown; stderr?: unknown };
    return parseWslList(decodeWslOutput(`${String(e.stdout ?? '')}${String(e.stderr ?? '')}`));
  }
}

const OUR_DISTRO_RE = /^het-lane-\d{4}(?:-\d+)?$/u;

/**
 * T17d（CI 部分）：Windows 自建私有发行版的端到端契约。
 *
 * 托管 runner **无嵌套虚拟化**，所以这里能验的是（每一项都有机器证据）：
 *   ① 无发行版时的计划必须提议自建，并把代价（下载/磁盘）与 0 侵入说清；
 *   ② **0 侵入**：跑前/跑后 `wsl -l -q` 对比 —— 用户已有的发行版不允许消失，
 *      新增的只允许是我们自己命名的；
 *   ③ 真实执行 `het.envPrepare`（rootfs 校验/缓存 → `wsl --import` → bootstrap），
 *      失败必须给 A/C 两条路，且**绝不**偷偷把工程切成 `system`；
 *   ④ `het.envRemove` 之后回到跑前集合（导入成功时是硬断言）。
 * 验不了的（日志里明说）：导入后的发行版**能否启动** → 机器 DoD（`run-lane-dod.mjs`）。
 * 若 runner 恰好能 import（自托管/将来），同一段代码自动升级到完整断言（换名 + 幂等复用）。
 */
async function runWslImportScenario(plan: ProviderPlan, ext: vscode.Extension<unknown>): Promise<void> {
  assert.strictEqual(process.platform, 'win32', 'wsl-import 场景只在 Windows 上有意义');
  const projRoot = join(ext.extensionPath, 'out', 'real-proj');

  console.log('[real][W1/6] 计划层：无发行版时必须提议自建，且代价 + 0 侵入先讲清');
  assert.ok(plan.setup && plan.setup.kind === 'wsl-import', `expected a wsl-import proposal, got ${JSON.stringify(plan.setup)}`);
  assert.match(String(plan.setup.distro), /^het-lane-\d{4}/u, '必须用我们自己的命名（het-lane-<版本号>）');
  assert.match(String(plan.setup.costText), /\d+MB/u, '代价（下载体积）必须先讲清');
  assert.match(String(plan.setup.costText), /GB/u, '代价（磁盘占用）必须先讲清');
  assert.match(String(plan.note ?? ''), /不会改动你已有的(任何)?发行版/u, '0 侵入承诺必须写进计划文案');
  assert.match(String(plan.note ?? ''), /wsl --install -d Ubuntu-24\.04/u, 'A 路线（官方发行版）必须保留');
  assert.match(String(plan.note ?? ''), /toolchain=system/u, 'C 路线（本机工具链）必须保留');
  console.log('[real] plan.setup=' + JSON.stringify(plan.setup));

  console.log('[real][W2/6] 0 侵入基线：跑前快照（真实 wsl.exe）');
  const before = realWslList();
  console.log('[real] wsl -l -q before: ' + JSON.stringify(before));
  const decoy = before.filter((n) => /^het-lane-\d{4}$/u.test(n));
  if (decoy.length > 0) {
    console.log(`[real] 已有同名（无标记）发行版 ${decoy.join('/')} —— 本次必须换名导入，绝不接管`);
  } else {
    console.log('[real] 本 runner 无同名发行版：换名判据由 wslDistro / wslImportStub 单测覆盖（跨平台），此处只验"新增的只能是我们自己的名字"');
  }

  console.log('[real][W3/6] 真实执行 het.envPrepare（rootfs 校验/缓存 → wsl --import → bootstrap）');
  const res = (await vscode.commands.executeCommand('het.envPrepare')) as { ok?: boolean; state?: string; message?: string } | undefined;
  console.log('[real] envPrepare → ' + JSON.stringify(res));

  const after = realWslList();
  console.log('[real] wsl -l -q after : ' + JSON.stringify(after));
  const newNames = after.filter((n) => !before.includes(n));
  const lost = before.filter((n) => !after.includes(n));
  const ours = after.filter((n) => OUR_DISTRO_RE.test(n));
  assert.deepStrictEqual(lost, [], 'I2：绝不能动/注销用户已有的发行版');
  assert.ok(newNames.every((n) => OUR_DISTRO_RE.test(n)), `新增的发行版只能是我们自己的名字：${JSON.stringify(newNames)}`);
  assert.ok(ours.length <= 1, `最多只允许一个托管发行版，实际 ${JSON.stringify(ours)}`);

  const msg = String(res?.message ?? '');
  const imported = ours.length === 1;
  const laneStarted = res?.ok === true;
  let branch: string;
  if (imported && laneStarted) {
    branch = 'imported';
    console.log(`[real][W4/6] 自建成功：${ours[0]}（双标记回读已通过）`);
    const marker = laneOwnerMarkerPath(process.env.LOCALAPPDATA ?? '', ours[0]);
    assert.ok(existsSync(marker), `Windows 侧 owner 标记必须存在：${marker}`);
    console.log('[real] 幂等复跑（"避免重复"的用户可见承诺）…');
    await vscode.commands.executeCommand('het.envPrepare');
    assert.deepStrictEqual(realWslList(), after, '第二次准备必须复用已就绪的发行版（不新建）');
  } else if (imported) {
    // 发行版建了，但车道没起来（无嵌套虚拟化 / 镜像无法引导 / 双标记没对上）。
    branch = 'imported-no-lane';
    console.log('[real][W4/6] 发行版已建但车道不可用（托管 runner 的预期）：\n' + msg.split('\n').slice(0, 4).join('\n'));
    assert.match(msg, /车道无法启动|双标记/u, '这条路径必须说清失败在哪一步');
    assert.match(msg, /wsl --install -d Ubuntu-24\.04/u, '必须给 A 路线');
    assert.match(msg, /toolchain: system/u, '必须给 C 路线');
  } else {
    branch = 'blocked';
    console.log('[real][W4/6] 未能自建（当前托管 runner 的预期结果）：\n' + msg.split('\n').slice(0, 4).join('\n'));
    assert.ok(msg.trim().length > 0, '失败必须带原因，不能是空话');
    // 只要求"说清了是 WSL 这条链上的事"；真正严格的是下面的 A/C 与"没有静默降级"。
    assert.match(msg, /wsl|WSL/u, '失败必须给出技术原因（全文已打印在上面的日志里）');
    assert.match(msg, /wsl --install -d Ubuntu-24\.04/u, '必须给 A 路线');
    assert.match(msg, /toolchain: system/u, '必须给 C 路线');
  }
  // 同名（无标记）已存在 → 名字必须换，绝不接管（只要 import 真的发生就能验）。
  if (imported && decoy.length > 0) {
    assert.match(ours[0], /-\d+$/u, `同名（无标记）已存在时必须换名，实际 ${ours[0]}`);
    console.log(`[real] 换名判据已验证：${decoy.join('/')} 保持不变，我们用了 ${ours[0]}`);
  }
  // 绝不静默降级：自建没成时，工程必须仍然是 managed（不是偷偷变成 system）。
  const meta = JSON.parse(readFileSync(join(projRoot, 'metadata.json'), 'utf8')) as { toolchain?: string };
  assert.strictEqual(meta.toolchain, 'managed', '自建失败时不得偷偷把工程改成 system');

  console.log('[real][W5/6] het.envRemove —— 撤销后必须回到跑前的集合');
  await vscode.commands.executeCommand('het.envRemove');
  const cleaned = realWslList();
  console.log('[real] wsl -l -q after remove: ' + JSON.stringify(cleaned));
  const leftover = cleaned.filter((n) => !before.includes(n));
  assert.deepStrictEqual(before.filter((n) => !cleaned.includes(n)), [], 'I2：撤销也不得碰用户已有的发行版');
  if (branch === 'imported') {
    assert.deepStrictEqual(cleaned, before, '移除托管环境后必须与跑前完全一致');
  } else if (leftover.length > 0) {
    // 建了但没成 → 没有写入双标记 → I1 故意不接管（不认领就不该注销）。
    // 现场交给作业的 CLEANUP 步骤按"跑前之外 + 我们的命名"精确删除。
    console.log('[real] 非我们所有的残留（I1 不接管，交 CI 清理）：' + JSON.stringify(leftover));
  }

  const evidence =
    `platform=${process.platform} provider=${plan.provider} mode=wsl-import branch=${branch} planCost=ok intrude=none` +
    ` distro=${ours[0] ?? '(none)'} renamed=${decoy.length > 0 && branch === 'imported' ? 'yes' : 'n/a'}` +
    ` vscode=${vscode.version} vscodeSource=${process.env.HET_VSCODE_SOURCE ?? '?'}\n`;
  writeFileSync(join(__dirname, '..', 'real-evidence.txt'), evidence, 'utf8');
  console.log('[real][W6/6] evidence written');
  console.log('[real] PASS ' + evidence.trim());
}

export async function run(): Promise<void> {
  console.log('[real][STEP 1/6] provider decision — capability-first, must match this host');
  console.log('[real] starting on ' + process.platform);
  // T28: the RUNNING host version, read from inside the extension host. It used
  // to be unknowable from the artifact (macOS silently ran the local/brew build
  // while the job asked for a pinned floor), so it is now a first-class fact:
  // the CI claim "we verify the promised VS Code floor" is checkable here.
  console.log(`[real] host VS Code: ${vscode.version} (source: ${process.env.HET_VSCODE_SOURCE ?? '(unset)'})`);
  // T28: `VSCODE_VERSION` is the promised floor, but a LOCAL install wins over the
  // download — so asking for a version is not the same as running it (macOS).
  // Make that mismatch LOUD instead of silent; `HET_REAL_EXPECT_VSCODE` turns it
  // into a hard assertion once a job has confirmed the value it gets.
  const pinnedVscode = process.env.VSCODE_VERSION ?? '';
  const expectVscode = process.env.HET_REAL_EXPECT_VSCODE ?? '';
  if (expectVscode) {
    assert.ok(
      vscode.version.startsWith(expectVscode),
      `job requires VS Code ${expectVscode}, but this host is ${vscode.version} (source: ${process.env.HET_VSCODE_SOURCE ?? '?'})`,
    );
  } else if (pinnedVscode && !vscode.version.startsWith(pinnedVscode)) {
    console.log(
      `[real] WARN: job asked for VS Code ${pinnedVscode} but ran ${vscode.version} (source: ${process.env.HET_VSCODE_SOURCE ?? '?'}) ` +
        '— the promised floor is NOT what this run verified (set HET_REAL_EXPECT_VSCODE to make it fatal, see T28)',
    );
  }
  const ext = hetExtension();
  assert.ok(ext, `extension must be discovered — expected id "${EXTENSION_ID}"; discovered: ${discoveredIds()}`);
  console.log('[real] extension id: ' + ext!.id);
  // Automation-host markers: `quietHost()` must be TRUE in this harness, otherwise
  // any consent modal is attempted and VS Code rejects it (that killed
  // env-fresh · windows run 34925439823 on VS Code 1.137, whose extension-host
  // argv no longer carries `--extensionTestsPath`). Printed so the next such
  // failure explains itself.
  console.log(
    '[real] automation markers: ' +
      JSON.stringify({
        HET_NO_UI: process.env.HET_NO_UI ?? '(unset)',
        HET_VERIFY_PHASE: process.env.HET_VERIFY_PHASE ?? '(unset)',
        argvHasTestsPath: process.argv.some((a) => a.includes('--extensionTestsPath')),
      }),
  );
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

  // T17d（CI 部分）：Windows 自建私有发行版 —— 不跑构建，只验证"计划/代价 → 真实执行 →
  // 0 侵入 → 撤销"这条契约链。
  if (WSL_IMPORT) {
    await runWslImportScenario(plan!, ext!);
    return;
  }

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
    // PREMISE: this scenario only makes sense on a Windows host WITHOUT a usable
    // distro (GitHub's hosted runners today: wsl.exe present, zero distros).
    // If a distro ever appears, the lane legitimately runs — say so explicitly
    // instead of leaving a cryptic "build must not succeed" failure.
    if (plan?.provider === 'win-wsl2') {
      throw new Error(
        `[real] PREMISE CHANGED: provider=${plan.provider} (the runner now HAS a usable WSL2 distro). ` +
          'This job asserts the "lane blocked → explicit switch" contract; on a distro-bearing runner ' +
          'it must be replaced by a "lane available" scenario (see .github/workflows/env-fresh-windows.yml).',
      );
    }
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
    const blockedEvidence = `platform=${process.platform} provider=${plan!.provider} mode=blocked switched=system vscode=${vscode.version} vscodeSource=${process.env.HET_VSCODE_SOURCE ?? '?'}\n`;
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

  // Docs scope (platform matrix, plan §5): the env-fresh jobs PREPARE the host
  // like a properly equipped developer machine (Linux: apt doxygen/graphviz +
  // venv sphinx; Windows: choco doxygen/graphviz + venv sphinx), so on those
  // hosts docs MUST succeed — same bar as the lane. The "host is not equipped →
  // give a recognisable prompt" contract is covered by core/docsHints unit tests
  // (see src/test/docsHints.test.ts); a CI job deliberately left bare can opt
  // into it with HET_REAL_EXPECT_DOCS=guide.
  const docsExpectGuide = process.env.HET_REAL_EXPECT_DOCS === 'guide';
  const docsCommitted = !docsExpectGuide;
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
    assert.ok(docsResult && docsResult.ok === true, 'het.docs should succeed on a PREPARED host (see the job SETUP step)');
    assert.ok(doxHtml, 'doxygen artifact (docs.html) must exist after the real docs build');
    assert.ok(sphHtml, 'sphinx artifact (index.html) must exist after the real docs build');
  } else {
    // Deliberately bare host → the promise is the GUIDANCE, not the artifact.
    const msg = docsResult?.message ?? '';
    console.log('[real][D1/2] bare host — asserting a recognisable, actionable prompt');
    assert.ok(
      /pip install|"toolchain": "managed"|winget |choco |brew |apt-get/u.test(msg),
      'an uncommitted docs run must tell the user HOW to fix it, got: ' + msg,
    );
    console.log('[real][D2/2] guidance verified:\n' + msg.split('\n').slice(0, 3).join('\n'));
    docsEvidence = 'unsupported-honest';
  }

  const evidence = `platform=${process.platform} provider=${plan!.provider} mode=${MODE_SYSTEM ? 'system' : 'managed'} docs=${docsEvidence} buildOk=${buildOk} passed=${summary.passed} failed=${summary.failed} skipped=${summary.skipped} vscode=${vscode.version} vscodeSource=${process.env.HET_VSCODE_SOURCE ?? '?'}\n`;
  writeFileSync(join(__dirname, '..', 'real-evidence.txt'), evidence, 'utf8');
  console.log('[real][STEP 6/6] evidence written');
  console.log('[real] PASS ' + evidence.trim());
  console.log(`[real] OK — REAL ${process.platform} build + tests + docs verified through the extension host`);
}
