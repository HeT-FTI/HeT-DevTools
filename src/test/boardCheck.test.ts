/**
 * K 块下半的门禁：**上板验证的前置检查**（计划 §6-K / §19.3 / G18）。
 *
 * 上板最容易出的事故是"以为在跑，其实什么也没连" —— 所以这里的断言都围绕四件事：
 *   1. **这次会不会刷写芯片**必须能判定、且默认安全（`--no-flash`；只有明确要求才上板）；
 *   2. **cpu → arch → 工具链**这条推导必须与模板 `run_bench.py` 的 `CONAN_ARCH_MAP`
 *      逐条一致（上游改了脚本而我们的表没改 → 红）；
 *   3. **板子看不见时**给的是"没连/驱动/权限"之外的**第二条路**（CI 自托管 runner），
 *      而不是一句"失败"；
 *   4. `workflow_triggers.cross_compile` 的状态要**说得出来**（卡片上可见），字段缺失也要说。
 */
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  BOARD_CI_WORKFLOW,
  boardNextStep,
  boardPlanFor,
  cpuToArch,
  flashExeFor,
  toolchainForCpu,
  triggerText,
  type BoardFacts,
} from '../core/boardCheck';
import { boardFact } from '../core/boardFacts';

const RUM_BENCH = readFileSync('assets/template/benchmark/script/run_bench.py', 'utf8');

/** 夹具事实：Cortex-M 裸机 + 没装工具链 + 看不见探针（开发机的常态）。 */
function facts(over: Partial<BoardFacts> = {}): BoardFacts {
  return {
    platform: 'm',
    cpu: 'cortex-m4',
    configPresent: true,
    flashTool: 'jlink',
    serialPort: '/dev/ttyUSB0',
    probeVisibility: 'none',
    toolPresent: () => false,
    mode: 'cross',
    ...over,
  };
}

describe('§K 上板：模式判定（默认安全，误刷芯片不可回滚）', () => {
  it('`cross` = 只构建，永不刷写；`on-board` 才可能刷', () => {
    assert.strictEqual(boardPlanFor(facts({ mode: 'cross' })).mode, 'build-only');
    assert.strictEqual(boardPlanFor(facts({ mode: 'on-board' })).mode, 'on-board');
    // 只构建时**不查**上板工具（没打算刷，就不该拦着）
    const plan = boardPlanFor(facts({ mode: 'cross', toolPresent: (e) => e !== 'JLinkExe' }));
    assert.ok(!plan.missing.includes('JLinkExe'), '只构建不该被"没装 JLink"拦住');
  });

  it('`canFlash` 要工具链齐 + 探针可见 + 真的走 on-board', () => {
    assert.strictEqual(boardPlanFor(facts({ mode: 'cross', toolPresent: () => true, probeVisibility: 'seen' })).canFlash, false);
    assert.strictEqual(boardPlanFor(facts({ mode: 'on-board', toolPresent: () => true, probeVisibility: 'seen' })).canFlash, true);
    assert.strictEqual(boardPlanFor(facts({ mode: 'on-board', toolPresent: () => true, probeVisibility: 'none' })).canFlash, false);
  });

  it('看不见设备时说的是"没连/驱动/权限"，**不是**"一定没连"', () => {
    const none = boardPlanFor(facts({ probeVisibility: 'none' }));
    assert.match(none.hints.lines.join('\n'), /没看到|没插好/u);
    const unknown = boardPlanFor(facts({ probeVisibility: 'unknown' }));
    assert.match(unknown.hints.lines.join('\n'), /看不出|不代表没连/u, 'Windows 上不枚举设备就要如实说"看不出"');
  });
});

describe('§K 上板：cpu → arch → 工具链（与 run_bench.py 对账）', () => {
  it('我们表里的每一条都要与脚本的 CONAN_ARCH_MAP 一致', () => {
    const map = /CONAN_ARCH_MAP = \{([\s\S]*?)\n\}/u.exec(RUM_BENCH)?.[1] ?? '';
    const pairs = [...map.matchAll(/"([^"]+)":\s*"([^"]+)"/gu)].map((m) => [m[1], m[2]] as const);
    assert.ok(pairs.length >= 20, `CONAN_ARCH_MAP 解析失败（只有 ${pairs.length} 条）`);
    for (const [cpu, arch] of pairs) {
      assert.strictEqual(cpuToArch(cpu), arch, `${cpu} 的 conan arch 与模板脚本不一致`);
    }
  });

  it('工具链按 cpu 取：M-core → arm-none-eabi；A-core 按 arch 取', () => {
    assert.strictEqual(toolchainForCpu('cortex-m4', 'm')?.cc, 'arm-none-eabi-gcc');
    assert.strictEqual(toolchainForCpu('cortex-m33', 'm')?.cc, 'arm-none-eabi-gcc');
    assert.strictEqual(toolchainForCpu('cortex-a53', 'a')?.cc, 'aarch64-linux-gnu-gcc');
    assert.strictEqual(toolchainForCpu('cortex-a7', 'a')?.cc, 'arm-linux-gnueabihf-gcc');
    assert.strictEqual(toolchainForCpu('cortex-a7', 'a')?.ar, 'arm-linux-gnueabihf-ar');
    assert.strictEqual(toolchainForCpu('mystery-core', 'm'), undefined, '不认识的 cpu 不猜');
  });

  it('上板工具按配置取（jlink/openocd/pyocd/adb），不认识的不编造', () => {
    assert.strictEqual(flashExeFor({ flashTool: 'jlink', platform: 'm' }), 'JLinkExe');
    assert.strictEqual(flashExeFor({ flashTool: 'openocd', platform: 'm' }), 'openocd');
    assert.strictEqual(flashExeFor({ flashTool: 'pyocd', platform: 'm' }), 'pyocd');
    assert.strictEqual(flashExeFor({ flashTool: 'adb', platform: 'a' }), 'adb');
    assert.strictEqual(flashExeFor({ flashTool: '', platform: 'a' }), 'adb', 'A-core 没写时默认 adb');
    assert.strictEqual(flashExeFor({ flashTool: '', platform: 'm' }), undefined, 'M-core 没写就不假定工具');
  });
});

