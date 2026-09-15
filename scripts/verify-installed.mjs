// Zero-manual verification of the INSTALLED het-devtools vsix.
//
//   1. Installs the packaged het-devtools vsix into an isolated extensions dir
//      of a downloaded VS Code copy (out/code-test) — no human action at all.
//   2. Bundles a tiny "verify runner" extension (id het-verify-runner) that
//      does NOT contain het-devtools, so the only het extension present is the
//      installed one.
//   3. Runs two automated phases (empty workspace → create projects offline;
//      then the created project → detect/chip/dashboard).
//
// Usage:  node scripts/verify-installed.mjs   (after `npm run package`)
import { build } from 'esbuild';
import { runTests } from '@vscode/test-electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const codeDir = join(root, 'out', 'code-test', 'vscode-win32-x64-archive-1.136.1');
const codeExe = join(codeDir, 'Code.exe');
// Read the version from package.json so version bumps (e.g. 0.1.0 -> 0.1.1)
// never desync the vsix filename / installed extension dir used here.
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const vsix = join(root, `het-devtools-${version}.vsix`);

const runnerDir = join(root, 'out', 'verifyRunner');
const extDir = join(root, 'out', 'verify-ext');
const udDir = join(root, 'out', 'verify-ud');
const emptyWs = join(root, 'out', 'verify-ws');
const proj = join(root, 'out', 'verify-proj');

if (!existsSync(codeExe)) {
  console.error('[verify-installed] downloaded VS Code missing: run an integration test first');
  process.exit(1);
}
if (!existsSync(vsix)) {
  console.error('[verify-installed] vsix missing: run `npm run package` first');
  process.exit(1);
}

// 1) "install" the vsix into an isolated extensions dir (offline, deterministic):
//    a .vsix is a zip whose `extension/` root is the extension folder.
rmSync(extDir, { recursive: true, force: true });
rmSync(udDir, { recursive: true, force: true });
rmSync(runnerDir, { recursive: true, force: true });
// Quiet host: kill every UI source that could demand human action (the built-in
// Git extension otherwise toasts about the repo our init just created; welcome
// /update/telemetry prompts are equally unwanted for a zero-manual run).
mkdirSync(join(udDir, 'User'), { recursive: true });
writeFileSync(
  join(udDir, 'User', 'settings.json'),
  JSON.stringify(
    {
      'git.enabled': false,
      'git.autorefresh': false,
      'workbench.startupEditor': 'none',
      'workbench.welcomePage.walkthroughs.openOnInstall': false,
      'update.mode': 'none',
      'extensions.autoCheckUpdates': false,
      'extensions.autoUpdate': false,
      'telemetry.telemetryLevel': 'off',
      'window.restoreWindows': 'none',
      'files.watcherExclude': { '**/.git/objects/**': true, '**/.git/subtree-cache/**': true },
    },
    null,
    2,
  ),
);
const tmp = join(root, 'out', 'verify-tmp');
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
mkdirSync(emptyWs, { recursive: true });
rmSync(proj, { recursive: true, force: true });
execFileSync('tar', ['-xf', vsix, '-C', tmp], { stdio: 'pipe' });
// VS Code names the installed folder `<publisher>.<name>-<version>` from
// package.json — never hardcode it (a publisher rename silently breaks this).
const installed = join(extDir, `${pkg.publisher}.${pkg.name}-${version}`);
cpSync(join(tmp, 'extension'), installed, { recursive: true });
rmSync(tmp, { recursive: true, force: true });
if (!existsSync(join(installed, 'assets', 'template', 'metadata.json'))) {
  console.error('[verify-installed] FATAL: installed vsix has no assets/template/metadata.json');
  process.exit(1);
}
console.log('[verify-installed] vsix installed; bundled template present');

// 2) bundle the verify runner (extension + tests)
const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'], sourcemap: false, logLevel: 'warning' };
mkdirSync(join(runnerDir), { recursive: true });
cpSync(join(root, 'src', 'test', 'installedRunner', 'package.json'), join(runnerDir, 'package.json'));
await Promise.all([
  build({ ...common, entryPoints: [join(root, 'src', 'test', 'installedRunner', 'extension.ts')], outfile: join(runnerDir, 'extension.js') }),
  build({ ...common, entryPoints: [join(root, 'src', 'test', 'installedRunner', 'verify.ts')], outfile: join(runnerDir, 'verify.js') }),
]);

process.env.VSLANG = '1033';
process.env.HET_VERIFY_DEST = proj;

