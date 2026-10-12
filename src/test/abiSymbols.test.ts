/**
 * V3 · L6b / G8 门禁：**导出符号（ABI）**。
 *
 * 计划 §6 表格 G8 的验收原文：「仅 `is_shared` 时启用；**改名一次 → 红**」。
 * 所以这里盯四件事：
 *   1. `nm` 输出解析只留**已定义全局**符号（局部符号/未定义不是 ABI）；
 *   2. 对比：**移除 = 破坏性（红）**、新增 = 绿（不影响已编译的下游）；
 *   3. **改名 = 移除 + 新增** → 必须红（C++ 名字修饰直接用，不去 demangle 让它"看起来一样"）；
 *   4. 扫不到符号时**如实说**（不许说成"与基线一致"）。
 */
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { abiFact, compareSymbols, parseNmOutput, type AbiSnapshot } from '../core/abiSymbols';
import { singlePageModelFrom } from '../features/cockpit/singlepage/modelFrom';
import { initialCockpitState } from '../features/cockpit/state';

/** 真 `nm -D --defined-only` 的形状（sysv 格式）。 */
const NM_SHARED = `0000000000004010 T _Z3addii
0000000000004020 T _Z3subii
0000000000001200 W _ZN5mylib5scopeEv
                 U malloc
0000000000004030 D mylib_global
0000000000001234 t local_helper
0000000000004040 B mylib_buf
`;

const snap = (symbols: [string, string][], at = '14:05'): AbiSnapshot => ({
  at,
  artifact: 'lib/libmylib.so',
  symbols: symbols.map(([name, kind]) => ({ name, kind })),
});

