/**
 * V3 · L6d 门禁：**交叉目标矩阵**（"多目标真的全绿了吗"）。
 *
 * 计划 §L6 领域专项第 4 项的验收原文：「裸机交叉矩阵：多目标全绿」。
 *
 * 这里盯五件事：
 *   1. **记为"最近一次有结论的尝试"**：成功 / 失败都算，用户取消**不算**（没结论）；
 *   2. **早期账本（只记"用过哪个目标"）不算绿** —— 没有结论 = 要重编，不许替它说绿；
 *   3. 红 / 缺都必须**点名**（矩阵的价值就在"哪个目标"），并给出下一步；
 *   4. 交付前门禁：多目标工程的"每个目标都验证过"（没编过 → 拦发布，不能装绿）；
 *   5. **拿模板本体那份矩阵**（`assets/template/.hetai/build-matrix.yml`）解析一遍 ——
 *      单测里的夹具形状必须与真工程一致。
 */
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { emptyLedger, parseLedger, recordBuild, type BuildLedger } from '../core/buildLedger';
import { enabledTargets, parseBuildMatrix, BUILD_MATRIX_REL } from '../core/buildMatrix';
import { matrixGateItem, matrixView, recordedRuns, type MatrixTarget } from '../core/targetMatrix';
import { singlePageModelFrom } from '../features/cockpit/singlepage/modelFrom';
import { initialCockpitState } from '../features/cockpit/state';

const TEMPLATE_MATRIX = join('assets', 'template', BUILD_MATRIX_REL);

/** 模板本体那份矩阵里的目标（真的解析，不是手写）。 */
function templateTargets(): MatrixTarget[] {
  const matrix = parseBuildMatrix(readFileSync(TEMPLATE_MATRIX, 'utf8'), BUILD_MATRIX_REL);
  return enabledTargets(matrix).map((t) => ({ id: t.id, arch: t.arch, isDefault: t.isDefault }));
}

const TARGETS: MatrixTarget[] = [
  { id: 'linux-armv7', arch: 'armv7', isDefault: true },
  { id: 'linux-aarch64', arch: 'armv8' },
  { id: 'linux-mips', arch: 'mips' },
];

function ledgerWith(records: { target: string; ok: boolean; at: number }[]): BuildLedger {
  let ledger = emptyLedger('/tmp/proj');
  for (const r of records) {
    ledger = recordBuild(ledger, { target: r.target, arch: 'x', profileHash: 'h', at: r.at, ok: r.ok });
  }
  return ledger;
}

const runs = (l: BuildLedger): ReturnType<typeof recordedRuns> => recordedRuns(l, (at) => `${Math.round((1_700_000_000_000 - at) / 60_000)} 分钟前`);