const launch = (workspace, phase) => ({
  vscodeExecutablePath: codeExe,
  extensionDevelopmentPath: runnerDir,
  extensionTestsPath: join(runnerDir, 'verify.js'),
  launchArgs: [workspace, '--extensions-dir', extDir, '--user-data-dir', udDir],
  ...(phase ? { extraArgs: undefined } : {}),
});


const only = (process.env.HET_VERIFY_ONLY ?? '').trim(); // e.g. HET_VERIFY_ONLY=empty
const want = (p) => !only || only === p;

// The downloaded VS Code copy occasionally drops the window at launch (host
// exits 0 before any test output). Zero-manual means the harness must be
// self-healing: retry a phase a few times before giving up.
async function runPhase(name, prepare) {
  const attempts = 3;
  for (let i = 1; i <= attempts; i++) {
    try {
      // A crashed previous launch may leave a Code process holding our
      // user-data dir lock; clear strays so the next attempt can start.
      try {
        execFileSync('powershell', [
          '-NoProfile', '-Command',
          `Get-CimInstance Win32_Process -Filter "Name='Code.exe'" | Where-Object { $_.CommandLine -like '*${udDir}*' -or $_.CommandLine -like '*${extDir}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
        ], { stdio: 'ignore' });
      } catch { /* cleanup is best-effort */ }
      prepare?.();
      // Backstop: a phase window must not live forever. The in-host watchdog
      // force-exits a stuck run after ~60 s of no progress; this outer race is
      // the last line of defense for whole-host hangs.
      const phaseDone = runTests(launch(name === 'empty' ? emptyWs : proj, name));
      const result = await Promise.race([
        phaseDone.then(() => ({ ok: true })),
        new Promise((resolve) => setTimeout(() => resolve({ ok: false, reason: 'window alive >6 min without completing' }), 6 * 60_000)),
      ]);
      if (!result.ok) {
        throw new Error(result.reason);
      }
      console.log(`[verify-installed] ${name}-phase host exited cleanly`);
      return;
    } catch (err) {
      console.log(`[verify-installed] ${name}-phase attempt ${i}/${attempts} failed: ${err?.message ?? err}`);
      if (i === attempts) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

if (want('empty')) {
  process.env.HET_VERIFY_PHASE = 'empty';
  // The empty phase exercises the Explorer "init here" channel. Point it at the
  // installed bundled template so creation is deterministic/offline (no network
  // wait): the default pinned→fallback chain is exercised by phase-gui unit/C4.
  process.env.HET_TEMPLATE_LOCAL = join(installed, 'assets', 'template');
  await runPhase('empty');
  delete process.env.HET_TEMPLATE_LOCAL;
}

if (want('proj')) {
  process.env.HET_VERIFY_PHASE = 'proj';
  await runPhase('proj');
}

// V4-7: four VIRTUAL hosts (win-noWSL / win-WSL2 / linux / macos) simulated in
// one host via HET_FAKE_HOST — Provider selection must be deterministic.
if (want('matrix')) {
  process.env.HET_VERIFY_PHASE = 'matrix';
  await runPhase('matrix');
}

// 3) scrub phase: a plain PowerShell PATH (no conda anywhere) — the extension
//    must sniff the conda env by itself and run a real `conan create`.
if (want('scrub')) {
  const saved = {
    PATH: process.env.PATH,
    CONDA_EXE: process.env.CONDA_EXE,
    CONDA_PREFIX: process.env.CONDA_PREFIX,
    MAMBA_ROOT_PREFIX: process.env.MAMBA_ROOT_PREFIX,
  };
  await runPhase('scrub', () => {
    delete process.env.CONDA_EXE;
    delete process.env.CONDA_PREFIX;
    delete process.env.MAMBA_ROOT_PREFIX;
    const defaultProfile = join(process.env.USERPROFILE ?? 'C:/Users/Chen', '.conan2', 'profiles', 'default');
    const c1Profile = join(root, 'out', 'c1-profile2.txt');
    process.env.HET_CONAN_PROFILES = defaultProfile + ';' + c1Profile;
    process.env.PATH = [join(root, 'out', 'binutils'), 'C:/Windows/System32', 'C:/Windows'].join(';');
    process.env.HET_VERIFY_PHASE = 'scrub';
  });
  process.env.PATH = saved.PATH;
  if (saved.CONDA_EXE !== undefined) { process.env.CONDA_EXE = saved.CONDA_EXE; }
  if (saved.CONDA_PREFIX !== undefined) { process.env.CONDA_PREFIX = saved.CONDA_PREFIX; }
  if (saved.MAMBA_ROOT_PREFIX !== undefined) { process.env.MAMBA_ROOT_PREFIX = saved.MAMBA_ROOT_PREFIX; }
}

console.log('[verify-installed] ALL OK — installed vsix verified with zero manual interaction');
