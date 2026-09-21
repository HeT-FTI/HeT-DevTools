// Runs the C8 one-tab / in-page slot check (V2 §6-A, 0-manual + watchdog):
// cockpit is the ONLY editor tab; opening detail views fills an in-page slot
// (mutually exclusive), never a new tab. Usage: npm run test:c8
import { runTests } from '@vscode/test-electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ws = join(root, 'out', 'c8-ws');
const miniFcpp = join(root, 'src', 'test', 'fixtures', 'mini-fcpp');

rmSync(ws, { recursive: true, force: true });
mkdirSync(ws, { recursive: true });
// Reuse the committed mini-fcpp fixture (same shape as c5/c6 use).
if (existsSync(miniFcpp)) {
  execFileSync('cp', ['-R', miniFcpp + '/.', ws]);
} else {
  console.error('[c8] fixture missing: ' + miniFcpp);
  process.exit(1);
}

const localCandidates = [
  'C:/Users/Chen/AppData/Local/Programs/Microsoft VS Code/Code.exe',
  '/usr/share/code/code',
  '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
];
// 优先级：显式 VSCODE_EXECUTABLE_PATH > VSCODE_VERSION（下载，与 CI 一致）> 本机安装。
// 本机那份可能是旧的（实测 1.109 < ^1.134）——那时扩展根本不会被加载，报出来的会是个
// secondary 错误（"extension must be discovered"），白查半天。
const explicitPath = process.env.VSCODE_EXECUTABLE_PATH;
const wantDownload = !!process.env.VSCODE_VERSION;
const vscodeExecutablePath =
  explicitPath ?? (wantDownload ? undefined : localCandidates.find((p) => p && existsSync(p)));
if (!vscodeExecutablePath && !wantDownload) {
  console.error('[c8] 没有可用的 VS Code，且未设 VSCODE_VERSION（无法下载指定版本）');
  process.exit(1);
}

process.env.VSLANG = '1033';
process.env.HET_NO_UI = '1'; // zero-manual host: no toasts/on-boarding
rmSync(join(root, '.vscode-test'), { recursive: true, force: true });
// 证据文件：用例跑完才写。少了它就说明"宿主根本没跑用例"（CLI 忽略参数也会退 0）。
const evidence = join(root, 'out', 'c8-evidence.txt');
rmSync(evidence, { force: true });

/** Kill any test VS Code still holding the .vscode-test user-data dir (best effort). */
function killTestCode() {
  try {
    execFileSync('pkill', ['-f', '.vscode-test'], { stdio: 'ignore' });
  } catch {
    /* best-effort */
  }
}

async function main() {
  const p = runTests({
    ...(vscodeExecutablePath ? { vscodeExecutablePath } : {}),
    extensionDevelopmentPath: root,
    extensionTestsPath: join(root, 'out', 'test-integration', 'c8.js'),
    launchArgs: [ws, '--disable-extensions'],
  });
  // 看门狗：卡住 = 失败（退出码 97，和 utils/watchdog.ts 同一套约定）
  const done = await Promise.race([
    p.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 3 * 60_000)),
  ]);
  if (!done) {
    killTestCode();
    console.error('[c8] host alive >3 min without completing — force killed (watchdog)');
    process.exit(97);
  }
  if (!existsSync(evidence)) {
    console.error(
      '[c8] 宿主退出了，但用例没有留下证据文件 —— 说明测试根本没跑起来（例如把 VS Code CLI 当成了可执行文件）。' +
        '请用真正的 Electron 可执行文件：VSCODE_EXECUTABLE_PATH=/usr/share/code/code npm run test:c8',
    );
    process.exit(1);
  }
  console.log('[c8] evidence:\n' + readFileSync(evidence, 'utf8').trim());
  console.log('[c8] host exited cleanly');
}

main().catch((e) => {
  console.error('[c8] FAILED: ' + (e?.message ?? e));
  process.exit(1);
});
