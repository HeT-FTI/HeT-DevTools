import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { env as processEnv } from 'node:process';
import { beatLiveness } from './liveness';

/** Result of a completed external process. */
export interface ExecResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * 报活间隔（见 `utils/liveness.ts`）。
 *
 * **必须显著小于 `core/tasks.ts` 的 `HEARTBEAT_STALE_MS`（10s）**，否则对账器会在两次报活
 * 之间把任务判成"僵死" —— 那正是 2026-10-12 真机走查抓到的 bug。有测试钉住这个关系。
 */
export const LIVENESS_TICK_MS = 3_000;

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Kill the child after this many ms and reject. */
  timeoutMs?: number;
  /** Streamed stdout chunks (utf8, raw). */
  onStdout?: (chunk: string) => void;
  /** Streamed stderr chunks (utf8, raw). */
  onStderr?: (chunk: string) => void;
  /**
   * 报活节拍（默认 `LIVENESS_TICK_MS`）。
   *
   * 只给**测试**留的口子（否则验证这条机制每个用例都要真等 3 秒）；生产一律用默认值 ——
   * "默认值必须显著小于僵死阈值"由单测钉住（`LIVENESS_TICK_MS * 2 <= HEARTBEAT_STALE_MS`）。
   */
  livenessTickMs?: number;
  /**
   * Abort support: kills the child when the signal fires.
   *
   * **它还承担第二件事**（2026-10-12 真机走查，问题 ①）：只要给了它，`run` 就会在子进程
   * 活着期间按 `LIVENESS_TICK_MS` 向"这个信号对应的长动作"报活（绑定见 `utils/liveness.ts`）。
   * 没有它，一个静默几十秒的 `conan create` 会被任务对账器误判成僵死并 abort ——
   * 而"还会 abort 谁"与"谁该为它的存活负责"本来就是同一件事。
   */
  signal?: AbortSignal;
}

export class ExecError extends Error {
  constructor(message: string, public readonly result?: ExecResult) {
    super(message);
    this.name = 'ExecError';
  }
}

/**
 * Run an executable with arguments (no shell by default).
 * Resolves on process close, rejects when the process cannot be started
 * (ENOENT etc.), on timeout, or on abort.
 */
export function run(
  command: string,
  args: string[] = [],
  options: ExecOptions = {},
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? processEnv,
        windowsHide: true,
        shell: false,
        // **自己成一个进程组**（POSIX）。为什么必须：托管车道走的是 `bash <脚本>`，
        // 脚本里再起真正的 conan/cmake —— 只 kill 直接子进程，真正的工具会变成孤儿继续跑完，
        // 那就是"假取消"（用户点了取消，构建还在后台写产物）。成组之后 `kill(-pid)` 一次收干净。
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      reject(new ExecError(`failed to start "${command}": ${(err as Error).message}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const killChild = (): void => {
      const pid = child.pid;
      if (process.platform !== 'win32' && typeof pid === 'number' && pid > 0) {
        try {
          process.kill(-pid, 'SIGTERM'); // 负号 = 整个进程组
          return;
        } catch {
          /* 组没了/权限不够 → 退回单进程 */
        }
      }
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    };

    const finish = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      fn();
    };

    /** 报活：绝不许让回调里的异常影响子进程本身（它只是"我还在"的通知）。 */
    const beat = (): void => {
      beatLiveness(options.signal);
    };

    const timer = options.timeoutMs
      ? setTimeout(() => {
          killChild();
          stopTimers();
          finish(() =>
            reject(
              new ExecError(`command timed out after ${options.timeoutMs}ms`, {
                code: null,
                signal: null,
                stdout,
                stderr,
              }),
            ),
          );
        }, options.timeoutMs)
      : undefined;

    // 静默期也要报活（`LIVENESS_TICK_MS`）：子进程没退出 = 它还没失败。
    const beatTimer = options.signal
      ? setInterval(beat, options.livenessTickMs ?? LIVENESS_TICK_MS)
      : undefined;
    const stopTimers = (): void => {
      if (timer) {
        clearTimeout(timer);
      }
      if (beatTimer) {
        clearInterval(beatTimer);
      }
    };

    const onAbort = (): void => {
      killChild();
      stopTimers();
      finish(() => reject(new ExecError('command aborted', { code: null, signal: null, stdout, stderr })));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      // 有输出 = 有进展：比"还没退出"更强的信号
      beat();
      options.onStdout?.(chunk);
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
      beat();
      options.onStderr?.(chunk);
    });

    child.on('error', (err) => {
      stopTimers();
      options.signal?.removeEventListener('abort', onAbort);
      finish(() => reject(new ExecError(`cannot run "${command}": ${err.message}`)));
    });

    child.on('close', (code, signal) => {
      stopTimers();
      options.signal?.removeEventListener('abort', onAbort);
      finish(() => resolve({ code, signal, stdout, stderr }));
    });
  });
}

/**
 * Resolve the Python interpreter **once, the same way everywhere**.
 *
 * Why this exists（2026-09-20 实测，同事报"系统中有 python，文档中心总是提示缺少 python"）：
 *   · 执行路径（跑 `docs/build.py`）试的是 `python` **和** `python3`；
 *   · 而文档面板的**探测**只 `which('python')` —— Ubuntu/Mint 从 20.04 起默认不提供
 *     `python` 这个命令（除非装 `python-is-python3`），于是出现"Python ✗ / Sphinx ✓"
 *     这种自相矛盾的显示，用户会以为缺 python 而去装一个已经有的东西。
 * 一次性把语义定死：**探测与执行必须问同一个函数**，别在两处各写一遍候选名单。
 * Windows 上还有 `py` 启动器；Linux/macOS 上 `python3` 优先。
 */
export async function findPython(
  platform: NodeJS.Platform | string = process.platform,
): Promise<string | null> {
  const names = platform === 'win32' ? ['python', 'python3', 'py'] : ['python3', 'python'];
  for (const n of names) {
    const found = await which(n);
    if (found) {
      return found;
    }
  }
  return null;
}

/** Locate an executable on PATH (respecting .exe/.cmd on Windows). */
export async function which(command: string): Promise<string | null> {
  const pathEnv = processEnv.PATH ?? '';
  const isWin = process.platform === 'win32';
  const extensions = isWin ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) {
      continue;
    }
    for (const ext of extensions) {
      const candidate = join(dir, command + ext);
      try {
        const s = await stat(candidate);
        if (s.isFile()) {
          return candidate;
        }
      } catch {
        /* keep searching */
      }
    }
  }
  return null;
}

/** Quote a single argument for a POSIX-ish / cmd one-line command string. */
export function quoteShell(arg: string): string {
  if (process.platform === 'win32') {
    return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
  }
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}
