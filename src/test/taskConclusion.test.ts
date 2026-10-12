/**
 * **一个动作只许有一个结论**（2026-10-12 真机走查 ①②④ 的回归门禁）。
 *
 * 走查现场（CI 产物 0.4.1，真 VS Code + 真 conan）：
 * ```
 * [13:08:01] [build] · finished ok=false issues=0
 * [13:08:01] [build] ✓ 编译打包完成（101.6s）
 * [13:08:01] [build] 🤔 编译打包超时（101.6s）：非法状态转换: timedOut → succeeded（任务 build）
 * ```
 * 同一件事三句话互相矛盾：动作失败了（`ok=false`）、输出说"完成"、右下角弹「构建失败」。
 * 而且 ② 构建站还挂着 ✓。根因是四条，各自一条门禁：
 *
 * 1. **没有心跳来源**：长动作一个都不打点 → 静默几十秒的构建被判超时（→ `utils/liveness.ts`）；
 * 2. **迟到的真实结论撞"非法转换"**：对账器是启发式，动作的返回是事实（→ `tasks.ts` 的转换表）；
 * 3. **动作的失败没穿过忙语义层**：自己 toast 完就 `return`，任务被记成"✓ 完成"（→ `extension.ts`）；
 * 4. **站壳（rail 点 / 站头状态字）只在首帧画一次**：卡片说失败、站头还说 ✓（→ `postSinglePage` 推 `chrome`）。
 */
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ReportedError,
  cancelBusy,
  reconcileBusy,
  resetBusy,
  runWithBusy,
  taskStore,
  type BusyHost,
} from '../core/busy';
import { HEARTBEAT_STALE_MS } from '../core/tasks';
import { DeadlineExceededError } from '../core/deadlines';
import { run } from '../utils/exec';

/** 假 host（与 `busy.test.ts` 同一形状：时钟可注入，输出/忙点/通知都记在内存里）。 */
function fakeHost(start = 1_000): BusyHost & {
  lines: string[];
  busy: string[];
  done: string[];
  at: number;
} {
  const lines: string[] = [];
  const busy: string[] = [];
  const done: string[] = [];
  const self = {
    at: start,
    lines,
    busy,
    done,
    now: () => self.at,
    outputChannel: (name: string) => ({
      appendLine: (line: string) => {
        lines.push(`${name}| ${line}`);
      },
    }),
    notifyBusy: (action: string, on: boolean) => {
      busy.push(`${on ? 'on' : 'off'}:${action}`);
    },
    notifyDone: (action: string, ok: boolean, message: string) => {
      done.push(`${ok ? 'ok' : 'fail'}:${action}:${message}`);
    },
  };
  return self;
}

const read = (p: string): string => readFileSync(join('src', p), 'utf8');

/** 把源码压成一行**并去掉注释**：断言要的是代码形状，不是注释里的话。 */
const code = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/\/\/[^\n]*/gu, ' ').replace(/\s+/gu, ' ');

