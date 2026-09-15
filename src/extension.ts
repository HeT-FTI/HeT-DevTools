import { isAbsolute, join, dirname, delimiter } from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import * as vscode from 'vscode';
import { LOG_CHANNEL_NAME, log, setOutputChannel } from './constants';
import { locateConan, runConanCreate, resolveConanRuntime, ensureConanDefaultProfile } from './core/conanService';
import { parseGTestOutput, GTestRunSummary } from './core/gtestRunner';
import { runHealthCheck, healthGapLabels, verdictZh } from './core/healthCheck';
import type { HealthReport } from './core/healthCheck';
import { CURATED_PACKAGES } from './data/conanIndex';
import { runAddDependencyQuickPick } from './features/deps/quickpick';
import { parseCompilerOutput } from './core/outputParser';
import { detectProjectsIn } from './core/projectDetector';
import { detectToolchain } from './core/toolchainDetector';
import { CockpitPage, isCockpitPage } from './features/cockpit/layout';
import { DepAddInput } from './features/deps/panel';
import { ModulePanelInput, showModuleWizardPanel } from './features/moduleWizard/panel';
import { DiscoveredModule, ModeBInput, ModeBPreview, showTestgenPanel } from './features/testgen/panel';
import { CoverageState, showCoveragePanel } from './features/coverage/panel';
import { DocsState, DocToolStatus, showDocsPanel } from './features/docs/panel';
import { QualityRow, QualityRunResult, showQualityPanel } from './features/quality/panel';
import { CommitRequest, CommitState, showCommitPanel } from './features/commit/panel';
import { ReleaseState, showReleasePanel } from './features/release/panel';
import { PreflightState, PreflightItem, showPreflightPanel } from './features/preflight/panel';
import { openCockpitPanel, emitCockpitEvent, getCockpitState, setCockpitPageProvider, setCockpitPageHandler, setCockpitWizardInfo, setCockpitWizardFinishHandler } from './features/cockpit/controller';
import { BenchState, showBenchPanel } from './features/bench/panel';
import { CiState, CiRunInfo, showCiPanel } from './features/ci/panel';
import { showSettingsPanel } from './features/settings/panel';
import { showTestResultsPanel } from './features/testResults/panel';
import { DashboardSnapshot, esc, pageShell } from './features/ui';
import { registerTestController } from './features/testExplorer/controller';
import { chipSpec } from './features/statusChip';
import {
  addDependency,
  listDependencies,
  removeDependency,
  DepBucket,
} from './core/dependencyService';
import { planModuleFiles } from './core/moduleTemplate';
import { planModuleTests, scanHeader } from './core/testgen';
import { parseBlueprint, renderContractTest, renderImplementationPlan } from './core/testgenModeB';
import { composeHeader, defaultEmoji, parsePorcelain, suggestType, TRIGGER_EMOJIS } from './core/commitAssistant';
import { applyMetadataPatch, loadMetadata, validateMetadata, hasErrors } from './core/metadataService';
import { formatConfigForFile, parseClangFormatOutput, parseClangTidyOutput, lintCommitHeader, collectHeaders, QualityIssue } from './core/qualityGates';
import { pathExists, readText, writeText } from './utils/fs';
import { fcppStyleStringify } from './core/metadataText';
import { run, which } from './utils/exec';
import { docsOptions, graphvizMismatch } from './core/docsService';
import { configPlatform, fieldsFor, parseBenchmarkProtocol, replaceJsoncField } from './core/benchmark';
import { parseRemoteOrigin, parseWorkflowYaml } from './core/ciStatus';
import { GithubAuthService, createGhAuthChecker, AuthInfo } from './core/githubAuthService';
import { renderAuditMarkdown, AuditInput } from './core/auditReport';
import { renderSearchQuery, renderTechDisclosure, PatentInput } from './core/patent';
import { resolveTemplateSource, resolveCloneRef, recommendedAnchors } from './core/templateService';
import { discoverTools, TOOL_DEFS, ToolRow } from './core/toolchainDiscovery';
import { getCurrentProvisionPlan, getHostCapabilities } from './features/env/provisionHost';
import { providerLabel, ProvisionPrefs } from './core/provisionPlan';
import { currentManagedStatus, managedGc, managedRemove } from './features/env/managedProvisioner';
import { getWslLaneStatus } from './features/env/wslProbe';
import { runWslConanCreate, runWslDocs, probeLaneDocsTools, LaneDocsTools, ensureWslLane } from './features/env/wslLane';
import { collectEnvSample, envConanFact } from './features/env/envSample';
import { buildEnvDump, dumpFileName, redactRoots } from './core/envDump';
import { findCoverageReport, readCoveragePct } from './features/coverage/report';
import { onStateChange, notifyStateChange } from './features/live';
import { parseProjectToolchain, localBuildType, withProjectToolchain, TOOLCHAIN_SYSTEM } from './core/projectToolchain';
import { getMacosLaneStatus } from './features/env/macosProbe';
import { ensureMacLane, getMacLaneStatus, runMacConanCreate, runMacDocs } from './features/env/macLane';
import { getLinuxLaneStatus, runLinuxConanCreate, runLinuxDocs, probeLinuxLaneFacts, linuxRootAvailable, ensureLinuxLane } from './features/env/linuxLane';
import { ContractFacts, EnvContract, buildEnvContract } from './core/envContract';
import { docsFailureHint } from './core/docsHints';
import { LaneMirror, laneMirrorOf, mirrorSummary } from './core/laneMirror';
import { effectiveCmakeFloor, laneCompilerGuide, nativeCmakePlan, unsupportedArchMessage } from './core/laneProfile';
import { prependPath } from './core/envPath';
import { openHudPanel } from './features/hud/panel';
import { HudEnvRow, HudModel, defaultHudActions, hudEnabled } from './features/hud/hudModel';
import { TEMPLATE_REPO } from './core/templateDefaults';
import { encodeMarker, parseMarker, parseCommitList, renderSyncPlan, markerPath } from './core/templateSync';
import { FcppMetadata, FcppProject, ParsedIssue } from './types';
import { normalizeLocale, t as _tl } from './utils/i18n';
import { wslExePath } from './core/wslHost';

/** Locale-aware label helper (zh/en runtime chrome). */
function L(key: string, params?: Record<string, string | number>): string {
  return _tl(normalizeLocale(vscode.env.language), key, params);
}

let channel: vscode.OutputChannel | undefined;
let statusItem: vscode.StatusBarItem | undefined;
let currentProject: FcppProject | undefined;
let activationLine = '';
let lastTestSummary: GTestRunSummary | undefined;
let lastBuildOk: boolean | undefined;
/** When the last build/test outcome was recorded (0 = never). */
let lastBuildAt = 0;
/** T23/CI: the last environment-level build error (asserted by the fresh-host runner). */
let lastBuildError = '';
let lastConanOutput = '';
let lastBenchParse: { complete: boolean; cases: [string, string][] } | null = null;
let wizardAutoOpened = false;
let lastHealth: { score: number; verdict: 'PASS' | 'WARN' | 'FAIL'; gaps: string[]; at: number } | undefined;
let lastHealthReport: HealthReport | null = null;
/** V5-2: last docs build outcome (技术文档 row). */
let lastDocs: { ok: boolean; at: number } | null = null;
/** V5-6: docs build in flight (chip spinner + cockpit log drawer sync). */
let docsRunning = false;
/** P2: headless docs-run binding (set when the docs center opens) + output tail. */
let docsRunImpl: (() => Promise<{ ok: boolean; message: string }>) | null = null;
let lastDocsOutput = '';
/** V5-6: parsed coverage % from the located report (cached 30 s). */
let coverageProbeCache: { at: number; found: boolean; line: number | null; func: number | null } | null = null;
/** V5-2: short-lived env sample summary cache for the 开发环境 row. */
let envSummaryCache: { at: number; summary: string } | null = null;
/** V5-6: singleton 体检明细 panel (live-synced with the chip). */
let healthPanel: vscode.WebviewPanel | undefined;
let onboardingNotified = false;
let lastChip: { text: string; tooltip: string; command?: string } | null = null;
/** Timer id for the "hide chip for 5 minutes" snooze. */
let chipSnoozeTimer: ReturnType<typeof setTimeout> | undefined;
const isTestHost = process.argv.some((a) => a.includes('--extensionTestsPath'));

/** Record a build/test outcome + timestamp (for the chip/HUD "…前" line). */
function markBuildOutcome(ok: boolean): void {
  lastBuildOk = ok;
  lastBuildAt = Date.now();
}

/** '刚刚' / '3 分钟前' / '2 小时前' from a timestamp. */
function agoText(at: number | undefined): string | null {
  if (!at) {
    return null;
  }
  const s = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (s < 15) {
    return '刚刚';
  }
  if (s < 60) {
    return `${s} 秒前`;
  }
  const min = Math.floor(s / 60);
  if (min < 60) {
    return `${min} 分钟前`;
  }
  const h = Math.floor(min / 60);
  return `${h} 小时前`;
}

/**
 * True inside any automation host (unit/integration mocha, the installed-vsix
 * verify runner, or any harness that sets HET_NO_UI=1). These hosts must stay
 * zero-manual: no window toasts that a human would have to dismiss.
 *
 * `--extensionTestsPath` is the classic marker, but it is NOT guaranteed to be
 * in the extension-host argv on every VS Code version (1.137 stopped carrying
 * it) — so `run-real.mjs` ALSO sets HET_NO_UI=1, and every modal goes through
 * `askModal()` which treats a refused dialog as "cancel" instead of crashing.
 */
function quietHost(): boolean {
  return isTestHost || !!process.env.HET_VERIFY_PHASE || !!process.env.HET_NO_UI;
}

/**
 * Modal confirm that can never break a command.
 *
 * A host that refuses dialogs (VS Code test hosts throw
 * `DialogService: refused to show dialog in tests`; locked-down/remote hosts may
 * too) must behave like "the user said no" — never like an exception that kills
 * the whole flow (env-fresh · windows run 34925439823 died exactly there).
 * Returns the picked label, or undefined when the dialog could not be shown.
 */
