// Runs the C6 check fully offline (two phases: empty workspace → chip hidden +
// init-here registered, mini-fcpp project → chip overview + dashboard deps).
// Usage: npm run test:c6
import { runTests } from '@vscode/test-electron';
import { readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
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

const tag = 'c6';
installFailureCleanup(tag);
const disarmGlobalWatchdog = armGlobalWatchdog(tag);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const emptyWs = join(root, 'out', 'c6-ws');
const miniFcpp = join(root, 'src', 'test', 'fixtures', 'mini-fcpp');

mkdirSync(emptyWs, { recursive: true });

const host = resolveHost({
  tag,
  localCandidates: [
    'C:/Users/Chen/AppData/Local/Programs/Microsoft VS Code/Code.exe',
    '/usr/share/code/code',
    '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
  ],
});
process.env.VSLANG = '1033';
process.env.HET_NO_UI = '1'; // automation: never show on-boarding/notifications
const cachePath = prepareCache({ tag, root, version: host.version });
// 下载/解压单独一步（自己的预算）——不跟“用例 3 分钟跑不完就杀”的看门狗抢时间。
const downloadedHost = await ensureHostDownloaded({ tag, version: host.version, cachePath });

/** 跑之前先清一次：残留窗口会占着 `.vscode-test` 的 user-data-dir，还会在服务器上堆积 Electron 进程。 */
try {
  cleanOrFail(tag, 'pre');
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

/** Run one phase; if the window shows no sign of completing within 3 min, kill it. */
async function runPhase(name, ws) {
  process.env.HET_C6_PHASE = name;
  const evidence = join(root, 'out', `c6-${name}-evidence.txt`);
  // 证据文件：用例跑完才写。少了它就说明"宿主根本没跑用例"（CLI 忽略参数也会退 0）。
  rmSync(evidence, { force: true });
  const p = runTests({
    ...host,
    ...(downloadedHost ? { vscodeExecutablePath: downloadedHost } : {}),
    cachePath,
    extensionDevelopmentPath: root,
    extensionTestsPath: join(root, 'out', 'test-integration', 'c6.js'),
    launchArgs: [ws, ...ISOLATED_LAUNCH_ARGS],
  });
  const done = await Promise.race([
    p.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 3 * 60_000)),
  ]);
  if (!done) {
    killTestWindows(`${tag}:watchdog`);
    console.error(`[${tag}] ${name}-phase window alive >3 min without completing — force killed`);
    process.exit(97); // 看门狗约定（和 utils/watchdog.ts 一致）
  }
  if (!existsSync(evidence)) {
    console.error(
      `[${tag}] ${name}-phase 宿主退出了，但用例没留下证据文件 —— 说明测试根本没跑起来（例如把 VS Code CLI 当成了可执行文件）`,
    );
    process.exit(1);
  }
  const text = readFileSync(evidence, 'utf8');
  console.log(`[${tag}] ${name}-phase evidence:\n${text.trim()}`);
  assertHostVersion({ tag: `${tag}:${name}`, pin: host.version, evidence: text });
  console.log(`[${tag}] ${name}-phase host exited cleanly`);
}

async function main() {
  await runPhase('empty', emptyWs);
  await runPhase('proj', miniFcpp);
  // 跑完再清一次，并如实报告（用户看不到残留窗口 = 这条才算过）
  try {
    cleanOrFail(tag, 'post');
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  console.log('[c6] OK（残留窗口已清）');
  disarmGlobalWatchdog();
  // 显式退出：别把“活干完了、人还在”的 node 进程留在服务器上（见 run-c8 里的同一条注释）。
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  cleanQuiet(tag); // 失败路径也要清 —— 别在服务器上留窗口
  process.exit(1);
});