describe('一个动作只许有一个结论（走查 ①②④ 回归）', () => {
  it('迟到的真实结论：对账器判过超时、动作随后正常结束 → 以事实为准（不再变成假失败）', async () => {
    resetBusy();
    const host = fakeHost();
    const res = await runWithBusy(host, 'build', async () => {
      // 模拟"对账器先把任务判成超时"（真机里是子进程静默 / 事件循环被饿死）
      host.at += HEARTBEAT_STALE_MS + 1;
      assert.strictEqual(reconcileBusy().length, 1, '对账器必须先真的把它收敛成 timedOut');
      return 'ok';
    });
    assert.strictEqual(res.status, 'done');
    assert.strictEqual(taskStore().get('build')!.state, 'succeeded', '事实落地：状态改成成功，不许抛"非法转换"');
    assert.ok(
      host.lines.some((l) => l.includes('✓ 编译打包完成')),
      '完成行照旧要写',
    );
    assert.ok(
      host.lines.some((l) => l.includes('以这次真实结论为准')),
      `要如实说明"曾被判超时"（不许静默改口）：${host.lines.join(' | ')}`,
    );
    assert.strictEqual(host.done.length, 1, '结论通知只许一条');
    assert.ok(host.done[0].startsWith('ok:build:'), `而且必须是"成功"那条：${host.done[0]}`);
    resetBusy();
  });

  it('§3.5 真超时落 `timedOut`（不是 failed）：状态/图标/结论行说同一件事', async () => {
    resetBusy();
    const host = fakeHost();
    const res = await runWithBusy(host, 'build', async () => {
      // exec 层按阈值杀掉子进程，`withDeadline` 把它翻成人话里的超时错误
      throw new DeadlineExceededError('⏱ 编译打包 超过 15 分钟仍未结束，已中止（子进程已杀掉）。');
    });
    assert.strictEqual(res.status, 'failed');
    assert.strictEqual(taskStore().get('build')!.state, 'timedOut', '真超时必须落**独立出口** timedOut，而不是 failed');
    assert.ok(
      host.lines.some((l) => l.includes('编译打包超时')),
      `结论行要用「超时」：${host.lines.join(' | ')}`,
    );
    assert.ok(
      !host.lines.some((l) => l.includes('编译打包失败')),
      '同一行里不许再出现“失败”（那就是第二套口径，用户不知道该信哪一条）',
    );
    assert.strictEqual(host.done.length, 1);
    assert.ok(host.done[0].startsWith('fail:build:编译打包超时'), host.done[0]);
    resetBusy();
  });

  it('动作自己给过结论（ReportedError）→ 状态落 failed，但**不补第二条通知**', async () => {
    resetBusy();
    const host = fakeHost();
    const res = await runWithBusy(host, 'build', async () => {
      // 真实场景：环境门禁弹出带按钮的对话框（"改用本机工具链 / 导出环境诊断"）——那就是结论
      throw new ReportedError('构建环境未就绪（对话框已经给过结论）');
    });
    assert.strictEqual(res.status, 'failed');
    assert.strictEqual(taskStore().get('build')!.state, 'failed', '状态必须落 failed（否则 chip/卡片还显示成功）');
    assert.deepStrictEqual(host.done, [], '不许补通知：同一个结果弹两次，用户不知道看哪条');
    assert.ok(
      host.lines.some((l) => l.includes('构建环境未就绪')),
      '输出通道里照样要有字（可复盘）',
    );
    resetBusy();
  });

  it('取消在先、动作随后结束 → 终态保持「已取消」（用户意图优先），但如实留一行', async () => {
    resetBusy();
    const host = fakeHost();
    const res = await runWithBusy(host, 'build', async () => {
      cancelBusy('build', '用户点了取消');
      return 'ok';
    });
    assert.strictEqual(res.status, 'done');
    assert.strictEqual(taskStore().get('build')!.state, 'cancelled', '不许把用户的取消洗成"成功"');
    assert.ok(
      host.lines.some((l) => l.includes('已取消') && l.includes('结果不采纳')),
      `要如实说明（别静默丢结果）：${host.lines.join(' | ')}`,
    );
    assert.strictEqual(host.done.length, 1);
    resetBusy();
  });

  it('子进程的报活真的接到了任务心跳上（静默的长动作不再被判僵死）', async () => {
    resetBusy();
    const host = fakeHost();
    const p = runWithBusy(host, 'build', (ctx) =>
      run(process.execPath, ['-e', 'console.log("hi")'], { signal: ctx.signal }),
    );
    // 子进程还没吐字之前先把注入时钟推走：之后心跳变了，就只可能来自"报活"
    host.at += 1_000;
    const res = await p;
    assert.strictEqual(res.status, 'done');
    const hb = taskStore().get('build')!.heartbeatAt ?? 0;
    assert.ok(
      hb >= host.at,
      `报活必须打到任务上（心跳=${hb}，注入时钟=${host.at}）—— 否则静默几十秒的动作必被误判僵死`,
    );
    resetBusy();
  });

  // ── 源码接线门禁（这几条正是走查里"没接上"的地方，删掉就红）──────────────
  it('构建/测试的失败必须穿过忙语义层（不许自己 toast 完就 return）', () => {
    const ext = read('extension.ts');
    const inner = ext.slice(ext.indexOf('async function buildProjectInner'), ext.indexOf('async function executeTestRun'));
    assert.match(
      code(inner),
      /if \(!result\.ok\) \{ throw new Error\(/u,
      '构建失败必须 throw（让 busy 层落 failed + 写一条结论行），否则任务会被记成"✓ 完成"',
    );
    const tests = ext.slice(ext.indexOf('async function runTestsInner'), ext.indexOf('function showStoredTestResults'));
    assert.match(
      code(tests),
      /if \(!result\.ok\) \{ throw new Error\(/u,
      '测试失败同理：不穿过忙语义层就会显示"✓ 全量测试完成"',
    );
  });

  it('构建结论落定处要重取单页事实（Test Explorer 那条路径不经过忙语义）', () => {
    const ext = read('extension.ts');
    const fn = ext.slice(ext.indexOf('function markBuildOutcome'), ext.indexOf('function agoText'));
    assert.match(
      code(fn),
      /requestFacts\(\);/u,
      '结论变了就要刷卡片（否则只有"忙点排空"那条入口会刷，Test Explorer 触发的构建永远停在旧结论）',
    );
  });

  it('刷新时必须重推**站壳**（rail 状态点 + 站头状态字），否则 ② 构建站永远停在首帧的 ✓', () => {
    const ctl = read('features/cockpit/controller.ts');
    assert.match(
      ctl.replace(/\s+/gu, ' '),
      /postMessage\(\{ type: 'chrome', \.\.\.stationChrome\(model\) \}\)/u,
      'postSinglePage 必须推 chrome（站壳）',
    );
    const shell = read('features/cockpit/singlepage/shell.ts');
    assert.ok(shell.includes('export function stationChrome('), '站壳要能单独渲染（rail + 站头）');
    assert.ok(shell.includes("m.type === 'chrome'"), '页内脚本要能接住 chrome 补丁');
  });

  it('托管车道的构建必须**有界且可取消**（问题 ① 的真根因：车道分支没收 timeout/signal）', () => {
    const ext = read('extension.ts');
    // 三条车道分支（默认路径就是 linux-managed：走查现场就是这个）
    const calls: ReadonlyArray<[string, string]> = [
      ['Linux', 'runLinuxConanCreate(project.root, {'],
      ['WSL2', 'runWslConanCreate(distro, project.root, {'],
      ['macOS', 'runMacConanCreate(project.root, {'],
    ];
    for (const [label, needle] of calls) {
      const at = ext.indexOf(needle);
      assert.ok(at > 0, `${label} 车道：找不到调用点（形状变了就同步这条门禁）`);
      const before = code(ext.slice(Math.max(0, at - 260), at));
      assert.match(before, /withDeadline\(/u, `${label} 车道：必须包在 withDeadline 里，否则车道里是 timeoutMs=0（挂住就转两小时）`);
      const call = code(ext.slice(at, at + 1100));
      assert.match(call, /timeoutMs,/u, `${label} 车道：必须把 §3.5 阈值传下去`);
      assert.match(call, /signal: ctx\?\.signal/u, `${label} 车道：必须接住取消信号（否则取消/超时杀不掉 conan = 假取消）`);
    }
    // 收下信号不算数：车道函数得把它透给 exec（否则只是多一个参数）
    for (const lane of ['linuxLane.ts', 'macLane.ts', 'wslLane.ts']) {
      const src = read(`features/env/${lane}`);
      assert.match(code(src), /signal: opts\.signal/u, `${lane} 必须把 signal 透给 run()`);
    }
  });

  it('取消/超时杀的是**整个进程组**（车道是 `bash <脚本>` 包装，只杀它 = 假取消）', () => {
    const ex = read('utils/exec.ts');
    assert.match(code(ex), /detached: process\.platform !== 'win32'/u, '要自己成组（否则不存在 -pid）');
    assert.match(code(ex), /process\.kill\(-pid/u, '要按进程组杀，否则真正的 conan/cmake 变孤儿继续写产物');
  });

  it('卡片动作没接线时不许静默丢弃（点了没反应是最不能接受的失败方式）', () => {
    const ctl = read('features/cockpit/controller.ts');
    assert.ok(ctl.includes('未接线的卡片动作'), '动作 id 查不到命令时要显式记日志');
    assert.ok(ctl.includes('未接线的卡片导航'), '导航动作同理');
  });
});