describe('L6d · 交叉目标矩阵（多目标全绿）', () => {
  it('账本 → 目标记录：**只有带结论的记录才算**（早期账本的时间戳不算绿）', () => {
    const legacy = emptyLedger('/tmp/proj');
    legacy.byTarget['linux-armv7'] = { target: 'linux-armv7', profileHash: 'h', at: 1_600_000_000_000 };
    assert.deepStrictEqual(recordedRuns(legacy), {}, '没有 ok 字段 = 没有结论 → 不能算绿');
    const r = runs(ledgerWith([{ target: 'linux-armv7', ok: false, at: 1_699_999_400_000 }]));
    assert.deepStrictEqual(r['linux-armv7'], {
      target: 'linux-armv7',
      ok: false,
      at: 1_699_999_400_000,
      atText: '10 分钟前',
      arch: 'x',
    });
  });

  it('坏账本不炸：解析失败 → 空账本 + 一句"读不到"（而不是把失败当绿）', () => {
    const { ledger, issue } = parseLedger('{ 这不是 json', '/tmp/proj');
    assert.deepStrictEqual(ledger.byTarget, {});
    assert.ok(issue, '读不到必须如实说');
    assert.deepStrictEqual(recordedRuns(ledger), {});
  });

  it('全绿 → ok（并写出"最近一次是哪天"—— 绿得有多新是另一半信息）', () => {
    const view = matrixView(
      TARGETS,
      runs(
        ledgerWith([
          { target: 'linux-armv7', ok: true, at: 1_699_999_400_000 },
          { target: 'linux-aarch64', ok: true, at: 1_699_998_000_000 },
          { target: 'linux-mips', ok: true, at: 1_699_990_000_000 },
        ]),
      ),
    );
    assert.strictEqual(view.state, 'ok');
    assert.match(view.fact, /^3\/3 个目标绿 · 最近 linux-armv7（10 分钟前）/u);
    assert.strictEqual(view.next, undefined, '绿的时候不啰嗦"下一步"');
    assert.deepStrictEqual(view.cells.map((c) => c.ok), [true, true, true]);
  });

  it('有目标红 → **红**：点名 + 让人重跑它', () => {
    const view = matrixView(
      TARGETS,
      runs(
        ledgerWith([
          { target: 'linux-armv7', ok: true, at: 1_699_999_400_000 },
          { target: 'linux-aarch64', ok: false, at: 1_699_999_000_000 },
          { target: 'linux-mips', ok: true, at: 1_699_998_000_000 },
        ]),
      ),
    );
    assert.strictEqual(view.state, 'fail');
    assert.match(view.fact, /3 个目标 · 2 绿 · 1 红（linux-aarch64）/u);
    assert.match(view.next ?? '', /^需要你执行：重跑 linux-aarch64/u);
    assert.match(view.next ?? '', /交叉编译/u, '"怎么重跑"要说清入口');
  });

  it('有目标没编过 → 黄（不是红：还没试过 ≠ 编不过），也点名', () => {
    const view = matrixView(
      TARGETS,
      runs(ledgerWith([{ target: 'linux-armv7', ok: true, at: 1_699_999_400_000 }])),
    );
    assert.strictEqual(view.state, 'warn');
    assert.match(view.fact, /1 绿 · 2 没编过（linux-aarch64、linux-mips）/u);
    assert.match(view.next ?? '', /把没编过的编一遍/u);
    assert.deepStrictEqual(view.cells.map((c) => c.ok), [true, undefined, undefined], '没编过的那两格必须是"没结论"');
  });

  it('红 + 缺同时存在 → 红，两步都要给；只有 1 个目标时也要说清', () => {
    const mixed = matrixView(
      TARGETS,
      runs(ledgerWith([{ target: 'linux-armv7', ok: true, at: 1 }, { target: 'linux-mips', ok: false, at: 2 }])),
    );
    assert.strictEqual(mixed.state, 'fail');
    assert.match(mixed.fact, /1 绿 · 1 红（linux-mips） · 1 没编过（linux-aarch64）/u);
    assert.ok((mixed.next ?? '').includes('重跑') && (mixed.next ?? '').includes('没编过的'), '两步都要给');

    const single = matrixView([TARGETS[0]], {});
    assert.strictEqual(single.state, 'warn');
    assert.match(single.fact, /1 个目标 · 0 绿 · 1 没编过（linux-armv7）/u);
  });

  it('矩阵里没有启用的目标 → 黄（配置没写完，不是"全部通过"）', () => {
    const view = matrixView([], {});
    assert.strictEqual(view.state, 'warn');
    assert.match(view.fact, /没有启用的目标/u);
    assert.match(view.next ?? '', /build-matrix\.yml/u);
    assert.deepStrictEqual(view.cells, []);
  });

  it('**交付前门禁**：多目标工程"每个目标都验证过"才算过（没编过 → 拦发布，不装绿）', () => {
    const gate = matrixGateItem(matrixView(TARGETS, {}), TARGETS.length);
    assert.strictEqual(gate.ok, false, '一个都没编过 → 不能发布');
    assert.strictEqual(gate.required, true, '这是交付承诺，不是建议');
    assert.match(gate.label, /3 个目标都绿/u);
    assert.ok((gate.detail ?? '').length > 0, '红/– 都必须写原因');
    // 红也算不过（只盯"没缺"是不够的：编挂了同样是没验证过）
    const redGate = matrixGateItem(
      matrixView(TARGETS, runs(ledgerWith([{ target: 'linux-armv7', ok: false, at: 1 }]))),
      TARGETS.length,
    );
    assert.strictEqual(redGate.ok, false, '有目标红 → 门禁必须红');
    assert.match(redGate.detail ?? '', /1 红（linux-armv7）/u, '门禁的 detail 要说清是哪个目标');
    const okGate = matrixGateItem(
      matrixView(TARGETS, runs(ledgerWith(TARGETS.map((t, i) => ({ target: t.id, ok: true, at: 1_700_000_000_000 - i }))))),
      TARGETS.length,
    );
    assert.strictEqual(okGate.ok, true);
    // 矩阵里一个启用目标都没有 → 无法判定（`undefined`，而不是假装过/不过）
    assert.strictEqual(matrixGateItem(matrixView([], {}), 0).ok, undefined);
  });

  it('**拿模板本体那份矩阵**：1 个目标，解析出来的 id/arch 与文件一致', () => {
    const targets = templateTargets();
    assert.deepStrictEqual(
      targets.map((t) => [t.id, t.arch]),
      [['linux-armv7', 'armv7']],
      '目标只来自文件（硬编码目标名 = 矩阵一变就静默失配）',
    );
    const view = matrixView(targets, runs(ledgerWith([{ target: 'linux-armv7', ok: true, at: 1_699_999_400_000 }])));
    assert.strictEqual(view.state, 'ok');
    assert.match(view.fact, /1\/1 个目标绿/u);
  });

  it('**邻接目标不许被吞掉**（解析器实测坑）：紧跟 toolchain_versions 列表的下一个目标', () => {
    // 这个形状是**真工程里必然会有的**（第一个目标带工具链列表，第二个紧跟其后）。
    // 修之前：`- id: linux-aarch64` 被当成上一个目标的"工具链版本"，紧随的 `arch:` 还给
    // 上一个目标覆写了 arch —— 目标凭空消失，而"多目标全绿"会替一个从没编过的目标背书。
    const text = [
      'package_ref: mylib/1.0.0',
      'targets:',
      '  - id: linux-armv7',
      '    enabled: true',
      '    arch: armv7',
      '    toolchain_versions:',
      '      - 11.3.rel1',
      '  - id: linux-aarch64',
      '    enabled: true',
      '    arch: armv8',
      '    toolchain_versions:',
      '      - 12.2.rel1',
      '',
    ].join('\n');
    const parsed = parseBuildMatrix(text, 'probe');
    assert.deepStrictEqual(
      enabledTargets(parsed).map((t) => [t.id, t.arch]),
      [['linux-armv7', 'armv7'], ['linux-aarch64', 'armv8']],
      '两个目标都要在，且 arch 不许互相覆写',
    );
    assert.deepStrictEqual(parsed.targets[0].toolchainVersions, ['11.3.rel1'], '工具链列表仍然是列表');
    assert.deepStrictEqual(parsed.targets[1].toolchainVersions, ['12.2.rel1']);
  });

  it('**卡片映射**：矩阵事实进 ⑧ 交付站的「交叉编译」卡（没有矩阵的工程看不到这张卡）', () => {
    const view = matrixView(
      TARGETS,
      runs(ledgerWith([{ target: 'linux-armv7', ok: false, at: 1_699_999_400_000 }])),
    );
    const model = singlePageModelFrom(initialCockpitState(), {
      metadata: { name: 'mylib' },
      artifacts: { buildMatrix: true },
      matrix: { state: view.state, fact: view.fact, ...(view.next ? { next: view.next } : {}) },
    });
    const card = model.cards.find((c) => c.id === 'crossBuild');
    assert.ok(card, '有矩阵事实的工程必须有这张卡');
    assert.strictEqual(card?.state, 'fail', '有目标红 → 卡片红（站状态跟着红）');
    assert.match(card?.fact ?? '', /1 红（linux-armv7）/u);
    assert.match(card?.next ?? '', /^需要你执行：/u);
    assert.strictEqual(model.spine?.find((s) => s.id === 'deliver')?.cards.includes('crossBuild'), true);

    // 没有 `.hetai/build-matrix.yml` → 能力不成立 → 卡不出现
    const off = singlePageModelFrom(initialCockpitState(), { metadata: { name: 'mylib' }, artifacts: {} });
    assert.ok(!off.cards.some((c) => c.id === 'crossBuild'), '单目标库不该看到"矩阵"这种说法');
  });

  it('**接线门禁**：账本记结论（取消不记）→ 事实/门禁/诊断读**同一份**推导', () => {
    const ext = readFileSync(join('src', 'extension.ts'), 'utf8');
    // ① 写侧：只在"有结论"时写账本，且把结论写进去
    const runStart = ext.indexOf('async function runCrossBuild');
    assert.ok(runStart > 0, '交叉编译函数得在');
    const run = ext.slice(runStart, ext.indexOf('\nasync function', runStart + 10));
    assert.match(run, /busy\.status === 'done' \|\| \(busy\.status === 'failed' && !canceled\)/u, '取消 / 重复点击不能写账本（没结论）');
    assert.ok(run.includes('ok: busy.status === \'done\''), '账本要记"成没成"（只记"用过哪个目标"= 矩阵无法回答全绿）');
    assert.ok(run.includes("addEventListener('abort'"), '取消要靠 abort 信号判定（不能靠匹配文案）');
    // 写账本之后必须**立刻重喂事实**：否则卡片停在"没编过"、而账本里已经是红
    // （真机截图抓到过这一步 —— 卡说没试过、事实说试过且没成）。
    const ledgerWrite = run.indexOf('writeText(ledgerFile');
    const reFeed = run.indexOf('feedExtraSinglePageFacts()');
    assert.ok(ledgerWrite > 0, '账本要真的落盘');
    assert.ok(reFeed > ledgerWrite, '落盘之后要重喂事实（`feedExtraSinglePageFacts()`）');

    // ② 读侧：单点函数（目标来自矩阵文件，结果来自账本）
    const fnStart = ext.indexOf('async function targetMatrixNow');
    assert.ok(fnStart > 0, '矩阵的单点函数得在');
    const fn = ext.slice(fnStart, ext.indexOf('\n}', fnStart));
    for (const needle of ['BUILD_MATRIX_REL', 'parseBuildMatrix(', 'ledgerPath(', 'parseLedger(', 'recordedRuns(', 'matrixView(']) {
      assert.ok(fn.includes(needle), `单点函数缺 ${needle}`);
    }
    // ③ 喂事实 + 门禁 + 诊断，三处都读同一份
    assert.ok(ext.includes('facts.matrix = { state: m.view.state'), '事实要真的喂进单页模型');
    assert.ok(ext.includes('items.push(matrixGateItem(mtx.view, mtx.targets.length))'), '交付前门禁要真的挂上');
    const diag = ext.slice(ext.indexOf("registerCommand('het.getBuildMatrix'"));
    assert.ok(diag.slice(0, 1200).includes('targetMatrixNow('), '诊断命令也要读同一份（会话断言的就是面板渲染的那份）');
  });
});
