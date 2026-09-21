import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOOL_MATRIX, localGateSummary, toolRowsFromPresence, toolSpec } from '../core/toolMatrix';
import { qualityRefreshedHtml } from '../features/quality/qualityHtml';

/**
 * §9 的工具矩阵 + 材料第 3 条后半条（「刷新状态」没作用）。
 *
 * 外部评审原话：「**要说明是否需要人为介入**；后台是自行安装的，还是需要手动安装」。
 * 所以每个工具都必须能回答三件事：**谁装**（owner）、**缺了会怎样**（ciBlocking/chain）、
 * **要不要人**（install 文案里明确"自动安装"或"需要你执行：…"）。
 */
describe('工具矩阵（§9）', () => {
  it('每个工具都能回答"谁装 / 缺了会怎样 / 要不要人"', () => {
    assert.ok(TOOL_MATRIX.length >= 12, '矩阵不能退化成空壳');
    for (const t of TOOL_MATRIX) {
      assert.ok(t.id && t.label, `${t.id} 要有 id 与标签`);
      assert.ok(t.chain, `${t.id} 要说明属于哪条链`);
      assert.match(t.install, /自动安装|需要你执行：/, `${t.id} 必须写清"自动装"还是"要人"`);
    }
    assert.strictEqual(new Set(TOOL_MATRIX.map((t) => t.id)).size, TOOL_MATRIX.length, 'id 不能重复');
  });

  it('质量面板用到的 4 个门禁工具 + 关键链工具都在矩阵里', () => {
    for (const id of ['clang-format', 'clang-tidy', 'commitlint', 'gitleaks', 'megalinter']) {
      assert.ok(toolSpec(id), `缺 ${id}`);
    }
    for (const id of ['conan', 'cmake', 'gcc', 'lcov', 'make', 'doxygen', 'graphviz', 'sphinx']) {
      assert.ok(toolSpec(id), `缺 ${id}`);
    }
    assert.strictEqual(toolSpec('nope'), undefined);
  });

  it('MegaLinter 在矩阵里是"阻塞门禁"+ Docker 提供（G14 语义一致）', () => {
    const m = toolSpec('megalinter');
    assert.ok(m);
    assert.strictEqual(m.owner, 'docker');
    assert.strictEqual(m.ciBlocking, true);
    // 允许"（不是 advisory）"这种否定表述，只禁止把它**当成** advisory
    const withoutNegation = m.install.replace(/[不非][^a-zA-Z]{0,8}advisory/gi, '');
    assert.ok(!/advisory/i.test(withoutNegation), '不得再说成 advisory');
  });

  it('探测结果 → 行视图：未探测不谎报缺失，缺失给"要不要人"', () => {
    const rows = toolRowsFromPresence({ 'clang-format': true, 'clang-tidy': false });
    const fmt = rows.find((r) => r.id === 'clang-format');
    const tidy = rows.find((r) => r.id === 'clang-tidy');
    const conan = rows.find((r) => r.id === 'conan');
    assert.strictEqual(fmt?.present, true);
    assert.strictEqual(fmt?.detail, undefined, '装了就不用给安装指引');
    assert.strictEqual(tidy?.present, false);
    assert.match(tidy?.detail ?? '', /需要你执行：/);
    assert.strictEqual(conan?.present, undefined, '未探测 = undefined（不谎报）');
    assert.strictEqual(conan?.detail, undefined);
  });

  it('本地门禁总结：缺谁、还差几个、CI 会不会拦', () => {
    const all = localGateSummary({
      'clang-format': true,
      'clang-tidy': true,
      gitleaks: true,
      megalinter: true,
      commitlint: true,
    });
    assert.strictEqual(all.ready, all.total);
    assert.deepStrictEqual(all.missing, []);
    assert.match(all.hint, /齐备/);

    const partial = localGateSummary({ 'clang-format': false, 'clang-tidy': true, gitleaks: true, megalinter: true });
    assert.strictEqual(partial.ready, partial.total - 1);
    assert.deepStrictEqual(partial.missing, ['clang-format']);
    assert.match(partial.hint, /clang-format/);
    assert.match(partial.hint, /CI 仍会拦/, '要告诉用户"本地跑不全≠CI 放过"');
  });

  it('extension.ts 的工具行确实来自矩阵（不是各写一套）', () => {
    const ext = readFileSync(join('src', 'extension.ts'), 'utf8');
    assert.ok(ext.includes('toolRowsFromPresence(presence)'), '质量面板工具行要经矩阵');
    assert.ok(ext.includes('localGateSummary('), '单页质量事实要用同一套判定');
    assert.ok(!/安装：pip install clang-format/.test(ext), '旧的散装指引应已被矩阵取代');
  });

  it('「刷新状态」有可见反馈（材料第 3 条后半条）', () => {
    const html = qualityRefreshedHtml(new Date(2026, 8, 17, 19, 12, 3));
    assert.match(html, /已刷新 · 19:12:03/, '必须给时间戳，否则用户以为按钮坏了');
    assert.match(html, /工具探测已重跑/);
    assert.ok(!html.includes('<script'), '反馈片段不带脚本（F.29 纪律）');

    const panel = readFileSync(join('src', 'features', 'quality', 'panel.ts'), 'utf8');
    assert.ok(panel.includes('qualityRefreshedHtml()'), '刷新分支要用它');
    const page = readFileSync(join('src', 'features', 'quality', 'qualityHtml.ts'), 'utf8');
    assert.ok(page.includes('刷新中…'), '按钮要有"进行中"反馈（防重复点击）');
  });
});