async function askModal(message: string, okLabel: string, cancelLabel = '取消'): Promise<string | undefined> {
  try {
    return await vscode.window.showWarningMessage(message, { modal: true }, okLabel, cancelLabel);
  } catch (err) {
    log(`[ui] 宿主拒绝显示弹窗 → 按「取消」处理：${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/** A no-op-safe wrapper for success/error toasts that would distract in automation. */
function maybeToast(kind: 'info' | 'warn' | 'error', message: string, ...buttons: string[]): Thenable<string | undefined> | undefined {
  if (quietHost()) {
    log(message.replace(/\n/g, ' '));
    return undefined;
  }
  // A host that refuses dialogs rejects this promise — never let that surface as
  // an unhandled rejection (and never as a failed command).
  const shown = kind === 'error'
    ? vscode.window.showErrorMessage(message, ...buttons)
    : kind === 'warn'
      ? vscode.window.showWarningMessage(message, ...buttons)
      : vscode.window.showInformationMessage(message, ...buttons);
  return shown.then(
    (v) => v,
    (err) => {
      log(`[ui] 宿主拒绝显示提示 → 忽略：${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    },
  );
}

/** Sniffed conan runtime (conda env + PATH emulation), cached 30 s. */
let conanRuntime: {
  exe: string;
  envName?: string;
  pathPrefix?: string;
  version?: string;
  at: number;
  /** True when the user pinned it manually (het.tools.conan / het.tools.envDir). */
  overrideUser?: boolean;
} | null = null;
/** Generic toolchain discovery (multi-source), cached 60 s. */
let toolRowsCache: { rows: ToolRow[]; at: number } | null = null;

function toolOverridesConfig(): Record<string, string> {
  return vscode.workspace.getConfiguration('het').get<Record<string, string>>('tools', {});
}

function prependPathDir(dir: string): void {
  if (!dir || (process.env.PATH ?? '').includes(dir)) {
    return;
  }
  process.env.PATH = `${dir}${delimiter}${process.env.PATH ?? ''}`;
  log(`[tools] PATH += ${dir}`);
}

async function applyToolOverrides(): Promise<void> {
  for (const p of Object.values(toolOverridesConfig())) {
    if (p && existsSync(p)) {
      prependPathDir(dirname(p));
    }
  }
}

/**
 * Generic discovery: PATH → conda/mamba envs → uv → venv → (WSL info).
 * Found dirs are injected into the child PATH so existing `which()`-based
 * flows (docs / quality / build) automatically see conda-forge tools.
 */
async function ensureToolDiscovery(force = false): Promise<ToolRow[]> {
  if (!force && toolRowsCache && Date.now() - toolRowsCache.at < 60_000) {
    return toolRowsCache.rows;
  }
  const rows = await discoverTools({ overrides: toolOverridesConfig(), wsl: true });
  toolRowsCache = { rows, at: Date.now() };
  for (const r of rows) {
    if (r.source === 'missing' || r.overridden || r.informational || r.source === 'path') {
      continue;
    }
    prependPathDir(dirname(r.exe));
  }
  await applyToolOverrides();
  await refreshChip();
  return rows;
}

/** Manual override flow from the dashboard env block (low mental load). */
async function handleEnvManualAction(action: string, tool: string): Promise<void> {
  const def = TOOL_DEFS.find((d) => d.key === tool);
  if (!def) {
    return;
  }
  const current = toolOverridesConfig();
  if (action === 'env:clear') {
    if (current[tool]) {
      const next = { ...current };
      delete next[tool];
      await vscode.workspace.getConfiguration('het').update('tools', next, vscode.ConfigurationTarget.Global);
      await applyToolOverrides();
      if (tool === 'conan' || tool === 'envDir') {
        await ensureConanRuntime(true);
      }
      void ensureToolDiscovery(true);
      void vscode.window.showInformationMessage(`已清除 ${def.label} 的手动指定，恢复自动嗅探。`);
    }
    return;
  }
  const pick = await vscode.window.showInputBox({
    title: `${def.label} · 手动指定`, 
    prompt: '可执行文件绝对路径（留空 = 清除手动指定）',
    value: current[tool] ?? '',
    ignoreFocusOut: true,
  });
  if (pick === undefined) {
    return;
  }
  const v = pick.trim();
  const next = { ...current };
  if (v) {
    if (!existsSync(v)) {
      void vscode.window.showWarningMessage(`路径不存在：${v}`);
      return;
    }
    next[tool] = v;
  } else {
    delete next[tool];
  }
  await vscode.workspace.getConfiguration('het').update('tools', next, vscode.ConfigurationTarget.Global);
  await applyToolOverrides();
  if (tool === 'conan' || tool === 'envDir') {
    await ensureConanRuntime(true);
  }
  await ensureToolDiscovery(true);
  void vscode.window.showInformationMessage(v ? `已手动指定 ${def.label} = ${v}（已写入 het.tools.${tool} 并注入工具链）` : `已清除 ${def.label} 手动指定。`);
}

async function ensureConanRuntime(force = false): Promise<typeof conanRuntime> {
  if (!force && conanRuntime && Date.now() - conanRuntime.at < 30_000) {
    return conanRuntime;
  }
  // User-pinned env (V3-4): a configured envDir with conan wins over heuristics.
  const tools = toolOverridesConfig();
  const overridePath = (tools['conan'] ?? '').trim();
  const overrideEnv = (tools['envDir'] ?? '').trim();
  let pinned: { exe: string; prefix?: string; envName?: string } | undefined;
  if (overridePath && existsSync(overridePath)) {
    pinned = { exe: overridePath };
  } else if (overrideEnv && existsSync(overrideEnv)) {
    for (const sub of ['Scripts', join('Library', 'bin'), 'bin']) {
      const cand = join(overrideEnv, sub, process.platform === 'win32' ? 'conan.exe' : 'conan');
      if (existsSync(cand)) {
        pinned = {
          exe: cand,
          envName: 'custom',
          prefix: [join(overrideEnv, 'Scripts'), join(overrideEnv, 'Library', 'bin'), join(overrideEnv, 'condabin')].join(delimiter),
        };
        break;
      }
    }
  }

  const resolved = pinned ? undefined : await resolveConanRuntime();
  const exe = pinned?.exe ?? resolved?.exe;
  if (!exe) {
    conanRuntime = null;
    return null;
  }
  const rt = resolved?.runtime;
  const prefix = pinned?.prefix ?? rt?.pathPrefix;
  if (prefix && !(process.env.PATH ?? '').includes(rt?.envDir ?? overrideEnv)) {
    process.env.PATH = `${prefix}${delimiter}${process.env.PATH ?? ''}`;
    log(`[conda] PATH prefix for ${pinned?.envName ?? rt?.envName ?? 'env'} (${rt?.envDir ?? overrideEnv})`);
  }
  let version = '';
  const v = await run(exe, ['--version'], { timeoutMs: 15000 }).catch(() => null);
  if (v && v.code === 0) {
    version = v.stdout.split(/\r?\n/)[0].trim();
  }
  conanRuntime = {
    exe,
    envName: pinned?.envName ?? rt?.envName,
    pathPrefix: prefix,
    version,
    at: Date.now(),
    overrideUser: !!pinned,
  };
  log(`[conda] conan=${exe} env=${conanRuntime.envName ?? 'PATH'} version=${version}${conanRuntime.overrideUser ? ' (用户自定义)' : ''}`);
  await refreshChip();
  return conanRuntime;
}
const buildDiagnostics = vscode.languages.createDiagnosticCollection('het-build');

/**
 * Read-only activation evidence (also written to the "HeT DevTools" output
 * channel). Exposed so the automated integration smoke test can assert the
 * exact activation line without manual F5 inspection.
 */
export function getActivationLine(): string {
  return activationLine;
}

/** Resolve GitHub identity via the D-9 three-tier chain (session → gh → anon). */
async function resolveGithubAuth(): Promise<AuthInfo> {
  const service = new GithubAuthService({
    scopes: ['repo', 'workflow', 'read:user'],
    getVsCodeSession: async () => {
      try {
        const s = await vscode.authentication.getSession('github', ['repo', 'workflow', 'read:user'], { createIfNone: false });
        return s ? { account: { id: s.account.id, label: s.account.label }, scopes: s.scopes } : undefined;
      } catch {
        return undefined;
      }
    },
    checkGh: createGhAuthChecker(),
  });
  return service.resolve();
}

/** Entry point: wires Phase 1 host features (detection, status bar, build). */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const startedAt = Date.now();

  // T-5.2: opt-in anonymous local telemetry (default OFF, nothing leaves this machine).
  const track = (name: string): void => {
    try {
      if (vscode.workspace.getConfiguration('het').get<boolean>('telemetry.enabled', false)) {
        const key = `het.stats.${name}`;
        void context.workspaceState.update(key, (context.workspaceState.get<number>(key) ?? 0) + 1);
        void context.workspaceState.update('het.stats.lastActive', Date.now());
        log(`[telemetry] ${name} (local counter)`);
      }
    } catch {
      /* never breaks activation */
    }
  };

  channel = vscode.window.createOutputChannel(LOG_CHANNEL_NAME);
  setOutputChannel(channel);
  context.subscriptions.push(channel, buildDiagnostics);
  // `context.extension.id` is the authoritative `<publisher>.<name>` of THIS
  // host — a hardcoded id breaks the moment the publisher is renamed
  // (het-test-publisher → het-fti; see src/test/hostExtension.ts).
  activationLine = `activated — ${context.extension.id} v${context.extension.packageJSON.version}`;
  log(activationLine);
  contextRef = context;
  track('activation');

  // V4-8: once per activation, GC pure leftovers in managed storage (keeps any
  // retryable tree; the real uninstall-clean is VS Code deleting globalStorage).
  void managedGc(context.globalStorageUri.fsPath);

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  context.subscriptions.push(statusItem);
  await refreshStatus();

  // Test Explorer: discover test_package/test/unit GTest cases, run via conan create.
  registerTestController(context, { projectRoot: () => currentProject?.root, run: executeTestRun });

  // P-G2: feed cockpit pages with live host data (overview / build-test first).
  setCockpitPageProvider('overview', async () => {
    const snap = await buildSnapshot();
    const rt = await ensureConanRuntime();
    // V5-2B: the overview env view is authoritative via plan/managed/lane; the
    // only generic-tool rows left are non-empty manual overrides (het.tools).
    const overrides = toolOverridesConfig();
    const envRows: ToolRow[] = Object.entries(overrides).map(([key, exe]) => {
      const def = TOOL_DEFS.find((d) => d.key === key);
      return { key, label: def?.label ?? key, exe, source: 'override' as const, overridden: true, sourceDetail: '' };
    });
    const plan = await getCurrentProvisionPlan(false, provisionPrefs()).catch(() => null);
    const storage = contextRef?.globalStorageUri.fsPath ?? '';
    const managed = storage ? currentManagedStatus(storage, process.platform === 'win32') : null;
    return {
      projectName: currentProject?.metadata?.name,
      version: currentProject?.metadata?.version,
      buildType: currentProject?.metadata?.build_type,
      healthScore: snap.health?.score,
      tools: Object.entries(snap.tools).map(([name, t]) => ({ name, ok: t.state === 'ok' })),
      lastBuildOk: lastBuildOk ?? null,
      lastTest: lastTestSummary
        ? { passed: lastTestSummary.passed, failed: lastTestSummary.failed, skipped: lastTestSummary.skipped }
        : null,
      runtime: rt ? { version: rt.version, envName: rt.envName, custom: rt.overrideUser === true } : null,
      envRows,
      plan: plan ? { label: providerLabel(plan.provider), coverage: plan.coverage, reason: plan.reason } : null,
      // T06: the unified contract is the preferred overview view — the four
      // legacy per-platform blocks stay only as a fallback for payloads built
      // elsewhere (tests/fixtures).
      contract: await collectEnvContract().catch(() => null),
      managed: managed && managed.state !== 'absent' ? managed : null,
      wsl:
        process.platform === 'win32' && (plan?.provider === 'win-wsl2' || plan?.provider === 'win-wsl2-pending')
          ? ((await getWslLaneStatus(false).catch(() => null)) as { distro?: string; ready: boolean; tools: Record<string, string>; note?: string } | null)
          : null,
      osx:
        process.platform === 'darwin' && plan?.provider === 'macos-native'
          ? ((await getMacosLaneStatus(false).catch(() => null)) as { clt: boolean; clangVersion?: string; python?: string; note?: string } | null)
          : null,
      linux:
        process.platform === 'linux' && plan?.provider === 'linux-managed'
          ? ((await getLinuxLaneStatus(false).catch(() => null)) as { home: string; ready: boolean; tools: Record<string, string>; note?: string } | null)
          : null,
    };
  });
  setCockpitPageProvider('buildTest', async () => ({
    lastBuildOk: lastBuildOk ?? null,
    lastTest: lastTestSummary
      ? { passed: lastTestSummary.passed, failed: lastTestSummary.failed, skipped: lastTestSummary.skipped }
      : null,
  }));

  // P-G2: light live summaries for the remaining pages (forms migrate later).
  const rootOf = (): string | undefined => currentProject?.root;
  const countIn = async (dir: string, re: RegExp): Promise<number> => {
    const root = rootOf();
    if (!root) {
      return 0;
    }
    const { readdir } = await import('node:fs/promises');
    try {
      return (await readdir(join(root, dir))).filter((n) => re.test(n)).length;
    } catch {
      return 0;
    }
  };

  setCockpitPageProvider('deps', async () => {
    const root = rootOf();
    if (!root) {
      return { items: [], issues: ['未检测到项目'] };
    }
    let ct = '';
    try {
      ct = await readText(join(root, 'conandata.yml'));
    } catch {
      /* missing */
    }
    const views = listDependencies(await loadMetadata(root), ct);
    return {
      items: views.map((v) => ({
        bucket: v.bucket,
        displayKey: v.displayKey,
        conanName: v.conanName,
        version: v.version,
        targets: v.targets,
      })),
      issues: [],
    };
  });

  setCockpitPageProvider('moduleTest', async () => {
    const headers = await countIn('include', /\.(hpp|h)$/);
    const tests = await countIn('test_package/test/unit', /\.cpp$/);
    return {
      rows: [
        ['模块头文件（include/）', `${headers} 个`],
        ['单元测试文件', `${tests} 个`],
      ],
      actions: [
        { cmd: 'het.newModule', icon: 'new-file', label: '新增模块' },
        { cmd: 'het.generateTests', icon: 'symbol-method', label: '生成测试（A/B）' },
      ],
    };
  });

  setCockpitPageProvider('docs', async () => {
    const root = rootOf();
    const [doxy, dot, sph, mk] = await Promise.all([which('doxygen'), which('dot'), which('sphinx-build'), which('make')]);
    const artifacts = root ? (await pathExists(join(root, 'docs', 'sphinx', 'build', 'html', 'index.html')) ? '已有产物' : '未生成') : '—';
    return {
      rows: [
        ['Doxygen', doxy ? '✓' : '✗'],
        ['Graphviz', dot ? '✓' : '✗'],
        ['Sphinx', sph ? '✓' : '✗'],
        ['make（Sphinx 段）', mk ? '✓' : '✗'],
        ['产物', artifacts],
      ],
      actions: [{ cmd: 'het.docs', icon: 'book', label: '文档中心' }],
    };
  });

  setCockpitPageProvider('quality', async () => {
    const [fmt, tidy, gl] = await Promise.all([which('clang-format'), which('clang-tidy'), which('gitleaks')]);
    return {
      rows: [
        ['clang-format', fmt ? '✓' : '✗'],
        ['clang-tidy', tidy ? '✓' : '✗'],
        ['gitleaks', gl ? '✓' : '✗'],
        ['commitlint', '内置规则 ✓'],
      ],
      actions: [{ cmd: 'het.quality', icon: 'shield', label: '质量与安全' }],
    };
  });

  setCockpitPageProvider('commit', async () => {
    const root = rootOf();
    let branch = '—';
    let changes = 0;
    if (root) {
      const git = await which('git');
      if (git) {
        const br = await run(git, ['-C', root, 'branch', '--show-current']).catch(() => null);
        branch = br && br.code === 0 ? br.stdout.trim() : '—';
        const st = await run(git, ['-C', root, 'status', '--porcelain']).catch(() => null);
        changes = st ? parsePorcelain(st.stdout).length : 0;
      }
    }
    return {
      rows: [
        ['当前分支', branch],
        ['工作区变更', `${changes} 个文件`],
      ],
      actions: [{ cmd: 'het.commit', icon: 'git-commit', label: '提交助手' }],
    };
  });

  setCockpitPageProvider('release', async () => {
    const root = rootOf();
    if (!root) {
      return { rows: [] as [string, string][], actions: [{ cmd: 'het.release', icon: 'rocket', label: '发布中心' }], note: '未检测到项目' };
    }
    const meta = await loadMetadata(root);
    const triggers: Record<string, boolean> = { ...(meta.workflow_triggers ?? {}) };
    const changelog = await pathExists(join(root, 'CHANGELOG.md'));
    return {
      rows: [
        ['release 开关', triggers.release === true ? '✓ 已开启' : '✗ 未开启'],
        ['build_type', meta.build_type ?? '—'],
        ['CHANGELOG.md', changelog ? '✓' : '✗（发布时自动生成）'],
      ],
      actions: [
        { cmd: 'het.release', icon: 'rocket', label: '发布中心' },
        { cmd: 'het.preflight', icon: 'checklist', label: '发布前检查' },
      ],
    };
  });

  setCockpitPageProvider('bench', async () => {
    const root = rootOf();
    let platform = '未配置';
    if (root) {
      try {
        const cfg = JSON.parse(await readText(join(root, 'benchmark', 'platform', 'bench_config.json'))) as Record<string, unknown>;
        platform = configPlatform(cfg) === 'm' ? 'Cortex-M 裸机' : configPlatform(cfg) === 'a' ? 'Cortex-A Linux' : '未知';
      } catch {
        platform = '未配置';
      }
    }
    return {
      platform,
      parsed: lastBenchParse,
      note: '无硬件可“只构建（--no-flash）”或粘贴模拟串口输出解析。',
    };
  });

  // P-G2 deep forms: interactive page actions inside the cockpit.
  setCockpitPageHandler('deps', async (action, data) => {
    const svc = createDepsService();
    if (action === 'deps:add') {
      const res = await svc.add({
        conanName: (data.conanName ?? '').trim(),
        version: (data.version ?? '').trim(),
        bucket: data.bucket as DepBucket,
        targets: data.targets,
      });
      void vscode.window.showInformationMessage(res.message);
      return;
    }
    if (action === 'deps:remove') {
      const res = await svc.remove(data.bucket, data.key);
      void vscode.window.showInformationMessage(res.message);
    }
  });
  setCockpitPageHandler('bench', async (action, data) => {
    if (action === 'bench:parse') {
      const parsed = parseBenchmarkProtocol(data.text ?? '');
      lastBenchParse = { complete: parsed.complete, cases: parsed.cases.map((c) => [c.name, String(c.value)] as [string, string]) };
    }
  });
  setCockpitPageHandler('overview', async (action, data) => {
    if (action === 'env:set' || action === 'env:clear') {
      await handleEnvManualAction(action, (data.tool ?? '').trim());
      return;
    }
    if (action === 'env:prepare') {
      await vscode.commands.executeCommand('het.envPrepare');
      return;
    }
    if (action === 'env:use-system') {
      // Explicit, user-confirmed fallback (never silent): lane blocked → system.
      await vscode.commands.executeCommand('het.useSystemToolchain');
      return;
    }
    if (action === 'env:remove') {
      await vscode.commands.executeCommand('het.envRemove');
    }
  });

  // P-G4: five-step onboarding wizard facts + finish handler.
  {
    const tpl = templateSourceForInit();
    const parentDir =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.env.USERPROFILE ?? '';
    const local = firstAvailableTemplate();
    setCockpitWizardInfo({
      templateRepo: tpl.repo ?? TEMPLATE_REPO,
      templateRef: tpl.ref ?? 'HEAD',
      modeLabel:
        tpl.mode === 'local' && tpl.localPath
          ? `本地副本：${tpl.localPath}`
          : local
            ? `${local.label}${local.path.includes('assets') ? '（离线新建可用）' : ''}`
            : '远程（固定推荐版本，需网络）',
      parentDir,
      localPath: local?.path ?? '',
      hasLocal: !!local,
    });
    setCockpitWizardFinishHandler(async (draft) => {
      const name = (draft.name ?? '').trim();
      if (!/^[A-Za-z0-9_-]+$/.test(name)) {
        return { ok: false, message: '项目名仅允许字母/数字/下划线/连字符。' };
      }
      const parent = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.env.USERPROFILE ?? '';
      if (!parent) {
        return { ok: false, message: '无法确定目标目录：请先打开一个工作区文件夹。' };
      }
      const dest = join(parent, name);
      const metadataExtra: Record<string, unknown> = {};
      if (draft.buildType) {
        metadataExtra.build_type = draft.buildType;
      }
      if (draft.cppstd) {
        metadataExtra.build_cppstd = draft.cppstd;
      }
      if (draft.pybind === 'yes') {
        metadataExtra.enable_python_bindings = true;
      }
      const choice = await vscode.window.showWarningMessage(
        `在 ${dest} 创建项目 ${name}？\n\n将复制模板 → 改写 metadata.json（name/description/构建参数，保留原排版、无 .bak）→（有 git 时）git init + 基线提交 → 记录 .het/template-ref.json。`,
        { modal: true },
        '创建',
        '取消',
      );
      if (choice !== '创建') {
        return { ok: false, message: '已取消' };
      }
      const res = await newProjectFromTemplate({
        name,
        description: (draft.description ?? '').trim() || undefined,
        dest,
        confirmed: true,
        metadataExtra,
        prefer: (draft.source as 'pinned' | 'release' | 'local' | undefined) ?? undefined,
      });
      if (res.ok) {
        log(`[wizard] created ${name} @ ${dest}`);
        await refreshStatus();
        if (!isTestHost) {
          await openProjectFolder(dest);
        }
      }
      return { ok: res.ok, message: res.message };
    });
  }

  setCockpitPageProvider('collab', async () => {
    const root = rootOf();
    const workflows = root ? await countIn('.github/workflows', /\.(yml|yaml)$/) : 0;
    const marker = root ? (await pathExists(join(root, '.het', 'template-ref.json')) ? '✓' : '✗') : '—';
    return {
      rows: [
        ['本地工作流', `${workflows} 个`],
        ['模板标记', marker],
      ],
      actions: [
        { cmd: 'het.ci', icon: 'globe', label: 'CI 状态' },
        { cmd: 'het.audit', icon: 'report', label: '审计报告' },
        { cmd: 'het.templateUpdate', icon: 'sync', label: '模板更新' },
        { cmd: 'het.patent', icon: 'lightbulb', label: '专利向导' },
      ],
    };
  });

  setCockpitPageProvider('settings', async () => {
    const root = rootOf();
    if (!root) {
      return { rows: [] as [string, string][], actions: [{ cmd: 'het.openSettings', icon: 'settings-gear', label: '项目设置' }], note: '未检测到项目' };
    }
    const meta = await loadMetadata(root);
    return {
      rows: [
        ['name', meta.name ?? '—'],
        ['version', meta.version ?? '—'],
        ['build_type', meta.build_type ?? '—'],
        ['doc_languages', (meta.doc_languages ?? []).join('、') || '—'],
      ],
      actions: [{ cmd: 'het.openSettings', icon: 'settings-gear', label: '项目设置（metadata.json）' }],
    };
  });

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => void refreshStatus()),
    vscode.commands.registerCommand('het.hello', () => {
      void vscode.window.showInformationMessage('HeT DevTools smoke test passed ✔');
    }),
    vscode.commands.registerCommand('het.getActivationLine', () => activationLine),
    vscode.commands.registerCommand('het.getCurrentProject', () => currentProject?.metadata?.name ?? null),
    vscode.commands.registerCommand('het.hasProject', () => currentProject !== undefined),
    vscode.commands.registerCommand('het.cockpit', () => openCockpitPanel(context)),
    vscode.commands.registerCommand('het.getCockpitState', () => getCockpitState()),
    vscode.commands.registerCommand('het.getChipState', () => lastChip),
    vscode.commands.registerCommand('het.getConanRuntime', async () => ensureConanRuntime()),
    vscode.commands.registerCommand('het.getEnvRows', async () => ensureToolDiscovery()),
    vscode.commands.registerCommand('het.getHostCapabilities', async (force?: boolean) => getHostCapabilities(!!force)),
    vscode.commands.registerCommand('het.getProvisionPlan', async (force?: boolean) => getCurrentProvisionPlan(!!force, provisionPrefs())),
    vscode.commands.registerCommand('het.getWslLane', async (force?: boolean) => getWslLaneStatus(!!force)),
    vscode.commands.registerCommand('het.getMacosLane', async (force?: boolean) => getMacosLaneStatus(!!force)),
    vscode.commands.registerCommand('het.getLinuxLane', async (force?: boolean) => getLinuxLaneStatus(!!force)),
    vscode.commands.registerCommand('het.envStatus', () => {
      const ctx = contextRef;
      return ctx ? currentManagedStatus(ctx.globalStorageUri.fsPath, process.platform === 'win32') : { state: 'absent' as const, tools: {} };
    }),
    vscode.commands.registerCommand('het.envGc', () => {
      const ctx = contextRef;
      return ctx ? managedGc(ctx.globalStorageUri.fsPath) : { state: 'absent' as const, tools: {} };
    }),
    vscode.commands.registerCommand('het.envPrepare', () => runEnvPrepare()),
    vscode.commands.registerCommand('het.envRemove', () => runEnvRemove()),
    vscode.commands.registerCommand('het.envDump', () => runEnvDump()),
    vscode.commands.registerCommand('het.useSystemToolchain', () => switchToSystemToolchain()),
    vscode.commands.registerCommand('het.refresh', () => refreshStatus()),
    vscode.commands.registerCommand('het.build', () => { track('build'); return buildProject(); }),
    vscode.commands.registerCommand('het.dashboard', (section?: string) => openDashboard(context, section)),
    vscode.commands.registerCommand('het.test', () => { track('test'); return runTests(); }),
    vscode.commands.registerCommand('het.showTestResults', () => showStoredTestResults(context)),
    vscode.commands.registerCommand('het.openSettings', () => openSettingsPanel(context)),
    vscode.commands.registerCommand('het.openDeps', () => openDashboard(context, 'deps')),
    vscode.commands.registerCommand('het.addDependency', () => runDepsAddFlow()),
    vscode.commands.registerCommand('het.refreshConanIndex', () => runConanIndexRefresh()),
    vscode.commands.registerCommand('het.newModule', () => openModuleWizard(context)),
    vscode.commands.registerCommand('het.generateTests', () => openTestgenPanel(context)),
    vscode.commands.registerCommand('het.coverage', () => openCoveragePanel(context)),
    vscode.commands.registerCommand('het.docs', () => { track('docs'); return openDocsPanel(context); }),
    vscode.commands.registerCommand('het.docsRun', async () => {
      track('docs');
      if (!docsRunImpl) {
        try {
          // Opening the center binds docsRunImpl synchronously (panel creation
          // may itself fail headless — the binding still happens first).
          openDocsPanel(context);
        } catch {
          /* fall through: rely on the binding made before showDocsPanel */
        }
      }
      if (!docsRunImpl) {
        return { ok: false, message: '文档中心未初始化：请先运行 het.docs 再调用 het.docsRun。' };
      }
      return docsRunImpl();
    }),
    vscode.commands.registerCommand('het.getLastDocsOutput', () => lastDocsOutput.slice(-3000)),
    vscode.commands.registerCommand('het.quality', () => { track('quality'); return openQualityPanel(context); }),
    vscode.commands.registerCommand('het.commit', () => openCommitPanel(context)),
    vscode.commands.registerCommand('het.commitRelease', () => openCommitPanel(context, { type: 'chore', emoji: ':package:', subject: 'bump version' })),
    vscode.commands.registerCommand('het.release', () => openReleasePanel(context)),
    vscode.commands.registerCommand('het.preflight', () => openPreflightPanel(context)),
    vscode.commands.registerCommand('het.benchmark', () => { track('benchmark'); return openBenchPanel(context); }),
    vscode.commands.registerCommand('het.ci', () => openCiPanel(context)),
    vscode.commands.registerCommand('het.audit', () => { track('audit'); return runAuditReport(); }),
    vscode.commands.registerCommand('het.patent', () => runPatentWizard()),
    vscode.commands.registerCommand('het.newProject', () => runNewProjectWizard()),
    vscode.commands.registerCommand('het.chipOverview', () => showChipOverview()),
    vscode.commands.registerCommand('het.newProjectHere', (folder?: vscode.Uri | string) => initHere(folder)),
    vscode.commands.registerCommand('het.newProjectDirect', (opts: NewProjectOpts) => newProjectFromTemplate(opts)),
    vscode.commands.registerCommand('het.templateUpdate', async () => {
      await runTemplateUpdateCheck();
      void emitTemplateBehind();
    }),
    vscode.commands.registerCommand('het.healthCheck', () => {
      // 重新体检 = 强制重跑 + 回写 chip（开放面板由「明细」入口负责）。
      void ensureHealthCached(true);
    }),
    vscode.commands.registerCommand('het.envCheck', async () => {
      const ctx = contextRef;
      // V5-6: fresh env sample — invalidate the summary cache AND the cached
      // WSL lane probe so the check reflects reality (not a 60 s-old snapshot).
      envSummaryCache = null;
      await getWslLaneStatus(true).catch(() => null);
      const sample = ctx ? await collectEnvSample(ctx.globalStorageUri.fsPath).catch(() => null) : null;
      if (sample) {
        envSummaryCache = { at: Date.now(), summary: sample.summary };
      }
      await refreshChip();
      void ensureHealthCached(true);
      if (sample && !quietHost()) {
        void vscode.window.showInformationMessage(`开发环境：${sample.summary}`);
      }
      return sample?.summary ?? null;
    }),
    vscode.commands.registerCommand('het.openDocsArtifact', async (family?: string) => {
      const root = currentProject?.root;
      if (!root) {
        return;
      }
      const dir = family === 'doxygen' ? 'doxygen' : 'sphinx';
      // V5-8: Doxygen opens the language/version NAVIGATION hub (docs.html),
      // never a specific language/version page; Sphinx keeps html/index.html.
      const main = family === 'doxygen' ? join(root, 'docs', 'doxygen', 'build', 'docs.html') : '';
      const found = main && existsSync(main) ? main : await findFirstIndex(join(root, 'docs', dir, 'build'));
      if (!found) {
        void vscode.window.showWarningMessage(`未找到 ${dir} 文档产物（请先构建文档）。`);
        return;
      }
      void vscode.env.openExternal(vscode.Uri.file(found));
    }),
    vscode.commands.registerCommand('het.openBuildOutput', () => {
      channel?.show(true);
    }),
    vscode.commands.registerCommand('het.openCoverageReport', () => {
      const root = currentProject?.root;
      if (!root) {
        return;
      }
      const found = findCoverageReport(root);
      if (!found) {
        void vscode.window.showWarningMessage('未找到覆盖率报告（请先开启 activate_code_coverage 并构建测覆盖率）。');
        return;
      }
      void vscode.env.openExternal(vscode.Uri.file(found));
    }),
    vscode.commands.registerCommand('het.healthReport', () => showHealthReportPanel(context)),
    vscode.commands.registerCommand('het.getBuildOk', () => lastBuildOk ?? null),
    vscode.commands.registerCommand('het.getLastBuildError', () => lastBuildError),
    vscode.commands.registerCommand('het.getTestSummary', () =>
      lastTestSummary
        ? { passed: lastTestSummary.passed, failed: lastTestSummary.failed, skipped: lastTestSummary.skipped }
        : null,
    ),
    vscode.commands.registerCommand('het.getLastConanOutput', () => lastConanOutput.slice(-12000)),
  );

  // T-5.3: activation perf note + debounced metadata/conandata file watchers
  // (only these two files drive project state, per development-plan T-5.3).
  let refreshTimer: NodeJS.Timeout | undefined;
  const scheduleRefresh = (): void => {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(() => void refreshStatus(), 500);
  };
  const watcher1 = vscode.workspace.createFileSystemWatcher('**/metadata.json');
  const watcher2 = vscode.workspace.createFileSystemWatcher('**/conandata.yml');
  watcher1.onDidChange(scheduleRefresh);
  watcher1.onDidCreate(scheduleRefresh);
  watcher1.onDidDelete(scheduleRefresh);
  watcher2.onDidChange(scheduleRefresh);
  watcher2.onDidCreate(scheduleRefresh);
  watcher2.onDidDelete(scheduleRefresh);
  context.subscriptions.push(watcher1, watcher2);
  log(`[perf] activate ${Date.now() - startedAt}ms`);

  // @het Chat bridge (T-4.5, optional): intent → matching HeT GUI action.
  try {
    const participant = vscode.chat.createChatParticipant('het.assistant', async (request) => {
      const text = (request.prompt ?? '').toLowerCase();
      const intent: { re: RegExp; cmd: string; label: string; note: string }[] = [
        { re: /模块|新建|新增/, cmd: 'het.newModule', label: '新增模块向导', note: '填写模块名/简介后「生成预览 → 创建文件」' },
        { re: /测试|用例/, cmd: 'het.generateTests', label: '测试生成', note: '模式 A 从代码生成或模式 B 蓝图先行' },
        { re: /依赖/, cmd: 'het.openDeps', label: '依赖管理器', note: '四桶归属与 conandata/metadata 双写' },
        { re: /文档/, cmd: 'het.docs', label: '文档中心', note: '一键 Doxygen+Sphinx（含 graphviz 本机修正）' },
        { re: /质量|格式|静态/, cmd: 'het.quality', label: '质量与安全', note: 'format/tidy/schema/commitlint/gitleaks' },
        { re: /审计/, cmd: 'het.audit', label: '审计报告', note: '生成 workspace/audit-report.md 供 @workspace 引用' },
        { re: /发版|发布|release/, cmd: 'het.release', label: '发布中心', note: '开启开关 → 📦 提交 → CI 自动发版' },
        { re: /预检|preflight|门禁/, cmd: 'het.preflight', label: '发布前检查', note: '与 CI 门禁一致' },
        { re: /上板|bench|板卡/, cmd: 'het.benchmark', label: '上板测试', note: '无硬件可用 --no-flash + 模拟输出解析' },
        { re: /ci|流水线|actions/, cmd: 'het.ci', label: 'CI 状态', note: '离线降级为本地工作流清单' },
        { re: /提交/, cmd: 'het.commit', label: '提交助手', note: 'type(:emoji:) 双通道，commitlint 预检' },
        { re: /覆盖率/, cmd: 'het.coverage', label: '覆盖率', note: '开启 activate_code_coverage 后构建并测覆盖率' },
        { re: /驾驶舱|仪表/, cmd: 'het.dashboard', label: '驾驶舱', note: '健康分/环境/快捷动作' },
      ];
      const hit = intent.find((x) => x.re.test(text));
      if (hit) {
        void vscode.commands.executeCommand(hit.cmd);
        return { metadata: { command: hit.cmd } };
      }
      return { metadata: {} };
    });
    context.subscriptions.push(participant);
    log('[chat] @het participant registered');
  } catch (err) {
    log(`[chat] participant unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Assemble the data snapshot shared by the dashboard / welcome panels. */
async function buildSnapshot(): Promise<DashboardSnapshot> {
  const tools = await detectToolchain();
  const health = await runHealthCheck({ project: currentProject, tools });
  return { project: currentProject, tools, health };
}

function openDashboard(context: vscode.ExtensionContext, sectionArg?: unknown): void {
  const section = Array.isArray(sectionArg) ? String(sectionArg[0] ?? '') : typeof sectionArg === 'string' ? sectionArg : '';
  const target = section && isCockpitPage(section) ? (section as CockpitPage) : undefined;
  openCockpitPanel(context, target);
}

/** Dependency manager (G-07): list + add/remove with preview & dual-file write.
 *  Shared by the deps panel and the cockpit deps deep form. */
function createDepsService(): {
  getState: () => Promise<{ views: ReturnType<typeof listDependencies>; issues: string[] }>;
  add: (input: DepAddInput) => Promise<{ ok: boolean; message: string }>;
  remove: (bucket: string, displayKey: string) => Promise<{ ok: boolean; message: string }>;
} {
  const loadPair = async (): Promise<{ metadata: FcppMetadata; conandata: string }> => {
    const root = currentProject?.root;
    if (!root) {
      throw new Error('未检测到 fcpp 项目：请先打开含 metadata.json 的库文件夹。');
    }
    const metadata = await loadMetadata(root);
    let conandata: string;
    try {
      conandata = await readText(join(root, 'conandata.yml'));
    } catch {
      conandata = '# requirements (managed by HeT DevTools)\nrequirements:\n';
    }
    return { metadata, conandata };
  };

  const persistPair = async (metadata: FcppMetadata, conandata: string): Promise<void> => {
    const root = currentProject?.root;
    if (!root) {
      return;
    }
    await writeText(join(root, 'conandata.yml'), conandata);
    await writeText(join(root, 'metadata.json'), fcppStyleStringify(metadata));
  };

  return {
    getState: async () => {
      const { metadata, conandata } = await loadPair();
      return { views: listDependencies(metadata, conandata), issues: [] };
    },
    add: async (input: DepAddInput) => {
      const { metadata, conandata } = await loadPair();
      const targets = input.targets ? input.targets.split(',').map((t) => t.trim()).filter(Boolean) : undefined;
      const res = addDependency(metadata, conandata, {
        conanName: input.conanName,
        version: input.version,
        bucket: input.bucket,
        targets,
      });
      if (!res.ok || !res.nextMetadata || !res.nextConandataText) {
        return { ok: false, message: `添加失败：${res.issues.join('；')}` };
      }
      const choice = await vscode.window.showWarningMessage(
        `添加 ${input.conanName}@${input.version} 到 ${input.bucket} 桶？将写入 conandata.yml 与 metadata.json。`,
        { modal: true },
        '应用',
        '取消',
      );
      if (choice !== '应用') {
        return { ok: false, message: '已取消' };
      }
      await persistPair(res.nextMetadata, res.nextConandataText);
      await refreshStatus();
      return { ok: true, message: `已添加 ${input.conanName}@${input.version} → ${input.bucket}` };
    },
    remove: async (bucket, displayKey) => {
      const { metadata, conandata } = await loadPair();
      const res = removeDependency(metadata, conandata, { bucket: bucket as never, displayKey });
      if (!res.ok || !res.nextMetadata || !res.nextConandataText) {
        return { ok: false, message: `移除失败：${res.issues.join('；')}` };
      }
      const choice = await vscode.window.showWarningMessage(`移除依赖 ${displayKey}？将同时清理 conandata.yml 与 metadata.json。`, {
        modal: true,
      }, '应用', '取消');
      if (choice !== '应用') {
        return { ok: false, message: '已取消' };
      }
      await persistPair(res.nextMetadata, res.nextConandataText);
      await refreshStatus();
      return { ok: true, message: `已移除 ${displayKey}` };
    },
  };
}

/** V2-3: search-first dependency add via native QuickPick (offline curated index). */
async function runDepsAddFlow(): Promise<void> {
  const root = currentProject?.root;
  if (!root) {
    void vscode.window.showWarningMessage(L('notify.noProject'));
    return;
  }
  const svc = createDepsService();
  await runAddDependencyQuickPick({
    curated: CURATED_PACKAGES,
    modules: await discoverModuleNames(root),
    commit: async (input) => {
      const res = await svc.add(input);
      await refreshStatus();
      return res.message;
    },
  });
}

/** Discover candidate internal module names (include/ headers) for targets. */
async function discoverModuleNames(root: string): Promise<string[]> {
  const names: string[] = [];
  const { readdir } = await import('node:fs/promises');
  try {
    for (const f of await readdir(join(root, 'include'))) {
      const m = /^([^.]*)\.(hpp|h)$/.exec(f);
      if (m) {
        names.push(m[1]);
      }
    }
  } catch {
    /* no include dir */
  }
  return names;
}

/** V2-3: explicit ConanCenter refresh (never automatic; falls back to built-in). */
async function runConanIndexRefresh(): Promise<void> {
  const conan = await locateConan();
  if (!conan) {
    void vscode.window.showWarningMessage('未找到 conan：内置精选索引继续可用。');
    return;
  }
  void vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '刷新 ConanCenter 索引…' }, async () => {
    try {
      const r = await run(conan, ['search', '*', '-r', 'conancenter', '--format=json'], { timeoutMs: 120000 });
      if (r.code !== 0) {
        throw new Error(r.stderr.slice(-200));
      }
      let count = 0;
      try {
        const parsed = JSON.parse(r.stdout) as { results?: { items?: unknown[] }[] };
        count = parsed.results?.reduce((n, res) => n + (res.items?.length ?? 0), 0) ?? 0;
      } catch {
        count = 0;
      }
      await contextRef?.globalState.update('het.conanIndex.refreshedAt', Date.now());
      void vscode.window.showInformationMessage(
        count > 0 ? `ConanCenter 索引已刷新（${count} 个包）· 已缓存。` : 'ConanCenter 索引已刷新并缓存。',
      );
    } catch (err) {
      void vscode.window.showInformationMessage(
        `在线刷新不可用（${err instanceof Error ? err.message : String(err)}）· 回退到内置精选索引。`,
      );
    }
  });
}

/** New-module wizard (G-08): live preview then create the paired skeleton. */
function openModuleWizard(context: vscode.ExtensionContext): void {
  const toPlanInput = (input: ModulePanelInput) => ({
    moduleName: input.moduleName,
    description: input.description,
    language: input.language,
    since: input.since,
    extraDeclarations: (input.extraDeclarations ?? '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0),
  });

  const plan = async (input: ModulePanelInput) => {
    const p = planModuleFiles(toPlanInput(input));
    const conflicts: string[] = [];
    if (p.ok && currentProject) {
      for (const f of p.files) {
        if (await pathExists(join(currentProject.root, f.relPath))) {
          conflicts.push(f.relPath);
        }
      }
    }
    return { plan: p, conflicts };
  };

  const create = async (input: ModulePanelInput) => {
    const root = currentProject?.root;
    if (!root) {
      return { ok: false, message: '未检测到 fcpp 项目。' };
    }
    const p = planModuleFiles(toPlanInput(input));
    if (!p.ok) {
      return { ok: false, message: `无法生成：${p.issues.join('；')}` };
    }
    const existing: string[] = [];
    for (const f of p.files) {
      if (await pathExists(join(root, f.relPath))) {
        existing.push(f.relPath);
      }
    }
    if (existing.length > 0) {
      return { ok: false, message: `以下文件已存在，请先删除或改名：${existing.join('、')}` };
    }
    const labels = p.files.map((f) => f.relPath).join(' 与 ');
    const choice = await vscode.window.showWarningMessage(`创建 ${labels}？`, { modal: true }, '创建', '取消');
    if (choice !== '创建') {
      return { ok: false, message: '已取消' };
    }
    for (const f of p.files) {
      await writeText(join(root, f.relPath), f.content);
    }
    await refreshStatus();
    return { ok: true, message: `已创建 ${labels}。可在命令行运行“构建”或继续添加测试。` };
  };

  showModuleWizardPanel(context, { plan, create });
}

/** Test generation Mode A (G-09): discover modules, preview, add-only create. */
function openTestgenPanel(context: vscode.ExtensionContext): void {
  const listModules = async (): Promise<DiscoveredModule[]> => {
    const root = currentProject?.root;
    if (!root) {
      return [];
    }
    const { readdir } = await import('node:fs/promises');
    let names: string[] = [];
    try {
      names = await readdir(join(root, 'include'));
    } catch {
      return [];
    }
    const modules: DiscoveredModule[] = [];
    for (const n of names.filter((f) => /\.(hpp|h)$/.test(f)).sort()) {
      let content = '';
      try {
        content = await readText(join(root, 'include', n));
      } catch {
        continue;
      }
      const count = scanHeader(content).length;
      if (count > 0) {
        modules.push({ name: n.replace(/\.(hpp|h)$/, ''), header: n, apiCount: count });
      }
    }
    return modules;
  };

  const create = async (moduleName: string) => {
    const root = currentProject?.root;
    if (!root) {
      return { ok: false, message: '未检测到 fcpp 项目。' };
    }
    const plan = await planModuleTests(root, moduleName);
    if (!plan.ok) {
      return { ok: false, message: `无法生成：${plan.issues.join('；')}` };
    }
    const target = join(root, plan.relPath);
    if (await pathExists(target)) {
      return { ok: false, message: `${plan.relPath} 已存在，未覆盖。` };
    }
    const choice = await vscode.window.showWarningMessage(`创建 ${plan.relPath}？只新增测试文件，不改 include/ 与 src/。`, {
      modal: true,
    }, '创建', '取消');
    if (choice !== '创建') {
      return { ok: false, message: '已取消' };
    }
    await writeText(target, plan.content);
    await refreshStatus();
    return { ok: true, message: `已创建 ${plan.relPath}。可运行「构建并测试」验证。` };
  };

  const modeBPlan = (input: ModeBInput): { ok: boolean; issues: string[]; testRelPath: string; planRelPath: string; testContent: string; planContent: string; contractCount: number } | null => {
    const name = input.moduleName.trim().toLowerCase();
    if (!/^[a-z][a-z0-9_]*$/.test(name)) {
      return { ok: false, issues: ['模块名须为小写标识符（字母开头，仅 a-z/0-9/_）'], testRelPath: '', planRelPath: '', testContent: '', planContent: '', contractCount: 0 };
    }
    const parsed = parseBlueprint(input.blueprint);
    if (!parsed.ok) {
      return { ok: false, issues: parsed.issues, testRelPath: '', planRelPath: '', testContent: '', planContent: '', contractCount: 0 };
    }
    const title = input.title.trim() || `${name} 蓝图`;
    const notes = [`Blueprint: ${title}`, 'Test-first: implement until these contract cases go green.'];
    const testRelPath = `test_package/test/unit/${name}_contract_test.cpp`;
    const planRelPath = `workspace/${name}-blueprint-plan.md`;
    return {
      ok: true,
      issues: [],
      testRelPath,
      planRelPath,
      testContent: renderContractTest(name, parsed.contracts, notes),
      planContent: renderImplementationPlan(name, 'src', parsed.contracts, title),
      contractCount: parsed.contracts.length,
    };
  };

  const createModeB = async (input: ModeBInput) => {
    const root = currentProject?.root;
    if (!root) {
      return { ok: false, message: '未检测到 fcpp 项目。' };
    }
    const plan = modeBPlan(input);
    if (!plan || !plan.ok) {
      return { ok: false, message: `无法生成：${plan?.issues.join('；') ?? '输入无效'}` };
    }
    const existing = [plan.testRelPath, plan.planRelPath].filter((p) => p !== '');
    const hits: string[] = [];
    for (const p of existing) {
      if (await pathExists(join(root, p))) {
        hits.push(p);
      }
    }
    if (hits.length > 0) {
      return { ok: false, message: `以下文件已存在，请先删除或改名：${hits.join('、')}` };
    }
    const choice = await vscode.window.showWarningMessage(
      `写入契约测试与实现计划？\n  ${plan.testRelPath}\n  ${plan.planRelPath}\nMode B 不创建 include/src（按计划另行实现）。`,
      { modal: true },
      '写入',
      '取消',
    );
    if (choice !== '写入') {
      return { ok: false, message: '已取消' };
    }
    await writeText(join(root, plan.testRelPath), plan.testContent);
    await writeText(join(root, plan.planRelPath), plan.planContent);
    await refreshStatus();
    return { ok: true, message: `已生成契约测试与实现计划。按计划实现模块后运行「构建并测试」使契约转绿。` };
  };

  showTestgenPanel(context, {
    listModules,
    preview: (m) => {
      const root = currentProject?.root;
      return root ? planModuleTests(root, m) : Promise.resolve({ ok: false, issues: ['未检测到 fcpp 项目'], relPath: '', content: '' });
    },
    create,
    planModeB: (input) => {
      const plan = modeBPlan(input);
      return Promise.resolve(
        plan
          ? (plan as ModeBPreview)
          : { ok: false, issues: ['输入无效'], testRelPath: '', planRelPath: '', testContent: '', planContent: '', contractCount: 0 },
      );
    },
    createModeB,
  });
}

/** Coverage view (G-06): enable flag + run coverage build + open report.
 *  V5-6 (issue-2/3): shares the report locator with the chip, reports the
 *  outcome into module state (chip/health sync), heals the lane as needed. */
function openCoveragePanel(context: vscode.ExtensionContext): void {
  const getState = async (): Promise<CoverageState> => {
    const root = currentProject?.root;
    if (!root || !currentProject?.metadata) {
      return { projectName: '', enabled: false, reportPath: '' };
    }
    const meta = await loadMetadata(root);
    return {
      projectName: currentProject.metadata.name ?? '',
      enabled: meta.activate_code_coverage === true,
      reportPath: findCoverageReport(root),
    };
  };

  const toggle = async (enabled: boolean) => {
    const root = currentProject?.root;
    if (!root) {
      return { ok: false, message: '未检测到 fcpp 项目。' };
    }
    const applied = await applyMetadataPatch(root, { activate_code_coverage: enabled }, { persist: true });
    coverageProbeCache = null;
    if (applied.ok) {
      await refreshStatus();
      return { ok: true, message: enabled ? '已开启 activate_code_coverage。' : '已关闭 activate_code_coverage。' };
    }
    return { ok: false, message: `写入失败：${applied.issues.map((i) => i.message).join('；')}` };
  };

  const runCoverage = async () => {
    const project = currentProject;
    if (!project || !project.metadata) {
      return { ok: false, message: '未检测到 fcpp 项目。' };
    }
    const meta = await loadMetadata(project.root);
    if (meta.activate_code_coverage !== true) {
      return { ok: false, message: '请先开启 activate_code_coverage（覆盖率需要 g++/gcov 工具链）。' };
    }
    const result = await runConanOnce(project);
    const issues = parseCompilerOutput(`${result.stdout}\n${result.stderr}`);
    mapIssues(issues, project.root);
    markBuildOutcome(result.ok);
    emitCockpitEvent({ type: 'issue:summary', count: issues.length });
    coverageProbeCache = null; // force a fresh locate + % parse
    const report = findCoverageReport(project.root);
    void refreshChip();
    // V5-6: coverage changes the 工程健康 state — recompute it now (not stale).
    void ensureHealthCached(true);
    if (!result.ok) {
      return { ok: false, message: '覆盖率构建失败：请查看“问题”面板（车道内需 lcov/genhtml，缺则自动安装）。' };
    }
    if (report) {
      void vscode.env.openExternal(vscode.Uri.file(report));
      return { ok: true, message: `覆盖率构建成功，报告已打开：${report}` };
    }
    return { ok: false, message: '构建成功但未找到 coverage_report/index.html（报告位于 test_package/test/export/coverage/coverage_report 或项目 coverage_report/）。' };
  };

  showCoveragePanel(context, { getState, toggle, runCoverage });
}

/** T14: no graphviz path is written into metadata anymore — the lane uses `dot`
 *  from PATH (macOS/brew, WSL apt, Linux) and users may still pin one on purpose. */

/** Docs center (G-10): run docs/build.py, D-10 graphviz banner, open artifacts. */
function openDocsPanel(context: vscode.ExtensionContext): void {  const locateArtifacts = async (root: string): Promise<{ rel: string; abs: string }[]> => {
    const { readdir } = await import('node:fs/promises');
    const hits: { rel: string; abs: string }[] = [];
    const walk = async (dir: string, relBase: string, depth: number): Promise<void> => {
      if (depth > 7) {
        return;
      }
      let entries: { name: string; isDir: boolean }[] = [];
      try {
        const ds = await readdir(dir, { withFileTypes: true });
        entries = ds.map((d) => ({ name: d.name, isDir: d.isDirectory() }));
      } catch {
        return;
      }
      for (const e of entries) {
        const abs = join(dir, e.name);
        const rel = `${relBase}/${e.name}`;
        if (!e.isDir && e.name === 'index.html') {
          hits.push({ rel, abs });
        } else if (e.isDir && !e.name.startsWith('.') && e.name !== 'node_modules') {
          await walk(abs, rel, depth + 1);
        }
      }
    };
    await walk(join(root, 'docs', 'sphinx', 'build'), 'docs/sphinx/build', 0);
    // V5-8: the Doxygen language/version navigation hub is the FIRST artifact.
    const doxMain = join(root, 'docs', 'doxygen', 'build', 'docs.html');
    if (existsSync(doxMain)) {
      hits.push({ rel: 'docs/doxygen/build/docs.html', abs: doxMain });
    }
    await walk(join(root, 'docs', 'doxygen', 'build'), 'docs/doxygen/build', 0);
    return hits.sort((a, b) => (a.rel === 'docs/doxygen/build/docs.html' ? -1 : a.rel.localeCompare(b.rel)));
  };

  const getState = async (): Promise<DocsState> => {
    const root = currentProject?.root;
    if (!root || !currentProject?.metadata) {
      return { projectName: '', languages: [], versions: [], tools: [], graphvizMismatch: false, graphvizCurrent: '', graphvizExpected: '', artifacts: [] };
    }
    const meta = await loadMetadata(root);
    // V5-6 (issue-1): under the managed WSL2 lane the docs center must report
    // the LANE toolchain (venv python/sphinx + system doxygen/dot/make), not
    // the Windows-side sniff — otherwise it wrongly shows "Python ✗" and a
    // graphviz mismatch even though the lane auto-fixes/reconciles everything.
    const laneDistro = currentProject ? await managedLaneDistro(currentProject) : null;
    let gv: { mismatch: boolean; current: string; expected: string };
    let tools: DocToolStatus[];
    if (laneDistro) {
      const lane = await probeLaneDocsTools(laneDistro).catch(() => ({} as LaneDocsTools));
      tools = [
        { name: 'Python', ok: !!lane.python, note: lane.python ? '车道 venv' : '车道未就绪（首次构建自动准备）' },
        { name: 'Doxygen', ok: !!lane.doxygen, note: lane.doxygen ? '车道系统 apt' : '首次构建自动安装' },
        { name: 'Graphviz (dot)', ok: !!lane.dot, note: lane.dot ? '车道 /usr/bin' : '首次构建自动安装' },
        { name: 'Sphinx', ok: !!lane.sphinx, note: lane.sphinx ? '车道 venv' : '首次构建自动安装' },
        { name: 'make', ok: !!lane.make, note: lane.make ? '车道系统' : '首次构建自动安装' },
      ];
      // T14: nothing is written into metadata for the lane (dot comes from the
      // lane's PATH) — report "no mismatch" instead of silently rewriting the
      // project file, which used to force a "revert before committing" ritual.
      gv = { mismatch: false, current: meta.graphviz_bin ?? '', expected: '' };
    } else {
      const dotExe = await which('dot');
      gv = graphvizMismatch(meta, dotExe);
      tools = [
        { name: 'Python', ok: (await which('python')) !== null },
        { name: 'Doxygen', ok: (await which('doxygen')) !== null },
        { name: 'Graphviz (dot)', ok: dotExe !== null },
        { name: 'Sphinx', ok: (await which('sphinx-build')) !== null },
        { name: 'make', ok: process.platform !== 'win32' || (await which('make')) !== null, note: process.platform === 'win32' ? 'Sphinx 段需要' : undefined },
      ];
    }
    const opts = docsOptions(meta);
    return {
      projectName: currentProject.metadata.name ?? '',
      languages: opts.languages,
      versions: opts.versions,
      tools,
      graphvizMismatch: gv.mismatch,
      graphvizCurrent: gv.current,
      graphvizExpected: gv.expected,
      artifacts: await locateArtifacts(root),
    };
  };

  const runDocs = async () => {
    const root = currentProject?.root;
    if (!root) {
      return { ok: false, message: '未检测到 fcpp 项目。' };
    }
    // V5-6: visible progress — chip spinner + cockpit log drawer, exactly like
    // `conan create` (user feedback: docs build must show busy + explanations).
    lastDocsOutput = '';
    docsRunning = true;
    void refreshChip();
    const finish = (ok: boolean): void => {
      docsRunning = false;
      lastDocs = { ok, at: Date.now() };
      void refreshChip();
    };
    const stream = (c: string): void => {
      lastDocsOutput += c;
      channel?.append(c);
      emitCockpitEvent({ type: 'log:append', line: c.replace(/\s+$/u, '') });
    };
    // V5-4: Windows + managed → build docs INSIDE the WSL2 lane (docs stack is
    // self-provisioned: venv sphinx/numpy + apt doxygen/graphviz/make).
    if (process.platform === 'win32' && currentProject && (await projectToolchainFor(currentProject)) !== 'system') {
      const laneDistro = await managedLaneDistro(currentProject);
      if (laneDistro) {
        channel?.appendLine(`[docs] WSL2 车道文档构建：distro=${laneDistro} · ${root}`);
        emitCockpitEvent({ type: 'log:start', title: `docs/build.py · WSL2 ${laneDistro}` });
        let summary;
        try {
          summary = await runWslDocs(laneDistro, root, { onStdout: stream, onStderr: stream });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          channel?.appendLine(msg);
          emitCockpitEvent({ type: 'log:done', ok: false });
          finish(false);
          return { ok: false, message: msg };
        }
        const artifacts = await locateArtifacts(root);
        const ok = summary.ok;
        log(`[docs] lane finished ok=${ok} artifacts=${artifacts.length}`);
        emitCockpitEvent({ type: 'log:done', ok });
        finish(ok);
        if (!ok) {
          return { ok: false, message: '文档生成失败（车道）：请查看“输出 → HeT DevTools”。' };
        }
        return { ok: true, message: `文档生成完成，找到 ${artifacts.length} 个产物页面（WSL2 车道）。` };
      }
      const plan = await getCurrentProvisionPlan(false, provisionPrefs()).catch(() => null);
      if (plan?.provider === 'win-wsl2-pending') {
        finish(false);
        return { ok: false, message: 'managed 文档构建需要 WSL2 发行版（当前无可用发行版）。请先 wsl --install -d Ubuntu-24.04，或把 metadata.toolchain 设为 system。' };
      }
    }
    // T07: macOS + managed → docs INSIDE the macOS lane (venv sphinx; doxygen/
  // graphviz must come from brew — we guide instead of installing).
  if (process.platform === 'darwin' && currentProject && (await projectToolchainFor(currentProject)) !== 'system') {
    channel?.appendLine(`[docs] macOS 托管车道文档构建：${root}`);
    emitCockpitEvent({ type: 'log:start', title: 'docs/build.py · macOS lane' });
    let summary;
    try {
      summary = await runMacDocs(root, { onStdout: stream, onStderr: stream, mirror: laneMirrorConfig() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      channel?.appendLine(msg);
      emitCockpitEvent({ type: 'log:done', ok: false });
      finish(false);
      return { ok: false, message: msg };
    }
    const artifacts = await locateArtifacts(root);
    log(`[docs] macOS lane finished ok=${summary.ok} artifacts=${artifacts.length}`);
    emitCockpitEvent({ type: 'log:done', ok: summary.ok });
    finish(summary.ok);
    if (!summary.ok) {
      return { ok: false, message: '文档生成失败（macOS 车道）：请查看“输出 → HeT DevTools”。' };
    }
    return { ok: true, message: `文档生成完成，找到 ${artifacts.length} 个产物页面（macOS 车道）。` };
  }

  // A3: Linux + managed → docs INSIDE the native-Linux managed lane (venv
    // sphinx/numpy + apt doxygen/graphviz/make self-heal, same as the WSL2
    // lane). Falls through to native python only when no lane is available.
    if (process.platform === 'linux' && currentProject && (await projectToolchainFor(currentProject)) !== 'system') {
      const plan = await getCurrentProvisionPlan(false, provisionPrefs()).catch(() => null);
      if (plan?.provider === 'linux-managed') {
        channel?.appendLine(`[docs] Linux 托管车道文档构建：${root}`);
        emitCockpitEvent({ type: 'log:start', title: 'docs/build.py · Linux lane' });
        let summary;
        try {
          summary = await runLinuxDocs(root, { onStdout: stream, onStderr: stream });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          channel?.appendLine(msg);
          emitCockpitEvent({ type: 'log:done', ok: false });
          finish(false);
          return { ok: false, message: msg };
        }
        const artifacts = await locateArtifacts(root);
        const ok = summary.ok;
        log(`[docs] linux lane finished ok=${ok} artifacts=${artifacts.length}`);
        emitCockpitEvent({ type: 'log:done', ok });
        finish(ok);
        if (!ok) {
          return { ok: false, message: '文档生成失败（Linux 车道）：请查看“输出 → HeT DevTools”。' };
        }
        return { ok: true, message: `文档生成完成，找到 ${artifacts.length} 个产物页面（Linux 车道）。` };
      }
    }
    // macOS / multi-python hosts: docs/build.py imports numpy on its first
    // lines, so the native path must pick a python/python3 that can REALLY
    // `import numpy`. CI installs sphinx+numpy into the conan venv, so the
    // FIRST candidate is the interpreter that OWNS the resolved conan runtime
    // (its sibling `python`) — deterministic even when the host process PATH
    // is re-ordered/re-inherited (macOS Code/test-electron) and a system
    // python shadows the venv for which('python'). Falls back to PATH
    // python/python3, then to the first candidate if none imports numpy (so
    // build.py surfaces the raw missing-dependency error in the tail).
    const docsPyCands: (string | null)[] = [];
    const rt = await resolveConanRuntime().catch(() => null);
    if (rt?.exe) {
      const conanDir = dirname(rt.exe);
      docsPyCands.push(join(conanDir, 'python'), join(conanDir, 'python3'));
    }
    docsPyCands.push(await which('python'), await which('python3'));
    const candidates = [...new Set(docsPyCands.filter((p): p is string => !!p))];
    let python: string | null = null;
    for (const cand of candidates) {
      try {
        const probe = await run(cand, ['-c', 'import numpy'], { timeoutMs: 8000 });
        if (probe.code === 0) {
          python = cand;
          break;
        }
      } catch {
        /* keep searching */
      }
    }
    python = python ?? candidates[0] ?? null;
    if (!python) {
      finish(false);
      return { ok: false, message: '找不到 python（docs/build.py 需要）。请先安装 Python 3.10+。' };
    }
    const preamble = `[docs] ${python} docs/build.py @ ${root}`;
    lastDocsOutput += `${preamble}\n`;
    channel?.appendLine(preamble);
    // `docs/build.py` shells out to `sphinx-build` / `sphinx-intl` / `doxygen` /
    // `dot`. The interpreter we picked may live in a venv that is NOT on the
    // host PATH (e.g. a venv python resolved from the conan runtime), in which
    // case the sibling console scripts would not be found:
    //   FileNotFoundError: [Errno 2] No such file or directory: 'sphinx-intl'
    // Prepend the interpreter's own directory so its venv tools always resolve.
    const pyDir = dirname(python);
    const docsEnv = prependPath({ ...process.env }, pyDir, delimiter);
    channel?.appendLine(`[docs] PATH += ${pyDir}`);
    emitCockpitEvent({ type: 'log:start', title: `docs/build.py（本机）` });
    const result = await run(python, ['docs/build.py'], {
      cwd: root,
      env: docsEnv,
      onStdout: stream,
      onStderr: stream,
      timeoutMs: 0,
    });
    const artifacts = await locateArtifacts(root);
    const ok = result.code === 0;
    log(`[docs] finished ok=${ok} artifacts=${artifacts.length}`);
    emitCockpitEvent({ type: 'log:done', ok });
    finish(ok);
    if (!ok) {
      // A missing prerequisite must come back as an executable path, not a bare
      // traceback (the env-fresh `linux-system` job hit exactly this with numpy).
      const hint = docsFailureHint({ tail: lastDocsOutput.slice(-4000), python, platform: process.platform });
      return {
        ok: false,
        message: hint ?? '文档生成失败：请查看“输出 → HeT DevTools”中的原始日志（常见：注释标注/工具缺失）。',
      };
    }
    return { ok: true, message: `文档生成完成，找到 ${artifacts.length} 个产物页面。` };
  };

  const fixGraphviz = async () => {
    const root = currentProject?.root;
    if (!root) {
      return { ok: false, message: '未检测到 fcpp 项目。' };
    }
    const dotExe = await which('dot');
    const meta = await loadMetadata(root);
    const gv = graphvizMismatch(meta, dotExe);
    if (!gv.mismatch || !gv.expected) {
      return { ok: false, message: '无需修正（未配置或已匹配）。' };
    }
    const choice = await vscode.window.showWarningMessage(
      `把 graphviz_bin 从 ${gv.current} 改为 ${gv.expected}？\n注意：这是机器相关路径，提交前请还原或忽略该行。`,
      { modal: true },
      '修正',
      '取消',
    );
    if (choice !== '修正') {
      return { ok: false, message: '已取消' };
    }
    const applied = await applyMetadataPatch(root, { graphviz_bin: gv.expected }, { persist: true });
    if (applied.ok) {
      await refreshStatus();
      return { ok: true, message: '已本机修正 graphviz_bin（保留原排版）。提交前请还原该字段。' };
    }
    return { ok: false, message: `写入失败：${applied.issues.map((i) => i.message).join('；')}` };
  };

  const openArtifact = async (rel: string) => {
    const root = currentProject?.root;
    if (!root) {
      return;
    }
    const abs = join(root, rel);
    if (await pathExists(abs)) {
      void vscode.env.openExternal(vscode.Uri.file(abs));
    }
  };

  // P2: bind the SAME runner the panel uses to a headless entry (het.docsRun),
  // so real-host CI can drive the docs build without a webview round-trip.
  docsRunImpl = runDocs;
  showDocsPanel(context, { getState, runDocs, fixGraphviz, openArtifact });
}

/** V5-2/5-6: lightweight 体检明细 panel — every check with score, colour,
 *  detail. V5-6 (issue-3): a SINGLE live instance that re-renders whenever
 *  the chip state changes (ensureHealthCached → refreshChip →
 *  notifyStateChange), so "重新体检" and any build/test/coverage outcome are
 *  always byte-synced with the hover console — no fixed-delay hack. */
function showHealthReportPanel(context: vscode.ExtensionContext): void {
  if (healthPanel) {
    healthPanel.reveal(vscode.ViewColumn.Active);
    return;
  }
  healthPanel = vscode.window.createWebviewPanel(
    'het.healthReport',
    'HeT DevTools — 工程健康明细',
    vscode.ViewColumn.Active,
    { enableScripts: true, localResourceRoots: [context.extensionUri] },
  );
  healthPanel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');
  let busy = false;

  const render = (): void => {
    const panel = healthPanel;
    if (!panel) {
      return;
    }
    const r = lastHealthReport;
    const busyNote = busy ? '<div class="card warn">⏳ 体检中…（完成后自动刷新）</div>' : '';
    if (!r) {
      panel.webview.html = pageShell(
        '工程健康明细',
        `<h1>工程健康</h1>
         <div class="sub">尚未体检 — 点击重新体检，或先在项目中构建/测试。</div>
         ${busyNote}
         <button id="rerun">重新体检</button>
         <script>
           (function () { document.getElementById("rerun").onclick = () => vscode.postMessage({ type: "rerun" }); })();
         </script>`,
      );
      return;
    }
    const rows = r.checks
      .map((c) => {
        const cls = c.kind === 'ok' ? 'ok' : c.kind === 'warn' ? 'warn' : 'fail';
        const mark = c.kind === 'ok' ? '✓' : c.kind === 'warn' ? '!' : '✗';
        const part = c.grade !== undefined ? Math.round(c.weight * c.grade) : c.kind === 'ok' ? c.weight : c.kind === 'warn' ? Math.round(c.weight * 0.5) : 0;
        return `<div class="row">
          <span class="title"><span class="${cls}">${mark}</span> <b>${esc(c.title)}</b> <span class="tag">${part}/${c.weight}</span></span>
        </div>
        <div class="detail">${esc(c.detail)}</div>
        ${c.suggestion ? `<div class="suggest">建议：${esc(c.suggestion)}</div>` : ''}`;
      })
      .join('');
    const toneCls = r.verdict === 'PASS' ? 'ok' : r.verdict === 'WARN' ? 'warn' : 'fail';
    panel.webview.html = pageShell(
      '工程健康明细',
      `<h1>工程健康：<span class="${toneCls}">${r.score}/100 · ${verdictZh(r.verdict)}</span></h1>
       <div class="sub">12 项规则 · 绿≥80% · 黄≥50% · 红不达标（细粒度分级打分）</div>
       ${busyNote}
       <div class="card">${rows}</div>
       <button id="rerun">重新体检</button>
       <script>
         (function () { document.getElementById("rerun").onclick = () => vscode.postMessage({ type: "rerun" }); })();
       </script>`,
    );
  };

  // V5-6: re-render on every chip-state broadcast (single source of truth).
  const unsubscribe = onStateChange(render);
  healthPanel.onDidDispose(() => {
    unsubscribe();
    healthPanel = undefined;
  });
  healthPanel.webview.onDidReceiveMessage((message: { type: string }) => {
    if (message.type === 'rerun') {
      busy = true;
      render();
      void ensureHealthCached(true).then(() => {
        busy = false;
        render();
      });
    }
  });
  render();
}

/** Quality & security panel (G-11): native gates, degraded gracefully. */
function openQualityPanel(context: vscode.ExtensionContext): void {
  const listSourceFiles = async (root: string): Promise<{ rel: string; abs: string; family: 'c' | 'cpp' }[]> => {
    const { readdir } = await import('node:fs/promises');
    const out: { rel: string; abs: string; family: 'c' | 'cpp' }[] = [];
    for (const sub of ['include', 'src']) {
      const dir = join(root, sub);
      let names: string[] = [];
      try {
        names = await readdir(dir);
      } catch {
        continue;
      }
      for (const n of names) {
        const fam = formatConfigForFile(`${sub}/${n}`);
        if (fam) {
          out.push({ rel: `${sub}/${n}`, abs: join(dir, n), family: fam });
        }
      }
    }
    return out;
  };

  const gateRows = async (): Promise<QualityRow[]> => {
    const [fmt, tidy, gitLeaks, docker] = await Promise.all([
      which('clang-format'),
      which('clang-tidy'),
      which('gitleaks'),
      which('docker'),
    ]);
    return [
      {
        id: 'format',
        label: '格式检查 (clang-format)',
        tool: fmt ? 'clang-format · 双配置 C/C++' : 'clang-format 未安装',
        status: fmt ? 'idle' : 'na',
        detail: fmt ? undefined : '安装：pip install clang-format（本地绿=CI 绿，warning 即失败）',
      },
      {
        id: 'tidy',
        label: '静态检查 (clang-tidy)',
        tool: tidy ? 'clang-tidy · WarningsAsErrors' : 'clang-tidy 未安装',
        status: tidy ? 'idle' : 'na',
        detail: tidy ? undefined : '本机未安装 clang-tidy（CI 原生门禁），可经 LLVM/conda 安装后本地自检。',
      },
      {
        id: 'schema',
        label: '配置校验 (schema)',
        tool: 'metadata.json',
        status: 'idle',
      },
      {
        id: 'commitlint',
        label: '提交信息规范 (commitlint)',
        tool: '最近 10 次提交',
        status: 'idle',
      },
      {
        id: 'gitleaks',
        label: '密钥扫描 (gitleaks)',
        tool: gitLeaks ? 'gitleaks' : 'gitleaks 未安装',
        status: gitLeaks ? 'idle' : 'na',
        detail: gitLeaks ? undefined : 'CI 原生门禁（.github/misc/.gitleaks.toml）；本地安装 gitleaks 后可用。',
      },
      {
        id: 'megalinter',
        label: '深度扫描 (MegaLinter / SAST, advisory)',
        tool: docker ? 'Docker 可用' : '需要 Docker',
        status: docker ? 'idle' : 'na',
        detail: docker ? undefined : 'MegaLinter 为 advisory（semgrep/checkov/devskim）。安装 Docker 后通过 run-megalinter.sh 运行。',
      },
    ];
  };

  const runRow = async (rowId: string): Promise<QualityRunResult> => {
    const root = currentProject?.root;
    const err = (summary: string, errors: string[]): QualityRunResult => ({
      rowId,
      status: 'fail',
      summary,
      issues: [],
      errors,
    });
    const na = (summary: string, errors: string[]): QualityRunResult => ({ rowId, status: 'na', summary, issues: [], errors });
    if (!root) {
      return err('未检测到 fcpp 项目', []);
    }
    if (rowId === 'format') {
      const tool = await which('clang-format');
      if (!tool) {
        return na('格式检查不可用', ['缺少 clang-format：pip install clang-format']);
      }
      const files = await listSourceFiles(root);
      if (files.length === 0) {
        return { rowId, status: 'pass', summary: '无 include/src 源文件', issues: [], errors: [] };
      }
      const issues: QualityIssue[] = [];
      const errors: string[] = [];
      const toRel = (p: string): string => (p.startsWith(root) ? p.slice(root.length).replace(/^[\\/]+/, '') : p);
      for (const family of ['c', 'cpp'] as const) {
        const famFiles = files.filter((f) => f.family === family);
        if (famFiles.length === 0) {
          continue;
        }
        const cfg = join(root, `.github/misc/.clang-format-${family}`);
        if (!(await pathExists(cfg))) {
          errors.push(`缺少配置文件 .github/misc/.clang-format-${family}（从 fcpp 模板同步）。`);
          continue;
        }
        const res = await run(tool, ['--dry-run', '--Werror', `--style=file:${cfg}`, ...famFiles.map((f) => f.abs)], { cwd: root });
        issues.push(
          ...parseClangFormatOutput(`${res.stdout}\n${res.stderr}`).map((i) => ({ ...i, file: toRel(i.file) })),
        );
      }
      if (errors.length > 0) {
        return err('格式检查未能完整运行', errors);
      }
      if (issues.length > 0) {
        return { rowId, status: 'fail', summary: `格式检查失败：${issues.length} 个文件不符合格式`, issues, errors: [] };
      }
      return { rowId, status: 'pass', summary: '格式检查通过（所有 C/C++ 文件已 clang-formatted）', issues: [], errors: [] };
    }
    if (rowId === 'tidy') {
      const tool = await which('clang-tidy');
      if (!tool) {
        return na('静态检查不可用', ['缺少 clang-tidy']);
      }
      const cfg = join(root, '.github/misc/.clang-tidy');
      if (!(await pathExists(cfg))) {
        return na('静态检查不可用', ['缺少 .github/misc/.clang-tidy 配置文件']);
      }
      const files = (await listSourceFiles(root)).filter((f) => f.family === 'cpp').map((f) => f.abs);
      if (files.length === 0) {
        return { rowId, status: 'pass', summary: '无 C++ 源文件', issues: [], errors: [] };
      }
      const res = await run(tool, [`--config-file=${join(root, '.github/misc/.clang-tidy')}`, ...files, '--', '-std=c++17', '-Iinclude'], {
        cwd: root,
        timeoutMs: 0,
      });
      const issues = parseClangTidyOutput(`${res.stdout}\n${res.stderr}`);
      if (issues.length > 0 || res.code !== 0) {
        return { rowId, status: 'fail', summary: `静态检查失败：${issues.length} 条诊断（WarningsAsErrors）`, issues, errors: [] };
      }
      return { rowId, status: 'pass', summary: '静态检查通过', issues: [], errors: [] };
    }
    if (rowId === 'schema') {
      let meta;
      try {
        meta = await loadMetadata(root);
      } catch (e) {
        return err('metadata.json 读取失败', [e instanceof Error ? e.message : String(e)]);
      }
      const issues = validateMetadata(meta);
      if (hasErrors(issues)) {
        return {
          rowId,
          status: 'fail',
          summary: `配置校验失败：${issues.filter((i) => i.severity === 'error').length} 个错误`,
          issues: [],
          errors: issues.map((i) => `${i.field}: ${i.message}`),
        };
      }
      return { rowId, status: 'pass', summary: '配置校验通过（metadata.json 合规）', issues: [], errors: [] };
    }
    if (rowId === 'commitlint') {
      const git = await which('git');
      if (!git) {
        return na('提交规范检查不可用', ['缺少 git']);
      }
      const res = await run(git, ['-C', root, 'log', '--format=%s', '-n', '10']);
      const errors: string[] = [];
      for (const h of collectHeaders(res.stdout)) {
        const r = lintCommitHeader(h);
        if (!r.ok) {
          errors.push(`${h}\n    → ${r.errors.join('；')}`);
        }
      }
      if (errors.length > 0) {
        return { rowId, status: 'fail', summary: `commitlint：最近 10 次提交中 ${errors.length} 条不合规`, issues: [], errors };
      }
      return { rowId, status: 'pass', summary: 'commitlint：最近 10 次提交全部合规', issues: [], errors: [] };
    }
    if (rowId === 'gitleaks') {
      const tool = await which('gitleaks');
      if (!tool) {
        return na('密钥扫描不可用', ['缺少 gitleaks（CI 原生门禁）。本地可选安装后启用。']);
      }
      const cfg = join(root, '.github/misc/.gitleaks.toml');
      const res = await run(tool, ['detect', '--source', root, '--config', cfg, '--no-banner', '--redact'], { cwd: root, timeoutMs: 0 });
      if (res.code === 0) {
        return { rowId, status: 'pass', summary: '密钥扫描通过（未发现泄露）', issues: [], errors: [] };
      }
      return { rowId, status: 'fail', summary: '密钥扫描发现潜在泄露', issues: [], errors: [`${res.stdout}\n${res.stderr}`.slice(-2000)] };
    }
    if (rowId === 'megalinter') {
      const docker = await which('docker');
      if (!docker) {
        return na('MegaLinter 不可用', ['需要 Docker（advisory SAST）。安装 Docker 后本项自动启用。']);
      }
      const script = join(root, '.github/misc/run-megalinter.sh');
      if (!(await pathExists(script))) {
        return na('MegaLinter 不可用', ['缺少 .github/misc/run-megalinter.sh（从 fcpp 模板同步）。']);
      }
      const res = await run('bash', [script], { cwd: root, timeoutMs: 0 });
      const out = `${res.stdout}\n${res.stderr}`;
      if (res.code === 0) {
        return { rowId, status: 'pass', summary: 'MegaLinter SAST 通过（advisory）', issues: [], errors: [] };
      }
      return { rowId, status: 'fail', summary: 'MegaLinter 报告问题（advisory，可先查看报告目录）', issues: [], errors: [out.slice(-2000)] };
    }
    return err('未知检查项', []);
  };

  const fixFormat = async () => {
    const root = currentProject?.root;
    if (!root) {
      return { ok: false, message: '未检测到 fcpp 项目。' };
    }
    const tool = await which('clang-format');
    if (!tool) {
      return { ok: false, message: '缺少 clang-format：pip install clang-format' };
    }
    const files = await listSourceFiles(root);
    if (files.length === 0) {
      return { ok: false, message: '无 include/src 源文件' };
    }
    const choice = await vscode.window.showWarningMessage(
      `对 ${files.length} 个 C/C++ 文件执行 clang-format -i？（include/ 与 src/ 下全部）`,
      { modal: true },
      '修复',
      '取消',
    );
    if (choice !== '修复') {
      return { ok: false, message: '已取消' };
    }
    let fixed = 0;
    for (const family of ['c', 'cpp'] as const) {
      const famFiles = files.filter((f) => f.family === family).map((f) => f.abs);
      if (famFiles.length === 0) {
        continue;
      }
      const cfg = join(root, `.github/misc/.clang-format-${family}`);
      if (!(await pathExists(cfg))) {
        continue;
      }
      const res = await run(tool, ['-i', `--style=file:${cfg}`, ...famFiles], { cwd: root });
      if (res.code === 0) {
        fixed += famFiles.length;
      }
    }
    return { ok: true, message: fixed > 0 ? `已格式化 ${fixed} 个文件。` : '没有可修复的文件（配置缺失）。' };
  };

  showQualityPanel(context, {
    getRows: gateRows,
    runRow,
    fixFormat,
    openIssue: async (file, line) => {
      const root = currentProject?.root;
      if (!root) {
        return;
      }
      const abs = (await pathExists(join(root, file))) ? join(root, file) : file;
      void vscode.window.showTextDocument(vscode.Uri.file(abs), {
        selection: line ? new vscode.Range(line - 1, 0, line - 1, 0) : undefined,
        preview: true,
      });
    },
  });
}

/** Commit assistant (G-16): dual-channel conventional commits, preview + confirm. */
function openCommitPanel(context: vscode.ExtensionContext, prefill?: { type: string; emoji: string | null; subject: string }): void {
  const gitRun = async (args: string[], cwd: string) => {
    const git = await which('git');
    if (!git) {
      return null;
    }
    return run(git, ['-C', cwd, ...args], { cwd });
  };

  const getState = async (): Promise<CommitState> => {
    const root = currentProject?.root;
    if (!root || !currentProject?.metadata) {
      return { projectName: '', branch: '', changes: [], triggers: {}, buildType: '', triggerTests: false, suggestedType: 'chore', suggestedEmojiId: null, initialSubject: '' };
    }
    const meta = await loadMetadata(root);
    const triggers: Record<string, boolean> = { ...(meta.workflow_triggers ?? {}) };
    let branch = '';
    let changes: { path: string; staged: boolean; status: string }[] = [];
    const st = await gitRun(['status', '--porcelain'], root);
    if (st) {
      changes = parsePorcelain(st.stdout);
      const br = await gitRun(['branch', '--show-current'], root);
      branch = br ? br.stdout.trim() : '';
    }
    const paths = changes.map((c) => c.path);
    const suggestedType = prefill?.type ?? suggestType(paths);
    const emoji =
      prefill?.type && prefill.emoji !== undefined
        ? { id: TRIGGER_EMOJIS.find((t) => t.emoji === prefill.emoji)?.id ?? '', emoji: prefill.emoji }
        : defaultEmoji(suggestedType as never, {
            triggers,
            buildType: meta.build_type ?? 'Debug',
            triggerTests: meta.trigger_tests === true,
          });
    return {
      projectName: currentProject.metadata.name ?? '',
      branch,
      changes,
      triggers,
      buildType: meta.build_type ?? 'Debug',
      triggerTests: meta.trigger_tests === true,
      suggestedType,
      suggestedEmojiId: emoji?.id ?? null,
      initialSubject: prefill?.subject ?? '',
    };
  };

  const commit = async (req: CommitRequest) => {
    const root = currentProject?.root;
    if (!root) {
      return { ok: false, message: '未检测到 fcpp 项目。' };
    }
    if (req.paths.length === 0) {
      return { ok: false, message: '请至少勾选一个变更文件。' };
    }
    if (!req.subject.trim()) {
      return { ok: false, message: '请填写一句话描述。' };
    }
    const header = composeHeader(req.type as never, req.emoji, req.breaking, req.subject);
    const lint = lintCommitHeader(header);
    if (!lint.ok) {
      return { ok: false, message: `commitlint 未通过：${lint.errors.join('；')}` };
    }
    const branch = req.push
      ? await gitRun(['branch', '--show-current'], root).then((r) => (r ? r.stdout.trim() : ''))
      : '';
    const pushNote = req.push ? `，然后推送到 ${branch || '当前分支'}` : '（不推送）';
    const choice = await vscode.window.showWarningMessage(
      `提交 ${req.paths.length} 个文件？\n\n${header}${pushNote}\n\n（提交助手默认只 commit，推送需显式确认）`,
      { modal: true },
      '提交',
      '取消',
    );
    if (choice !== '提交') {
      return { ok: false, message: '已取消' };
    }
    const add = await gitRun(['add', '--', ...req.paths], root);
    if (!add) {
      return { ok: false, message: '找不到 git。' };
    }
    const c = await gitRun(['commit', '-m', header], root);
    const out = c ? `${c.stdout}\n${c.stderr}` : '';
    if (!c || c.code !== 0) {
      return { ok: false, message: `提交失败（无暂存改动或错误）：\n${out.slice(-800)}` };
    }
    if (req.push) {
      if (!branch) {
        return { ok: true, message: '已提交，但无法确定分支名，跳过推送。请手动推送。' };
      }
      const p = await gitRun(['push', 'origin', branch], root);
      if (!p || p.code !== 0) {
        return { ok: false, message: `已提交但推送失败：\n${(p ? `${p.stdout}\n${p.stderr}` : '').slice(-800)}` };
      }
    }
    await refreshStatus();
    return { ok: true, message: req.push ? `已提交并推送：${header}` : `已提交：${header}` };
  };

  showCommitPanel(context, { getState, commit });
}

/** Release center (G-12): workflow_triggers.release + guided 📦 flow. */
function openReleasePanel(context: vscode.ExtensionContext): void {
  const getState = async (): Promise<ReleaseState> => {
    const root = currentProject?.root;
    if (!root || !currentProject?.metadata) {
      return { projectName: '', version: '', buildType: '', releaseOn: false, docsOn: false, changelogExists: false, changelogHead: '', hasRemote: false };
    }
    const meta = await loadMetadata(root);
    const triggers: Record<string, boolean> = { ...(meta.workflow_triggers ?? {}) };
    let changelogHead = '';
    let changelogExists = false;
    const cl = join(root, 'CHANGELOG.md');
    if (await pathExists(cl)) {
      changelogExists = true;
      try {
        changelogHead = (await readText(cl)).slice(0, 2000);
      } catch {
        /* ignore */
      }
    }
    let hasRemote = false;
    const git = await which('git');
    if (git) {
      const r = await run(git, ['-C', root, 'remote', 'get-url', 'origin']).catch(() => null);
      hasRemote = !!r && r.code === 0 && r.stdout.trim().length > 0;
    }
    return {
      projectName: currentProject.metadata.name ?? '',
      version: meta.version ?? '',
      buildType: meta.build_type ?? '',
      releaseOn: triggers.release === true,
      docsOn: triggers.docs === true,
      changelogExists,
      changelogHead,
      hasRemote,
    };
  };

  const toggleRelease = async () => {
    const root = currentProject?.root;
    if (!root) {
      return { ok: false, message: '未检测到 fcpp 项目。' };
    }
    const meta = await loadMetadata(root);
    const triggers: Record<string, boolean> = { ...(meta.workflow_triggers ?? {}) };
    triggers.release = true;
    const choice = await vscode.window.showWarningMessage(
      `开启发布：写入 workflow_triggers.release=true 并将 build_type 设为 Release？\n（发布不可回滚，CI 收到 📦 提交后自动发版）`,
      { modal: true },
      '开启',
      '取消',
    );
    if (choice !== '开启') {
      return { ok: false, message: '已取消' };
    }
    const applied = await applyMetadataPatch(root, { workflow_triggers: triggers, build_type: 'Release' }, { persist: true });
    if (applied.ok) {
      await refreshStatus();
      return { ok: true, message: '已开启发布。用「提交助手并预填 📦」发起发布提交。' };
    }
    return { ok: false, message: `写入失败：${applied.issues.map((i) => i.message).join('；')}` };
  };

  showReleasePanel(context, {
    getState,
    toggleRelease,
    openCommitRelease: async () => {
      await vscode.commands.executeCommand('het.commitRelease');
    },
    openChangelog: async () => {
      const root = currentProject?.root;
      if (root) {
        void vscode.window.showTextDocument(vscode.Uri.file(join(root, 'CHANGELOG.md')), { preview: true });
      }
    },
  });
}

/** Pre-release gate (G-13): checklist aligned with CI gates. */
function openPreflightPanel(context: vscode.ExtensionContext): void {
  const getState = async (): Promise<PreflightState> => {
    const root = currentProject?.root;
    const items: PreflightItem[] = [];
    if (!root || !currentProject?.metadata) {
      return { projectName: '', items: [], passed: 0, total: 0, allowRelease: false };
    }
    const meta = await loadMetadata(root);

    // 1) build (session evidence)
    items.push({
      label: '构建成功',
      ok: lastBuildOk === undefined ? undefined : lastBuildOk,
      detail: lastBuildOk === undefined ? '本会话尚未构建 → 点击「运行构建并测试」' : lastBuildOk ? '最近一次构建成功' : '最近一次构建失败',
      required: true,
    });
    // 2) tests (session evidence)
    items.push({
      label: '测试全绿',
      ok: lastTestSummary ? lastTestSummary.failed === 0 && lastTestSummary.passed > 0 : undefined,
      detail: lastTestSummary
        ? `通过 ${lastTestSummary.passed} · 失败 ${lastTestSummary.failed} · 跳过 ${lastTestSummary.skipped}`
        : '本会话尚未运行测试',
      required: true,
    });

    // 3) quality (format quick + schema + commitlint)
    const tool = await which('clang-format');
    const files = await (async () => {
      const { readdir } = await import('node:fs/promises');
      const out: { abs: string; fam: 'c' | 'cpp' }[] = [];
      for (const sub of ['include', 'src']) {
        try {
          for (const n of await readdir(join(root, sub))) {
            const fam = formatConfigForFile(`${sub}/${n}`);
            if (fam) {
              out.push({ abs: join(root, sub, n), fam });
            }
          }
        } catch {
          /* missing dir */
        }
      }
      return out;
    })();
    let formatOk: boolean | undefined;
    if (tool && files.length > 0) {
      let allOk = true;
      for (const fam of ['c', 'cpp'] as const) {
        const famFiles = files.filter((f) => f.fam === fam).map((f) => f.abs);
        if (famFiles.length === 0) {
          continue;
        }
        const cfg = join(root, `.github/misc/.clang-format-${fam}`);
        if (!(await pathExists(cfg))) {
          allOk = false;
          break;
        }
        const res = await run(tool, ['--dry-run', '--Werror', `--style=file:${cfg}`, ...famFiles], { cwd: root });
        if (res.code !== 0) {
          allOk = false;
        }
      }
      formatOk = allOk;
    }
    let schemaOk = true;
    const schemaIssues = validateMetadata(meta);
    if (hasErrors(schemaIssues)) {
      schemaOk = false;
    }
    let commitOk = true;
    const git = await which('git');
    if (git) {
      const res = await run(git, ['-C', root, 'log', '--format=%s', '-n', '10']);
      for (const h of collectHeaders(res.stdout)) {
        if (!lintCommitHeader(h).ok) {
          commitOk = false;
        }
      }
    }
    const qualityOk = formatOk === true && schemaOk && commitOk;
    items.push({
      label: '质量门禁（format/schema/commitlint）',
      ok: formatOk === undefined ? undefined : qualityOk,
      detail:
        formatOk === undefined
          ? 'clang-format 不可用或配置缺失 → 在质量面板查看'
          : qualityOk
            ? '格式/配置/提交规范均绿'
            : `格式：${formatOk ? '绿' : '红'} · schema：${schemaOk ? '绿' : '红'} · commitlint：${commitOk ? '绿' : '红'}`,
      required: false,
    });

    // 4) docs tools (advisory)
    const docsNeed = ['python', 'doxygen', 'dot', 'sphinx-build'];
    const missing: string[] = [];
    if (process.platform === 'win32' && !(await which('make'))) {
      missing.push('make');
    }
    for (const d of docsNeed) {
      if (!(await which(d))) {
        missing.push(d);
      }
    }
    items.push({
      label: '文档可生成（工具齐全）',
      ok: missing.length === 0,
      detail: missing.length ? `缺少：${missing.join('、')}` : 'Doxygen/Sphinx/Graphviz 齐备',
      required: false,
    });

    // 5) working tree clean
    let clean = true;
    if (git) {
      const res = await run(git, ['-C', root, 'status', '--porcelain']);
      clean = res.stdout.trim().length === 0;
    }
    items.push({
      label: '无未提交变更',
      ok: clean,
      detail: clean ? '工作区干净' : '存在未提交变更（先提交助手收尾）',
      required: true,
    });

    // 6) CHANGELOG present
    const changelogExists = await pathExists(join(root, 'CHANGELOG.md'));
    items.push({ label: 'CHANGELOG.md 就绪', ok: changelogExists, detail: changelogExists ? undefined : '发布时由 semantic-release 自动生成', required: true });

    // 7) metadata switches (advisory)
    const triggers: Record<string, boolean> = { ...(meta.workflow_triggers ?? {}) };
    items.push({
      label: '发布开关与 build_type=Release',
      ok: triggers.release === true && (meta.build_type ?? '') === 'Release',
      detail: `release=${triggers.release === true} · build_type=${meta.build_type ?? ''}`,
      required: false,
    });

    const total = items.filter((i) => i.ok !== undefined).length;
    const passed = items.filter((i) => i.ok === true).length;
    const allowRelease = items.filter((i) => i.required).every((i) => i.ok === true);
    return { projectName: currentProject.metadata.name ?? '', items, passed, total, allowRelease };
  };

  showPreflightPanel(context, {
    getState,
    runTests: async () => {
      await vscode.commands.executeCommand('het.test');
      const ok = lastBuildOk === true && lastTestSummary?.failed === 0 && (lastTestSummary?.passed ?? 0) > 0;
      return { ok, message: ok ? '构建与测试全绿。' : '构建或测试未全绿，请查看结果面板。' };
    },
    openQuality: async () => {
      await vscode.commands.executeCommand('het.quality');
    },
    openRelease: async () => {
      await vscode.commands.executeCommand('het.release');
    },
  });
}

/** Benchmark board panel (G-14): config (comment-preserving) + no-flash build + protocol parse. */
function openBenchPanel(context: vscode.ExtensionContext): void {
  const configRel = 'benchmark/platform/bench_config.json';
  const load = async (root: string): Promise<{ text: string; cfg: Record<string, unknown> } | null> => {
    const abs = join(root, configRel);
    if (!(await pathExists(abs))) {
      return null;
    }
    const text = await readText(abs);
    try {
      return { text, cfg: JSON.parse(text) as Record<string, unknown> };
    } catch {
      return null;
    }
  };

  const getState = async (): Promise<BenchState> => {
    const root = currentProject?.root;
    if (!root || !currentProject?.metadata) {
      return { projectName: '', platform: 'unknown', fields: [], values: {}, configRel };
    }
    const loaded = await load(root);
    if (!loaded) {
      return { projectName: currentProject.metadata.name ?? '', platform: 'unknown', fields: [], values: {}, configRel };
    }
    const platform = configPlatform(loaded.cfg);
    const values: Record<string, string> = {};
    for (const f of fieldsFor(platform)) {
      const v = loaded.cfg[f.key];
      values[f.key] = Array.isArray(v) ? (v as string[]).join(', ') : v === undefined ? '' : String(v);
    }
    return { projectName: currentProject.metadata.name ?? '', platform, fields: fieldsFor(platform), values, configRel };
  };

  const saveConfig = async (values: Record<string, string>) => {
    const root = currentProject?.root;
    if (!root) {
      return { ok: false, message: '未检测到 fcpp 项目。' };
    }
    const loaded = await load(root);
    if (!loaded) {
      return { ok: false, message: `无法读取 ${configRel}。` };
    }
    const platform = configPlatform(loaded.cfg);
    let text = loaded.text;
    for (const f of fieldsFor(platform)) {
      const raw = loaded.cfg[f.key];
      const input = (values[f.key] ?? '').trim();
      let next: unknown;
      if (Array.isArray(raw)) {
        next = input ? input.split(',').map((s) => s.trim()).filter(Boolean) : [];
      } else if (typeof raw === 'number') {
        const n = Number(input);
        next = Number.isNaN(n) ? raw : n;
      } else if (typeof raw === 'boolean') {
        next = input === 'true';
      } else {
        next = input;
      }
      const r = replaceJsoncField(text, f.key, next);
      if (!r.ok) {
        return { ok: false, message: r.error ?? '写入失败' };
      }
      text = r.text;
    }
    await writeText(join(root, configRel), text);
    await refreshStatus();
    return { ok: true, message: `已保存 ${configRel}（字段级写回，注释/结构保留）。` };
  };

  const buildNoFlash = async () => {
    const root = currentProject?.root;
    if (!root) {
      return { ok: false, message: '未检测到 fcpp 项目。' };
    }
    const python = await which('python');
    if (!python) {
      return { ok: false, message: '找不到 python。' };
    }
    const script = 'benchmark/script/run_bench.py';
    if (!(await pathExists(join(root, script)))) {
      return { ok: false, message: `缺少 ${script}（fcpp 模板未含 benchmark 时跳过）。` };
    }
    channel?.appendLine(`[bench] ${python} ${script} --no-flash @ ${root}`);
    const res = await run(python, [script, '--no-flash'], { cwd: root, onStdout: (c) => channel?.append(c), onStderr: (c) => channel?.append(c), timeoutMs: 0 });
    if (res.code === 0) {
      return { ok: true, message: '无板卡构建（--no-flash）成功。可粘贴串口输出解析结果，或接板后执行 ② 构建并上板。' };
    }
    return { ok: false, message: '无板卡构建失败：请查看“输出 → HeT DevTools”。（通常需先经 Conan 拉取 arm-toolchain）' };
  };

  showBenchPanel(context, {
    getState,
    saveConfig,
    buildNoFlash,
    parseSim: (text) => {
      const p = parseBenchmarkProtocol(text);
      if (p.cases.length === 0) {
        return { ok: false, message: '未解析到 BENCHMARK_START…RESULT|…|n…BENCHMARK_END 协议行。', cases: [], complete: false };
      }
      return { ok: true, message: `解析到 ${p.cases.length} 例`, cases: p.cases, complete: p.complete };
    },
    openConfig: async () => {
      const root = currentProject?.root;
      if (root) {
        void vscode.window.showTextDocument(vscode.Uri.file(join(root, configRel)), { preview: true });
      }
    },
  });
}

/** CI status view (G-19): GitHub Actions with D-9 tier + offline degradation. */
function openCiPanel(context: vscode.ExtensionContext): void {
  const getState = async (): Promise<CiState> => {
    const root = currentProject?.root;
    const empty: CiState = {
      repoLabel: '',
      tier: 'offline',
      tierLabel: '离线',
      hint: '未配置 git 远程（origin）或无项目。',
      workflows: [],
      runs: [],
      online: false,
      actionsUrl: '',
    };
    if (!root) {
      return empty;
    }
    const git = await which('git');
    let owner = '';
    let repoName = '';
    let actionsUrl = '';
    if (git) {
      const r = await run(git, ['-C', root, 'remote', 'get-url', 'origin']).catch(() => null);
      const id = r && r.code === 0 ? parseRemoteOrigin(r.stdout) : null;
      if (id) {
        owner = id.owner;
        repoName = id.repo;
        actionsUrl = `https://github.com/${owner}/${repoName}/actions`;
      }
    }
    const auth = await resolveGithubAuth();
    const tierLabel =
      auth.tier === 'vscode'
        ? `已登录 · VS Code 账户：${auth.username ?? ''}`
        : auth.tier === 'gh'
          ? `已登录 · gh CLI：${auth.username ?? ''}`
          : '匿名（公开仓库只读）';
    const workflows: CiState['workflows'] = [];
    const { readdir } = await import('node:fs/promises');
    try {
      const dir = join(root, '.github', 'workflows');
      for (const f of (await readdir(dir)).filter((n) => /\.(yml|yaml)$/.test(n))) {
        try {
          workflows.push(parseWorkflowYaml(f, await readText(join(dir, f))));
        } catch {
          /* skip */
        }
      }
    } catch {
      /* no workflows */
    }
    let runs: CiRunInfo[] = [];
    let online = false;
    if (owner && repoName && git) {
      try {
        const res = await run(
          'gh',
          ['api', `repos/${owner}/${repoName}/actions/runs`, '--paginate=false', '--jq', '.workflow_runs[:10][] | {name: (.name // .display_title), branch: .head_branch, status, conclusion, created_at, html_url}'],
          { timeoutMs: 15000 },
        );
        if (res.code === 0 && res.stdout.trim().length > 0) {
          online = true;
          runs = res.stdout
            .split(/\r?\n/)
            .filter((l) => l.trim().length > 0)
            .map((l) => {
              try {
                const j = JSON.parse(l) as { name?: string; branch?: string; status?: string; conclusion?: string; created_at?: string; html_url?: string };
                return { name: j.name ?? '', branch: j.branch ?? '', status: j.status ?? '', conclusion: j.conclusion ?? '', createdAt: j.created_at ?? '', url: j.html_url ?? '' };
              } catch {
                return null;
              }
            })
            .filter((x): x is CiRunInfo => x !== null);
        }
      } catch {
        online = false;
      }
    }
    return {
      repoLabel: owner && repoName ? `${owner}/${repoName}` : '(未配置 origin)',
      tier: auth.tier,
      tierLabel,
      hint: auth.hint,
      workflows: workflows.sort((a, b) => a.file.localeCompare(b.file)),
      runs,
      online,
      actionsUrl,
    };
  };

  showCiPanel(context, {
    getState,
    openActions: async () => {
      const s = await getState();
      if (s.actionsUrl) {
        void vscode.env.openExternal(vscode.Uri.parse(s.actionsUrl));
      }
    },
  });
}