describe('L6b · 导出符号（G8）', () => {
  it('解析 nm 输出：只留**已定义全局**符号（局部 / 未定义不算 ABI）', () => {
    const syms = parseNmOutput(NM_SHARED);
    assert.deepStrictEqual(
      syms.map((s) => s.name),
      ['_Z3addii', '_Z3subii', '_ZN5mylib5scopeEv', 'mylib_buf', 'mylib_global'],
      '排序后按名字列出；`U malloc`（未定义）与 `t local_helper`（局部）都要丢掉',
    );
    assert.strictEqual(syms.find((s) => s.name === '_Z3addii')?.kind, 'T');
  });

  it('解析静态库的输出（带段头）与异常输入（不炸、不猜）', () => {
    const archive = `foo.o:
0000000000000000 T foo_init
0000000000000010 D foo_table

bar.o:
0000000000000000 T bar_init
`;
    assert.deepStrictEqual(parseNmOutput(archive).map((s) => s.name), ['bar_init', 'foo_init', 'foo_table']);
    assert.deepStrictEqual(parseNmOutput('nm: libx.a: no symbols'), []);
    assert.deepStrictEqual(parseNmOutput(''), []);
  });

  it('对比：移除 = 破坏性；新增 = 不破坏；同名同型 = 一致', () => {
    const base = snap([['_Z3addii', 'T'], ['mylib_global', 'D']]);
    const added = snap([['_Z3addii', 'T'], ['mylib_global', 'D'], ['_Z3mulii', 'T']]);
    const removed = snap([['_Z3addii', 'T']]);
    assert.deepStrictEqual(compareSymbols(base.symbols, added.symbols), { removed: [], added: ['_Z3mulii'], same: 2 });
    assert.deepStrictEqual(compareSymbols(base.symbols, removed.symbols), { removed: ['mylib_global'], added: [], same: 1 });
  });

  it('**改名一次 → 红**（G8 的门禁原文）', () => {
    // `_Z3addii` → `_Z3sumii`：源码里只是改了函数名，但符号表是"移除 + 新增"。
    const baseline = snap([['_Z3addii', 'T'], ['mylib_global', 'D']]);
    const renamed = snap([['_Z3sumii', 'T'], ['mylib_global', 'D']]);
    const v = abiFact({ baseline, now: renamed });
    assert.strictEqual(v.state, 'fail', '改名必须红 —— 已编译好的下游会链不上');
    assert.deepStrictEqual(v.compare?.removed, ['_Z3addii']);
    assert.match(v.fact, /移除 1（_Z3addii）/u);
    assert.match(v.next ?? '', /改名会同时产生/u, '要点明"改名 = 移除 + 新增"这个陷阱');
  });

  it('三态：没基线 / 没扫过 / 扫不到 —— 都要说人话（不许说成"一致"）', () => {
    const none = abiFact({});
    assert.strictEqual(none.state, 'idle');
    assert.strictEqual(none.fact, '符号基线未设');
    assert.match(none.next ?? '', /扫描当前产物/u);

    const noScan = abiFact({ baseline: snap([['a', 'T']], '昨天') });
    assert.strictEqual(noScan.state, 'idle');
    assert.strictEqual(noScan.fact, '基线 1 个符号 · 存于 昨天（还没扫过当前产物）');

    const empty = abiFact({ baseline: snap([['a', 'T']]), now: snap([]) });
    assert.strictEqual(empty.state, 'idle');
    assert.match(empty.fact, /扫描没取到符号/u);
    assert.ok(!/一致/u.test(empty.fact), '扫不到 ≠ 一致（不许给假绿）');

    const same = abiFact({ baseline: snap([['a', 'T'], ['b', 'T']]), now: snap([['b', 'T'], ['a', 'T']]) });
    assert.strictEqual(same.state, 'ok');
    assert.strictEqual(same.fact, '符号 2 个 · 与基线完全一致');

    const grew = abiFact({ baseline: snap([['a', 'T']]), now: snap([['a', 'T'], ['b', 'T']]) });
    assert.strictEqual(grew.state, 'ok', '新增不破坏 ABI');
    assert.match(grew.fact, /新增 1 个，已编译的下游不受影响/u);
  });

  it('**卡片映射**：三态上到 ⑤ 质量站的「导出符号」卡（且只在共享库/C 接口时出现）', () => {
    const model = singlePageModelFrom(initialCockpitState(), {
      metadata: { name: 'mylib', is_shared: true },
      abi: { baseline: snap([['_Z3addii', 'T']]), now: snap([['_Z3sumii', 'T']]) },
    });
    const card = model.cards.find((c) => c.id === 'abiSymbols');
    assert.ok(card, '共享库必须有这张卡');
    assert.strictEqual(card?.state, 'fail');
    assert.match(card?.fact ?? '', /移除 1/u);
    assert.match(card?.next ?? '', /^需要你执行：/u);

    // 纯头文件库：没有符号可谈 → 卡不出现（能力显隐）
    const headerOnly = singlePageModelFrom(initialCockpitState(), {
      metadata: { name: 'mylib', is_header: true },
      artifacts: {},
    });
    assert.ok(!headerOnly.cards.some((c) => c.id === 'abiSymbols'));
  });

  it('**接线门禁**：产物路径问 conan（不猜）、符号用 nm、结果落缓存', () => {
    const ext = readFileSync(join('src', 'extension.ts'), 'utf8');
    // 只看**扫描函数自己那一段**：别处（交叉编译）也有 conan list —— 全局 includes 会被它蒙过去
    // （这条门禁第一版就是这么错的：注入"改成猜路径"，测试照样绿）。
    const start = ext.indexOf('async function scanAbiSymbols');
    assert.ok(start > 0, '扫描函数得在');
    const body = ext.slice(start, ext.indexOf('\nasync function', start + 10));
    assert.ok(body.includes("['list', `${ref}:*`]"), '包目录要问 conan list');
    assert.ok(body.includes("['cache', 'path', `${ref}:${uid}`]"), '包目录要问 conan cache path（与交叉编译同一条推导）');
    assert.ok(body.includes("which('nm')") && body.includes('parseNmOutput('), '符号要真的用 nm 读并解析');
    assert.ok(body.includes("update('het.abi.last'"), '扫描结果要落盘');
    assert.ok(ext.includes("update('het.abi.baseline'"), '基线要真的落盘');
    assert.ok(ext.includes('facts.abi = {'), '事实要真的喂进单页模型');
  });
});
