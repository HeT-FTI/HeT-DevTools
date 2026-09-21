// Runs the C8 one-tab / in-page slot check (V2 §6-A, 0-manual + watchdog):
// cockpit is the ONLY editor tab; opening detail views fills an in-page slot
// (mutually exclusive), never a new tab. Usage: npm run test:c8
import { runTests } from '@vscode/test-electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { ISOLATED_LAUNCH_ARGS, killTestWindows } from './lib/testWindows.mjs';

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
const pin = process.env.VSCODE_VERSION;
const wantDownload = !!pin;
const vscodeExecutablePath =
  explicitPath ?? (wantDownload ? undefined : localCandidates.find((p) => p && existsSync(p)));
if (!vscodeExecutablePath && !wantDownload) {
  // 实测教训：`@vscode/test-electron` **不读** VSCODE_VERSION。不显式传 version 时它下载
  // "stable"（最新版）—— 于是"我跑的是 1.134"这句话是假的（真的跑到了 1.138）。
  // 所以：没有本地可执行文件就必须显式给版本；想跑 latest 得显式说 HET_VSCODE_ALLOW_LATEST=1。
  if (process.env.HET_VSCODE_ALLOW_LATEST === '1') {
    console.warn('[c8] 未指定版本 → 将下载 stable（最新版）：结论请按"最新版"记录');
  } else {
    console.error('[c8] 没有可用的 VS Code，且未设 VSCODE_VERSION（显式给版本，或用 HET_VSCODE_ALLOW_LATEST=1 接受最新版）');
    process.exit(1);
  }
}

process.env.VSLANG = '1033';
process.env.HET_NO_UI = '1'; // zero-manual host: no toasts/on-boarding
rmSync(join(root, '.vscode-test'), { recursive: true, force: true });
// 证据文件：用例跑完才写。少了它就说明"宿主根本没跑用例"（CLI 忽略参数也会退 0）。
const evidence = join(root, 'out', 'c8-evidence.txt');
rmSync(evidence, { force: true });

/**
 * 跑之前先清一次：残留的测试窗口会占着 `.vscode-test` 的 user-data-dir，
 * 让这次 runTests 附着到旧窗口（结论就不是这一份代码了），而且会在服务器上堆积
 * 一堆 Electron 进程 —— 用户看到的"卡在远程连接密码提示的窗口"就是这么来的。
 */
const cleanedBefore = killTestWindows('c8:pre');
if (cleanedBefore.failed.length > 0) {
  console.error('[c8] 有测试窗口杀不掉，拒绝在脏环境里跑（否则结论不可信）');
  process.exit(1);
}

async function main() {
  const p = runTests({
    ...(vscodeExecutablePath ? { vscodeExecutablePath } : {}),
    // 必须显式传：这个库不认 VSCODE_VERSION 环境变量（见上面的注释）
    ...(vscodeExecutablePath ? {} : { version: pin }),
    extensionDevelopmentPath: root,
    extensionTestsPath: join(root, 'out', 'test-integration', 'c8.js'),
    // 隔离参数：禁用扩展/工作区信任/欢迎页 —— 被测的只有我们这份开发目录里的扩展
    launchArgs: [ws, ...ISOLATED_LAUNCH_ARGS],
  });
  // 看门狗：卡住 = 失败（退出码 97，和 utils/watchdog.ts 同一套约定）
  const done = await Promise.race([
    p.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 3 * 60_000)),
  ]);
  if (!done) {
    killTestWindows('c8:watchdog');
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
  const text = readFileSync(evidence, 'utf8');
  console.log('[c8] evidence:\n' + text.trim());
  // 跑完再清一次，并如实报告（用户看不到残留窗口 = 这条才算过）
  const cleanedAfter = killTestWindows('c8:post');
  if (cleanedAfter.failed.length > 0) {
    console.error('[c8] 跑完仍有测试窗口杀不掉 —— 请手动检查，别让它继续占着服务器');
    process.exit(1);
  }
  // 版本回验：跑的是不是我们声明的那一版？（防止"报告 1.134、实际跑 1.138"这类偏差）
  const hostVscode = /^host\.vscode=(.+)$/mu.exec(text)?.[1] ?? '(unknown)';
  if (pin && !hostVscode.startsWith(pin)) {
    console.error(`[c8] 宿主版本与请求不符：请求 ${pin}，实际 ${hostVscode} —— 本次结论必须按 ${hostVscode} 记录`);
    process.exit(1);
  }
  console.log(`[c8] 宿主版本回验：请求 ${pin ?? '(latest)'} · 实际 ${hostVscode}`);
  console.log('[c8] host exited cleanly（残留窗口已清）');
}

main().catch((e) => {
  console.error('[c8] FAILED: ' + (e?.message ?? e));
  process.exit(1);
});
