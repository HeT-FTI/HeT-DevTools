// Runs the C10 consistency session (V2 §6-H, 0-manual + watchdog):
// one tab forever, and Task / Output / Frontend must agree at every step
// (open/close stress, then the four long-action exits: ok / fail / cancel / timeout).
// Usage: npm run test:c10
import { runTests } from '@vscode/test-electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, copyFileSync, appendFileSync } from 'node:fs';
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

const tag = 'c10';
installFailureCleanup(tag);
const disarmGlobalWatchdog = armGlobalWatchdog(tag);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ws = join(root, 'out', 'c10-ws');
const miniFcpp = join(root, 'src', 'test', 'fixtures', 'mini-fcpp');

rmSync(ws, { recursive: true, force: true });
mkdirSync(join(ws, '.vscode'), { recursive: true });
if (existsSync(miniFcpp)) {
  execFileSync('cp', ['-R', miniFcpp + '/.', ws]);
} else {
  console.error('[c10] fixture missing: ' + miniFcpp);
  process.exit(1);
}
/**
 * L6c / G9 的真宿主夹具：Python 绑定对账得有**真文件**可读。
 *
 * 夹具工程本来没开 Python 绑定（metadata 里没这个键）→ 卡片会被能力显隐藏起来，
 * 真机就什么都验不到。这里把模板本体那两份**真文件**（公开头 + 绑定源）拷进来，
 * 再用与模板同一条约定补上 CMake 的模块名/绑定路径（CMake 是这两件事的唯一来源）。
 *
 * 得到的状态很常见：**改了库名，忘了改绑定模块名**（`PYBIND11_MODULE(fcpp_python)`
 * vs 产物名 `mini-fcpp_python`）—— 本地构建全绿，import 才报错。
 */
const tpl = join(root, 'assets', 'template');
if (existsSync(join(tpl, 'api', 'python_bindings.cpp'))) {
  const meta = JSON.parse(readFileSync(join(ws, 'metadata.json'), 'utf8'));
  meta.enable_python_bindings = true;
  writeFileSync(join(ws, 'metadata.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');
  mkdirSync(join(ws, 'include'), { recursive: true });
  mkdirSync(join(ws, 'api'), { recursive: true });
  for (const f of readdirSync(join(tpl, 'include'))) {
    copyFileSync(join(tpl, 'include', f), join(ws, 'include', f));
  }
  copyFileSync(join(tpl, 'api', 'python_bindings.cpp'), join(ws, 'api', 'python_bindings.cpp'));
  appendFileSync(
    join(ws, 'CMakeLists.txt'),
    [
      '',
      '# L6c 夹具：与模板同一条约定（模块名/绑定路径只从 CMake 读，不猜）',
      'file(READ "${CMAKE_CURRENT_SOURCE_DIR}/metadata.json" METADATA_JSON)',
      'string(JSON PROJECT_NAME_VALUE ERROR_VARIABLE json_error GET "${METADATA_JSON}" "name")',
      'set(LIB_NAME "${PROJECT_NAME_VALUE}")',
      'set(PYTHON_MODULE_NAME "${LIB_NAME}_python")',
      'set(PYTHON_BINDINGS_SOURCE "${CMAKE_CURRENT_SOURCE_DIR}/api/python_bindings.cpp")',
      '',
    ].join('\n'),
    'utf8',
  );
  console.log('[c10] L6c 夹具就位：include/ + api/python_bindings.cpp（模块名与库名不一致）');
}
/**
 * L6d 的真宿主夹具：交叉目标矩阵要有**真矩阵文件**可读。
 *
 * 拷模板本体那份 `.hetai/build-matrix.yml`，只把 `package_ref` 改成夹具工程的
 * （目标/工具链版本都是真的）。这样 c10 可以：先看"还没编过"，再**真跑一次交叉编译**
 * —— 这台机器没有 arm 工具链，所以它真的会失败，而这正是矩阵要暴露的：
 * **"试过且没成"必须留痕**，不能等发布时才发现。
 */
const tplMatrix = join(tpl, '.hetai', 'build-matrix.yml');
if (existsSync(tplMatrix)) {
  mkdirSync(join(ws, '.hetai'), { recursive: true });
  const fixed = readFileSync(tplMatrix, 'utf8').replace(/^package_ref:.*$/mu, 'package_ref: mini-fcpp/0.1.0');
  writeFileSync(join(ws, '.hetai', 'build-matrix.yml'), fixed, 'utf8');
  console.log('[c10] L6d 夹具就位：.hetai/build-matrix.yml（模板本体那份，只改 package_ref）');
}
/**
 * L6e 的真宿主夹具：编译期成本要有**真头文件**可量。
 *
 * 把模板的公开头拷成 `include/<模块名>.hpp`（探针按 `<模块名>.hpp` 找入口头——
 * 这样量到的是"用户会 include 的那一个"，而不是"我们随手挑的第一个"），
 * 并把 metadata 标成 `is_header`（只有仅头文件产物才谈 include 成本）。
 */
const tplHeader = join(tpl, 'include', 'cpptest.hpp');
if (existsSync(tplHeader)) {
  copyFileSync(tplHeader, join(ws, 'include', 'mini-fcpp.hpp'));
  const meta = JSON.parse(readFileSync(join(ws, 'metadata.json'), 'utf8'));
  meta.is_header = true;
  writeFileSync(join(ws, 'metadata.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');
  console.log('[c10] L6e 夹具就位：include/mini-fcpp.hpp + is_header=true');
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
const evidence = join(root, 'out', 'c10-evidence.txt');
rmSync(evidence, { force: true });

const cleanedBefore = cleanOrFail(tag, 'pre');
console.log(`[${tag}] pre-clean：${cleanedBefore.killed.length} 个残留窗口被清掉`);

async function main() {
  const p = runTests({
    ...host,
    ...(downloadedHost ? { vscodeExecutablePath: downloadedHost } : {}),
    cachePath,
    extensionDevelopmentPath: root,
    extensionTestsPath: join(root, 'out', 'test-integration', 'c10.js'),
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
    killTestWindows('c10:watchdog');
    console.error('[c10] host alive >4 min without completing — force killed (watchdog)');
    process.exit(97);
  }
  if (!existsSync(evidence)) {
    console.error(
      '[c10] 宿主退出了，但用例没有留下证据文件 —— 说明测试根本没跑起来（例如把 VS Code CLI 当成了可执行文件）。',
    );
    process.exit(1);
  }
  const text = readFileSync(evidence, 'utf8');
  console.log('[c10] evidence:\n' + text.trim());
  // 证据自洽：会话必须真的跑过四个出口、且一次消息都没丢
  for (const must of ['tabs=1', 'stations=8', 'accordion=exclusive', 'legacy=11', 'toolsSlot=tools', 'dropped=0']) {
    if (!text.includes(must)) {
      console.error(`[c10] 证据缺少「${must}」—— 这条会话没有真的走完`);
      process.exit(1);
    }
  }
  const hostVscode = assertHostVersion({ tag, pin: host.version, evidence: text });
  const cleanedAfter = cleanOrFail(tag, 'post');
  console.log(`[${tag}] post-clean：${cleanedAfter.killed.length} 个残留窗口被清掉`);
  disarmGlobalWatchdog();
  console.log(`[c10] host exited cleanly（残留窗口已清）· 宿主 ${hostVscode}`);
  process.exit(0);
}

main().catch((e) => {
  console.error('[c10] FAILED: ' + (e?.message ?? e));
  cleanQuiet(tag);
  process.exit(1);
});