describe('§K 上板：缺东西时给定向提示（含第二条路）', () => {
  it('缺工具链：点名可执行 + apt 包名 + 指向 CI 的自托管 runner', () => {
    const plan = boardPlanFor(facts());
    const all = [...plan.hints.lines, ...plan.hints.fix].join('\n');
    assert.match(all, /arm-none-eabi-gcc/u);
    assert.match(all, /apt-get install -y gcc-arm-none-eabi/u);
    assert.match(all, new RegExp(BOARD_CI_WORKFLOW.replace(/\./gu, '\\.'), 'u'));
    assert.match(all, /自托管 runner/u, '要说清 CI 上是真的连板');
    assert.ok(!/ENOENT|not found/u.test(all), '不要把裸错误丢给用户');
  });

  it('没配置：先说要复制/改哪份文件（不是"配置错误"）', () => {
    const plan = boardPlanFor(facts({ configPresent: false, cpu: '' }));
    assert.match(plan.hints.lines.join('\n'), /bench_config\.json/u);
    assert.match(plan.hints.fix.join('\n'), /模板/u);
  });

  it('cpu 不认识：明说"不会猜"，并指向模板里的型号', () => {
    const plan = boardPlanFor(facts({ cpu: 'mystery-core' }));
    assert.match(plan.hints.lines.join('\n'), /不在已知表里/u);
    assert.match(plan.hints.fix.join('\n'), /target_mcu|target_cpu/u);
  });

  it('前置检查通过时也要说清"会上板刷写"（模式必须可见，§19.3）', () => {
    const plan = boardPlanFor(facts({ mode: 'on-board', toolPresent: () => true, probeVisibility: 'seen' }));
    assert.strictEqual(plan.canFlash, true);
    assert.match(plan.hints.lines.join('\n'), /真的上板/u);
    assert.match(plan.hints.lines.join('\n'), /前置检查通过/u);
  });

  it('`boardNextStep` 永远给一句可照做的话（失败不许只说"失败"）', () => {
    assert.match(boardNextStep(boardPlanFor(facts())), /apt-get install/u);
    assert.ok(boardNextStep(boardPlanFor(facts({ toolPresent: () => true, configPresent: true }))).length > 5);
  });
});

describe('§K 上板：`workflow_triggers.cross_compile` 要说得出来', () => {
  it('开/关/字段缺失三种说法各不相同', () => {
    // 文案里有 markdown 强调（**不会**）——断言前先去掉，免得测的是排版
    const plain = (t: string): string => t.replace(/\*\*/gu, '');
    assert.match(plain(triggerText(true).text), /会触发/u);
    assert.match(plain(triggerText(false).text), /不会触发/u);
    assert.match(plain(triggerText(undefined).text), /没这一项|workflow_triggers/u);
    assert.strictEqual(triggerText(true).state, 'on');
    assert.strictEqual(triggerText(undefined).state, 'missing');
  });

  it('上板卡片的 L2 带上触发开关（否则用户永远不知道 CI 跑不跑）', () => {
    const on = boardFact({ platform: 'm', crossTrigger: true });
    assert.match(on.next ?? '', /🛠️/u);
    assert.match(on.next ?? '', /开/u);
    const off = boardFact({ platform: 'm', crossTrigger: false });
    assert.match(off.next ?? '', /关/u);
    // 字段缺失时**不编造**（没有这一行，而不是显示"关"）
    const missing = boardFact({ platform: 'm' });
    assert.ok(!(missing.next ?? '').includes('🛠️'), '没有这个字段就不显示（别把"没配置"说成"关"）');
    // 原有语义不能丢：模式 + 上次采集
    assert.match(on.fact, /--no-flash/u);
    assert.match(boardFact({ platform: 'm', last: { at: '14:05', cases: 3 } }).next ?? '', /上次 14:05 · 3 例/u);
  });
});
