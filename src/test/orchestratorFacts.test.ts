/**
 * V3 · L4 / G10 门禁：**总编排不许 0 引用**。
 *
 * 计划 §6 表格 G10 的原文：「总编排不可见 … 门禁：workflow 与 Intent 对账表里必须出现
 * （现在 0 引用）」。所以这里把"对账"做成可测的三句话：
 *   1. 模板里**每个** workflow 文件都登记了"它在界面上由谁呈现"（漏一个 → 红）；
 *   2. 登记为 `intent:<id>` 的，那条 Intent 的 `ci.workflow` **必须**等于本行文件（不许张冠李戴）；
 *   3. 登记为 `card:<id>` 的，那张卡真的存在（`ci-orchestrator.yml` 走的就是这条 —— 新增卡）。
 */
import * as assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  WORKFLOW_SURFACES,
  orchestratorFactOf,
  parseOrchestrator,
  parseWorkflowJobs,
  surfaceViolations,
} from '../core/orchestratorFacts';
import { INTENTS, intentFor } from '../core/intents';
import { allCards } from '../features/cockpit/singlepage/sections';

const WF_DIR = join('assets', 'template', '.github', 'workflows');
const templateFiles = readdirSync(WF_DIR).filter((f) => /\.ya?ml$/u.test(f)).sort();
const orchestratorText = readFileSync(join(WF_DIR, 'ci-orchestrator.yml'), 'utf8');

describe('L4 · CI 总编排（G10：一次 push 跑什么，要看得见）', () => {
  it('解析入口 workflow：job 清单**保序**，触发事件来自 `on:`', () => {
    const o = parseOrchestrator(orchestratorText);
    assert.strictEqual(o.name, 'CI Orchestrator');
    assert.ok(o.triggers.includes('push') && o.triggers.includes('pull_request'), o.triggers.join('/'));
    assert.ok(o.jobs.length >= 8, `job 数看起来不对：${o.jobs.length}`);
    assert.strictEqual(o.jobs[0].id, 'controller', '文件里的顺序就是编排顺序，不许重排');
    assert.ok(o.jobs.some((j) => j.id === 'cross-compile'));
    // `name:` 抓得到（屏幕上给的是人话名）
    assert.strictEqual(o.jobs.find((j) => j.id === 'controller')?.name, 'Analyze Metadata');
  });

  it('解析器对"不是 jobs 段的内容"免疫（on/env/permissions 里的键不算 job）', () => {
    const text = ['name: X', 'on:', '  push:', '    branches: [main]', 'permissions:', '  contents: read', 'jobs:', '  a:', '    runs-on: ubuntu-latest', '  b:', '    name: Bee', '    runs-on: ubuntu-latest', 'x-top: 1'].join('\n');
    assert.deepStrictEqual(parseWorkflowJobs(text), [{ id: 'a' }, { id: 'b', name: 'Bee' }]);
    assert.deepStrictEqual(parseWorkflowJobs('name: 没有 jobs 段\n'), []);
  });

  it('事实行：`N 个 job · 触发事件`，读不到就如实说为什么', () => {
    const view = orchestratorFactOf(parseOrchestrator(orchestratorText));
    assert.strictEqual(view.state, 'idle', '编排是静态知识，不是运行结果 —— 不许给绿色');
    assert.match(view.fact, /^\d+ 个 job · push\/pull_request$/u);
    assert.match(view.next ?? '', /第一个 job：Analyze Metadata/u);

    const missing = orchestratorFactOf(null);
    assert.strictEqual(missing.fact, '—');
    assert.ok(missing.next?.includes('ci-orchestrator.yml'), '要说清在哪找');
  });

  it('**G10 对账**：模板里每个 workflow 都有落点，且落点是真的', () => {
    assert.deepStrictEqual(surfaceViolations(templateFiles), [], '漏登记 / 幽灵条目 / 未落地都算红');

    for (const s of WORKFLOW_SURFACES) {
      if (s.surface?.startsWith('intent:')) {
        const id = s.surface.slice('intent:'.length);
        const it = intentFor(id);
        assert.ok(it, `${s.file} 登记的 Intent ${id} 不存在`);
        assert.strictEqual(it?.ci?.workflow, s.file, `${s.file} 与 Intent ${id} 的 ci.workflow 对不上`);
      }
      if (s.surface?.startsWith('card:')) {
        const id = s.surface.slice('card:'.length);
        assert.ok(allCards().some((c) => c.id === id), `${s.file} 登记的卡片 ${id} 不存在`);
      }
    }

    // 这条就是 G10 的"0 引用 → 有引用"：入口 workflow 必须有卡 + 有入口动作
    const orch = WORKFLOW_SURFACES.find((s) => s.file === 'ci-orchestrator.yml');
    assert.strictEqual(orch?.surface, 'card:orchestrator', '入口 workflow 必须由卡片呈现');
    const card = allCards().find((c) => c.id === 'orchestrator');
    assert.strictEqual(card?.action?.id, 'openOrchestrator', '卡片必须能给到原文入口');
    const nav = INTENTS.find((i) => i.command === 'het.openOrchestrator');
    assert.ok(nav, '`het.openOrchestrator` 必须在 Intent 表里（否则点了没反应）');

    // 还没落地的只许有一个，且必须写明哪个块补
    const pending = WORKFLOW_SURFACES.filter((s) => s.surface === null);
    assert.ok(pending.length <= 1, `未落地的条目太多：${pending.map((p) => p.file).join('、')}`);
    for (const p of pending) {
      assert.ok(p.pending, `${p.file}: 还没落地就要写明哪个块补`);
    }
    // `'none'` = "确实不该有界面落点"，必须写清为什么（否则就是"懒得接"的垃圾桶）
    const none = WORKFLOW_SURFACES.filter((s) => s.surface === 'none');
    assert.ok(none.length <= 2, `"没有落点"的条目太多了（当成垃圾桶了）：${none.map((n) => n.file).join('、')}`);
    for (const n of none) {
      assert.ok(n.note.length > 12, `${n.file}: 说"不该有落点"要给出理由`);
      assert.strictEqual(n.pending, undefined, `${n.file}: 不该同时写 pending`);
    }
  });

  it('**弄红自证**：新增一个 workflow 不登记 / 删掉登记条目 → 门禁红', () => {
    const added = surfaceViolations([...templateFiles, 'brand-new.yml']);
    assert.strictEqual(added.length, 1);
    assert.match(added[0], /brand-new\.yml/u);
    assert.match(added[0], /没登记/u);

    const stale = surfaceViolations(templateFiles.filter((f) => f !== 'docs-build.yml'));
    assert.strictEqual(stale.length, 1);
    assert.match(stale[0], /幽灵条目/u);
  });
});
