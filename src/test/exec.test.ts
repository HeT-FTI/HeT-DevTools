import * as assert from 'node:assert';
import { ExecError, LIVENESS_TICK_MS, quoteShell, run, which } from '../utils/exec';
import { beatLiveness, bindLiveness, unbindLiveness } from '../utils/liveness';
import { HEARTBEAT_STALE_MS } from '../core/tasks';

describe('exec.run', () => {
  it('captures stdout and exit code', async () => {
    const res = await run(process.execPath, ['-e', 'console.log("hello-from-node")']);
    assert.strictEqual(res.code, 0);
    assert.ok(res.stdout.includes('hello-from-node'));
  });

  it('captures stderr', async () => {
    const res = await run(process.execPath, ['-e', 'console.error("oops")']);
    assert.strictEqual(res.code, 0);
    assert.ok(res.stderr.includes('oops'));
  });

  it('reports non-zero exit codes', async () => {
    const res = await run(process.execPath, ['-e', 'process.exit(7)']);
    assert.strictEqual(res.code, 7);
  });

  it('streams stdout via callback before completion', async () => {
    const chunks: string[] = [];
    const res = await run(process.execPath, ['-e', 'console.log("AAA"); console.log("BBB")'], {
      onStdout: (c) => chunks.push(c),
    });
    assert.strictEqual(res.code, 0);
    assert.ok(chunks.join('').includes('AAA'));
    assert.ok(chunks.join('').includes('BBB'));
  });

  it('rejects on unknown executable', async () => {
    await assert.rejects(
      () => run('definitely-not-a-real-command-xyz'),
      (e: unknown) => e instanceof ExecError,
    );
  });

  it('kills the child on timeout', async () => {
    await assert.rejects(
      () => run(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { timeoutMs: 300 }),
      (e: unknown) => e instanceof ExecError && e.message.includes('timed out'),
    );
  });

  it('supports abort signal', async () => {
    const ac = new AbortController();
    const pending = run(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { signal: ac.signal });
    ac.abort();
    await assert.rejects(() => pending, (e: unknown) => e instanceof ExecError);
  });

  it('runs in a given cwd', async () => {
    const cwd = process.cwd();
    const res = await run(process.execPath, ['-e', 'console.log(process.cwd())'], { cwd });
    assert.ok(res.stdout.trim().includes(cwd));
  });
});

describe('exec.run 报活（长动作不许被误判僵死）', () => {
  // 背景（2026-10-12 真机走查问题 ①）：任务状态机的规则是"running 必须有 ≤10s 的心跳，
  // 否则对账器判 timedOut 并 abort"，但生产代码里**没有任何一处打点** —— 一次跑了 101.6s 的
  // `conan create`（下载/配置期一句话不说）被判成超时，随后动作正常结束，输出里同时出现
  // "✓ 编译打包完成"与"超时／非法转换"。这里钉住"子进程还活着就报活"这条机制。

  it('报活间隔必须显著小于僵死阈值（否则两次报活之间就会被判超时）', () => {
    assert.ok(
      LIVENESS_TICK_MS * 2 <= HEARTBEAT_STALE_MS,
      `报活 ${LIVENESS_TICK_MS}ms 要显著小于僵死阈值 ${HEARTBEAT_STALE_MS}ms`,
    );
  });

  it('子进程有输出 → 报活（输出就是进展）', async () => {
    const ac = new AbortController();
    let beats = 0;
    bindLiveness(ac.signal, () => {
      beats += 1;
    });
    const res = await run(process.execPath, ['-e', 'console.log("hi")'], { signal: ac.signal });
    assert.strictEqual(res.code, 0);
    assert.ok(beats >= 1, `有输出必须报活（实际 ${beats} 次）`);
  });

  it('**静默**的子进程也要报活（conan 在下载/配置期就是这样被判超时的）', async () => {
    const ac = new AbortController();
    let beats = 0;
    bindLiveness(ac.signal, () => {
      beats += 1;
    });
    // 一个运行期间**一个字都不打印**的子进程（正是 conan 下载/配置期的形状）；
    // 这里只用 150ms 的节拍（机制与生产同一条，生产节拍由 `LIVENESS_TICK_MS` 定）
    const res = await run(process.execPath, ['-e', 'setTimeout(() => {}, 400)'], {
      signal: ac.signal,
      livenessTickMs: 150,
    });
    assert.strictEqual(res.code, 0);
    assert.ok(beats >= 1, `静默期间必须至少报活一次（实际 ${beats} 次）—— 否则长动作必被误判僵死`);
  });

  it('没给信号就没有报活（exec 不认识任何上层概念）', async () => {
    const res = await run(process.execPath, ['-e', 'console.log("hi")']);
    assert.strictEqual(res.code, 0);
    // 只需不抛：`beatLiveness(undefined)` 是空操作
    beatLiveness(undefined);
  });

  it('解绑之后报活是空操作（动作结束不许再给它续命）', () => {
    const ac = new AbortController();
    let beats = 0;
    bindLiveness(ac.signal, () => {
      beats += 1;
    });
    beatLiveness(ac.signal);
    assert.strictEqual(beats, 1, '绑定期间照常报活');
    unbindLiveness(ac.signal);
    beatLiveness(ac.signal);
    assert.strictEqual(beats, 1, '解绑之后（迟到的报活）必须是空操作');
  });

  it('abort 杀的是**整个进程组**（包装脚本死了，真正干活的工具也不许活）', async function () {
    if (process.platform === 'win32') {
      this.skip();
      return;
    }
    // 形状与托管车道一模一样：`bash <脚本>` → 脚本里再起真正干活的进程
    let grandchild = 0;
    const ac = new AbortController();
    const pending = run('/bin/sh', ['-c', 'sleep 30 & echo $!; wait'], {
      signal: ac.signal,
      onStdout: (c) => {
        const m = /(\d+)/u.exec(c);
        if (m) {
          grandchild = Number(m[1]);
        }
      },
    });
    for (let i = 0; i < 100 && grandchild === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(grandchild > 0, '要先拿到孙进程的 pid');
    ac.abort();
    await assert.rejects(() => pending, (e: unknown) => e instanceof ExecError);
    let alive = true;
    for (let i = 0; i < 60; i += 1) {
      try {
        process.kill(grandchild, 0);
      } catch {
        alive = false;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.strictEqual(alive, false, `孙进程 ${grandchild} 必须被杀掉（只杀包装进程 = 假取消）`);
  });

  it('abort 之后不再报活（进程都被杀了，不能算活着）', async () => {
    const ac = new AbortController();
    let beats = 0;
    bindLiveness(ac.signal, () => {
      beats += 1;
    });
    const pending = run(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      signal: ac.signal,
      livenessTickMs: 100,
    });
    ac.abort();
    await assert.rejects(() => pending, (e: unknown) => e instanceof ExecError);
    const after = beats;
    await new Promise((r) => setTimeout(r, 350));
    assert.strictEqual(beats, after, '子进程已经死了，计时的报活必须停掉');
  });
});

describe('exec.which', () => {
  it('finds node on PATH', async () => {
    const found = await which('node');
    assert.ok(found && found.length > 0);
  });

  it('returns null for unknown executables', async () => {
    assert.strictEqual(await which('definitely-not-a-real-command-xyz'), null);
  });
});

describe('exec.quoteShell', () => {
  it('returns a quoted token', () => {
    assert.ok(quoteShell('abc').startsWith('"') || quoteShell('abc').startsWith("'"));
  });

  it('handles embedded double quotes', () => {
    const q = quoteShell('a"b');
    assert.ok(q.includes('b'));
  });
});
