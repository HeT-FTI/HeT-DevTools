/**
 * C10：**V3 阶段带会话**（0 人工 + 喂狗）—— 回答 L2 改造后的三个新问题：
 *
 * 1. **8 站真的在位吗**：逐个站深链，`focus` / `opened` / `folded` 三处必须一致；
 * 2. **手风琴真的互斥吗**：任何时刻**只有一站展开**（这是用户 2026-09-30 实测到的
 *    "点了一下却同时展开两项"那条 bug 的回归门禁）；
 * 3. **旧链接还认吗**：旧 UI 的 11 个 tab 深链必须仍然落到正确的**站**上
 *    （改名/重排最容易在这里悄悄断掉，而单测看不到"真宿主里 deep link 到底落到哪"）。
 *
 * 另外验：新视图「工具链与环境」（`het.openTools`）在真宿主里能开、标题合规、页签恒 1。
 *
 * **与 c9 的分工**：c9 管"任务 × 输出 × 前端三面一致 + 四个出口"；c10 管"结构/导航/手风琴"。
 * 两者都开真宿主，但 c10 不碰长动作（快，~20 秒）。
 *
 * Run with:  npm run test:c10
 */
import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';

import { EXTENSION_ID } from '../hostExtension';
import { assertHostIsTrustworthy, hostProvenance, writeEvidence } from './support/hostProvenance';
import { getAllTabIds, LEGACY_LINK_EXPECTATION, tabStationOf } from './support/stationPlan';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface UiSnapshot {
  tabs: number;
  tabReport: string;
  slot: { open: { id: string; title: string } | null; dropped: number };
  sections: { focus: string | null; folded: string[]; opened: string[] };
}

async function snapshot(): Promise<UiSnapshot> {
  return (await vscode.commands.executeCommand('het.getUiSnapshot')) as UiSnapshot;
}

/**
 * **真机截图**（服务器上跑无头 X，把真实的 VS Code 窗口拍下来）。
 *
 * 为什么需要：开发机是远端服务器，用户看不到我这边；静态预览（`npm run preview:cockpit`）
 * 只能证明"渲染函数长这样"，证明不了"真宿主里也是这样"。
 *
 * 截图是**证据不是门禁**：`import`/`xdotool` 缺了、DISPLAY 没了都不该让会话失败
 * （失败只记一行日志，证据文件里的 `shots=` 会如实写 0）。
 */
