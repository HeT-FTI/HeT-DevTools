/**
 * 集成测试的**进程卫生**（本机 = SSH 服务器，这条尤其要紧）。
 *
 * 背景（用户实测反馈）：开发用的"本机"其实是一台被 Remote-SSH 连进来的服务器；
 * 以前跑集成测试会留下 VS Code 测试窗口，用户那边看到的是"一堆卡在远程连接密码提示上的窗口"。
 * 症状有两层：
 *   1. 资源泄漏（每个窗口都是好几个 Electron 进程，积起来能把服务器拖慢，甚至影响用户自己的 SSH 会话）；
 *   2. **结论被污染**：残留实例占着 `.vscode-test` 的 user-data-dir 时，下一次 runTests 可能
 *      附着到旧窗口、或直接失败 —— 于是"测试通过/失败"说的不是这一份代码。
 *
 * 所以每个驱动都要：跑之前清一次、跑完再清一次，并且**如实报告**清掉了什么。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** 找残留的测试 VS Code 进程（只认带 `.vscode-test` 的命令行 —— 绝不动用户自己的编辑器/服务端）。 */
export function findTestWindows() {
  if (process.platform === 'win32') {
    return findTestWindowsWin32();
  }
  let out = '';
  try {
    out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  } catch {
    return [];
  }
  /** @type {{pid: number, cmd: string}[]} */
  const found = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/u.exec(line);
    if (!m) {
      continue;
    }
    const pid = Number(m[1]);
    const cmd = m[2];
    if (pid === process.pid) {
      continue;
    }
    // 只匹配**真正的 VS Code 可执行文件**，不能只看命令行里有 `.vscode-test`：
    // 下载/解压阶段跑的是 `tar -xzf - -C .../.vscode-test/vscode-...` —— 那是**正在下载**，
    // 把它当“残留窗口”杀掉，恰好会造成半截缓存（实测踩过）。
    if (cmd.includes('.vscode-test') && isHostBinary(cmd)) {
      found.push({ pid, cmd });
    }
  }
  return found;
}

/** 命令行是不是“宿主二进制”在跑（按第一个 token 的 basename 判，tar/ps/grep 一律排除）。 */
function isHostBinary(cmd) {
  const first = cmd.trim().split(/\s+/u)[0] ?? '';
  const base = first.split('/').pop() ?? '';
  return /^(code|Code\.exe|Code - Insiders\.exe|code-insiders|Electron)$/u.test(base);
}

/** 杀掉残留测试窗口；返回"杀掉 / 杀不掉"两份清单（杀不掉必须让调用方红，不能装看不见）。 */
export function killTestWindows(label = 'cleanup') {
  /** @type {number[]} */
  const killed = [];
  /** @type {number[]} */
  const failed = [];
  for (const { pid, cmd } of findTestWindows()) {
    try {
      process.kill(pid, 'SIGKILL');
      killed.push(pid);
      console.log(`[${label}] killed test window pid=${pid} :: ${cmd.slice(0, 160)}`);
    } catch {
      failed.push(pid);
      console.error(`[${label}] 无法结束测试窗口 pid=${pid}（请手动检查）`);
    }
  }
  if (killed.length === 0 && failed.length === 0) {
    console.log(`[${label}] 没有残留测试窗口`);
  }
  return { killed, failed };
}

/** 隔离参数：禁用扩展/工作区信任/欢迎页，保证测试实例不和用户环境互相影响。 */
export const ISOLATED_LAUNCH_ARGS = [
  '--disable-extensions',
  '--disable-workspace-trust',
  '--skip-welcome',
  '--skip-release-notes',
  '--disable-updates',
  '--disable-telemetry',
];

/** Windows 上的查找（`ps` 不存在）：同样只认命令行含 `.vscode-test` 的进程。 */
function findTestWindowsWin32() {
  let out = '';
  try {
    out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*.vscode-test*' -and ($_.Name -eq 'Code.exe' -or $_.Name -eq 'Code - Insiders.exe') } | ForEach-Object { \"$($_.ProcessId)|$($_.CommandLine)\" }",
      ],
      { encoding: 'utf8' },
    );
  } catch {
    return [];
  }
  /** @type {{pid: number, cmd: string}[]} */
  const found = [];
  for (const line of out.split('\n')) {
    const idx = line.indexOf('|');
    if (idx <= 0) {
      continue;
    }
    const pid = Number(line.slice(0, idx).trim());
    const cmd = line.slice(idx + 1).trim();
    if (!Number.isInteger(pid) || pid === process.pid) {
      continue;
    }
    if (isHostBinary(cmd)) {
      found.push({ pid, cmd });
    }
  }
  return found;
}

