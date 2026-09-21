import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { env as processEnv } from 'node:process';

/** Result of a completed external process. */
export interface ExecResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Kill the child after this many ms and reject. */
  timeoutMs?: number;
  /** Streamed stdout chunks (utf8, raw). */
  onStdout?: (chunk: string) => void;
  /** Streamed stderr chunks (utf8, raw). */
  onStderr?: (chunk: string) => void;
  /** Abort support: kills the child when the signal fires. */
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
      });
    } catch (err) {
      reject(new ExecError(`failed to start "${command}": ${(err as Error).message}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const killChild = (): void => {
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

    const timer = options.timeoutMs
      ? setTimeout(() => {
          killChild();
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

    const onAbort = (): void => {
      killChild();
      finish(() => reject(new ExecError('command aborted', { code: null, signal: null, stdout, stderr })));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      options.onStdout?.(chunk);
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
      options.onStderr?.(chunk);
    });

    child.on('error', (err) => {
      if (timer) {
        clearTimeout(timer);
      }
      options.signal?.removeEventListener('abort', onAbort);
      finish(() => reject(new ExecError(`cannot run "${command}": ${err.message}`)));
    });

    child.on('close', (code, signal) => {
      if (timer) {
        clearTimeout(timer);
      }
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
