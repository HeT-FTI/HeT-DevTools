// Runs the C9 consistency session (V2 §6-H, 0-manual + watchdog):
// one tab forever, and Task / Output / Frontend must agree at every step
// (open/close stress, then the four long-action exits: ok / fail / cancel / timeout).
// Usage: npm run test:c9
import { runTests } from '@vscode/test-electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const tag = 'c9';
installFailureCleanup(tag);
const disarmGlobalWatchdog = armGlobalWatchdog(tag);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ws = join(root, 'out', 'c9-ws');
const miniFcpp = join(root, 'src', 'test', 'fixtures', 'mini-fcpp');

rmSync(ws, { recursive: true, force: true });
mkdirSync(join(ws, '.vscode'), { recursive: true });
if (existsSync(miniFcpp)) {
  execFileSync('cp', ['-R', miniFcpp + '/.', ws]);
} else {
  console.error('[c9] fixture missing: ' + miniFcpp);
  process.exit(1);
}
/**
 * 超时用例要能在 30 秒内跑完，所以把 §3.5 的阈值**通过设置**压到 2 秒
 * （e2e 证明"设置真的生效" —— 这曾经是个 bug：只有 exec 层读了设置，
 * 对账器仍按表里的 30 分钟判，用户调大设置等于没调）。
 */
writeFileSync(
  join(ws, '.vscode', 'settings.json'),
  JSON.stringify({ 'het.task.deadlines': { docs: 2000 } }, null, 2) + '\n',
  'utf8',
);

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
// 长动作注入体的开关（`extension.ts` 里两道守卫之一；另一道是"必须在测试宿主里"）。
process.env.HET_TASK_INJECT = '1';
const cachePath = prepareCache({ tag, root, version: host.version });
const downloadedHost = await ensureHostDownloaded({ tag, version: host.version, cachePath });
const evidence = join(root, 'out', 'c9-evidence.txt');
rmSync(evidence, { force: true });

const cleanedBefore = cleanOrFail(tag, 'pre');
console.log(`[${tag}] pre-clean：${cleanedBefore.killed.length} 个残留窗口被清掉`);

async function main() {
  const p = runTests({
    ...host,
    ...(downloadedHost ? { vscodeExecutablePath: downloadedHost } : {}),
    cachePath,
    extensionDevelopmentPath: root,
    extensionTestsPath: join(root, 'out', 'test-integration', 'c9.js'),
    launchArgs: [ws, ...ISOLATED_LAUNCH_ARGS],
    // 显式再传一次（`runTests` 会 merge 到 process.env 上）：注入体只在这种会话里存在
    extensionTestsEnv: { HET_TASK_INJECT: '1', HET_NO_UI: '1' },
  });
  // 看门狗：会话说 40 秒左右（含对账器一跳最多 15 秒），4 分钟没完 = 卡住
  const done = await Promise.race([
    p.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 4 * 60_000)),
  ]);
  if (!done) {
    killTestWindows('c9:watchdog');
    console.error('[c9] host alive >4 min without completing — force killed (watchdog)');
    process.exit(97);
  }
  if (!existsSync(evidence)) {
    console.error(
      '[c9] 宿主退出了，但用例没有留下证据文件 —— 说明测试根本没跑起来（例如把 VS Code CLI 当成了可执行文件）。',
    );
    process.exit(1);
  }
  const text = readFileSync(evidence, 'utf8');
  console.log('[c9] evidence:\n' + text.trim());
  // 证据自洽：会话必须真的跑过四个出口、且一次消息都没丢
  for (const must of ['tabs=1', 'exits=ok,fail,cancel,timeout', 'dropped=0']) {
    if (!text.includes(must)) {
      console.error(`[c9] 证据缺少「${must}」—— 这条会话没有真的走完`);
      process.exit(1);
    }
  }
  const hostVscode = assertHostVersion({ tag, pin: host.version, evidence: text });
  const cleanedAfter = cleanOrFail(tag, 'post');
  console.log(`[${tag}] post-clean：${cleanedAfter.killed.length} 个残留窗口被清掉`);
  disarmGlobalWatchdog();
  console.log(`[c9] host exited cleanly（残留窗口已清）· 宿主 ${hostVscode}`);
  process.exit(0);
}

main().catch((e) => {
  console.error('[c9] FAILED: ' + (e?.message ?? e));
  cleanQuiet(tag);
  process.exit(1);
});
