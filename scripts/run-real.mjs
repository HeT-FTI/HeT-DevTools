// P2 cross-platform REAL host runner (macOS native / Linux).
// Prepares a real project from the COMMITTED assets/template (coverage off —
// macOS has no GNU lcov/gcov; the coverage lane stays Linux/WSL DoD + verify),
// then launches a real VS Code extension host on the CURRENT platform and runs
// src/test/integration/realBuild.ts through the extension.
// Usage: npm run test:real   (needs VSCODE_VERSION or a local VS Code)
import { runTests } from '@vscode/test-electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readdirSync, rmSync, readFileSync, writeFileSync, cpSync, accessSync, constants as fsConsts } from 'node:fs';
import { platform, homedir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tpl = join(root, 'assets', 'template');
const proj = join(root, 'out', 'real-proj');

if (!existsSync(join(tpl, 'metadata.json'))) {
  console.error('[real] committed template missing under assets/template');
  process.exit(1);
}

// Fresh project copy from the committed template (deterministic on CI).
rmSync(proj, { recursive: true, force: true });
cpSync(tpl, proj, { recursive: true });
const metaPath = join(proj, 'metadata.json');
const meta = JSON.parse(readFileSync(metaPath, 'utf8'));

// T23/CI fresh-host switches (see .github/workflows/env-fresh-{linux,windows,macos}.yml):
//   HET_REAL_FRESH=1           → wipe the host managed lane (~/.het-fti) first,
//                                so provisioning is proven from scratch
//   HET_REAL_TOOLCHAIN=system  → fixture gets metadata.toolchain=system (native
//                                loop; coverage off — MSVC/native limitation)
//   HET_REAL_EXPECT=blocked    → managed build must REFUSE with guidance
const modeSystem = process.env.HET_REAL_TOOLCHAIN === 'system';
if (process.env.HET_REAL_FRESH === '1') {
  const lane = join(homedir(), '.het-fti');
  rmSync(lane, { recursive: true, force: true });
  console.log('[real] fresh host: removed ' + lane);
}

// Coverage stays ON for Linux (the managed lane runs lcov/genhtml — real
// lane-coverage validation). macOS has no GNU gcov/lcov, so disable it there.
if (platform() === 'darwin' && meta.activate_code_coverage !== false) {
  meta.activate_code_coverage = false;
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
}
if (modeSystem && meta.toolchain !== 'system') {
  // Same effect as `het.useSystemToolchain`: build/test on the host toolchain.
  // Coverage is a lane-only capability → off, so CMake configure cannot fail.
  meta.toolchain = 'system';
  meta.activate_code_coverage = false;
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
}
console.log(
  `[real] project fixture ready: ${proj} (toolchain=${meta.toolchain ?? 'managed'} coverage=${meta.activate_code_coverage ? 'on' : 'off'})`,
);

// Explicit scenario banner (T23): the job log must state WHAT is verified.
const scenario =
  process.env.HET_REAL_EXPECT === 'blocked'
    ? 'blocked-guidance → explicit system switch'
    : modeSystem
      ? 'system toolchain (no lane)'
      : 'managed lane (fresh)';
console.log('='.repeat(78));
console.log('[real] SCENARIO : ' + scenario);
console.log(
  '[real] switches : ' +
    JSON.stringify({
      HET_REAL_FRESH: process.env.HET_REAL_FRESH ?? '(unset)',
      HET_REAL_TOOLCHAIN: process.env.HET_REAL_TOOLCHAIN ?? '(unset)',
      HET_REAL_EXPECT: process.env.HET_REAL_EXPECT ?? '(unset)',
      HET_REAL_EXPECT_PROVIDER: process.env.HET_REAL_EXPECT_PROVIDER ?? '(unset)',
      HET_REAL_EXPECT_AFTER_SWITCH: process.env.HET_REAL_EXPECT_AFTER_SWITCH ?? '(unset)',
    }),
);
console.log('[real] platform : ' + platform() + ' · node ' + process.version);
console.log(
  '[real] asserting: provider decision → conan create → GTest' +
    (modeSystem ? ' → docs artifacts' : ' → coverage report (linux lane) → docs artifacts'),
);
console.log('='.repeat(78));

// Native macOS docs must run under the SAME python that owns conan + the docs
// deps (the CI conan venv /tmp/het-conan, where sphinx/numpy are installed).
// The runner PATH may list a system `python` before that venv, so which('python')
// inside the extension host would pick an interpreter WITHOUT numpy and
// docs/build.py crashes at `import numpy`. Prepend the venv so python/python3
// resolve deterministically (no-op on a dev box without that venv).
if (platform() !== 'win32') {
  for (const venvBin of ['/tmp/het-conan/bin']) {
    if (existsSync(join(venvBin, 'python')) && process.env.PATH) {
      // Force to the FRONT even if already listed (the runner may append the
      // venv AFTER a system python, which shadows it for which('python')).
      const parts = process.env.PATH.split(':').filter((p) => p && p !== venvBin);
      process.env.PATH = `${venvBin}:${parts.join(':')}`;
      console.log('[real] prepended to PATH: ' + venvBin);
    }
  }
}

function isExec(p) {
  try {
    accessSync(p, fsConsts.X_OK);
    return true;
  } catch {
    return false;
  }
}

// macOS: locate the app's MAIN executable without hardcoding its name (the
// cask layout has varied: Electron / Visual Studio Code / …). Prefer the known
// names, else the first executable that is not a Helper.
function macAppExecutable() {
  const app = '/Applications/Visual Studio Code.app';
  const macosDir = join(app, 'Contents', 'MacOS');
  if (!existsSync(macosDir)) {
    return undefined;
  }
  const known = ['Electron', 'Visual Studio Code', 'Code'];
  for (const name of known) {
    const p = join(macosDir, name);
    if (isExec(p)) {
      return p;
    }
  }
  let entries = [];
  try {
    entries = readdirSync(macosDir);
  } catch {
    return undefined;
  }
  for (const name of entries) {
    if (/ Helper(\.app)?$/i.test(name)) {
      continue;
    }
    const p = join(macosDir, name);
    if (isExec(p)) {
      return p;
    }
  }
  return undefined;
}

const candidates = [
  process.env.VSCODE_EXECUTABLE_PATH,
  ...(platform() === 'darwin' ? [macAppExecutable()] : []),
  'C:/Users/Chen/AppData/Local/Programs/Microsoft VS Code/Code.exe',
  '/usr/bin/code',
  '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
].filter(Boolean);
const vscodeExecutablePath = candidates.find((p) => p && existsSync(p) && isExec(p));
if (vscodeExecutablePath) {
  console.log('[real] using VS Code executable: ' + vscodeExecutablePath);
}

async function main() {
  const opts = {
    extensionDevelopmentPath: root,
    extensionTestsPath: join(root, 'out', 'test-integration', 'realBuild.js'),
    launchArgs: [proj],
  };
  if (vscodeExecutablePath) {
    opts.vscodeExecutablePath = vscodeExecutablePath;
  } else if (!process.env.VSCODE_VERSION) {
    throw new Error('no local VS Code found and VSCODE_VERSION not set');
  } else {
    // Pin the download: without this, @vscode/test-electron silently fetched the
    // LATEST VS Code (the CI job asked for 1.95.0 but ran 1.137.0 — and the newer
    // host stopped carrying `--extensionTestsPath` in the extension-host argv,
    // which is how the modal-detection bug surfaced). Pinning keeps every job on
    // the same host version.
    opts.version = process.env.VSCODE_VERSION;
  }
  // This harness IS an automation host: make it explicit instead of relying on
  // argv sniffing, so modals/toasts are never attempted (vscode refuses dialogs
  // in test hosts and the rejection used to kill the command).
  process.env.HET_NO_UI = '1';
  console.log(
    '[real] VS Code: ' +
      (vscodeExecutablePath ? `local ${vscodeExecutablePath}` : `download @ ${process.env.VSCODE_VERSION}`),
  );
  console.log('[real] automation markers: HET_NO_UI=1' + (process.env.HET_VERIFY_PHASE ? ' HET_VERIFY_PHASE=' + process.env.HET_VERIFY_PHASE : ''));
  await runTests(opts);
  console.log('[real] host exited cleanly');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
