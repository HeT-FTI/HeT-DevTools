/**
 * statusChip 的门禁（C 块重写：三档同源 + 悬停预算）。
 *
 * 旧版契约是"7 行表格 + 6 个动作"。V2 的 §3.6 / D2 / G18 把它推翻：
 *   · 悬停 = **5 条域行**（行名与 rail 定名一致）+ **≤3 动作** + **≤2 导航**；
 *   · 健康分是"没有 rail 的横切指标"，进徽章行 + 提示行，不硬塞成一条域行；
 *   · 三档（芯片 / 悬停 / 页内）全部由 `core/statusItem.ts` 的 StatusItem 投影 ——
 *     谁都不许自己再拼一套文案。
 *
 * 保留的既有纪律（都是实测反馈换来的）：
 *   · 状态格只放**结论 + 结果入口**，执行动作只在快捷操作区；
 *   · 忙的时候 chip 说"正在做什么"，不说分数、更不许飘红；
 *   · 忙的域只表达"进行中"，不与"上一次失败"并列。
 */
import * as assert from 'node:assert';
import { chipSpec, chipStatusItems, chipHoverActions, ChipModel } from '../features/statusChip';
import { HOVER_LIMITS, StatusItemError, hoverProjection } from '../core/statusItem';

const projectModel = (over: Partial<ChipModel> = {}): ChipModel => ({
  projectName: 'mylib',
  health: 87,
  running: null,
  lastBuildOk: true,
  test: { passed: 7, failed: 0, skipped: 1 },
  templateBehind: 0,
  ...over,
});

/** 悬停表格区域（表头 → 快捷操作栏之间）。 */
function tableRegion(tooltip: string): string {
  const start = tooltip.indexOf('| 项目 | 状态 |');
  const end = tooltip.indexOf('━━━ 快捷操作');
  assert.ok(start > -1, 'table header present');
  assert.ok(end > start, 'quick actions bar present after the table');
  return tooltip.slice(start, end);
}