/** Full audit (G-03): collect facts, render Markdown, write to /workspace/. */
async function runAuditReport(): Promise<void> {
  const root = currentProject?.root;
  if (!root || !currentProject?.metadata) {
    void vscode.window.showWarningMessage('未检测到 fcpp 项目。');
    return;
  }
  const { readdir } = await import('node:fs/promises');
  const meta = currentProject.metadata;

  // structure
  const structure: { path: string; present: boolean }[] = [];
  for (const p of ['include/', 'src/', 'test_package/', 'docs/', 'benchmark/', '.github/misc/', '.github/workflows/', 'CHANGELOG.md']) {
    structure.push({ path: p, present: await pathExists(join(root, p)) });
  }

  // paired modules (include/a.hpp ↔ src/a.cpp)
  const pairedModules: string[] = [];
  try {
    const inc = (await readdir(join(root, 'include'))).filter((n) => /\.(hpp|h)$/.test(n)).map((n) => n.replace(/\.(hpp|h)$/, ''));
    const srcNames = new Set((await readdir(join(root, 'src'))).map((n) => n.replace(/\.(cpp|c)$/, '')));
    for (const n of inc) {
      if (srcNames.has(n)) {
        pairedModules.push(n);
      }
    }
  } catch {
    /* missing dirs */
  }

  const metaErrors = hasErrors(validateMetadata(meta))
    ? validateMetadata(meta).filter((i) => i.severity === 'error').map((i) => `${i.field}: ${i.message}`)
    : [];

  const tools = await detectToolchain();
  const toolRows = Object.entries(tools).map(([name, t]) => ({ name, ok: t.state === 'ok' }));

  const git = await which('git');
  let branch = '';
  let clean = true;
  if (git) {
    const br = await run(git, ['-C', root, 'branch', '--show-current']).catch(() => null);
    branch = br && br.code === 0 ? br.stdout.trim() : '';
    const st = await run(git, ['-C', root, 'status', '--porcelain']).catch(() => null);
    clean = !st || st.stdout.trim().length === 0;
  }

  // docs artifacts + coverage
  const docsArtifacts: string[] = [];
  const walk = async (dir: string, relBase: string, depth: number): Promise<void> => {
    if (depth > 7) {
      return;
    }
    let entries: { name: string; isDir: boolean }[] = [];
    try {
      entries = (await readdir(dir, { withFileTypes: true })).map((d) => ({ name: d.name, isDir: d.isDirectory() }));
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDir && e.name === 'index.html') {
        docsArtifacts.push(`${relBase}/${e.name}`);
      } else if (e.isDir && !e.name.startsWith('.')) {
        await walk(join(dir, e.name), `${relBase}/${e.name}`, depth + 1);
      }
    }
  };
  await walk(join(root, 'docs', 'sphinx', 'build'), 'docs/sphinx/build', 0);
  await walk(join(root, 'docs', 'doxygen', 'build'), 'docs/doxygen/build', 0);
  let coverageReport: string | null = null;
  const covProbe = [join(root, 'coverage_report', 'index.html'), join(root, 'build', 'coverage_report', 'index.html')];
  for (const c of covProbe) {
    if (await pathExists(c)) {
      coverageReport = c.startsWith(root) ? c.slice(root.length).replace(/^[\\/]+/, '') : c;
      break;
    }
  }

  // workflows + security configs
  const workflows: AuditInput['workflows'] = [];
  try {
    for (const f of (await readdir(join(root, '.github', 'workflows'))).filter((n) => /\.(yml|yaml)$/.test(n))) {
      try {
        workflows.push(parseWorkflowYaml(f, await readText(join(root, '.github', 'workflows', f))));
      } catch {
        /* skip */
      }
    }
  } catch {
    /* none */
  }
  const sec = {
    gitleaks: await pathExists(join(root, '.github', 'misc', '.gitleaks.toml')),
    megalinter: await pathExists(join(root, '.github', 'misc', '.mega-linter.yml')),
    checkov: await pathExists(join(root, '.github', 'misc', '.checkov.yml')),
  };

  // quality quick facts
  let formatOk: boolean | undefined;
  let commitlintOk: boolean | undefined;
  const fmt = await which('clang-format');
  const srcFiles: { abs: string; fam: 'c' | 'cpp' }[] = [];
  for (const sub of ['include', 'src']) {
    try {
      for (const n of await readdir(join(root, sub))) {
        const fam = formatConfigForFile(`${sub}/${n}`);
        if (fam) {
          srcFiles.push({ abs: join(root, sub, n), fam });
        }
      }
    } catch {
      /* skip */
    }
  }
  if (fmt && srcFiles.length > 0) {
    let allOk = true;
    for (const fam of ['c', 'cpp'] as const) {
      const famAbs = srcFiles.filter((f) => f.fam === fam).map((f) => f.abs);
      const cfg = join(root, `.github/misc/.clang-format-${fam}`);
      if (famAbs.length === 0 || !(await pathExists(cfg))) {
        continue;
      }
      const res = await run(fmt, ['--dry-run', '--Werror', `--style=file:${cfg}`, ...famAbs], { cwd: root });
      if (res.code !== 0) {
        allOk = false;
      }
    }
    formatOk = allOk;
  }
  if (git) {
    const res = await run(git, ['-C', root, 'log', '--format=%s', '-n', '10']);
    commitlintOk = collectHeaders(res.stdout).every((h) => lintCommitHeader(h).ok);
  }

  const health = await runHealthCheck({ project: currentProject, tools, state: { lastBuildOk, lastTestsOk: lastTestSummary ? lastTestSummary.failed === 0 : undefined } });
  const input: AuditInput = {
    generatedAt: new Date().toISOString(),
    projectName: meta.name ?? '',
    version: meta.version ?? '',
    target: meta.target ?? '',
    health,
    structure,
    pairedModules: pairedModules.sort(),
    metadataErrors: metaErrors,
    tools: toolRows,
    build: {
      ok: lastBuildOk,
      detail: lastBuildOk === undefined ? '本会话未构建' : lastBuildOk ? '最近一次构建成功' : '最近一次构建失败',
    },
    tests: {
      passed: lastTestSummary?.passed,
      failed: lastTestSummary?.failed,
      skipped: lastTestSummary?.skipped,
      detail: lastTestSummary ? '最近一次测试' : '本会话未运行测试',
    },
    docsArtifacts: docsArtifacts.slice(0, 20),
    coverageReport,
    workflows: workflows.sort((a, b) => a.file.localeCompare(b.file)),
    security: sec,
    git: { branch, clean },
    quality: { formatOk, commitlintOk, tidyOk: undefined },
  };

  const mdText = renderAuditMarkdown(input);
  const target = join(root, 'workspace', 'audit-report.md');
  await writeText(target, mdText);
  log(`[audit] report written: ${target}`);
  void vscode.window.showInformationMessage('审计报告已生成：workspace/audit-report.md（可在 Copilot Chat 用 @workspace 引用）。');
  void vscode.window.showTextDocument(vscode.Uri.file(target), { preview: false });
}

