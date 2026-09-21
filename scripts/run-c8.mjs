// Runs the C8 one-tab / in-page slot check (V2 §6-A, 0-manual + watchdog):
// cockpit is the ONLY editor tab; opening detail views fills an in-page slot
// (mutually exclusive), never a new tab. Usage: npm run test:c8
import { runTests } from '@vscode/test-electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  ISOLATED_LAUNCH_ARGS,
  armGlobalWatchdog,
  assertHostVersion,
  cleanOrFail,
  cleanQuiet,
  ensureHostDownloaded,
  installFailureCleanup,
  killTestWindows,
  prepareCache,
  resolveHost,
} from './lib/testWindows.mjs';

const tag = 'c8';
installFailureCleanup(tag);
const disarmGlobalWatchdog = armGlobalWatchdog(tag);
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

// 宿主选择与卫生纪律和 c6 共用一套（`scripts/lib/testWindows.mjs`）：
// 本机那份 VS Code 可能低于 `engines.vscode` 下限（实测 1.109，报出来的是
// "extension must be discovered" 这种二级错误）；而要下载就必须**显式传 version** ——
// `@vscode/test-electron` 不读 `VSCODE_VERSION`，默认下载的是 stable（最新版）。
const host = resolveHost({
  tag,
  localCandidates: [
    'C:/Users/Chen/AppData/Local/Programs/Microsoft VS Code/Code.exe',
    '/usr/share/code/code',
    '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
  ],
});

process.env.VSLANG = '1033';
process.env.HET_NO_UI = '1'; // zero-manual host: no toasts/on-boarding
// 宿主下载缓存：保留二进制（否则每次重下 330MB），但每次都换一份干净的 profile/扩展目录。
const cachePath = prepareCache({ tag, root, version: host.version });
// 下载/解压单独一步（自己的预算）——不跟“用例 3 分钟跑不完就杀”的看门狗抢时间。
const downloadedHost = await ensureHostDownloaded({ tag, version: host.version, cachePath });
// 证据文件：用例跑完才写。少了它就说明"宿主根本没跑用例"（CLI 忽略参数也会退 0）。
const evidence = join(root, 'out', 'c8-evidence.txt');
rmSync(evidence, { force: true });

/**
 * 跑之前先清一次：残留的测试窗口会占着 `.vscode-test` 的 user-data-dir，
 * 让这次 runTests 附着到旧窗口（结论就不是这一份代码了），而且会在服务器上堆积
 * 一堆 Electron 进程 —— 用户看到的"卡在远程连接密码提示的窗口"就是这么来的。
 */
const cleanedBefore = cleanOrFail(tag, 'pre');
console.log(`[${tag}] pre-clean：${cleanedBefore.killed.length} 个残留窗口被清掉`);

async function main() {
  const p = runTests({
    ...host,
    ...(downloadedHost ? { vscodeExecutablePath: downloadedHost } : {}),
    cachePath,
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
  // 版本回验：跑的是不是我们声明的那一版？（防"报告 1.134、实际 1.138"这类偏差）
  const hostVscode = assertHostVersion({ tag, pin: host.version, evidence: text });
  // 跑完再清一次，并如实报告（用户看不到残留窗口 = 这条才算过）
  const cleanedAfter = cleanOrFail(tag, 'post');
  console.log(`[${tag}] post-clean：${cleanedAfter.killed.length} 个残留窗口被清掉`);
  disarmGlobalWatchdog();
  console.log(`[c8] host exited cleanly（残留窗口已清）· 宿主 ${hostVscode}`);
  // 显式退出：`runTests` 把宿主 process 存下来之后，子进程的 stdio 句柄可能一直不关，
  // 于是“活干完了、人还在”（实测：日志已写完最后一行，node 进程却吊着不走）。
  // 这里不留给它：活干完就走人 —— 服务器上不该留我们的东西。
  process.exit(0);
}

main().catch((e) => {
  console.error('[c8] FAILED: ' + (e?.message ?? e));
  cleanQuiet(tag); // 失败路径也要清 —— 别在服务器上留窗口
  process.exit(1);
});
