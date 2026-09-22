import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { summarizePreflight, type PreflightLikeItem } from '../core/preflightSummary';
import { boardFact, boardLastText, boardModeText, platformText } from '../core/boardFacts';
import { EMPTY_FACTS, singlePageModelFrom } from '../features/cockpit/singlepage/modelFrom';
import { initialCockpitState } from '../features/cockpit/state';

/**
 * G23：三项未实测功能（上板 / 提交 / 发布）在新 UI 里的呈现门禁（§19）。
 *
 * 只盯三件可判的事：**三态齐**（§19.2）、**`–` 有原因 + ✗ 有下一步**、**上板模式在 L2 可见**（§19.3）。
 */
describe('三项卡片的呈现（G23）', () => {
  const read = (p: string): string => readFileSync(join('src', p), 'utf8');

  it('§19.2 三态摘要：✓/✗/– 都要出现，全绿才说"预检就绪"', () => {
    const allOk: PreflightLikeItem[] = [
      { label: '构建成功', ok: true, detail: '最近一次构建成功', required: true },
      { label: '测试全绿', ok: true, detail: '通过 12', required: true },
      { label: '无未提交变更', ok: true, detail: '工作区干净', required: true },
    ];
    const ok = summarizePreflight(allOk);
    assert.strictEqual(ok.ok, 3);
    assert.strictEqual(ok.fail, 0);
    assert.strictEqual(ok.na, 0);
    assert.strictEqual(ok.fact, '✓ 3 · 预检就绪');
    assert.strictEqual(ok.next, undefined, '全绿就不该再让人动手');
    assert.strictEqual(ok.allowRelease, true);

    const mixed: PreflightLikeItem[] = [
      { label: '构建成功', ok: true, required: true },
      { label: '测试全绿', ok: undefined, detail: '本会话尚未运行测试', required: true },
      { label: 'CHANGELOG.md 就绪', ok: false, detail: 'npx semantic-release --dry-run', required: true },
      { label: '文档可生成', ok: undefined, detail: '缺少：doxygen、dot', required: false },
    ];
    const m = summarizePreflight(mixed);
    assert.strictEqual(m.fact.includes('✓ 1') && m.fact.includes('✗ 1') && m.fact.includes('– 2'), true, m.fact);
    assert.ok(m.fact.includes('CHANGELOG'), `红项要点名：${m.fact}`);
    assert.ok(m.next?.startsWith('需要你执行：'), m.next);
    assert.ok(m.next?.includes('semantic-release'), '下一步要用 item 自己的命令，不是套话');
    assert.strictEqual(m.allowRelease, false);
    assert.strictEqual(m.firstFail, 'CHANGELOG.md 就绪');
  });

  it('§19.2 红项优先，且 required 的红项不被 advisory 挤掉；`–` 必须写原因', () => {
    const items: PreflightLikeItem[] = [
      { label: '文档可生成（工具齐全）', ok: false, detail: '缺少：doxygen', required: false },
      { label: '测试全绿', ok: false, detail: '失败 2', required: true },
    ];
    const s = summarizePreflight(items);
    assert.strictEqual(s.firstFail, '测试全绿', 'required 的红项优先');
    assert.ok(s.next?.includes('失败 2'));

    const onlyNa: PreflightLikeItem[] = [
      { label: '构建成功', ok: undefined, detail: '本会话尚未构建 → 点「运行构建并测试」', required: true },
      { label: '质量门禁（format/schema/commitlint）', ok: undefined, detail: '未深度判定（卡片只做浅探测）', required: false },
    ];
    const na = summarizePreflight(onlyNa);
    assert.strictEqual(na.fail, 0);
    assert.strictEqual(na.fact, '✓ 0 · – 2', '没有红项就不许瞎标红');
    assert.ok(na.next?.startsWith('– '), `没红项时要解释为什么没判定：${na.next}`);
    assert.ok(na.next?.includes('本会话尚未构建'));
    assert.strictEqual(na.allowRelease, false, '未判定 ≠ 放行');

    const longLabel = summarizePreflight([{ label: '质量门禁（format/schema/commitlint）', ok: false, required: true }]);
    assert.ok(longLabel.fact.includes('…'), `长标签要截断：${longLabel.fact}`);
    assert.ok(longLabel.next?.startsWith('需要你执行：'), '没有 detail 也要给个可执行动作');
  });

  it('§19.3 上板：模式（是否 flash）必须在 L2 文案里说得明明白白', () => {
    assert.strictEqual(boardModeText(), '默认只构建（--no-flash）');
    assert.strictEqual(boardModeText(false), '默认只构建（--no-flash）');
    assert.ok(boardModeText(true).includes('会上板刷写'), '真刷写要有警示');
    assert.strictEqual(platformText('m'), 'Cortex-M 裸机');
    assert.strictEqual(platformText('a'), 'Cortex-A Linux');
    assert.strictEqual(platformText('unknown'), '未知平台');

    const safe = boardFact({ platform: 'm' });
    assert.ok(safe.fact.includes('--no-flash'), `默认档必须写清不刷板：${safe.fact}`);
    assert.strictEqual(safe.next, '上次：无', '没采集过就说"无"，不编造时间');

    const withLast = boardFact({ platform: 'm', last: { at: '14:05', cases: 12, complete: true } });
    assert.strictEqual(withLast.next, '上次 14:05 · 12 例');
    assert.strictEqual(boardLastText({ at: '14:05', cases: 3, complete: false }), '上次 14:05 · 3 例（协议未结束）');

    const flash = boardFact({ platform: 'a', flashing: true, last: { at: '09:00' } });
    assert.ok(flash.next?.includes('刷写') && flash.next?.includes('目标板'), '上板前要提醒确认目标板/供电');
  });

  it('卡片映射：三态进 state（fail/warn/ok），下一步真的显示出来', () => {
    const fail = singlePageModelFrom(initialCockpitState(), {
      release: { summary: summarizePreflight([{ label: 'CHANGELOG.md 就绪', ok: false, detail: 'semantic-release --dry-run', required: true }]) },
    }).cards.find((c) => c.id === 'release')!;
    assert.strictEqual(fail.state, 'fail');
    assert.ok(fail.fact.includes('✗ 1'));
    assert.ok(fail.next?.startsWith('需要你执行：'), '红项后面必须有下一步（§19.2 判据）');

    const na = singlePageModelFrom(initialCockpitState(), {
      release: { summary: summarizePreflight([{ label: '测试全绿', ok: undefined, detail: '尚未运行测试', required: true }]) },
    }).cards.find((c) => c.id === 'release')!;
    assert.strictEqual(na.state, 'warn', '未判定是"要你看一眼"，不是红');

    const ok = singlePageModelFrom(initialCockpitState(), {
      release: { summary: summarizePreflight([{ label: '构建成功', ok: true, required: true }]) },
    }).cards.find((c) => c.id === 'release')!;
    assert.strictEqual(ok.state, 'ok');
    assert.ok(!ok.next, '全绿不显示下一步');

    // 兼容旧字段（只给 notReady 时行为不变）
    const legacy = singlePageModelFrom(initialCockpitState(), { release: { notReady: 2 } }).cards.find((c) => c.id === 'release')!;
    assert.strictEqual(legacy.fact, '2 项未就绪');

    const board = singlePageModelFrom(initialCockpitState(), {
      board: { fact: boardFact({ platform: 'm' }).fact, next: boardFact({ platform: 'm' }).next, collected: false },
    }).cards.find((c) => c.id === 'board')!;
    assert.strictEqual(board.state, 'idle');
    assert.ok(board.fact.includes('--no-flash'));
    assert.strictEqual(board.next, '上次：无');
    const boardDone = singlePageModelFrom(initialCockpitState(), {
      board: { fact: 'Cortex-M 裸机 · 默认只构建（--no-flash）', collected: true },
    }).cards.find((c) => c.id === 'board')!;
    assert.strictEqual(boardDone.state, 'ok');
    // 没事实时仍然是 `—`（不编造）
    assert.strictEqual(singlePageModelFrom(initialCockpitState(), EMPTY_FACTS).cards.find((c) => c.id === 'board')!.fact, '—');
  });

  it('接线：浅探测喂卡片、深探测留给面板；上板走统一忙语义', () => {
    const ext = read(join('extension.ts'));
    assert.ok(ext.includes('preflightState({ deep: false })'), '喂卡片要用浅探测（别每次全量跑格式检查）');
    assert.ok(ext.includes('const files = deep'), '逐文件格式检查要受 deep 开关控制');
    assert.ok(ext.includes('未深度判定'), '跳过的项要如实说明，不能假装绿');
    assert.ok(ext.includes('preflightState({ deep: true })'), '面板入口跑深探测');
    assert.ok(ext.includes('setSinglePageFacts({ release: { summary: summarizePreflight(st.items) } })'), '面板跑完要把真实三态回喂卡片');
    // K 块：面板的两个按钮与命令走**同一条** runBoardBuild（不再各自拼命令 ——
    // 否则"面板点的那条"与"命令跑的那条"会慢慢变成两条流水线）
    assert.ok(
      /runWithBusy\(\s*busyHost\(\),\s*'board'/u.test(ext),
      '上板构建要走 runWithBusy（§7/§19.3）',
    );
    assert.ok(
      ext.includes("runBoardBuild('cross')") && ext.includes("runBoardBuild('on-board')"),
      '面板的"只构建"与"构建并上板"必须走同一个执行器',
    );
    assert.ok(
      ext.includes("vscode.commands.registerCommand('het.boardBuild'"),
      '命令入口也要走同一个执行器（不然无头环境跑不了）',
    );
    assert.ok(ext.includes("'het.bench.last'"), '「上次采集」要有出处');
    assert.ok(ext.includes('void feedExtraSinglePageFacts();'), '解析成功后要刷新卡片');
    const ctl = read(join('features', 'cockpit', 'controller.ts'));
    assert.ok(ctl.includes('export function notifySinglePageBusy('), '忙点通知要能被 host 侧复用');
  });
});