describe('statusChip（C 块：三档同源 + 悬停预算）', () => {
  it('芯片：紧凑一句 + 点击开监控卡', () => {
    const s = chipSpec(projectModel())!;
    assert.ok(s.text.includes('HeT 87'));
    assert.strictEqual(s.command, 'het.chipOverview');
  });

  it('悬停 = 5 条域行，行名与 rail 定名一致、顺序一致（含 工程健康 不是行）', () => {
    const s = chipSpec(projectModel())!;
    assert.ok(s.tooltip.includes('| 项目 | 状态 |'));
    const rows = ['环境车道', '构建验证', '模块文档', '质量安全', '交付发布'];
    let last = -1;
    for (const label of rows) {
      const at = s.tooltip.indexOf(`| ${label} |`);
      assert.ok(at > -1, `row ${label} present`);
      assert.ok(at > last, `row order: ${label} after previous`);
      last = at;
    }
    assert.strictEqual(s.tooltip.split('| 环境车道 |').length - 1, 1, '同域多状态项合并成一行（不许重复出行）');
    assert.ok(!tableRegion(s.tooltip).includes('| 工程健康 |'), '健康分不是域行（它是横切指标）');
    assert.ok(s.tooltip.includes('工程健康 87/100'), '健康分进徽章行');
  });

  it('悬停预算（§3.6/G18）：≤5 行、≤3 主动作、≤2 导航 —— 超了直接抛错', () => {
    const items = chipStatusItems(projectModel());
    const { actions, nav } = chipHoverActions();
    const projection = hoverProjection(items, { actions, nav });
    assert.ok(projection.rows.length <= HOVER_LIMITS.rows, '行数在上限内');
    assert.strictEqual(projection.rows.length, 5, '五个域 ⇒ 五行（构建/测试同域合并）');
    assert.strictEqual(items.length, 6, '状态项比行多：构建与测试是两个项、同一行');
    assert.ok(projection.actions.length <= HOVER_LIMITS.primaryActions, `主动作 ≤ ${HOVER_LIMITS.primaryActions}`);
    assert.ok(projection.nav.length <= HOVER_LIMITS.nav, `导航 ≤ ${HOVER_LIMITS.nav}`);
    const s = chipSpec(projectModel())!;
    assert.ok(s.tooltip.includes('━━━ 快捷操作（点按即执行）━━━'), '快捷操作区在');
    assert.ok(s.tooltip.includes('\n- [🔧 检查环境]('), '动作各占一行（不许挤成一行）');
    assert.ok(s.tooltip.includes('\n- [🧹 清理构建缓存]('), '清理构建缓存（K.1）在快捷操作区');

    // 预算越界必须抛错（而不是渲染出来才发现挤成一片）。
    // 用「上限 + 1」构造，而不是硬编码数量 —— 否则上限一改（如导航从 2 收到 1），
    // 这条断言就会变成"没超也能过"，门禁静默失效。
    const tooMany = Array.from({ length: HOVER_LIMITS.primaryActions + 1 }, (_, i) => ({
      id: `a${i}`,
      label: `a${i}`,
      command: `het.a${i}`,
      kind: 'primary' as const,
    }));
    assert.throws(
      () => hoverProjection(items, { actions: tooMany, nav: [] }),
      StatusItemError,
      `${tooMany.length} 个主动作必须抛错（上限 ${HOVER_LIMITS.primaryActions}）`,
    );
    const tooManyNav = Array.from({ length: HOVER_LIMITS.nav + 1 }, (_, i) => ({
      id: `n${i}`,
      label: `n${i}`,
      command: `het.n${i}`,
      kind: 'nav' as const,
    }));
    assert.throws(
      () => hoverProjection(items, { actions, nav: tooManyNav }),
      StatusItemError,
      `${tooManyNav.length} 个导航必须抛错（上限 ${HOVER_LIMITS.nav}）`,
    );
  });

  it('状态格只放结论 + 结果入口；执行动作只在快捷操作区', () => {
    const fail = chipSpec(projectModel({ lastBuildOk: false, test: { passed: 4, failed: 3, skipped: 0 } }))!;
    const table = tableRegion(fail.tooltip);
    assert.ok(table.includes('❌ 失败'), '构建失败是结论');
    assert.ok(table.includes('command:het.openBuildOutput'), '输出入口');
    assert.ok(table.includes('command:het.showTestResults'), '测试结果入口');
    for (const word of ['检查环境', '清理构建缓存', '编译打包']) {
      assert.ok(!table.includes(word), `状态格不许出现执行动作「${word}」`);
    }
  });

  it('入口类链接保留（文档产物 / 覆盖率报告）', () => {
    const ok = chipSpec(projectModel({ docs: 'ok', docsDoxygen: true, docsSphinx: true }))!;
    assert.ok(ok.tooltip.includes('command:het.openDocsArtifact?%22doxygen%22'));
    assert.ok(ok.tooltip.includes('command:het.openDocsArtifact?%22sphinx%22'));
    const cov = chipSpec(projectModel({ coverageEnabled: true, coverageFound: true, coverageLine: 76.9, coverageFunc: 66.7 }))!;
    assert.ok(cov.tooltip.includes('✅ 行 76.9% · 函数 66.7%'));
    assert.ok(cov.tooltip.includes('command:het.openCoverageReport'));
  });

  it('K.1 缓存数字进环境车道行（>1 个架构要显式说出来），动作仍在快捷操作区', () => {
    const s = chipSpec(projectModel({ cache: { sizeText: '12.4 GB', archs: 3, lastCleanAgo: '2 天前' } }))!;
    const envRow = tableRegion(s.tooltip).split('\n').find((l) => l.includes('| 环境车道 |')) ?? '';
    assert.ok(envRow.includes('缓存 12.4 GB'), '缓存体积要对用户可见（这是"高频刚需"的前提）');
    assert.ok(envRow.includes('3 个架构并存'), '多架构并存要明说（今天 armv7、明天 v8 的存储顾虑）');
    assert.ok(envRow.includes('上次清理 2 天前'));
    assert.ok(!envRow.includes('command:het.cacheClean'), '清理是动作 → 只在快捷操作区');
    assert.ok(!chipSpec(projectModel({ cache: null }))!.tooltip.includes('缓存 '), '没有缓存事实时不许编数字');
  });

  it('§F.35 忙时 chip 说"正在做什么"，不说分数、更不许飘红', () => {
    const s = chipSpec(projectModel({ running: '构建中', runningAction: 'build', lastBuildOk: false, health: 42 }))!;
    assert.strictEqual(s.text, '$(sync~spin) HeT 构建中');
    assert.ok(!s.text.includes('42'), '忙的时候不给历史分数');
    assert.strictEqual(s.color, undefined, 'chip 不因"上次失败"变红');
  });

  it('§F.35 忙的域只表达"进行中"（不与上次失败并列）；别的域保持真实历史', () => {
    const s = chipSpec(projectModel({ running: '构建中', runningAction: 'build', lastBuildOk: false }))!;
    const buildRow = tableRegion(s.tooltip).split('\n').find((l) => l.includes('| 构建验证 |')) ?? '';
    assert.ok(buildRow.includes('$(sync~spin) 进行中'), `构建在跑就该说进行中：${buildRow}`);
    assert.ok(!buildRow.includes('❌ 失败'), '不许把"正在跑"写成"失败"（实测反馈最刺眼的一处）');

    const t = chipSpec(
      projectModel({ running: '测试中', runningAction: 'test', lastBuildOk: false, test: { passed: 7, failed: 0, skipped: 1 } }),
    )!;
    const rows = tableRegion(t.tooltip);
    assert.ok(rows.includes('$(sync~spin) 进行中'), '测试在跑 → 该行进行中');
    assert.ok(rows.includes('❌ 失败'), '构建仍显示真实的历史失败（别的域不被牵连）');
  });

  it('环境检查是秒级动作，不抢芯片（但该行要显示进行中）', () => {
    const s = chipSpec(projectModel({ running: '检查环境', runningAction: 'envCheck' }))!;
    assert.ok(!s.text.includes('检查环境'), '芯片不被秒级动作抢走');
    assert.ok(tableRegion(s.tooltip).includes('$(sync~spin) 进行中'));
  });

  it('工程健康：徽章显示分数与评级；可提升项在提示行里，重新体检是链接', () => {
    const good = chipSpec(projectModel({ healthVerdict: '良好', healthGaps: [] }))!;
    assert.ok(good.tooltip.includes('工程健康 87/100 · 良好'));
    assert.ok(!good.tooltip.includes('可提升'));
    const weak = chipSpec(projectModel({ health: 62, healthVerdict: '需改进', healthGaps: ['尚未构建', '覆盖率未开'] }))!;
    assert.ok(weak.tooltip.includes('可提升：尚未构建 · 覆盖率未开'));
    assert.ok(weak.tooltip.includes('command:het.healthCheck'), '重新体检可点（但不占主动作额度）');
    assert.ok(!tableRegion(weak.tooltip).includes('尚未构建'), '缺口文案不许撑破表格');
  });

  it('模板同步：落后时说清几个提交，一致时说"与参考一致"', () => {
    assert.ok(chipSpec(projectModel({ templateBehind: 2 }))!.tooltip.includes('可更新 2 个提交'));
    assert.ok(chipSpec(projectModel())!.tooltip.includes('与参考一致'));
  });

  it('is invisible without a project (monitoring only)', () => {
    assert.strictEqual(
      chipSpec({ projectName: '', health: null, running: null, lastBuildOk: null, test: null, templateBehind: 0 }),
      null,
    );
  });
});