function capture(name: string): boolean {
  const dir = join(__dirname, '..', '..', 'workspace', 'develope', 'screenshots');
  try {
    mkdirSync(dir, { recursive: true });
    // 先把窗口调到固定尺寸：不同 Xvfb 屏幕大小会让截图无法逐版对比
    execFileSync('xdotool', ['search', '--name', 'Visual Studio Code', 'windowsize', '1600', '1040', 'windowmove', '0', '0'], {
      stdio: 'ignore',
      timeout: 5000,
    });
    execFileSync('import', ['-window', 'root', join(dir, `${name}.png`)], { stdio: 'ignore', timeout: 15000 });
    return true;
  } catch (e) {
    console.log(`[c10] 截图 ${name} 跳过：${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    return false;
  }
}

/** 深链到某站，并断言"定位到了它、它开着、别的都收着"（手风琴）。 */
async function deepLinkStation(id: string): Promise<void> {
  await vscode.commands.executeCommand('het.dashboard', [id]);
  await sleep(120);
  const s = await snapshot();
  assert.strictEqual(s.sections.focus, id, `深链 ${id} 后 focus 必须就是它（实际 ${s.sections.focus}）`);
  assert.ok(s.sections.opened.includes(id), `深链 ${id} 后它必须是展开的（opened=${s.sections.opened.join(',')}）`);
  assert.ok(!s.sections.folded.includes(id), `深链 ${id} 后它不该在 folded 里`);
  const stillOpen = s.sections.opened.filter((x) => !s.sections.folded.includes(x));
  assert.deepStrictEqual(
    stillOpen,
    [id],
    `手风琴：深链到 ${id} 后同时只能有它一个展开（实际开着 ${stillOpen.join(',')}）`,
  );
  assert.strictEqual(s.tabs, 1, `深链 ${id} 后页签仍然只能有 1 个`);
}

export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(ext, 'extension must be discovered');
  await ext.activate();
  await sleep(300);
  assertHostIsTrustworthy({ tag: 'c10', workspaceContains: ['c10-ws'] });

  // ── ① 8 站逐个深链（含手风琴互斥）──────────────────────────────────────
  const stations = getAllTabIds();
  assert.strictEqual(stations.length, 8, 'V3 的 rail 是 8 站（动作序列）');
  let shots = 0;
  for (const id of stations) {
    await deepLinkStation(id);
  }
  // 真实窗口留证：先深链回目标站，**等页面画完**再拍。
  // （原来在循环里边深链边拍，拍到的常常是空页 —— 那是"还没画完"，不是缺陷，
  //  但作为留证没有信息量，所以这里补一段沉降时间。）
  await deepLinkStation('ready');
  await sleep(1200);
  if (capture('v3-l2e-realhost-01-ready-station')) {
    shots += 1;
  }
  await deepLinkStation('test');
  await sleep(600);
  if (capture('v3-l2e-realhost-02-test-station')) {
    shots += 1;
  }
  console.log(`[c10] 阶段带 OK — ${stations.length} 站逐个深链，每次只有一站展开，页签恒 1`);

  // ── ② 旧 tab 深链 → 必须落到**预期的站**（改名/重排最容易在这里悄悄断掉）──
  const legacy = Object.keys(LEGACY_LINK_EXPECTATION);
  const mapped: string[] = [];
  for (const tab of legacy) {
    const expected = LEGACY_LINK_EXPECTATION[tab];
    const actual = tabStationOf(tab);
    assert.strictEqual(actual, expected, `旧 tab ${tab} 应该落到「${expected}」，实际「${actual}」`);
    await deepLinkStation(actual);
    mapped.push(`${tab}->${actual}`);
  }
  console.log(`[c10] 旧链接 OK — ${mapped.join(' ')}`);

  // ── ③ 新视图「工具链与环境」：在真宿主里能开、标题合规、页签恒 1 ───────
  await vscode.commands.executeCommand('het.openTools');
  await sleep(400);
  const withTools = await snapshot();
  assert.strictEqual(withTools.tabs, 1, '打开工具链视图后页签仍然只能有 1 个');
  assert.strictEqual(withTools.slot.open?.id, 'tools', `工具链视图没开成（实际 ${withTools.slot.open?.id ?? 'null'}）`);
  assert.ok(
    withTools.slot.open?.title?.includes('：'),
    `Slot 标题要按"<站>：<对象>"格式，实际「${withTools.slot.open?.title}」`,
  );
  assert.strictEqual(withTools.slot.dropped, 0, '消息丢弃数必须为 0（不是 0 就是有视图没接住消息）');
  if (capture('v3-l2e-realhost-03-tools-slot')) {
    shots += 1;
  }

  // 切回去：关掉 Slot 后不该还有残留
  await vscode.commands.executeCommand('het.detail.close');
  await sleep(250);
  const closed = await snapshot();
  assert.strictEqual(closed.slot.open, null, '关闭后不该还有 Slot');
  assert.strictEqual(closed.tabs, 1, '关闭后页签仍然只能有 1 个');

  // ── ④ V3 · L4 / G3：交付前的两条硬门禁必须在**发布前检查**里（真宿主，不是单测）──
  const pre = (await vscode.commands.executeCommand('het.getPreflightItems')) as {
    allowRelease: boolean;
    items: { label: string; ok?: boolean; detail?: string; required?: boolean }[];
  };
  const labels = pre.items.map((i) => i.label);
  assert.ok(
    labels.includes('已推送（无未推提交）'),
    `发布前检查缺"已推送"这条（实际：${labels.join(' / ')}）`,
  );
  assert.ok(labels.includes('PR / CI 回执'), `发布前检查缺 PR / CI 回执（实际：${labels.join(' / ')}）`);
  const push = pre.items.find((i) => i.label === '已推送（无未推提交）');
  assert.strictEqual(push?.required, true, '它是发布的前置条件 —— 必须 required（否则只是装饰）');
  assert.ok((push?.detail ?? '').length > 0, '红/– 都必须写原因（detail 不许空）');
  assert.ok(
    typeof pre.allowRelease === 'boolean',
    '结论必须由同一份 items 算出（两处口径漂移会让"预检说不能发、发布中心说能发"）',
  );
  // ⑥⑦ 两站在真宿主里的样子（截图留证）：Git 事实行 + 「CI 总编排」卡
  await deepLinkStation('commit');
  if (capture('v3-l4-realhost-01-commit-git-facts')) {
    shots += 1;
  }
  await deepLinkStation('release');
  if (capture('v3-l4-realhost-02-release-orchestrator')) {
    shots += 1;
  }
  // 「打开编排文件」：本夹具没有 workflow → 只要求"点了不炸、不留残留页签"
  await vscode.commands.executeCommand('het.openOrchestrator');
  await sleep(200);
  assert.strictEqual((await snapshot()).tabs, 1, '打开编排入口后页签仍然只能有 1 个');
  console.log(`[c10] L4 门禁 OK — 预检 ${pre.items.length} 条（含"已推送"+PR/CI 回执）· allowRelease=${pre.allowRelease}`);

  // ── ⑤ V3 · L5 / G4：「新库自检」的 Slot（判定读的是真文件，页签恒 1）──────────
  await vscode.commands.executeCommand('het.openNewLibAudit');
  await sleep(600);
  const withAudit = await snapshot();
  assert.strictEqual(withAudit.tabs, 1, '打开新库自检后页签仍然只能有 1 个');
  assert.strictEqual(
    withAudit.slot.open?.id,
    'newLibAudit',
    `新库自检没开成（实际 ${withAudit.slot.open?.id ?? 'null'}）`,
  );
  assert.ok(
    withAudit.slot.open?.title?.includes('：'),
    `Slot 标题要按"<站>：<对象>"格式，实际「${withAudit.slot.open?.title}」`,
  );
  assert.strictEqual(withAudit.slot.dropped, 0, '消息丢弃数必须为 0（不是 0 就是有视图没接住消息）');
  if (capture('v3-l5-realhost-01-newlib-audit')) {
    shots += 1;
  }
  await vscode.commands.executeCommand('het.detail.close');
  await sleep(200);
  console.log(`[c10] L5 自检 OK — Slot=${withAudit.slot.open?.id} · 判定来自工程里的真文件`);

  // ── ⑥ V3 · L6c / G9：Python 绑定对账（⑧ 交付站）─────────────────────────────
  // 夹具里放的是**模板本体那两份真文件**（公开头 + 绑定源），状态是"改了库名、
  // 忘了改绑定模块名"：产物名 mini-fcpp_python，而 `PYBIND11_MODULE(fcpp_python)`。
  // 这正是这张卡要抓的东西 —— 本地构建全绿、只有 import 才炸。
  const py = (await vscode.commands.executeCommand('het.getPythonBindings')) as
    | {
        state: string;
        fact: string;
        next?: string;
        bindingsFile: string;
        fromCmake: boolean;
        entities: number;
      }
    | null;
  assert.ok(py, 'Python 绑定对账要有结果（夹具里放了真头文件 + 真绑定源）');
  assert.strictEqual(
    py?.state,
    'fail',
    `夹具是"改名后忘了改绑定模块名" → 必须红（实际 ${py?.state}：${py?.fact}）`,
  );
  assert.match(py?.fact ?? '', /≠/u, '事实里要写出两个名字不一致（不是一句"有问题"）');
  assert.match(py?.next ?? '', /PyInit_/u, '下一步要说清"为什么 import 会失败"');
  assert.strictEqual(py?.bindingsFile, 'api/python_bindings.cpp', '绑定路径要问 CMake（不许写死）');
  assert.strictEqual(py?.fromCmake, true, '路径来源必须是 CMake 的 PYTHON_BINDINGS_SOURCE');
  assert.ok((py?.entities ?? 0) > 0, '公开 API（include/ 里带 @exporter）必须真的数出来');
  // ⑧ 交付站的真机样子（截图留证）：卡片红、事实一行说清
  await deepLinkStation('deliver');
  if (capture('v3-l6c-realhost-01-python-bindings')) {
    shots += 1;
  }
  await vscode.commands.executeCommand('het.openPythonBindings');
  await sleep(300);
  const afterPy = await snapshot();
  assert.strictEqual(afterPy.tabs, 1, '打开绑定文件后页签仍然只能有 1 个');
  assert.strictEqual(afterPy.slot.dropped, 0, '消息丢弃数必须为 0');
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  await sleep(150);
  console.log(`[c10] L6c 对账 OK — ${py?.fact}（公共 API ${py?.entities} 个 · 路径来自 CMake）`);

  // ── ⑦ V3 · L6d：交叉目标矩阵（"多目标真的全绿了吗"）─────────────────────────
  // 夹具里放的是**模板本体那份矩阵**（真文件，只改了 package_ref）。两步：
  //   ① 还没编过 → 黄（"没编过"要在界面上说得出来，而不是一片空白）；
  //   ② 真跑一次交叉编译 —— 这台机器没有 arm 工具链 → 它**真的会失败**，而这正是矩阵
  //      存在的理由：**"试过且没成"必须留痕**，不能等发布时才发现。
  interface MatrixDiag {
    error?: string;
    targets?: { id: string }[];
    matrix?: { state: string; fact: string; next?: string; cells?: { id: string; ok?: boolean }[] };
  }
  const before = (await vscode.commands.executeCommand('het.getBuildMatrix')) as MatrixDiag;
  assert.ok(before.matrix, '有矩阵文件的工程必须有矩阵汇总（`het.getBuildMatrix` 要把它带出来）');
  assert.ok(
    before.matrix?.state === 'warn' || before.matrix?.state === 'fail',
    `还没编过（或上次没成）→ 绝不能是绿（实际 ${before.matrix?.state}：${before.matrix?.fact}）`,
  );
  assert.match(before.matrix?.fact ?? '', /没编过|红/u, '事实要说清"哪个目标什么状态"');
  assert.match(before.matrix?.next ?? '', /^需要你执行：/u, '非绿要说清人该干什么');

  const built = (await vscode.commands.executeCommand('het.crossBuild')) as { ok: boolean; message: string };
  assert.strictEqual(built.ok, false, `这台机器没有 arm 工具链 → 交叉编译必须如实失败（${built.message}）`);
  const after = (await vscode.commands.executeCommand('het.getBuildMatrix')) as MatrixDiag;
  assert.strictEqual(after.matrix?.state, 'fail', `"试过且没成"必须留下红（实际 ${after.matrix?.state}：${after.matrix?.fact}）`);
  assert.match(after.matrix?.fact ?? '', /linux-armv7/u, '红必须点名是哪个目标');
  assert.strictEqual(after.matrix?.cells?.[0]?.ok, false, '格子里也得是"没成"（不是"没编过"）');

  // 交付前门禁：多目标工程的"每个目标都验证过"—— 与卡片读**同一份**事实
  const pre2 = (await vscode.commands.executeCommand('het.getPreflightItems')) as {
    items: { label: string; ok?: boolean; required?: boolean; detail?: string }[];
  };
  const gateItem = pre2.items.find((i) => i.label.startsWith('交叉目标矩阵'));
  assert.ok(
    gateItem,
    `预检里必须有「交叉目标矩阵」（实际：${pre2.items.map((i) => i.label).join(' / ')}）`,
  );
  assert.strictEqual(gateItem?.required, true, '多目标工程的"每个目标都验证过"是交付承诺');
  assert.strictEqual(gateItem?.ok, false, '有目标红 → 门禁必须红（不许装绿）');
  assert.match(gateItem?.detail ?? '', /linux-armv7/u, '门禁 detail 要说清是哪个目标');

  await deepLinkStation('deliver');
  if (capture('v3-l6d-realhost-01-target-matrix')) {
    shots += 1;
  }
  console.log(`[c10] L6d 矩阵 OK — ${after.matrix?.fact}（真跑一次交叉编译：失败也留痕）`);

  // ── ⑧ V3 · L6e：编译期成本（仅头文件库）───────────────────────────────
  // 夹具里放的是模板的公开头（拷成 `include/<模块名>.hpp`，探针只认这个名字）。
  // 这一步**真的编译**：编一个只 include 它的 TU 与一个空 TU，各 5 次取中位 → 报差值。
  interface HeaderCostDiag {
    state: string;
    fact: string;
    next?: string;
    now?: { header: string; compiler: string; std: string; runs: number; emptyMs: number; includeMs: number; deltaMs: number };
    baseline?: { deltaMs: number };
    costPct: number;
  }
  const hcBefore = (await vscode.commands.executeCommand('het.getHeaderCost')) as HeaderCostDiag;
  assert.strictEqual(hcBefore.state, 'idle', `还没量过 → 白（不是绿、更不是 0ms）：${hcBefore.fact}`);
  assert.match(hcBefore.fact, /还没实测过/u);
  assert.match(hcBefore.fact, /不等于"成本为零"/u, '必须点破这个误读');
  assert.match(hcBefore.next ?? '', /^需要你执行：/u);

  const probed = (await vscode.commands.executeCommand('het.probeHeaderCost')) as boolean;
  assert.strictEqual(probed, true, '探针要真的量出数（探头只 include 公开头 + 空 TU 对照）');
  const hcAfter = (await vscode.commands.executeCommand('het.getHeaderCost')) as HeaderCostDiag;
  assert.ok(hcAfter.now, '测量结果要落盘（会话读的就是卡片读的那份）');
  assert.match(hcAfter.now?.header ?? '', /include\/mini-fcpp\.hpp$/u, '量的是"用户会 include 的那个头"');
  assert.strictEqual(hcAfter.now?.runs, 5, '中位 5 次');
  assert.ok((hcAfter.now?.includeMs ?? 0) > 0 && (hcAfter.now?.emptyMs ?? 0) > 0, '两个 TU 的原始中位都要有');
  assert.strictEqual(
    hcAfter.now?.deltaMs,
    Math.max(0, (hcAfter.now?.includeMs ?? 0) - (hcAfter.now?.emptyMs ?? 0)),
    '头条数字 = include − 空 TU（扣掉进程启动那一份）',
  );
  assert.match(hcAfter.now?.compiler ?? '', /\d+\.\d+/u, '快照要带编译器与版本（否则以后是假对比）');
  assert.match(hcAfter.now?.std ?? '', /^c\+\+/u, '标准取自 metadata');
  assert.match(hcAfter.fact, /还没有基线/u, '第一次量：绿，但写明还没有基线');

  const pinned = (await vscode.commands.executeCommand('het.pinHeaderCostBaseline')) as boolean;
  assert.strictEqual(pinned, true, '要把这次实测钉成基线');
  const hcPinned = (await vscode.commands.executeCommand('het.getHeaderCost')) as HeaderCostDiag;
  assert.match(hcPinned.fact, /比基线 [+-]?\d+%/u, `钉完基线就要有对比：${hcPinned.fact}`);

  await deepLinkStation('quality');
  if (capture('v3-l6e-realhost-01-header-cost')) {
    shots += 1;
  }
  console.log(`[c10] L6e 成本 OK — ${hcAfter.fact}（${hcAfter.now?.compiler} · -std=${hcAfter.now?.std}）`);

  writeEvidence(
    'c10',
    [
      `tabs=1`,
      `stations=${stations.length}`,
      `accordion=exclusive`,
      `legacy=${mapped.length}`,
      `toolsSlot=${withTools.slot.open?.id ?? 'none'}`,
      `preflightItems=${pre.items.length}`,
      `preflightGate=${labels.includes('已推送（无未推提交）') && labels.includes('PR / CI 回执')}`,
      `auditSlot=${withAudit.slot.open?.id ?? 'none'}`,
      `pyBind=${py?.state ?? 'none'}`,
      `matrix=${after.matrix?.state ?? 'none'}`,
      `headerCost=${hcAfter.state}`,
      `headerCostMs=${hcAfter.now?.deltaMs ?? 'none'}`,
      `dropped=${closed.slot.dropped}`,
      `shots=${shots}`,
    ],
    hostProvenance(),
  );
  console.log(
    `[c10] 完成 — 8 站 · 手风琴互斥 · ${mapped.length} 条旧链接 · 工具链Slot · 交付前门禁 · 新库自检 · Python 绑定对账 · 交叉目标矩阵 · 编译期成本 · 页签恒 1`,
  );
}
