import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HealthReport } from '../core/healthCheck';
import { healthBodyHtml, healthBusyHtml, healthPageHtml } from '../features/health/html';

const read = (p: string): string => readFileSync(join('src', p), 'utf8');

const report: HealthReport = {
  score: 82,
  verdict: 'WARN',
  checks: [
    { id: 'build', title: '构建通过', kind: 'ok', detail: '最近一次构建成功', weight: 20 },
    {
      id: 'coverage',
      title: '覆盖率达标',
      kind: 'warn',
      detail: '行覆盖 61%',
      suggestion: '把 include/ 里的分支用例补起来',
      weight: 20,
      grade: 0.5,
    },
    { id: 'docs', title: '文档生成', kind: 'fail', detail: '缺 doxygen', weight: 10 },
  ],
} as never;

describe('§F.45 工程健康明细（迁入细节页签）', () => {
  it('有报告：健康分 + 逐项 + 建议都在，分级打分照旧', () => {
    const html = healthBodyHtml(report);
    assert.ok(html.includes('82/100'), '健康分');
    assert.ok(html.includes('需改进'), 'verdict 要给人话');
    assert.ok(html.includes('构建通过'));
    assert.ok(html.includes('20/20'), 'ok 项给满权重');
    assert.ok(html.includes('10/20'), 'grade 0.5 的项要给一半（细粒度分级）');
    assert.ok(html.includes('0/10'), 'fail 项给 0');
    assert.ok(html.includes('建议：把 include/ 里的分支用例补起来'), '建议要显示');
    assert.ok(html.includes(`${report.checks.length} 项规则`), '项数来自报告，不写死');
  });

  it('没报告：说清"还没体检"并给出入口（不是空白页）', () => {
    const html = healthBodyHtml(null);
    assert.ok(html.includes('尚未体检'));
    assert.ok(html.includes('data-action="rerun"'), '要有体检入口');
  });

  it('体检中：有明确的进行中提示（终态之间不能啥都不说）', () => {
    assert.ok(healthBusyHtml().includes('体检中'));
    assert.ok(healthBodyHtml(report, true).includes('体检中'));
  });

  it('页面：不整页重渲（只替换 #body）、不用 onclick=、rerun 有处理分支', () => {
    const html = healthPageHtml(report);
    assert.ok(html.includes('id="body"'), '要有可局部替换的锚点');
    assert.ok(html.includes("m.type !== 'health'"), '监听宿主 health 消息');
    assert.ok(!/onclick=/u.test(html), '不许用 inline onclick（F.31 同源错法）');
    const acts = [...html.matchAll(/data-action="([^"]+)"/gu)].map((m) => m[1]);
    assert.deepStrictEqual([...new Set(acts)], ['rerun']);
    assert.ok(html.includes("btn.getAttribute('data-action')"), '走事件委托');
    const panel = read('features/health/panel.ts');
    assert.ok(panel.includes('showDetailPanel('), '必须走细节页签');
    const assigns = panel.match(/webview\.html\s*=/gu) ?? [];
    assert.strictEqual(assigns.length, 1, '整页渲染只允许首帧一次');
    assert.ok(panel.includes("type: 'health'"), '刷新走局部消息');
    assert.ok(/finally \{/u.test(panel), 'rerun 失败也要收尾（不许把"体检中…"留在页面上）');
  });

  it('细节页签是唯一持有者：扩展里不再自己开体检页签', () => {
    const ext = read('extension.ts');
    const healthBlock = ext.slice(ext.indexOf("registerCommand('het.healthReport'"), ext.indexOf("registerCommand('het.healthReport'") + 400);
    assert.ok(healthBlock.includes('showHealthReportPanel(context'), '命令要打开细节页签');
    assert.ok(!/createWebviewPanel\('het\.healthReport'/u.test(ext), '不再自己开页签');
    assert.ok(!/let healthPanel\b/u.test(ext), '旧的单例变量要删掉');
  });
});
