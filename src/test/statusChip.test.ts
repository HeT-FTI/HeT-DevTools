import * as assert from 'node:assert';
import { chipSpec, ChipModel } from '../features/statusChip';

const projectModel = (over: Partial<ChipModel> = {}): ChipModel => ({
  projectName: 'mylib',
  health: 87,
  running: null,
  lastBuildOk: true,
  test: { passed: 7, failed: 0, skipped: 1 },
  templateBehind: 0,
  ...over,
});

/** The 项目/状态 table region (between the header and the quick-actions bar). */
function tableRegion(tooltip: string): string {
  const start = tooltip.indexOf('| 项目 | 状态 |');
  const end = tooltip.indexOf('━━━ 快捷操作');
  assert.ok(start > -1, 'table header present');
  assert.ok(end > start, 'quick actions bar present after the table');
  return tooltip.slice(start, end);
}

describe('statusChip V5-2/V5-6 hover console', () => {
  it('shows a compact project chip that opens the HUD on click', () => {
    const s = chipSpec(projectModel());
    assert.ok(s);
    assert.ok(s!.text.includes('HeT 87'));
    assert.strictEqual(s!.command, 'het.chipOverview');
  });

  it('renders the 项目/状态 table with all seven four-char rows (health last)', () => {
    const s = chipSpec(projectModel())!;
    assert.ok(s.tooltip.includes('| 项目 | 状态 |'));
    const labels = ['🔧 开发环境', '🏗️ 构建结果', '🍺 测试中心', '📚 技术文档', '📊 代码覆盖', '📖 模板同步', '💚 工程健康'];
    let lastIndex = -1;
    for (const label of labels) {
      const at = s.tooltip.indexOf(label);
      assert.ok(at > -1, `row ${label} present`);
      assert.ok(at > lastIndex, `row order: ${label} after previous`);
      lastIndex = at;
    }
  });

  it('V5-6: every execute action lives ONLY in the 快捷操作 bar (not in status cells)', () => {
    const s = chipSpec(projectModel())!;
    // The bar exists below the table with all six actions, each exactly once.
    assert.ok(s.tooltip.includes('━━━ 快捷操作（点按即执行）━━━'));
    // V5-7: one action per line (bullet list) — never a squeezed single row.
    assert.ok(s.tooltip.includes('\n- [🔧 检查环境]('), 'first action is its own bullet line');
    assert.ok(s.tooltip.includes('\n- [🖥️ 完整监控卡]('), 'last action is its own bullet line');
    const execute = [
      ['command:het.envCheck', '检查环境'],
      ['command:het.test', '构建并测试'],
      ['command:het.docs', '构建文档'],
      ['command:het.coverage', '生成覆盖率'],
      ['command:het.healthCheck', '重新体检'],
      ['command:het.chipOverview', '完整监控卡'],
    ] as const;
    for (const [link, label] of execute) {
      assert.strictEqual(s.tooltip.split(link).length - 1, 1, `${label} appears exactly once (${link})`);
      assert.ok(s.tooltip.indexOf(link) > s.tooltip.indexOf('━━━ 快捷操作'), `${label} link sits in the quick bar`);
    }
    // Status cells carry NO execution wording.
    const table = tableRegion(s.tooltip);
    for (const word of ['构建并测试', '检查环境', '生成覆盖率', '重新体检', '构建文档']) {
      assert.ok(!table.includes(word), `status column must not show action "${word}"`);
    }
  });

  it('V5-6: status cells keep entry links for existing results', () => {
    const fail = chipSpec(projectModel({ lastBuildOk: false, test: { passed: 4, failed: 3, skipped: 0 } }))!;
    const table = tableRegion(fail.tooltip);
    assert.ok(table.includes('❌ 失败'), 'build failure shown as result');
    assert.ok(table.includes('command:het.openBuildOutput'), '输出 entry for the failed build');
    assert.ok(table.includes('command:het.showTestResults'), '测试结果 entry for failed tests');
    // doc artifacts remain entry links (open, not execute).
    const ok = chipSpec(projectModel({ docs: 'ok', docsDoxygen: true, docsSphinx: true }))!;
    const okTable = tableRegion(ok.tooltip);
    assert.ok(okTable.includes('command:het.openDocsArtifact?%22doxygen%22'));
    assert.ok(okTable.includes('command:het.openDocsArtifact?%22sphinx%22'));
  });

  it('开发环境 row shows the env sample summary (no action)', () => {
    const s = chipSpec(projectModel({ envSummary: 'WSL2 · Ubuntu-24.04 · gcc-13 · conan 2.32.0' }))!;
    assert.ok(s.tooltip.includes('WSL2 · Ubuntu-24.04 · gcc-13 · conan 2.32.0'));
    assert.ok(!tableRegion(s.tooltip).includes('command:het.envCheck'));
  });

  it('技术文档 row: none → 未构建 · ok → Doxygen/Sphinx links · fail → 详情 entry', () => {
    const none = chipSpec(projectModel())!;
    assert.ok(tableRegion(none.tooltip).includes('未构建'));
    assert.ok(!tableRegion(none.tooltip).includes('command:het.docs'), '构建文档 only lives in the quick bar');
    const ok = chipSpec(projectModel({ docs: 'ok', docsDoxygen: true, docsSphinx: true }))!;
    assert.ok(ok.tooltip.includes('command:het.openDocsArtifact?%22doxygen%22'));
    assert.ok(ok.tooltip.includes('command:het.openDocsArtifact?%22sphinx%22'));
    const fail = chipSpec(projectModel({ docs: 'fail' }))!;
    assert.ok(tableRegion(fail.tooltip).includes('❌ 失败'));
    assert.ok(tableRegion(fail.tooltip).includes('command:het.docs'), '详情 entry opens the docs center');
  });

  it('代码覆盖 row: 未开启 / 未生成 / ✅ %+报告入口 (no 生成覆盖率 action)', () => {
    const off = chipSpec(projectModel({ coverageEnabled: false }))!;
    assert.ok(tableRegion(off.tooltip).includes('未开启（metadata 开关）'));
    assert.ok(!tableRegion(off.tooltip).includes('command:het.coverage'));
    const empty = chipSpec(projectModel({ coverageEnabled: true }))!;
    assert.ok(tableRegion(empty.tooltip).includes('未生成'));
    const done = chipSpec(projectModel({ coverageEnabled: true, coverageFound: true, coverageLine: 76.9, coverageFunc: 66.7 }))!;
    const dt = tableRegion(done.tooltip);
    assert.ok(dt.includes('✅ 行 76.9% · 函数 66.7%'));
    assert.ok(dt.includes('command:het.openCoverageReport'), '报告 entry opens the generated report');
    const bare = chipSpec(projectModel({ coverageEnabled: true, coverageFound: true, coverageLine: null, coverageFunc: null }))!;
    assert.ok(tableRegion(bare.tooltip).includes('command:het.openCoverageReport'));
  });

  it('💚 工程健康 (last row) stays minimal; gap labels live below the table; 体检 only in the bar', () => {
    const good = chipSpec(projectModel({ healthVerdict: '良好', healthGaps: [] }))!;
    assert.ok(good.tooltip.includes('87/100 · 良好'));
    assert.ok(!good.tooltip.includes('het.healthReport'));
    assert.ok(!good.tooltip.includes('可提升'));
    const weak = chipSpec(projectModel({ health: 62, healthVerdict: '需改进', healthGaps: ['尚未构建', '覆盖率未开'] }))!;
    assert.ok(weak.tooltip.includes('62/100 · 需改进 · 2项'), 'row stays minimal with a gap count');
    assert.ok(weak.tooltip.includes('command:het.healthReport'), '明细 entry when improvable');
    const healthRow = tableRegion(weak.tooltip).split('\n').find((l) => l.includes('💚 工程健康')) ?? '';
    assert.ok(!healthRow.includes('尚未构建'), 'gap labels must not break the table cell');
    assert.ok(!healthRow.includes('command:het.healthCheck'), '重新体检 must NOT be in the status cell');
    assert.ok(weak.tooltip.includes('可提升：尚未构建 · 覆盖率未开'));
  });

  it('模板同步 row reports behind state with fcpp-native 📖 glyph', () => {
    assert.ok(chipSpec(projectModel({ templateBehind: 2 }))!.tooltip.includes('可更新 2 个提交'));
    assert.ok(!chipSpec(projectModel())!.tooltip.includes('可更新'));
    assert.ok(chipSpec(projectModel())!.tooltip.includes('与参考一致'));
  });

  it('shows the running marker while a command is in flight', () => {
    const s = chipSpec(projectModel({ running: 'conan create (Debug)' }))!;
    assert.ok(s.text.includes('$(sync~spin)'));
    assert.ok(s.tooltip.includes('conan create (Debug)'));
  });

  it('§F.35 忙时 chip 说"正在做什么"，不说分数（更不许飘红）', () => {
    const s = chipSpec(
      projectModel({
        running: '构建中',
        runningAction: 'build',
        lastBuildOk: false,
        health: 42,
      }),
    )!;
    assert.strictEqual(s.text, '$(sync~spin) HeT 构建中');
    assert.ok(!s.text.includes('42'), '忙的时候不给历史分数');
    assert.strictEqual(s.color, undefined, 'chip 不因"上次失败"变红');
  });

  it('§F.35 忙的域在悬停里显示进行中，而不是上一次的失败', () => {
    const s = chipSpec(
      projectModel({ running: '构建中', runningAction: 'build', lastBuildOk: false }),
    )!;
    assert.ok(s.tooltip.includes('$(sync~spin) 构建 进行中'), s.tooltip.slice(0, 400));
    assert.ok(!s.tooltip.includes('$(error) 构建 失败'), '不许把"正在跑"写成"失败"');
    // 同一时刻测试格保持真实历史结果（不许被别的域牵连）
    const t = chipSpec(
      projectModel({
        running: '测试中',
        runningAction: 'test',
        lastBuildOk: false,
        test: { passed: 7, failed: 0, skipped: 1 },
      }),
    )!;
    assert.ok(t.tooltip.includes('$(sync~spin) 测试 进行中'));
    assert.ok(t.tooltip.includes('$(error) 构建 失败'), '构建格仍显示真实的历史失败');
  });

  it('is invisible without a project (monitoring only)', () => {
    assert.strictEqual(chipSpec({ projectName: '', health: null, running: null, lastBuildOk: null, test: null, templateBehind: 0 }), null);
  });
});