/** 钉住的宿主版本：集成测试的结论必须写明"跑的是哪一版"。 */
export const DEFAULT_PIN = '1.134.0';

/**
 * 决定用哪个宿主跑集成测试（c6/c8 共用一套纪律）。
 *
 * 优先级：显式 `VSCODE_EXECUTABLE_PATH` > `VSCODE_VERSION`（下载）> 本机安装。
 * **本机那份可能低于 `engines.vscode` 下限**（本机实测 1.109 < ^1.134）：那时扩展根本不会被加载，
 * 报出来的是 "extension must be discovered" 这种二级错误 —— 白查半天。
 *
 * @param {{tag: string, localCandidates: string[]}} opts
 * @returns {{vscodeExecutablePath?: string, version?: string}}
 */
export function resolveHost({ tag, localCandidates }) {
  const explicitPath = process.env.VSCODE_EXECUTABLE_PATH;
  const pin = process.env.VSCODE_VERSION;
  if (explicitPath) {
    if (!existsSync(explicitPath)) {
      console.error(`[${tag}] VSCODE_EXECUTABLE_PATH 指向的文件不存在：${explicitPath}`);
      process.exit(1);
    }
    console.log(`[${tag}] 宿主：${explicitPath}（显式 VSCODE_EXECUTABLE_PATH；版本由证据文件回验）`);
    return { vscodeExecutablePath: explicitPath };
  }
  // 显式要版本 = 想下载那一版：**必须优先于本机安装**。
  // 教训（2026-09-21 实测）：本机 `/usr/share/code/code` 是 1.109 < engines 下限，
  // 先挑本机安装会把"请求 1.134"静默降级成 1.109 → 扩展根本不会被加载。
  if (pin) {
    console.log(`[${tag}] 宿主：下载 VS Code ${pin}（显式传 version，不靠环境变量）`);
    return { version: pin };
  }
  const local = localCandidates.find((p) => p && existsSync(p));
  if (local) {
    console.warn(
      `[${tag}] 宿主：本机安装 ${local}（不保证满足 engines.vscode ^1.134；要确定性请设 VSCODE_VERSION）`,
    );
    return { vscodeExecutablePath: local };
  }
  // 实测教训：`@vscode/test-electron` **不读** VSCODE_VERSION 环境变量 —— 不显式传 version 时
  // 它下载 "stable"（最新版），于是"我跑的是 1.134"这句话就是假的（真的跑到了 1.138）。
  if (process.env.HET_VSCODE_ALLOW_LATEST === '1') {
    console.warn(`[${tag}] 未指定版本 → 下载 stable（最新版）：结论请按"最新版"记录`);
    return {};
  }
  console.log(`[${tag}] 宿主：下载 VS Code ${DEFAULT_PIN}（默认钉住的版本）`);
  return { version: DEFAULT_PIN };
}

/**
 * 版本回验：证据文件里的 `host.vscode` 必须与声明的版本一致。
 * 这是防"报告 1.134、实际跑 1.138"这类偏差的最后一道闸。
 *
 * @param {{tag: string, pin?: string, evidence: string}} opts
 * @returns {string} 实际宿主版本
 */
export function assertHostVersion({ tag, pin, evidence }) {
  const actual = /^host\.vscode=(.+)$/mu.exec(evidence)?.[1] ?? '(unknown)';
  if (pin && !actual.startsWith(pin)) {
    throw new Error(`[${tag}] 宿主版本与请求不符：请求 ${pin}，实际 ${actual} —— 结论必须按 ${actual} 记录`);
  }
  if (actual === '(unknown)') {
    throw new Error(`[${tag}] 证据文件里没有 host.vscode —— 这次结论无法自证跑在哪一版宿主上`);
  }
  console.log(`[${tag}] 宿主版本回验：请求 ${pin ?? '(本机安装)'} · 实际 ${actual}`);
  return actual;
}

