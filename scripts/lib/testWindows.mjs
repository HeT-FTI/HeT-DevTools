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

/** 找残留的测试 VS Code 进程（只认带 `.vscode-test` 的命令行 —— 绝不动用户自己的编辑器/服务端）。 */
export function findTestWindows() {
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
    // 只匹配测试实例：命令行里出现 .vscode-test（user-data/extensions 目录就在那儿）
    if (cmd.includes('.vscode-test') && !cmd.includes('grep')) {
      found.push({ pid, cmd });
    }
  }
  return found;
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