/** Patent mining wizard (G-20, optional): quick-input → draft under /workspace/. */
async function runPatentWizard(): Promise<void> {
  const root = currentProject?.root;
  if (!root) {
    void vscode.window.showWarningMessage('未检测到 fcpp 项目。');
    return;
  }
  const ask = async (title: string, placeholder: string): Promise<string | undefined> =>
    vscode.window.showInputBox({ title, placeHolder: placeholder, ignoreFocusOut: true });
  const title = await ask('专利标题', '如：嵌入式算子融合调度方法');
  if (!title) {
    return;
  }
  const domain = (await ask('技术领域', '如：嵌入式神经网络算子')) ?? '';
  const problem = (await ask('要解决的技术问题', '一句话描述')) ?? '';
  const pointsRaw = (await ask('技术方案要点（每条用分号 ; 分隔）', '要点1; 要点2; …')) ?? '';
  const novelty = (await ask('与现有技术的区别（创新点）', '相比现有技术的改进')) ?? '';
  const input: PatentInput = {
    title,
    domain,
    problem,
    solutionPoints: pointsRaw.split(';').map((s) => s.trim()).filter(Boolean),
    novelty,
  };
  if (input.solutionPoints.length === 0) {
    void vscode.window.showWarningMessage('至少需要一个技术方案要点。');
    return;
  }
  const slug = title.replace(/[^\w\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '') || 'invention';
  const searchFile = join(root, 'workspace', `patent-${slug}-search.md`);
  const draftFile = join(root, 'workspace', `patent-${slug}-disclosure.md`);
  await writeText(searchFile, renderSearchQuery(input));
  await writeText(draftFile, renderTechDisclosure(input));
  log(`[patent] drafts written: ${searchFile} , ${draftFile}`);
  void vscode.window.showInformationMessage('已生成检索式与交底书草稿（workspace/ 下，可 @workspace 引用）。');
  void vscode.window.showTextDocument(vscode.Uri.file(draftFile), { preview: false });
}

interface NewProjectOpts {
  name: string;
  description?: string;
  dest: string;
  gitAuthor?: { name: string; email: string };
  confirmed?: boolean;
  /** Extra top-level metadata.json fields to patch on top of name/description. */
  metadataExtra?: Record<string, unknown>;
  /** V2-4 template-source preference: pinned ref (default) | online latest | local. */
  prefer?: 'pinned' | 'release' | 'local';
}

/** Resolve the bootstrap template source (env override wins for dev/offline). */
function templateSourceForInit(): ReturnType<typeof resolveTemplateSource> {
  const localOverride = process.env.HET_TEMPLATE_LOCAL?.trim() ?? '';
  return resolveTemplateSource(localOverride || undefined);
}

/**
 * V2-4 local-template candidate chain:
 *   HET_TEMPLATE_LOCAL → het.template.localPath → workspace/fcpp (dev copy).
 */
/**
 * V2-4 local-template candidate chain, newest → fallback:
 *   HET_TEMPLATE_LOCAL → het.template.localPath → workspace/fcpp (dev copy)
 *   → assets/template (bundled into the vsix, fully offline).
 */
function resolveLocalTemplateCandidates(): { path: string; label: string }[] {
  const out: { path: string; label: string }[] = [];
  const env = process.env.HET_TEMPLATE_LOCAL?.trim() ?? '';
  if (env) {
    out.push({ path: env, label: `本地模板（HET_TEMPLATE_LOCAL）` });
  }
  const cfg = vscode.workspace.getConfiguration('het').get<string>('template.localPath', '').trim();
  if (cfg) {
    out.push({ path: cfg, label: `本地模板（het.template.localPath）` });
  }
  const dev = join(contextRef?.extensionUri.fsPath ?? '', 'workspace', 'fcpp');
  out.push({ path: dev, label: `workspace/fcpp 开发副本` });
  const bundled = join(contextRef?.extensionUri.fsPath ?? '', 'assets', 'template');
  out.push({ path: bundled, label: `内置模板（随扩展发布，离线可用）` });
  return out;
}

/** First candidate whose directory actually contains a template. */
function firstAvailableTemplate(): { path: string; label: string } | undefined {
  return resolveLocalTemplateCandidates().find((c) => existsSync(join(c.path, 'metadata.json')));
}

/**
 * T-4.6 / G-21 — create a new fcpp project from the template at `opts.dest`.
 * - Version = maintainer-pinned TEMPLATE_REF (recommended) unless a local
 *   dev copy is supplied via TEMPLATE_LOCAL_PATH / HET_TEMPLATE_LOCAL.
 * - Records the exact ref in `.het/template-ref.json` for T-4.7 updates.
 * - Never asks the user for a commit hash; never mutates the template source.
 */
async function newProjectFromTemplate(opts: NewProjectOpts): Promise<{ ok: boolean; message: string; root?: string }> {
  const name = opts.name.trim();
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    return { ok: false, message: '项目名仅允许字母/数字/下划线/连字符。' };
  }
  const dest = opts.dest.trim();
  if (!dest) {
    return { ok: false, message: '请选择目标目录。' };
  }
  if (!opts.confirmed) {
    return { ok: false, message: '未确认。' };
  }
  const git = await which('git');
  const gitMissing = !git;
  if (gitMissing) {
    // T04 (E12): a bare Windows machine has no git. Project creation must not
    // depend on it — only the baseline commit does (degraded below, with a note).
    log('[init] 未检测到 git：将跳过在线克隆与基线提交（本地/内置模板仍可用）');
  }
  const source = templateSourceForInit();
  const repo = source.repo ?? TEMPLATE_REPO;
  const localCandidates = resolveLocalTemplateCandidates();
  const envLocal = source.mode === 'local' && !!source.localPath;
  // Prefer an explicitly configured local copy (maintainer/offline), else pinned.
  const prefer = opts.prefer ?? (envLocal ? 'local' : 'pinned');

  let tplDir = '';
  let markerRef = '';
  let label = '';
  let remoteUsed = false;
  let fallbackNote = '';

  const tryLocal = async (): Promise<boolean> => {
    for (const c of localCandidates) {
      if (!(await pathExists(join(c.path, 'metadata.json')))) {
        continue;
      }
      tplDir = c.path;
      const rev = git ? await run(git, ['-C', tplDir, 'rev-parse', 'HEAD']).catch(() => null) : null;
      markerRef = rev && rev.code === 0 ? rev.stdout.trim() : 'HEAD';
      label = c.label;
      return true;
    }
    return false;
  };

  const tryRemote = async (ref: string | undefined, refLabel: string): Promise<boolean> => {
    // E2 (marketplace-readiness): deterministic offline simulation — the C7
    // host sets this so the online pin "fails" instantly and the local
    // candidate chain is exercised (same code path as a real network outage).
    if (process.env.HET_FORCE_TEMPLATE_OFFLINE === '1') {
      log('[init] HET_FORCE_TEMPLATE_OFFLINE=1 → 跳过在线克隆，演练本地回退');
      return false;
    }
    if (!git) {
      log('[init] 未检测到 git → 跳过在线克隆，回退本地/内置模板');
      return false;
    }
    const osMod = await import('node:os');
    const tmp = join(osMod.tmpdir(), `het-tpl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    const args = ref ? ['clone', '--depth', '1', '--branch', ref, repo, tmp] : ['clone', '--depth', '1', repo, tmp];
    const clone = await run(git, args, { timeoutMs: 120000 });
    if (!clone || clone.code !== 0) {
      return false;
    }
    tplDir = tmp;
    markerRef = ref ?? 'HEAD';
    label = refLabel;
    remoteUsed = true;
    return true;
  };

  let ok = false;
  if (prefer === 'local') {
    ok = await tryLocal();
    if (!ok) {
      const available = localCandidates.map((c) => c.path).join('；');
      return {
        ok: false,
        message: `本地模板不可用（${available || '未配置'}）。请设置 het.template.localPath 或 HET_TEMPLATE_LOCAL。`,
      };
    }
  } else if (prefer === 'release') {
    // online latest → pinned → local (each fallback is explicit + recorded)
    ok = await tryRemote(undefined, `在线最新（${repo} 默认分支）`);
    if (!ok) {
      const pinned = resolveCloneRef(source, 'recommended', { releases: [], tags: [] });
      ok = await tryRemote(pinned.cloneRef, pinned.label);
      if (ok) {
        fallbackNote = '在线最新不可用，已回退到固定哈希版本。';
      }
    }
    if (!ok) {
      ok = await tryLocal();
      if (ok) {
        fallbackNote = '在线不可用，已自动回退到本地模板。';
      }
    }
    if (!ok) {
      return { ok: false, message: `在线克隆失败（${repo}）且无本地模板可用。请检查网络或配置本地模板。` };
    }
  } else {
    // pinned (recommended) → local. D-E3 default chain: TEMPLATE_TAG (release)
    // → TEMPLATE_REF (fixed hash) → local/bundled asset template. NOTE: the
    // final gate must be the actual template outcome (remote OR local
    // fallback), not just the remote flag — otherwise an offline machine with
    // a bundled template wrongly reports "无本地模板可用" (regression caught
    // by verify-installed).
    const anchors = recommendedAnchors(source);
    const chain = anchors.length ? anchors : [{ ref: 'main', label: 'main（未锁定）' }];
    for (const a of chain) {
      ok = await tryRemote(a.ref, a.label);
      if (ok) {
        break;
      }
    }
    if (!ok) {
      ok = await tryLocal();
      if (ok) {
        fallbackNote = '在线不可用（tag/固定哈希均失败），已自动回退到本地模板。';
      }
    }
    if (!ok) {
      return { ok: false, message: `在线克隆失败（${chain.map((c) => c.ref).join(' → ')}）且无本地模板可用。请检查网络或配置本地模板。` };
    }
  }
  if (tplDir === dest) {
    return { ok: false, message: '目标目录不能是模板目录本身。' };
  }

  // copy tree excluding version-control & build noise
  const { cpSync } = await import('node:fs');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(dest, { recursive: true });
  const EXCLUDE = new Set(['.git', 'build', 'out', 'node_modules', '.vscode-test', '.het']);
  try {
    cpSync(tplDir, dest, {
      recursive: true,
      filter: (p) => !EXCLUDE.has(join(p).split(/[\\/]/).pop() ?? '') && !p.includes('docs/sphinx/build') && !p.includes('docs/doxygen/build'),
    });
  } catch (err) {
    return { ok: false, message: `复制模板失败：${err instanceof Error ? err.message : String(err)}` };
  }

  // Windows compat: CTest's LastTest.log carries GBK bytes (MSVC runtime writes
  // cp936), but the template reads it as strict UTF-8 → UnicodeDecodeError in
  // the test package. Patch the COPY only (upstream template stays pristine).
  if (process.platform === 'win32') {
    const cf = join(dest, 'test_package', 'conanfile.py');
    if (await pathExists(cf)) {
      const txt = await readText(cf);
      const patched = txt.replaceAll("open(report, 'r', encoding='utf-8')", "open(report, 'r', encoding='utf-8', errors='replace')");
      if (patched !== txt) {
        await writeText(cf, patched);
        log('[init] Windows compat patch applied: test_package/conanfile.py (GBK LastTest.log)');
      }
    }
  }

  // record template ref for T-4.7
  await writeText(join(dest, markerPath()), encodeMarker({ repo, ref: markerRef, label }));

  // rewrite identity fields (preview/confirm happens in the wizard)
  const metadataPatch: Record<string, unknown> = {
    name,
    description: opts.description ?? name,
    ...(opts.metadataExtra ?? {}),
  };
  let coverageNote = '';
  // T13 (E8): the coverage default follows the PROVIDER's real capability —
  // not the platform name. Previously every win32 project was forced off, even
  // when the WSL2 lane (coverage=full) would build it; conversely macOS got the
  // template default (on) although Apple clang has no GNU gcov.
  if (metadataPatch.activate_code_coverage === undefined) {
    const plan = await getCurrentProvisionPlan(false, provisionPrefs()).catch(() => null);
    const fullCoverage = plan ? plan.coverage === 'full' : process.platform === 'linux';
    if (!fullCoverage) {
      metadataPatch.activate_code_coverage = false;
      const why = plan?.reason ?? (process.platform === 'darwin' ? 'macOS：Apple clang 无 GNU gcov/lcov' : '本机工具链不支持 --coverage');
      coverageNote = `\n（已默认关闭代码覆盖率：${why}；换成支持覆盖率的车道或在 metadata.json 手动开启）`;
    }
  }
  // V4-8: new projects default to the extension-managed toolchain semantic
  // (deterministic & uninstall-clean); system is an explicit opt-in.
  if (metadataPatch.toolchain === undefined) {
    metadataPatch.toolchain = 'managed';
  }
  const applied = await applyMetadataPatch(dest, metadataPatch, { persist: true });
  if (!applied.ok) {
    return { ok: false, message: `metadata 改写失败：${applied.issues.map((i) => i.message).join('；')}` };
  }

  // git init + baseline commit + template remote — skipped entirely when git is
  // absent (T04): the copy + metadata rewrite above is already the deliverable.
  let gitNote = '';
  if (git) {
    const author = opts.gitAuthor ?? { name: 'HeT Developer', email: 'dev@het.invalid' };
    await run(git, ['init', '-b', 'main'], { cwd: dest });
    await run(git, ['config', 'user.name', author.name], { cwd: dest });
    await run(git, ['config', 'user.email', author.email], { cwd: dest });
    await run(git, ['add', '-A'], { cwd: dest });
    const header = `chore(release): init from fcpp template ${label.replace(/[^\w\u4e00-\u9fa5]+/g, '-') || 'pinned'}`;
    const c = await run(git, ['commit', '-m', header], { cwd: dest });
    if (c.code !== 0) {
      return { ok: false, message: `git 基线提交失败：${c.stdout}\n${c.stderr}`.slice(-400) };
    }
    if (remoteUsed) {
      await run(git, ['remote', 'add', 'template', repo], { cwd: dest }).catch(() => null);
    }
  } else {
    gitNote = '\n（未检测到 git：已跳过 git init/基线提交。装好 Git 后可在此目录自行 `git init`；winget 安装：winget install --id Git.Git -e）';
    log('[init] git 缺失：项目已创建（跳过 git init/commit）');
  }
  const suffix = fallbackNote ? `\n${fallbackNote}` : '';
  log(`[init] project created @ ${dest} (template ${label})${suffix}`);
  return { ok: true, message: `已从模板创建项目 ${name} @ ${dest}\n（模板源：${label}${suffix}，已记录到 .het/template-ref.json）${coverageNote}${gitNote}`, root: dest };
}

/** User-facing init wizard (G-21): collects identity, preview, confirm, run. */
async function runNewProjectWizard(): Promise<void> {
  const ask = async (title: string, placeholder: string, value?: string): Promise<string | undefined> =>
    vscode.window.showInputBox({ title, placeHolder: placeholder, value, ignoreFocusOut: true, prompt: title });
  const name = await ask('新项目名（字母/数字/下划线/连字符）', 'my_lib');
  if (!name) {
    return;
  }
  const description = (await ask('一句话描述（将写入 metadata.description）', 'A small library based on fcpp')) ?? name;
  const folder = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: '选择项目存放目录' });
  if (!folder || folder.length === 0) {
    return;
  }
  const dest = join(folder[0].fsPath, name);
  const source = templateSourceForInit();
  const label =
    source.mode === 'local'
      ? `本地模板副本：${source.localPath}`
      : `上游锁定：${source.repo}（TEMPLATE_REF）`;
  const choice = await vscode.window.showWarningMessage(
    `在 ${dest} 创建项目 ${name}？\n\n模板源：${label}\n\n将复制模板 → 改写 metadata.json（name/description，保留原排版、无 .bak）→（有 git 时）git init + 基线提交（历史可追溯模板 ref）→ 记录 .het/template-ref.json。`,
    { modal: true },
    '创建',
    '取消',
  );
  if (choice !== '创建') {
    return;
  }
  const r = await newProjectFromTemplate({ name, description, dest, confirmed: true });
  if (r.ok) {
    log(`[wizard] created ${name} @ ${dest}`);
    await refreshStatus();
    await openProjectFolder(dest);
  } else {
    maybeToast('error', r.message);
  }
}

/** T-4.7 — template update check (read-only) for the current project. */
async function runTemplateUpdateCheck(): Promise<void> {
  const root = currentProject?.root;
  const metaName = currentProject?.metadata?.name ?? 'project';
  if (!root) {
    void vscode.window.showWarningMessage('未检测到 fcpp 项目。');
    return;
  }
  const markerFile = join(root, markerPath());
  if (!(await pathExists(markerFile))) {
    void vscode.window.showInformationMessage('本项目不是由模板初始化生成（缺少 .het/template-ref.json），无需更新检查。');
    return;
  }
  const marker = parseMarker(await readText(markerFile));
  if (!marker) {
    void vscode.window.showWarningMessage('.het/template-ref.json 无法解析。');
    return;
  }
  const git = await which('git');
  if (!git) {
    return;
  }
  const source = templateSourceForInit();
  if (source.mode !== 'local' || !source.localPath) {
    void vscode.window.showInformationMessage(
      '在线模式模板更新检查需要 GitHub 网络（当前离线）。恢复网络后重试；开发/离线可用 HET_TEMPLATE_LOCAL 指向本地模板副本以本地对比。',
    );
    return;
  }
  if (!(await pathExists(source.localPath))) {
    void vscode.window.showWarningMessage(`本地模板副本不存在：${source.localPath}`);
    return;
  }
  const rev = await run(git, ['-C', source.localPath, 'rev-parse', 'HEAD']);
  if (rev.code !== 0) {
    void vscode.window.showWarningMessage('无法读取本地模板 HEAD。');
    return;
  }
  const head = rev.stdout.trim();
  if (head === marker.ref) {
    void vscode.window.showInformationMessage(`模板无更新（HEAD=${head.slice(0, 12)}，与初始化时一致）。`);
    return;
  }
  const logRes = await run(git, ['-C', source.localPath, 'log', '--oneline', `${marker.ref}..HEAD`]);
  const commits = logRes.code === 0 ? parseCommitList(logRes.stdout) : [];
  const plan = renderSyncPlan({
    projectName: metaName,
    repo: marker.repo,
    fromRef: marker.ref.slice(0, 12),
    toRef: head.slice(0, 12),
    commits,
    localOnly: true,
  });
  const planFile = join(root, 'workspace', 'template-sync-plan.md');
  await writeText(planFile, plan);
  log(`[template] update: ${marker.ref.slice(0, 12)} -> ${head.slice(0, 12)} (${commits.length} commits)`);
  void vscode.window.showInformationMessage(
    commits.length > 0
      ? `模板有更新：落后 ${commits.length} 个提交。同步计划已生成 workspace/template-sync-plan.md（只读，不会自动合入）。`
      : `模板 HEAD 已变化（${head.slice(0, 12)}）但历史不可枚举（副本标记不相交）。已生成同步计划文档供人工参考。`,
  );
  void vscode.window.showTextDocument(vscode.Uri.file(planFile), { preview: true });
}

/** Settings editor (G-17): preview + confirm + backup write of metadata.json. */
function openSettingsPanel(context: vscode.ExtensionContext): void {
  showSettingsPanel(context, {
    getMetadata: async () => {
      const root = currentProject?.root;
      if (!root) {
        return { error: '未检测到 fcpp 项目：请先打开含 metadata.json 的库文件夹。' };
      }
      try {
        return { metadata: await loadMetadata(root) };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
    savePatch: async (patch) => {
      const root = currentProject?.root;
      if (!root) {
        return { ok: false, message: '未检测到 fcpp 项目。', diff: [] };
      }
      const preview = await applyMetadataPatch(root, patch); // dry-run
      if (!preview.ok) {
        const detail = preview.issues
          .filter((i) => i.severity === 'error')
          .map((i) => `${i.field ?? '?'}: ${i.message}`)
          .join('；');
        return { ok: false, message: `校验未通过：${detail}`, diff: preview.diff };
      }
      const summary = preview.diff.length === 0 ? '（无字段变化）' : preview.diff.map((d) => d.field).join(', ');
      const choice = await vscode.window.showWarningMessage(
        `将写回 ${preview.diff.length} 项变更：${summary}。按 fcpp 原排版手术式更新（无 .bak）。`,
        { modal: true },
        '应用',
        '取消',
      );
      if (choice !== '应用') {
        return { ok: false, message: '已取消（未写回）', diff: preview.diff };
      }
      const applied = await applyMetadataPatch(root, patch, { persist: true });
      return {
        ok: applied.ok,
        message: applied.ok ? `已保存 ${applied.diff.length} 项变更（排版保留，无 .bak）` : '写回失败',
        diff: applied.diff,
      };
    },
    refreshProject: async () => {
      await refreshStatus();
    },
  });
}

/** Detect fcpp projects in the current window and update the status bar. */
async function refreshStatus(): Promise<void> {
  const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  const projects = await detectProjectsIn(roots);
  currentProject = projects[0];

  if (currentProject?.metadata) {
    const m = currentProject.metadata;
    emitCockpitEvent({ type: 'project', name: m.name ?? '' });
    log(`project detected: ${m.name} (level=${currentProject.level}) @ ${currentProject.root}`);
  } else {
    currentProject = undefined;
    emitCockpitEvent({ type: 'project', name: '' });
    if (!wizardAutoOpened) {
      wizardAutoOpened = true;
      emitCockpitEvent({ type: 'wizard:open' });
    }
    log('no fcpp project in current workspace');
    // Never block on the onboarding prompt — it is a gentle hint, not a gate.
    void maybeOnboardEmptyWorkspace();
  }
  await emitTemplateBehind();
  await refreshChip();
  // Health is comparatively expensive: refresh at most once a minute, lazily.
  void ensureHealthCached(false);
  void ensureConanRuntime();
  void ensureToolDiscovery();
}

/** Whether the open workspace folder is truly empty (used for the ＋ hint). */
async function isWorkspaceEmpty(): Promise<boolean> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return false;
  }
  const { readdir } = await import('node:fs/promises');
  for (const f of folders) {
    try {
      const entries = await readdir(f.uri.fsPath);
      if (entries.length > 0) {
        return false;
      }
    } catch {
      /* unreadable folder treated as non-empty */
    }
  }
  return true;
}

/** Rich one-line runtime description for chip/HUD. */
function conanRuntimeDetail(): string | null {
  if (!conanRuntime) {
    return null;
  }
  const ver = conanRuntime.version ? `conan ${conanRuntime.version} · ` : '';
  if (conanRuntime.overrideUser) {
    return `${ver}用户自定义`;
  }
  if (conanRuntime.envName) {
    return `${ver}conda env ${conanRuntime.envName}（启发式推断 · 极可能）`;
  }
  return `${ver}PATH`;
}

function hudFontSize(): number {
  const n = vscode.workspace.getConfiguration('het').get<number>('hud.fontSize', 13.5);
  return typeof n === 'number' && Number.isFinite(n) ? n : 13.5;
}

/** V4-3: user prefs for provider selection (reserved; no MinGW toggle). */
function provisionPrefs(): ProvisionPrefs {
  return {};
}

/** V4-6: hide the chip for 5 minutes (Snooze), then it returns. */
function snoozeChip(minutes = 5): void {
  if (chipSnoozeTimer) {
    clearTimeout(chipSnoozeTimer);
  }
  statusItem?.hide();
  lastChip = null;
  chipSnoozeTimer = setTimeout(() => {
    chipSnoozeTimer = undefined;
    void refreshStatus();
  }, minutes * 60_000);
}

/** V4-6: chip click falls back to the QuickPick list instead of the HUD card. */
function disableHud(): void {
  void vscode.workspace.getConfiguration('het').update('hud.disableHud', true, vscode.ConfigurationTarget.Global);
  maybeToast('info', '已改用快捷列表（可随时在设置 het.hud.disableHud 恢复 HUD）。');
}

async function assembleHudModel(): Promise<HudModel> {
  const st = getCockpitState();
  const plan = await getCurrentProvisionPlan(true, provisionPrefs()).catch(() => null);
  const tools = await ensureToolDiscovery().catch(() => []);
  // V5-6 (issue-1): under the WSL2 lane the rows must reflect the toolchain the
  // extension ACTUALLY uses (lane venv conan/cmake/ninja/python), never the
  // Windows-side sniff — a Windows box without local conan would otherwise show
  // a red ✗ while builds succeed through the lane. A3: the same holds on Linux
  // under the linux-managed provider (native Linux managed lane).
  let lane: { conan?: string; cmake?: string; provisioned: boolean } | null = null;
  let laneKind: 'wsl' | 'linux' | null = null;
  if (process.platform === 'win32' && plan?.provider === 'win-wsl2') {
    const wsl = await getWslLaneStatus(false).catch(() => null);
    if (wsl?.tools.gcc) {
      lane = { conan: wsl.tools.conan, cmake: wsl.tools.cmake, provisioned: !!wsl.tools.conan };
      laneKind = 'wsl';
    }
  } else if (process.platform === 'linux' && plan?.provider === 'linux-managed') {
    const laneStatus = await getLinuxLaneStatus(false).catch(() => null);
    if (laneStatus?.tools.gcc) {
      lane = { conan: laneStatus.tools.conan, cmake: laneStatus.tools.cmake, provisioned: !!laneStatus.tools.conan };
      laneKind = 'linux';
    }
  }
  const env: HudEnvRow[] = [];
  const wanted = new Set(['conan', 'cmake', 'python', 'ninja', 'gtest']);
  for (const t of tools) {
    if (!wanted.has(t.key)) {
      continue;
    }
    const missing = t.source === 'missing';
    // Lane override: the used toolchain has it → ok, whatever Windows says.
    const laneOk = lane !== null && (t.key === 'conan' || t.key === 'cmake' ? !!lane[t.key as 'conan' | 'cmake'] : lane.provisioned && (t.key === 'python' || t.key === 'ninja'));
    let tone: HudEnvRow['tone'] = missing ? (t.managed ? 'ok' : t.optional ? 'plain' : 'fail') : 'ok';
    let value = missing
      ? t.managed
        ? 'conan 托管（构建时获取）'
        : t.optional
          ? '可选（Linux/WSL 覆盖率）'
          : '未找到'
      : (t.sourceDetail || t.exe || t.source).slice(0, 60);
    // V5-7 dual-line: the second line shows the REAL binding (lane path vs
    // system path) so users can tell the managed toolchain from local tools.
    let path = missing ? (t.managed ? 'Conan 缓存中的包（构建时自动获取）' : '本机未找到') : (t.exe || t.sourceDetail || '').slice(0, 96);
    if (laneOk) {
      tone = 'ok';
      const bin =
        laneKind === 'linux'
          ? 'Linux 派生 managed lane · ~/.het-fti/managed-env/venv/bin'
          : 'WSL2 车道 · ~/.het-fti/managed-env/venv/bin';
      const kindTag = laneKind === 'linux' ? 'Linux lane venv' : 'WSL2 车道 venv';
      value =
        t.key === 'conan' && lane?.conan
          ? `${kindTag} · ${lane.conan}`
          : t.key === 'cmake' && lane?.cmake
            ? `${kindTag} · ${lane.cmake}`
            : t.key === 'python'
              ? `${kindTag}（托管）`
              : t.key === 'ninja'
                ? `${kindTag}（托管）`
                : value;
      if (['conan', 'cmake', 'python', 'ninja'].includes(t.key)) {
        path = `${bin}/${t.key}`;
      }
    }
    env.push({ label: t.label, value, tone, path });
  }
  return {
    title: currentProject?.metadata?.name ?? 'fcpp 项目',
    health: lastHealth?.score ?? st.top.health,
    running: st.top.running,
    lastBuildOk: lastBuildOk ?? null,
    test: lastTestSummary
      ? { passed: lastTestSummary.passed, failed: lastTestSummary.failed, skipped: lastTestSummary.skipped }
      : null,
    coverage: null,
    buildAgo: agoText(lastBuildAt || undefined),
    provider: plan ? { label: providerLabel(plan.provider), coverage: plan.coverage } : null,
    runtime: conanRuntimeDetail(),
    env,
    actions: defaultHudActions(),
    templateBehind: st.top.templateBehind,
  };
}

/** V5-2: do the Sphinx/Doxygen build trees contain an index.html? (disk probe) */
async function probeDocsArtifacts(root?: string): Promise<{ doxygen: boolean; sphinx: boolean }> {
  const out = { doxygen: false, sphinx: false };
  if (!root) {
    return out;
  }
  const { readdir } = await import('node:fs/promises');
  const scan = async (dir: string): Promise<boolean> => {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isFile() && e.name === 'index.html') {
          return true;
        }
        if (e.isDirectory() && !e.name.startsWith('.') && !['search', '_static'].includes(e.name)) {
          if (await scan(join(dir, e.name))) {
            return true;
          }
        }
      }
    } catch {
      /* missing tree */
    }
    return false;
  };
  // V5-8: the Doxygen MAIN entry is docs/doxygen/build/docs.html (the
  // language/version navigation hub), not a per-language index.html.
  out.doxygen = existsSync(join(root, 'docs', 'doxygen', 'build', 'docs.html')) || await scan(join(root, 'docs', 'doxygen', 'build'));
  out.sphinx = await scan(join(root, 'docs', 'sphinx', 'build'));
  return out;
}

/** V5-2: docs row state = disk artifacts (ok) → last failed run → none. */
function docsRowState(art: { doxygen: boolean; sphinx: boolean }, last: { ok: boolean } | null): {
  state: 'ok' | 'fail' | 'none';
  doxygen: boolean;
  sphinx: boolean;
} {
  if (art.doxygen || art.sphinx) {
    return { state: 'ok', doxygen: art.doxygen, sphinx: art.sphinx };
  }
  if (last && !last.ok) {
    return { state: 'fail', doxygen: false, sphinx: false };
  }
  return { state: 'none', doxygen: false, sphinx: false };
}

/** V5-2: first matching `index.html` under a docs build tree (or null). */
async function findFirstIndex(buildDir: string): Promise<string | null> {
  const { readdir } = await import('node:fs/promises');
  const scan = async (dir: string): Promise<string | null> => {
    let entries: { name: string; isDir: boolean; isFile: boolean }[];
    try {
      entries = (await readdir(dir, { withFileTypes: true })).map((d) => ({ name: d.name, isDir: d.isDirectory(), isFile: d.isFile() }));
    } catch {
      return null;
    }
    for (const e of entries) {
      if (e.isFile && e.name === 'index.html') {
        return join(dir, e.name);
      }
    }
    for (const e of entries) {
      if (e.isDir && !e.name.startsWith('.') && !['search', '_static'].includes(e.name)) {
        const hit = await scan(join(dir, e.name));
        if (hit) {
          return hit;
        }
      }
    }
    return null;
  };
  return scan(buildDir);
}

/** V5-2: cached single env summary line for the hover 开发环境 row. */
async function currentEnvSummary(): Promise<string | null> {
  if (envSummaryCache && Date.now() - envSummaryCache.at < 60_000) {
    return envSummaryCache.summary;
  }
  if (!contextRef) {
    return null;
  }
  try {
    const sample = await collectEnvSample(contextRef.globalStorageUri.fsPath);
    envSummaryCache = { at: Date.now(), summary: sample.summary };
    return sample.summary;
  } catch {
    return null;
  }
}

/** V5-6: cached coverage-report presence + line/function % for chip/panel. */
async function probeCoverage(root?: string): Promise<{ found: boolean; line: number | null; func: number | null }> {
  const none = { found: false, line: null, func: null };
  if (!root) {
    return none;
  }
  if (coverageProbeCache && Date.now() - coverageProbeCache.at < 30_000) {
    return { found: coverageProbeCache.found, line: coverageProbeCache.line, func: coverageProbeCache.func };
  }
  try {
    const report = findCoverageReport(root);
    const pct = report ? readCoveragePct(report) : { line: null, func: null };
    const found = report.length > 0;
    coverageProbeCache = { at: Date.now(), found, line: pct.line, func: pct.func };
    return { found, line: pct.line, func: pct.func };
  } catch {
    return none;
  }
}

/** Push the latest model into the single status-bar chip (hide = invisible). */
async function refreshChip(): Promise<void> {
  if (!statusItem) {
    return;
  }
  const st = getCockpitState();
  const [envSummary, docsArt, cov] = await Promise.all([
    currentEnvSummary(),
    probeDocsArtifacts(currentProject?.root),
    probeCoverage(currentProject?.root),
  ]);
  // V5-6: docs build in flight → spinner + "构建文档" running line (like create).
  const docs = docsRunning
    ? { state: 'running' as const, doxygen: false, sphinx: false }
    : docsRowState(docsArt, lastDocs);
  const spec = chipSpec({
    projectName: currentProject?.metadata?.name ?? '',
    health: lastHealth?.score ?? null,
    running: docsRunning ? '构建文档' : st.top.running,
    lastBuildOk: lastBuildOk ?? null,
    test: lastTestSummary
      ? { passed: lastTestSummary.passed, failed: lastTestSummary.failed, skipped: lastTestSummary.skipped }
      : null,
    templateBehind: st.top.templateBehind,
    buildAgo: agoText(lastBuildAt || undefined),
    buildType: currentProject?.metadata?.build_type ?? null,
    envSummary,
    docs: docs.state,
    docsDoxygen: docs.doxygen,
    docsSphinx: docs.sphinx,
    coverageEnabled: currentProject?.metadata?.activate_code_coverage ?? null,
    coverageFound: cov.found,
    coverageLine: cov.line,
    coverageFunc: cov.func,
    healthVerdict: lastHealth?.verdict ? verdictZh(lastHealth.verdict) : null,
    healthGaps: lastHealth?.gaps ?? null,
  });
  if (!spec) {
    statusItem.hide();
    lastChip = null;
    notifyStateChange();
    return;
  }
  statusItem.text = spec.text;
  const md = new vscode.MarkdownString(spec.tooltip, true);
  md.isTrusted = true; // command: links are only clickable in trusted markdown
  statusItem.tooltip = md;
  statusItem.command = spec.command;
  statusItem.backgroundColor = spec.color ? new vscode.ThemeColor(spec.color) : undefined;
  statusItem.show();
  lastChip = { text: spec.text, tooltip: spec.tooltip, command: spec.command };
  // V5-6 (issue-3): the chip is the single state funnel — broadcast so every
  // open result panel (体检明细 / 覆盖率 / …) repaints in lockstep.
  notifyStateChange();
}

/** V4-6: click the chip → Level-2 HUD card; disabled/automation → QuickPick. */
async function showChipOverview(): Promise<void> {
  const disabled = !hudEnabled(vscode.workspace.getConfiguration('het').get('hud.disableHud'));
  if (disabled || quietHost()) {
    await showChipQuickPick();
    return;
  }
  if (!contextRef) {
    await showChipQuickPick();
    return;
  }
  openHudPanel(contextRef, {
    getModel: assembleHudModel,
    fontSize: hudFontSize,
    onSnooze: () => snoozeChip(5),
    onHideHud: disableHud,
  });
}

/** V3-3 fallback / automation: keyboard-reachable QuickPick overview. */
async function showChipQuickPick(): Promise<void> {
  const st = getCockpitState();
  const health = lastHealth?.score ?? st.top.health;
  const buildState = lastBuildOk === null ? '未运行' : lastBuildOk ? '成功' : '失败';
  const testLine = lastTestSummary
    ? `通过 ${lastTestSummary.passed} · 失败 ${lastTestSummary.failed} · 跳过 ${lastTestSummary.skipped}`
    : '未运行';
  const items: { label: string; description?: string; detail?: string; cmd?: string }[] = [
    { label: '$(home) 打开仪表盘（概览）', detail: '健康分 · 环境 · 动作', cmd: 'het.dashboard' },
    { label: '$(beaker) 构建并测试', detail: 'conan create + GTest', cmd: 'het.test' },
    { label: '$(tools) 仅构建', detail: buildState, cmd: 'het.build' },
    { label: '$(package) 依赖', detail: 'QuickPick 搜索添加', cmd: 'het.addDependency' },
    { label: '$(book) 文档中心', detail: 'Doxygen + Sphinx', cmd: 'het.docs' },
    { label: '$(shield) 质量与安全', detail: 'format/tidy/schema/commitlint', cmd: 'het.quality' },
    { label: '$(git-commit) 提交助手', detail: 'type(:emoji:)', cmd: 'het.commit' },
    { label: '$(rocket) 发布', detail: 'Preflight + 门禁', cmd: 'het.release' },
    { label: '$(report) 测试结果', detail: testLine, cmd: 'het.showTestResults' },
    { label: '$(heart) 一键体检', detail: health === null ? '未体检' : `健康分 ${health}/100`, cmd: 'het.healthCheck' },
  ];
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: `HeT 概况 — ${currentProject?.metadata?.name ?? 'fcpp 项目'}（Enter 直达）`,
    matchOnDescription: true,
  });
  if (pick?.cmd) {
    void vscode.commands.executeCommand(pick.cmd);
  }
}

/** Whether auto-opening a freshly created project is allowed here. */
function canAutoOpenFolder(): boolean {
  if (isTestHost) {
    return false;
  }
  if (process.env.HET_VERIFY_PHASE) {
    return false; // inside the zero-manual verification host
  }
  return process.env.HET_AUTO_OPEN !== '0';
}

/** Open the freshly created project in the current window (skip in test hosts). */
async function openProjectFolder(dest: string): Promise<void> {
  if (!canAutoOpenFolder()) {
    return;
  }
  try {
    await new Promise((r) => setTimeout(r, 350));
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(dest));
  } catch (err) {
    log(`[init] auto-open failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** V3-1/3-2: zero-interaction init from the Explorer folder context menu. */
async function initHere(folder?: vscode.Uri | string): Promise<void> {
  const folderPath = typeof folder === 'string' ? folder : folder?.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!folderPath) {
    void vscode.window.showWarningMessage('请在 Explorer 中右键一个文件夹，或先打开一个文件夹。');
    return;
  }
  const raw = folderPath.split(/[\\/]/).pop() ?? 'my-lib';
  const name = (raw.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'my_lib').replace(/-/g, '_');
  const res = await newProjectFromTemplate({ name, dest: folderPath, description: 'A C/C++ library based on fcpp', confirmed: true });
  if (res.ok) {
    // Deliberately NO toast here: creation is complete when the folder opens /
    // the chip refreshes — the window must stay zero-manual (V3-2/V3-7).
    await refreshStatus();
    await openProjectFolder(folderPath);
  } else {
    maybeToast('error', res.message);
  }
}

/** Run the full health check when stale (>60 s) and cache the score for the chip. */
async function ensureHealthCached(force: boolean): Promise<void> {
  if (!currentProject) {
    return;
  }
  if (!force && lastHealth && Date.now() - lastHealth.at < 60_000) {
    return;
  }
  try {
    const tools = await detectToolchain();
    const env = await envConanFact();
    const cov = await probeCoverage(currentProject.root);
    const health = await runHealthCheck({
      project: currentProject,
      tools,
      env,
      coverage: cov,
      state: {
        lastBuildOk,
        lastTestsOk: lastTestSummary ? lastTestSummary.failed === 0 : undefined,
        testsRun: lastTestSummary ? { passed: lastTestSummary.passed, failed: lastTestSummary.failed, skipped: lastTestSummary.skipped } : undefined,
      },
    });
    if (health && typeof health.score === 'number') {
      lastHealthReport = health;
      lastHealth = { score: health.score, verdict: health.verdict, gaps: healthGapLabels(health), at: Date.now() };
      emitCockpitEvent({ type: 'health', score: health.score });
      await refreshChip();
    }
  } catch {
    /* health is best-effort; never breaks anything */
  }
}

/** V3-1: a single gentle onboarding notification guiding to the Explorer menu. */
async function maybeOnboardEmptyWorkspace(): Promise<void> {
  // quietHost() (isTestHost OR the verify sandbox) must NEVER await a human
  // button choice — that would hang the whole zero-manual run.
  if (onboardingNotified || quietHost()) {
    return;
  }
  if (!(await isWorkspaceEmpty())) {
    return;
  }
  const ctx = contextRef;
  if (!ctx || ctx.workspaceState.get<boolean>('het.onboard.dismissed')) {
    return;
  }
  onboardingNotified = true;
  const pick = await vscode.window.showInformationMessage(
    'HeT DevTools：要在空文件夹里开始一个 C/C++ 库工程？\n在左侧 Explorer 中右键任意文件夹 →「在此初始化 fcpp 项目」（零操作），或运行命令面板中的初始化向导。',
    '运行初始化向导',
    '不再提示',
  );
  if (pick === '运行初始化向导') {
    void vscode.commands.executeCommand('het.newProject');
  } else if (pick === '不再提示') {
    void ctx.workspaceState.update('het.onboard.dismissed', true);
  }
}

/**
 * T06: collect the ONE environment contract (facts → rows → card/chip/health).
 * Facts come from the SAME probes the build uses, so the card can never claim
 * "ready" for a lane the build would reject.
 */
async function collectEnvContract(): Promise<EnvContract> {
  const plan = await getCurrentProvisionPlan(false, provisionPrefs()).catch(() => null);
  const sample = await collectEnvSample(contextRef?.globalStorageUri.fsPath ?? '').catch(() => null);
  const rows = await ensureToolDiscovery().catch(() => [] as ToolRow[]);
  const has = (key: string): string | undefined => {
    const row = rows.find((r) => r.key === key);
    return row && row.source !== 'missing' && row.exe ? row.exe : undefined;
  };
  const facts: ContractFacts = {
    platform: `${process.platform}/${process.arch}`,
    lane: plan ? providerLabel(plan.provider) : '未检测到方案',
    coverage: plan ? (plan.coverage === 'partial' ? 'limited' : plan.coverage) : 'none',
    summary: sample?.summary ?? '',
    git: has('git') ? '已安装' : undefined,
    python: has('python') ? '已安装' : undefined,
    doxygen: has('doxygen') ? '已安装' : undefined,
    graphviz: has('graphviz') ? '已安装' : undefined,
    make: has('make') ? '已安装' : undefined,
  };
  // F2: name the CMake that will ACTUALLY build. Managed semantics → the lane's
  // cmake; system semantics → the HOST cmake (F1 uses it when it meets the
  // template floor). The floor decides whether a ConanCenter download is ahead.
  facts.cmakeFloor = effectiveCmakeFloor(process.env.HET_CMAKE_MIN);
  const systemMode = currentProject?.metadata?.toolchain === TOOLCHAIN_SYSTEM;
  const hostCmake = await hostCmakeVersion().catch(() => undefined);
  const pickCmake = (laneCmake?: string): string | undefined => (systemMode ? hostCmake ?? laneCmake : laneCmake ?? hostCmake);
  if (process.platform === 'win32') {
    facts.compiler = sample?.wsl?.tools.gcc;
    facts.compilerBaseline = sample?.wsl?.baseline;
    facts.arch = sample?.wsl?.arch;
    facts.conan = sample?.wsl?.tools.conan;
    facts.cmake = pickCmake(sample?.wsl?.tools.cmake);
    facts.ninja = sample?.wsl?.tools.ninja;
    facts.lcov = sample?.wsl?.tools.lcov;
    facts.laneHealable = true;
  } else if (process.platform === 'linux') {
    facts.compiler = sample?.linux?.tools.gcc;
    facts.compilerBaseline = sample?.linux?.baseline;
    facts.arch = sample?.linux?.arch;
    facts.conan = sample?.linux?.tools.conan;
    facts.cmake = pickCmake(sample?.linux?.tools.cmake);
    facts.ninja = sample?.linux?.tools.ninja;
    facts.lcov = sample?.linux?.tools.lcov;
    facts.laneHealable = plan?.provider === 'linux-managed';
  } else {
    // T07: macOS reads its facts from the macOS LANE (venv conan/cmake/ninja +
    // Apple clang), so the card matches what the build actually uses.
    const mac = await getMacLaneStatus(false).catch(() => null);
    facts.compiler = mac?.clangVersion ? `Apple clang ${mac.clangVersion}` : mac?.clt ? 'Apple clang（版本未知）' : undefined;
    facts.compilerBaseline = facts.compiler ? 'native' : undefined;
    facts.arch = mac?.arch;
    facts.conan = mac?.tools.conan;
    facts.cmake = pickCmake(mac?.tools.cmake);
    facts.ninja = mac?.tools.ninja;
    // macOS = limited support: no GNU gcov/lcov (llvm-cov adapter is T20).
    facts.lcovSupported = false;
    facts.lcovUnsupportedReason = 'macOS/Apple clang 无 GNU gcov（有限支持）';
    facts.laneHealable = true;
    if (!mac?.clt) {
      facts.laneGuide = 'xcode-select --install   （装好后重新“一键准备环境”）';
    }
  }
  return buildEnvContract(facts);
}

/**
 * T18: corporate mirror/proxy for the managed lanes (pip / conan / http proxy).
 * apt mirrors are intentionally NOT rewritten on a reused distro — the proxy
 * covers them; an owned distro (T17-B) will get sources.list at import time.
 */
function laneMirrorConfig(): LaneMirror | undefined {
  const cfg = vscode.workspace.getConfiguration('het.env');
  return laneMirrorOf({
    pipIndexUrl: cfg.get<string>('pipIndexUrl', ''),
    conanRemote: cfg.get<string>('conanRemote', ''),
    httpProxy: cfg.get<string>('httpProxy', ''),
  });
}

/**
 * T15 (E14): cheap, non-provisioning lane gate for the build path — an
 * unprepared environment must fail at OUR layer (with the contract card),
 * not deep inside conan/CMake. Windows coverage lives in `winLaneBlockedMessage`.
 */
async function preflightEnvGate(): Promise<{ ok: boolean; message?: string }> {
  if (process.platform === 'linux') {
    const plan = await getCurrentProvisionPlan(false, provisionPrefs()).catch(() => null);
    if (plan?.provider === 'linux-managed') {
      const facts = await probeLinuxLaneFacts().catch(() => null);
      if (facts && !facts.compiler) {
        const root = await linuxRootAvailable().catch(() => false);
        return { ok: false, message: `${laneCompilerGuide()}${root ? '' : '\n（当前无免密 root：自动安装不可用）'}` };
      }
      if (facts && !facts.arch) {
        return { ok: false, message: unsupportedArchMessage(facts.archRaw) };
      }
    }
  }
  return { ok: true };
}

/**
 * T16 (E16): uninstall-consistent cleanup. 「移除托管环境」 used to wipe only
 * globalStorage while the real lane lives in `~/.het-fti/managed-env`
 * (Linux/macOS) or inside the WSL distro — leaving gigabytes behind.
 */
async function runEnvRemove(): Promise<{ ok: boolean; message: string }> {
  const ctx = contextRef;
  if (!ctx) {
    return { ok: false, message: '扩展未就绪。' };
  }
  const removed: string[] = [];
  const storage = ctx.globalStorageUri.fsPath;
  const r = managedRemove(storage);
  if (r.ok) {
    removed.push(`扩展存储：${storage}`);
  }
  const homeLane = join(homedir(), '.het-fti', 'managed-env');
  if (process.platform !== 'win32' && existsSync(homeLane)) {
    try {
      rmSync(homeLane, { recursive: true, force: true });
      removed.push(`托管车道：${homeLane}`);
    } catch (err) {
      log(`[env] 清理车道失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  let unregisterHint = '';
  if (process.platform === 'win32') {
    const wsl = await getWslLaneStatus(true).catch(() => null);
    if (wsl?.distro) {
      const res = await run(wslExePath(), ['-d', wsl.distro, '--', 'bash', '-lc', 'rm -rf "$HOME/.het-fti"']).catch(() => null);
      if (res && res.code === 0) {
        removed.push(`WSL 车道（${wsl.distro}）：~/.het-fti`);
      }
      unregisterHint = `\n如需连发行版一起删除：wsl --unregister ${wsl.distro}（仅当你不再需要该发行版时执行）`;
    }
  }
  void ctx.globalState.update('het.env.consented', false);
  const message = removed.length
    ? `已清理托管环境：\n· ${removed.join('\n· ')}${unregisterHint}`
    : `未发现可清理的托管环境。${unregisterHint}`;
  maybeToast('info', message);
  return { ok: removed.length > 0, message };
}

/**
 * 显式回退（设计原则：车道优先，绝不静默降级）：车道不可用时，由用户确认后把
 * 项目切到本机工具链（system · 兼容模式），并把代价说清楚（需自备 conan/编译器，
 * Windows/MSVC 无覆盖率）。可随时改回 managed。
 */
async function switchToSystemToolchain(): Promise<{ ok: boolean; message: string }> {
  const project = currentProject;
  if (!project) {
    void vscode.window.showWarningMessage(L('notify.noProject'));
    return { ok: false, message: '未检测到项目。' };
  }
  // Automation hosts (CI fresh-host runner, HET_NO_UI) must stay zero-manual:
  // the consent modal is skipped exactly like the env-prepare consent.
  const quiet = quietHost();
  const choice = quiet
    ? '切换为 system'
    : (await askModal(
        '改用本机工具链（兼容模式）？\n\n' +
          '将把 metadata.json 的 toolchain 设为 "system"：\n' +
          '· 构建/测试走本机 conan + MSVC（Windows）或系统 gcc/clang\n' +
          '· 需要你自行准备：conan 2、C/C++ 编译器、CMake（模板要求 ≥3.28，可用 -DHET_CMAKE_MIN 自降）\n' +
          '· Windows/MSVC 无覆盖率（该能力仅在 WSL2 托管车道可用）\n\n' +
          '改回 "managed" 即可恢复车道语义（并支持一键准备）。',
        '切换为 system',
      )) ?? '取消';
  if (choice !== '切换为 system') {
    return { ok: false, message: quiet ? '已取消。' : '已取消（未确认切换）。' };
  }
  try {
    const file = join(project.root, 'metadata.json');
    await writeText(file, withProjectToolchain(await readText(file), TOOLCHAIN_SYSTEM));
    // The native toolchain cannot instrument coverage on Windows/macOS
    // (MSVC / Apple clang) — leaving activate_code_coverage=true would make the
    // very next build fail at CMake configure. Turn it off in the same step.
    if (process.platform !== 'linux') {
      const applied = await applyMetadataPatch(project.root, { activate_code_coverage: false }, { persist: true });
      if (!applied.ok) {
        log('[env] 覆盖率开关未能自动关闭（可手动在 metadata.json 设置 activate_code_coverage=false）');
      }
    }
    log('[env] toolchain → system（用户显式切换，车道判定被绕过）');
    await refreshStatus();
    maybeToast('info', '已切换为本机工具链（system · 兼容模式）：构建/测试走本机工具链，覆盖率不可用。');
    return { ok: true, message: '已切换为本机工具链（system）。' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    maybeToast('error', `切换失败：${message}`);
    return { ok: false, message };
  }
}

/**
 * T07 (E15, partial): 「准备托管环境」 used to build a Windows-host venv under
 * globalStorage that NO build lane ever consumed — and that required a system
 * Python a bare machine does not have. The command now drives the REAL lane
 * (linux-managed / win-wsl2); macOS keeps the native path until its own lane
 * lands (T07 remainder). Consent still happens exactly once.
 */
async function runEnvPrepare(): Promise<{ ok: boolean; state: string; message: string }> {
  const ctx = contextRef;
  if (!ctx) {
    return { ok: false, state: 'absent', message: '扩展未就绪。' };
  }
  const plan = await getCurrentProvisionPlan(false, provisionPrefs()).catch(() => null);
  const consented = quietHost() || ctx.globalState.get<boolean>('het.env.consented', false) === true;
  if (!consented) {
    const choice = await askModal(
      '准备托管构建环境？将在隔离车道内下载 conan/cmake/ninja（Linux：~/.het-fti/managed-env；WSL2：发行版内同名路径），必要时用免密 root 安装编译器/lcov（会列出安装包）。可随时用「移除托管环境」清理。',
      '同意并开始',
    );
    if (choice !== '同意并开始') {
      return { ok: false, state: 'absent', message: '已取消。' };
    }
    await ctx.globalState.update('het.env.consented', true);
  }
  try {
    if (process.platform === 'win32') {
      const wsl = await getWslLaneStatus(true).catch(() => null);
      if (plan?.provider === 'win-wsl2' && wsl?.distro) {
        const r = await ensureWslLane(wsl.distro, { mirror: laneMirrorConfig() });
        const message = `WSL2 车道已就绪（${wsl.distro}）${r.note ? ` · ${r.note}` : ''}`;
        maybeToast('info', message);
        return { ok: true, state: 'ready', message };
      }
      const message = winLaneBlockedMessage(plan?.provider ?? 'win-wsl-required', wsl?.distro);
      maybeToast('warn', message);
      return { ok: false, state: 'absent', message };
    }
    if (process.platform === 'linux' && plan?.provider === 'linux-managed') {
      const r = await ensureLinuxLane({ mirror: laneMirrorConfig() });
      const message = `Linux 托管车道已就绪${r.note ? ` · ${r.note}` : ''}`;
      maybeToast('info', message);
      return { ok: true, state: 'ready', message };
    }
    if (process.platform === 'darwin') {
      const r = await ensureMacLane({ mirror: laneMirrorConfig() });
      const message = `macOS 托管车道已就绪${r.note ? ` · ${r.note}` : ''}（覆盖率不支持：有限支持）`;
      maybeToast('info', message);
      return { ok: true, state: 'ready', message };
    }
    const message = `当前为原生模式（provider=${plan?.provider ?? '?'}）：无需准备托管环境；如需隔离车道请提供 apt + 免密 root。`;
    maybeToast('info', message);
    return { ok: false, state: 'absent', message };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    maybeToast('error', message);
    return { ok: false, state: 'error', message };
  }
}

/**
 * T05 (E13): export a REDACTED environment dump (one command → one file) so a
 * colleague on an unknown machine can hand over everything needed to diagnose:
 * host capabilities, provider decision, lane facts, tool rows, versions, health
 * and the tail of the last build. Paths are collapsed to `~`.
 */
async function runEnvDump(): Promise<{ ok: boolean; path?: string; message: string }> {
  const ctx = contextRef;
  if (!ctx) {
    return { ok: false, message: '扩展未就绪。' };
  }
  try {
    const isWin = process.platform === 'win32';
    const plan = await getCurrentProvisionPlan(true, provisionPrefs()).catch(() => null);
    const host = await getHostCapabilities(true).catch(() => null);
    const managed = currentManagedStatus(ctx.globalStorageUri.fsPath, isWin);
    const rows = await ensureToolDiscovery(true).catch(() => [] as ToolRow[]);
    const rt = await ensureConanRuntime(true).catch(() => null);
    let lane: Record<string, unknown> | null = null;
    if (isWin) {
      const wsl = await getWslLaneStatus(true).catch(() => null);
      lane = {
        id: 'wsl2-managed',
        distro: wsl?.distro,
        ready: wsl?.ready ?? false,
        baseline: wsl?.baseline,
        arch: wsl?.arch,
        tools: wsl?.tools ?? {},
        note: wsl?.note,
      };
    } else if (process.platform === 'linux') {
      const lin = await getLinuxLaneStatus(true).catch(() => null);
      lane = lin ? { id: 'linux-managed', root: lin.home, ready: lin.ready, tools: lin.tools, note: lin.note } : null;
    } else {
      const osx = await getMacosLaneStatus(true).catch(() => null);
      lane = osx ? { id: 'macos-native', clt: osx.clt, clangVersion: osx.clangVersion, note: osx.note } : null;
    }
    const doc = buildEnvDump(
      {
        extension: { version: String(ctx.extension.packageJSON.version ?? '?'), vscode: vscode.version },
        host: (host ?? {}) as unknown as Record<string, unknown>,
        provider: plan ? { id: plan.provider, coverage: plan.coverage, reason: plan.reason } : null,
        lane,
        managed: { state: managed.state, tools: managed.tools, note: managed.note },
        tools: rows.map((r) => ({ key: r.key, source: r.source, exe: r.exe })),
        versions: { conan: rt?.version || '(未找到)', node: process.version },
        mirrors: {
          pip: laneMirrorConfig()?.pipIndexUrl ?? 'default (PyPI)',
          conan: laneMirrorConfig()?.conanRemote ?? 'conancenter',
          proxy: laneMirrorConfig()?.httpProxy ?? '(none)',
          note: 'T18：apt 镜像不重写复用的发行版（用 proxy 覆盖）；自建发行版见 T17-B',
        },
        health: lastHealth ? { score: lastHealth.score, verdict: lastHealth.verdict, gaps: lastHealth.gaps } : null,
        lastBuildTail: lastConanOutput.slice(-4096).split(/\r?\n/u).slice(-80),
      },
      redactRoots(),
    );
    const dir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ctx.globalStorageUri.fsPath;
    const file = join(dir, dumpFileName());
    await writeText(file, `${JSON.stringify(doc, null, 2)}\n`);
    try {
      await vscode.env.clipboard.writeText(file);
    } catch {
      /* clipboard is best-effort (headless hosts) */
    }
    log(`[dump] written: ${file}`);
    maybeToast('info', `环境诊断已导出（路径已复制到剪贴板）：\n${file}`);
    return { ok: true, path: file, message: '已导出环境诊断。' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    maybeToast('error', `导出环境诊断失败：${message}`);
    return { ok: false, message: `导出失败：${message}` };
  }
}

/** P-G3: compute how many commits the recorded template ref is behind (0 = up to date). */async function emitTemplateBehind(): Promise<void> {
  const root = currentProject?.root;
  if (!root) {
    emitCockpitEvent({ type: 'template:update', behind: 0 });
    return;
  }
  try {
    const markerFile = join(root, markerPath());
    if (!(await pathExists(markerFile))) {
      emitCockpitEvent({ type: 'template:update', behind: 0 });
      return;
    }
    const marker = parseMarker(await readText(markerFile));
    const source = templateSourceForInit();
    if (!marker?.ref || source.mode !== 'local' || !source.localPath) {
      emitCockpitEvent({ type: 'template:update', behind: 0 });
      return;
    }
    const git = await which('git');
    if (!git) {
      return;
    }
    const r = await run(git, ['-C', source.localPath, 'rev-list', '--count', `${marker.ref}..HEAD`]);
    emitCockpitEvent({ type: 'template:update', behind: r.code === 0 ? Number(r.stdout.trim()) || 0 : 0 });
  } catch {
    emitCockpitEvent({ type: 'template:update', behind: 0 });
  }
}

/** Read the project toolchain semantic (metadata.toolchain; missing = managed). */
async function projectToolchainFor(project: FcppProject): Promise<'managed' | 'system'> {
  try {
    const text = await readText(join(project.root, 'metadata.json'));
    return parseProjectToolchain(text) ?? 'managed';
  } catch {
    return 'managed';
  }
}

/** V5-6: the WSL2 managed-lane distro for a project (null = native/system). */
async function managedLaneDistro(project: FcppProject): Promise<string | null> {  if (process.platform !== 'win32') {
    return null;
  }
  const tc = await projectToolchainFor(project);
  if (tc === 'system') {
    return null;
  }
  const plan = await getCurrentProvisionPlan(false, provisionPrefs()).catch(() => null);
  const wsl = await getWslLaneStatus(false).catch(() => null);
  return plan?.provider === 'win-wsl2' && wsl?.available && wsl.distro ? wsl.distro : null;
}

/**
 * T03 (E3): environment-level guidance when a Windows managed project has no
 * usable WSL2 lane (feature missing or no distro). Mirror of the Linux lanes'
 * compiler guide — the user must see a fixable checklist, never a conan error.
 */
function winLaneBlockedMessage(provider: string, distro?: string): string {
  return [
    `managed 工具链需要 WSL2 车道（当前 provider=${provider}${distro ? ` · 发行版=${distro}` : ''}）。`,
    '请在管理员 PowerShell 任选一条，然后重新构建：',
    '  ① 启用 WSL2 并安装发行版：wsl --install -d Ubuntu-24.04（需虚拟化；可能需重启一次）',
    '  ② 已装好发行版：确认 `wsl -l -q` 能列出名字（车道会按阶梯自动准备 gcc/conan/cmake/lcov）',
    '  ③ 改用本机工具链（需自备 conan + MSVC）：点下面的「改用本机工具链（兼容模式）」一键切换（会说明代价），或手动把 metadata.json 的 toolchain 设为 "system"',
    '完成后可运行「HeT DevTools: 环境检查」（het.envCheck），或「导出环境诊断」（het.envDump）反馈问题。',
  ].join('\n');
}

/** Memoized host `cmake --version` line (contract row + native cmake decision). */
let hostCmakeCache: { at: number; version?: string } | null = null;
async function hostCmakeVersion(): Promise<string | undefined> {
  if (hostCmakeCache && Date.now() - hostCmakeCache.at < 30_000) {
    return hostCmakeCache.version;
  }
  let version: string | undefined;
  const exe = await which('cmake').catch(() => null);
  if (exe) {
    const r = await run(exe, ['--version'], { timeoutMs: 8000 }).catch(() => null);
    version = r?.stdout.split(/\r?\n/u).find((l) => l.trim().length > 0)?.trim();
  }
  hostCmakeCache = { at: Date.now(), version };
  return version;
}

/**
 * F1: which CMake may the NATIVE (toolchain=system) build use?
 *
 * Probes the host cmake and turns the pure decision (`nativeCmakePlan`) into the
 * child env for `conan create`: `HET_CMAKE_BUILD_REQUIRE=none` when the host
 * cmake meets the template floor (→ the host tool is used, no ConanCenter
 * download), otherwise the template's pinned cmake stays — with the reason and
 * the three ways out surfaced in the output channel.
 */
async function planNativeCmake(pinnedCmake?: string, conanExe?: string): Promise<{ reason: string; guide: string; env: NodeJS.ProcessEnv }> {
  const floor = effectiveCmakeFloor(process.env.HET_CMAKE_MIN);
  const version = await hostCmakeVersion().catch(() => undefined);
  const plan = nativeCmakePlan(version, floor, pinnedCmake ?? '');
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (plan.useHost) {
    env.HET_CMAKE_BUILD_REQUIRE = plan.buildRequire;
  }
  // Recipes shell out to bare `conan` (the template's coverage step does:
  // `subprocess.run(["conan","list", …])`) and to other tools next to it. Conan
  // may have been found by sniffing (conda envs) rather than on PATH, which made
  // the native build die with `FileNotFoundError: 'conan'`. Guarantee that its
  // own directory is on PATH for the child process — via the Windows-safe helper
  // (writing `PATH` on Windows alongside the existing `Path` drops System32).
  return { reason: plan.reason, guide: plan.guide, env: prependPath(env, conanExe ? dirname(conanExe) : '', delimiter) };
}

/** Run `conan create` in the project and stream everything to the output channel. */
async function runConanOnce(project: FcppProject): Promise<{ ok: boolean; stdout: string; stderr: string }> {  // V5-1: managed semantics on a WSL2-ready Windows host → build INSIDE the
  // WSL2 managed lane (Linux-identical gcc/gcov semantics, isolated from the
  // distro's conda base / FEniCS envs via its own venv + CONAN_HOME + profile).
  const isWin = process.platform === 'win32';
  const tc = await projectToolchainFor(project);
  // V5-6: coverage-enabled recipes run geninfo inside the test package on every
  // create — force-rebuild the project's own package so the captured .gcda
  // always carry current absolute paths (matches the fresh-runner CI).
  const forceSelf = project.metadata?.activate_code_coverage === true ? project.metadata.name : undefined;
  // T12 (E7): honour metadata.build_type for local builds (coverage stays Debug).
  const buildType = localBuildType(project.metadata);
  // T11 (E6): user profiles must apply to the LANE paths too — previously they
  // were read only by the native branch, so the documented escape hatch
  // (het.conan.profiles / HET_CONAN_PROFILES) silently did nothing on the
  // default (managed) path.
  const userProfiles = [
    ...vscode.workspace.getConfiguration('het').get<string[]>('conan.profiles', []),
    ...(process.env.HET_CONAN_PROFILES ?? '').split(';').filter((p) => p.length > 0),
  ].filter((p) => p.trim().length > 0);
  // T18: corporate mirror/proxy (pip · conan remote · http proxy).
  const mirror = laneMirrorConfig();
  if (mirror) {
    log(`[env] 镜像/代理：${mirrorSummary(mirror)}`);
  }
  let wslDistro: string | null = null;
  if (isWin && tc !== 'system') {
    const plan = await getCurrentProvisionPlan(false, provisionPrefs()).catch(() => null);
    const wsl = await getWslLaneStatus(false).catch(() => null);
    if (plan?.provider === 'win-wsl2' && wsl?.available && wsl.distro) {
      wslDistro = wsl.distro;
    } else {
      // T03 (E3/E14): managed semantics on Windows REQUIRE a usable WSL2 lane.
      // The old code logged and fell through to the native sniff, ending in a
      // misleading "找不到 conan。…请安装 Conan" while the dashboard said
      // "请启用 WSL2" — that contradiction is fixed by failing HERE, with the
      // actionable contract (both wsl2-pending and wsl-required share it).
      throw new Error(winLaneBlockedMessage(plan?.provider ?? 'win-wsl-required', wsl?.distro));
    }
  }
  // A3: managed semantics on an apt + passwordless-root Linux host → build
  // INSIDE the native-Linux managed lane (~/.het-fti/managed-env — the same
  // isolation the WSL2 lane gives Windows). Native (system/conda conan) is used
  // only when the lane cannot self-provision (linux-native provider) or when
  // metadata.toolchain=system is explicit (lane-first, native = last resort).
  const isLinuxManaged = !isWin && process.platform === 'linux' && tc !== 'system';
  let linuxManaged = false;
  if (isLinuxManaged) {
    const plan = await getCurrentProvisionPlan(false, provisionPrefs()).catch(() => null);
    if (plan?.provider === 'linux-managed') {
      linuxManaged = true;
    } else {
      log(`[conan] Linux 无隔离车道（provider=${plan?.provider ?? '?'}）→ 走原生；需要 apt+免密 root 才会启用 managed lane。`);
    }
  }
  if (linuxManaged) {
    log(`[conan] Linux 托管车道：${project.root}${forceSelf ? ` forceSelf=${forceSelf}` : ''}`);
    emitCockpitEvent({ type: 'log:start', title: `conan create . (${buildType}) · Linux lane` });
    let summary: { ok: boolean; stdout: string; stderr: string };
    try {
      const s = await runLinuxConanCreate(project.root, {
        buildType,
        forceSelf,
        profiles: userProfiles,
        mirror,
        onStdout: (c) => {
          channel?.append(c);
          emitCockpitEvent({ type: 'log:append', line: c.replace(/\s+$/u, '') });
        },
        onStderr: (c) => {
          channel?.append(c);
          emitCockpitEvent({ type: 'log:append', line: c.replace(/\s+$/u, '') });
        },
      });
      summary = s;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      channel?.appendLine(msg);
      emitCockpitEvent({ type: 'log:done', ok: false });
      throw new Error(msg);
    }
    lastConanOutput = `${summary.stdout}\n${summary.stderr}`;
    channel?.appendLine('');
    emitCockpitEvent({ type: 'log:done', ok: summary.ok });
    return { ok: summary.ok, stdout: summary.stdout, stderr: summary.stderr };
  }
  if (wslDistro) {
    log(`[conan] WSL2 托管车道：distro=${wslDistro} · ${project.root}${forceSelf ? ` forceSelf=${forceSelf}` : ''}`);
    emitCockpitEvent({ type: 'log:start', title: `conan create . (${buildType}) · WSL2 ${wslDistro}` });
    const summary = await runWslConanCreate(wslDistro, project.root, {
      buildType,
      forceSelf,
      profiles: userProfiles,
      mirror,
      onStdout: (c) => {
        channel?.append(c);
        emitCockpitEvent({ type: 'log:append', line: c.replace(/\s+$/u, '') });
      },
      onStderr: (c) => {
        channel?.append(c);
        emitCockpitEvent({ type: 'log:append', line: c.replace(/\s+$/u, '') });
      },
    });
    lastConanOutput = `${summary.stdout}\n${summary.stderr}`;
    channel?.appendLine('');
    emitCockpitEvent({ type: 'log:done', ok: summary.ok });
    return { ok: summary.ok, stdout: summary.stdout, stderr: summary.stderr };
  }

  // T07: macOS managed lane (limited support: build/test/docs committed,
  // coverage unsupported — Apple clang has no GNU gcov). Lane-first, so a CLT
  // problem surfaces as actionable guidance instead of a deep CMake error.
  if (process.platform === 'darwin' && tc !== 'system') {
    log(`[conan] macOS 托管车道：${project.root}${forceSelf ? ` forceSelf=${forceSelf}` : ''}`);
    emitCockpitEvent({ type: 'log:start', title: `conan create . (${buildType}) · macOS lane` });
    let macSummary: { ok: boolean; stdout: string; stderr: string };
    try {
      macSummary = await runMacConanCreate(project.root, {
        buildType,
        forceSelf,
        profiles: userProfiles,
        mirror,
        onStdout: (c) => {
          channel?.append(c);
          emitCockpitEvent({ type: 'log:append', line: c.replace(/\s+$/u, '') });
        },
        onStderr: (c) => {
          channel?.append(c);
          emitCockpitEvent({ type: 'log:append', line: c.replace(/\s+$/u, '') });
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      channel?.appendLine(msg);
      emitCockpitEvent({ type: 'log:done', ok: false });
      throw new Error(msg);
    }
    lastConanOutput = `${macSummary.stdout}\n${macSummary.stderr}`;
    channel?.appendLine('');
    emitCockpitEvent({ type: 'log:done', ok: macSummary.ok });
    return { ok: macSummary.ok, stdout: macSummary.stdout, stderr: macSummary.stderr };
  }

  const rt = await ensureConanRuntime();
  const conanExe = rt?.exe ?? (await locateConan());
  if (!conanExe) {
    throw new Error(
      '找不到 conan。已自动嗅探 conda 环境（miniforge/miniconda/anaconda 的 envs）仍无结果。\n请安装 Conan（pip install conan; conan profile detect --force），或设置 het.template.localPath / HET_TEMPLATE_LOCAL 类配置，或将其所在环境加入 PATH。',
    );
  }

  // Dev-machine adaptations (NOT shipped defaults): extra -pr profiles may be
  // needed to override e.g. the CMake version for newer VS generators.
  const profiles = userProfiles;

  // P2 (fresh machines / native): conan 2 refuses to run without a default
  // profile. When no extra profile is pinned, auto `conan profile detect` only
  // if the default is missing (never overwrite an existing user profile).
  if (profiles.length === 0) {
    const okProfile = await ensureConanDefaultProfile(conanExe);
    log(`[conan] native 默认 profile ${okProfile ? 'ok' : '缺失且 detect 失败（conan 将报错，建议手动 conan profile detect）'}`);
  }

  log(`[conan] ${conanExe} create . (${buildType}) in ${project.root}${profiles.length ? ` profiles=${profiles.join(',')}` : ''}`);

  // F1: "toolchain=system" must mean *the host's* tools. Until now the template
  // always pulled `cmake/<metadata.cmake_version>` from ConanCenter, so even a
  // perfectly good host cmake was ignored (and intranets paid a ~40 MB download).
  // Now: host cmake ≥ floor → HET_CMAKE_BUILD_REQUIRE=none (host cmake is used);
  // otherwise keep the pinned cmake but SAY SO with the three ways out.
  const cmakePlan = await planNativeCmake(project.metadata?.cmake_version, conanExe);
  log(`[cmake] ${cmakePlan.reason}`);
  if (cmakePlan.guide) {
    channel?.appendLine(cmakePlan.guide);
    log('[cmake] 提示：宿主 CMake 低于模板下限，本次将联网拉取模板钉死的版本');
  }

  emitCockpitEvent({ type: 'log:start', title: `conan create . (${buildType}) · ${project.metadata?.name ?? project.root}` });
  const summary = await runConanCreate(
    conanExe,
    project.root,
    { buildType, profiles },
    {
      onStdout: (c) => {
        channel?.append(c);
        emitCockpitEvent({ type: 'log:append', line: c.replace(/\s+$/u, '') });
      },
      onStderr: (c) => {
        channel?.append(c);
        emitCockpitEvent({ type: 'log:append', line: c.replace(/\s+$/u, '') });
      },
      timeoutMs: 0,
      env: cmakePlan.env,
    },
  );
  lastConanOutput = `${summary.stdout}\n${summary.stderr}`;
  channel?.appendLine('');
  emitCockpitEvent({ type: 'log:done', ok: summary.ok });
  return { ok: summary.ok, stdout: summary.stdout, stderr: summary.stderr };
}

/** Run `conan create` for the current project; map diagnostics to the Problems panel. */
async function buildProject(): Promise<void> {
  const project = currentProject;
  if (!project || !project.metadata) {
    void vscode.window.showWarningMessage(L('notify.noProject'));
    return;
  }
  buildDiagnostics.clear();

  // T15 (E14): environment gate — fail fast with the contract card instead of
  // letting an unprepared lane die deep inside CMake/conan.
  const gate = await preflightEnvGate();
  if (!gate.ok) {
    lastBuildError = gate.message ?? '构建环境未就绪。';
    const pick = await vscode.window.showErrorMessage(lastBuildError, '打开环境面板', '导出环境诊断');
    if (pick === '打开环境面板') {
      void vscode.commands.executeCommand('het.dashboard', 'overview');
    } else if (pick === '导出环境诊断') {
      void vscode.commands.executeCommand('het.envDump');
    }
    return;
  }

  let result: { ok: boolean; stdout: string; stderr: string };
  try {
    result = await runConanOnce(project);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    lastBuildError = message;
    // Lane-first design: when the managed lane cannot start we DO NOT silently
    // fall back — we hand the user the two explicit choices.
    const pick = await vscode.window.showErrorMessage(message, '改用本机工具链（兼容模式）', '导出环境诊断');
    if (pick === '改用本机工具链（兼容模式）') {
      await switchToSystemToolchain();
    } else if (pick === '导出环境诊断') {
      void vscode.commands.executeCommand('het.envDump');
    }
    return;
  }

  const issues = parseCompilerOutput(`${result.stdout}\n${result.stderr}`);
  mapIssues(issues, project.root);
  log(`[build] finished ok=${result.ok} issues=${issues.length}`);
  markBuildOutcome(result.ok);
  emitCockpitEvent({ type: 'issue:summary', count: issues.length });

  if (result.ok) {
    maybeToast('info', `构建成功 — ${project.metadata.name} (Debug)`);
  } else {
    const detail = issues.length > 0 ? `${issues.length} 个错误/警告，详见“问题”面板` : '详见“输出 → HeT DevTools”';
    maybeToast('error', `构建失败：${detail}`);
  }
  void refreshChip();
  // V5-6: after a real run the lane is provisioned — re-grade health (env.conan).
  void ensureHealthCached(true);
}

/**
 * One full "build + run tests" cycle, shared by the het.test command and the
 * Test Explorer controller: runs conan create, maps diagnostics, records the
 * parsed summary and last output, and returns the raw result.
 */
async function executeTestRun(): Promise<{ ok: boolean; stdout: string; stderr: string } | undefined> {
  const project = currentProject;
  if (!project || !project.metadata) {
    void vscode.window.showWarningMessage(L('notify.noProject'));
    return undefined;
  }

  let result: { ok: boolean; stdout: string; stderr: string };
  try {
    result = await runConanOnce(project);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    lastConanOutput = message;
    lastBuildError = message;
    void vscode.window.showErrorMessage(message);
    return undefined;
  }

  const fullOutput = `${result.stdout}\n${result.stderr}`;
  const issues = parseCompilerOutput(fullOutput);
  mapIssues(issues, project.root);

  markBuildOutcome(result.ok);
  lastTestSummary = parseGTestOutput(fullOutput);
  emitCockpitEvent({ type: 'issue:summary', count: issues.length });
  log(
    `[test] ok=${result.ok} gtest=${JSON.stringify({ p: lastTestSummary.passed, f: lastTestSummary.failed, s: lastTestSummary.skipped })}`,
  );
  void refreshChip();
  // V5-6: the lane may have been provisioned by this run — re-grade health now.
  void ensureHealthCached(true);
  return result;
}

/** Run `conan create` (includes the test package step) and show a parsed test view. */
async function runTests(): Promise<void> {
  const project = currentProject;
  if (!project || !project.metadata) {
    void vscode.window.showWarningMessage(L('notify.noProject'));
    return;
  }

  const result = await executeTestRun();
  if (!result) {
    return;
  }

  if (!result.ok) {
    void vscode.window.showErrorMessage('构建/测试失败：先修复构建错误（见问题面板），再重新测试。');
    return;
  }
  if (lastTestSummary?.empty) {
    void vscode.window.showInformationMessage(
      '构建成功，但未捕获到 GTest 用例。请确认 metadata.json 的 trigger_tests=true 且 test_package/test/unit 下有测试。',
    );
    return;
  }
  void vscode.window.showInformationMessage(
    L('test.done', { passed: lastTestSummary?.passed ?? 0, failed: lastTestSummary?.failed ?? 0, skipped: lastTestSummary?.skipped ?? 0 }),
  );
  if (lastTestSummary) {
    showTestResults(contextRef, lastTestSummary);
  }
}

function showStoredTestResults(context: vscode.ExtensionContext): void {
  if (!lastTestSummary) {
    void vscode.window.showInformationMessage('尚无测试结果。先运行：HeT DevTools: 构建并测试。');
    return;
  }
  showTestResults(context, lastTestSummary);
}

let contextRef: vscode.ExtensionContext;

function showTestResults(context: vscode.ExtensionContext, summary: GTestRunSummary): void {
  contextRef = context;
  showTestResultsPanel(context, summary, {
    runTests: () => void runTests(),
    openFile: (file, line) => openFileAt(file, line),
  });
}

/** Open a (possibly relative) file at a 1-based line. */
async function openFileAt(file: string, line: number): Promise<void> {
  const root = currentProject?.root;
  const abs = isAbsolute(file) ? file : root ? join(root, file) : file;
  try {
    const doc = await vscode.workspace.openTextDocument(abs);
    const editor = await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.One });
    const pos = new vscode.Position(Math.max(0, line - 1), 0);
    editor.revealRange(new vscode.Range(pos, pos));
  } catch (err) {
    void vscode.window.showWarningMessage(`无法打开 ${abs}：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Resolve relative compiler paths against the project root and publish diagnostics. */
function mapIssues(issues: ParsedIssue[], projectRoot: string): void {
  const byFile = new Map<string, vscode.Diagnostic[]>();
  for (const issue of issues) {
    const abs = isAbsolute(issue.file) ? issue.file : join(projectRoot, issue.file);
    const uri = vscode.Uri.file(abs);
    const range = new vscode.Range(
      new vscode.Position(Math.max(0, issue.line - 1), Math.max(0, (issue.column ?? 1) - 1)),
      new vscode.Position(Math.max(0, issue.line - 1), 1024),
    );
    const diagnostic = new vscode.Diagnostic(
      range,
      issue.message,
      issue.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
    );
    diagnostic.source = 'het-build';
    const list = byFile.get(uri.toString()) ?? [];
    list.push(diagnostic);
    byFile.set(uri.toString(), list);
  }
  for (const [uriKey, diagnosticsList] of byFile) {
    buildDiagnostics.set(vscode.Uri.parse(uriKey), diagnosticsList);
  }
}

export function deactivate(): void {
  log('deactivated');
}