/**
 * 跑前/跑后清残留：清不掉就红（宁可失败，也不要在"不知道有没有旧窗口掺和"的环境里出结论）。
 *
 * @param {string} tag
 * @param {'pre'|'post'} when
 */
export function cleanOrFail(tag, when) {
  const r = killTestWindows(`${tag}:${when}`);
  if (r.failed.length > 0) {
    throw new Error(`[${tag}] 有测试窗口杀不掉（pid=${r.failed.join(',')}）—— 拒绝在脏环境里出结论`);
  }
  return r;
}

/**
 * 失败路径也要清一次（用例红了、宿主崩了、看门狗超时都算）—— 否则服务器上会攒下一堆 Electron。
 * **不许抛异常**：失败路径上再炸一次会把真正的错误盖掉。
 *
 * @param {string} tag
 */
export function cleanQuiet(tag) {
  try {
    return cleanOrFail(tag, 'post');
  } catch (e) {
    console.error(String(e?.message ?? e));
    return { killed: [], failed: [] };
  }
}

/** 宿主可执行文件在下载目录里的相对路径（各平台不同）。 */
function hostExeRel() {
  if (process.platform === 'win32') {
    return 'Code.exe';
  }
  if (process.platform === 'darwin') {
    return join('Visual Studio Code.app', 'Contents', 'MacOS', 'Electron');
  }
  return 'code';
}

/**
 * 下载缓存（`.vscode-test`）的完整性 + 隔离。
 *
 * 两个实测教训：
 *   1. **半截下载会被静默复用**：`@vscode/test-electron` 只看"版本目录在不在"，
 *      不看里面有没有可执行文件。一次 ECONNRESET 中断（实测就碰上了）会留下一个
 *      残缺目录，后续每次都拿它去启动 —— 报出来的是个莫名其妙的启动错误。
 *   2. **不能把整个缓存目录删掉**：那等于每次重下 330MB（慢，而且重新引入了中断风险）。
 *      要"每次都是干净环境"只需换掉 `user-data` / `extensions`。
 *
 * @param {{tag: string, root: string, version?: string}} opts
 * @returns {string} cachePath（给 runTests 用）
 */
