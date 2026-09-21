// Runs the C6 check fully offline (two phases: empty workspace → chip hidden +
// init-here registered, mini-fcpp project → chip overview + dashboard deps).
// Usage: npm run test:c6
import { runTests } from '@vscode/test-electron';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { ISOLATED_LAUNCH_ARGS, killTestWindows } from './lib/testWindows.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const emptyWs = join(root, 'out', 'c6-ws');
const miniFcpp = join(root, 'src', 'test', 'fixtures', 'mini-fcpp');

mkdirSync(emptyWs, { recursive: true });

const candidates = [
  process.env.VSCODE_EXECUTABLE_PATH,
  'C:/Users/Chen/AppData/Local/Programs/Microsoft VS Code/Code.exe',
  join(root, 'out', 'code-test', 'vscode-win32-x64-archive-1.136.1', 'Code.exe'),
  '/usr/bin/code',
];
const vscodeExecutablePath = candidates.find((p) => p && existsSync(p));
process.env.VSLANG = '1033';
process.env.HET_NO_UI = '1'; // automation: never show on-boarding/notifications

/** Kill any test VS Code still holding the .vscode-test user-data dir. */
function killTestCode() {
  try {
    execFileSync('powershell', [
      '-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='Code.exe'\" | Where-Object { $_.CommandLine -like '*\\.vscode-test*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    ], { stdio: 'ignore' });
  } catch { /* best-effort */ }
}

/** Run one phase; if the window shows no sign of completing within 3 min, kill it. */
async function runPhase(name, ws) {
  process.env.HET_C6_PHASE = name;
  const p = runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: root,
    extensionTestsPath: join(root, 'out', 'test-integration', 'c6.js'),
    launchArgs: [ws, ...ISOLATED_LAUNCH_ARGS],
  });
  const done = await Promise.race([
    p.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 3 * 60_000)),
  ]);
  if (!done) {
    killTestCode();
    throw new Error(`[c6] ${name}-phase window alive >3 min without completing — force killed`);
  }
  console.log(`[c6] ${name}-phase host exited cleanly`);
}

async function main() {
  await runPhase('empty', emptyWs);
  await runPhase('proj', miniFcpp);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