export function prepareCache({ tag, root, version }) {
  const cachePath = join(root, '.vscode-test');
  mkdirSync(cachePath, { recursive: true });
  if (version) {
    for (const name of readdirSync(cachePath)) {
      if (!name.startsWith('vscode-') || !name.endsWith(version)) {
        continue;
      }
      const dir = join(cachePath, name);
      if (!existsSync(join(dir, hostExeRel()))) {
        console.warn(`[${tag}] 下载缓存不完整（缺可执行文件）：${name} —— 清掉重下`);
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }
  // 每次跑都换一份干净的 profile / 扩展目录（二进制缓存保留）
  rmSync(join(cachePath, 'user-data'), { recursive: true, force: true });
  rmSync(join(cachePath, 'extensions'), { recursive: true, force: true });
  return cachePath;
}

/**
 * 失败路径的兼底：`@vscode/test-electron` 内部（下载/启动）的 rejected promise 不受我们控制，
 * 它会让进程直接崩掉 —— 那就绕过我们自己的 `try/catch`，窗口就留在服务器上了（用户实测的困扰）。
 * 所以显式接管：报清楚 + 清一次 + 非 0 退出。
 *
 * @param {string} tag
 */
export function installFailureCleanup(tag) {
  process.on('unhandledRejection', (reason) => {
    console.error(`[${tag}] 未处理的异常（多半出在宿主下载/启动阶段）：${reason?.message ?? reason}`);
    cleanQuiet(tag);
    process.exit(1);
  });
}

/**
 * **全局看门狗**：整轮（下载 + 启动 + 用例 + 清理）不许无限挂着。
 *
 * 实测（2026-09-21）：宿主跑完、证据也落盘了，但 `runTests` 的 promise 再也没 settle ——
 * 进程就元在事件循环里（无子进程、无 IO），终端里看上去就是"卡住不说话"。
 * 本来只想卡住这一点：超时就报清楚 + 清残留 + 退出 97（与 `utils/watchdog.ts` 同一套约定）。
 *
 * @param {string} tag
 * @param {number} ms
 * @returns {() => void} 成功路径上解除看门狗
 */
export function armGlobalWatchdog(tag, ms = Number(process.env.HET_TEST_BUDGET_MS ?? 12 * 60_000)) {
  const timer = setTimeout(() => {
    console.error(`[${tag}] 全局看门狗：整轮超过 ${Math.round(ms / 60_000)} 分钟仍未结束 → 强制清理并退出 97`);
    cleanQuiet(tag);
    process.exit(97);
  }, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
}

/**
 * 把**下载/解压**从“启动 + 跑用例”里拆出来，各自给合适的预算。
 *
 * 为什么：330MB 的下载和解压跟“用例 3 分钟跑不完就杀”的看门狗共用一个 deadline 时，
 * 网络慢一点就会被看门狗杀掉 —— 而杀掉的是一个正在解压的 tar，留下半截缓存（实测踩过）。
 *
 * @param {{tag: string, version?: string, cachePath: string, timeoutMs?: number}} opts
 * @returns {Promise<string | undefined>} 宿主可执行文件路径（没指定版本时返回 undefined，交给 runTests）
 */
export async function ensureHostDownloaded({ tag, version, cachePath, timeoutMs = 15 * 60_000 }) {
  if (!version) {
    return undefined;
  }
  // 实测（2026-09-21）：`@vscode/test-electron` 内部基于 Node https 的下载在 330MB 这份包上会被 reset
  // （aborted / ECONNRESET，重试也一样），而同一时刻 `curl` 能稳定拉完。更要命的是那个失败是以
  // **未被处理的 rejection** 冒出来的，会绕过我们的 try/catch 直接把进程带走。
  // 所以 Linux/macOS 上**直接用 curl + tar 铺缓存目录**，再把可执行文件路径交给 runTests
  // （走 `vscodeExecutablePath`，完全不碰库的下载逻辑）。Windows 上不猜 zip 布局，仍用库。
  if (process.platform !== 'win32') {
    return curlPrimeCache({ tag, version, cachePath });
  }
  const { downloadAndUnzipVSCode } = await import('@vscode/test-electron');
  const step = downloadAndUnzipVSCode({ version, cachePath });
  const done = await Promise.race([
    step.then((p) => ({ ok: true, path: p })),
    new Promise((resolve) => setTimeout(() => resolve({ ok: false }), timeoutMs)),
  ]);
  if (!done.ok) {
    console.error(`[${tag}] 库自带下载超时（>${Math.round(timeoutMs / 60_000)} 分钟）`);
    process.exit(97); // 看门狗约定
  }
  console.log(`[${tag}] 宿主已就绪：${done.path}`);
  return done.path;
}

/** curl + tar 手工把宿主铺到 `<cachePath>/vscode-<platform>-<version>/`（Linux/macOS）。 */
function curlPrimeCache({ tag, version, cachePath }) {
  if (process.platform === 'win32') {
    return undefined; // Windows 上不猜 zip 布局：交回调用方（库自带下载）
  }
  const platform =
    process.platform === 'linux' ? `linux-${process.arch}` : process.arch === 'arm64' ? 'darwin-arm64' : 'darwin';
  const dir = join(cachePath, `vscode-${platform}-${version}`);
  const url = `https://update.code.visualstudio.com/${version}/${platform}/stable?released=true`;
  const tmp = join(cachePath, `vscode-${platform}-${version}.tar.gz`);
  console.log(`[${tag}] curl 下载：${url}`);
  execFileSync('curl', ['-sSL', '--fail', '-o', tmp, url], { stdio: ['ignore', 'ignore', 'inherit'] });
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  execFileSync('tar', ['-xzf', tmp, '-C', dir, '--strip-components=1'], { stdio: 'inherit' });
  rmSync(tmp, { force: true });
  const exe = join(dir, process.platform === 'darwin' ? join('Visual Studio Code.app', 'Contents', 'MacOS', 'Electron') : 'code');
  if (!existsSync(exe)) {
    console.error(`[${tag}] 回退下载后仍找不到可执行文件：${exe}`);
    process.exit(1);
  }
  console.log(`[${tag}] 宿主已就绪（curl 回退）：${exe}`);
  return exe;
}

