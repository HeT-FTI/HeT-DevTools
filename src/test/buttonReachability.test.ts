/**
 * **按钮可达性契约**（F.31：被真实反馈咬出来的门禁）。
 *
 * 背景（2026-09-20，同事在 Linux 上实测）：
 * 「仪表盘中除了与 Copilot 相关的按钮，其余按钮点击没反应。」
 * 根因不是接线没写，而是**发射端与处理端的属性契约断了**：
 *   · 卡片渲染器只发了 `data-act="build"`，**没有 `data-action`**；
 *   · 而点击处理器的分支是 `var btn = el.closest('[data-action]'); if (!btn) return;`
 *   → 所有卡片按钮在**第一行就 return**，永远到不了 `act === 'act'` 那段。
 * Copilot 按钮用的是另一条分支（`data-copilot`，先判），所以只有它活着 —— 现象完全对上。
 *
 * 为什么原来的测试没拦住：它们断言的是**发射**（`html.includes('data-act="test"')`）与
 * **协议字段**（host 侧消息形状），从来没人把"渲染出来的 DOM"与"脚本的选择器"对起来。
 * 所以这里做三件事：
 *   1. 把页面里的 `<script>` 剥掉（脚本里到处是这些属性名的字面量，不剥就是自伤）；
 *   2. 逐个按钮查**能不能被某个分支接住**；
 *   3. 查**动作 id 在 host 那边认不认得**（`COMMAND_FOR_ACTION`）—— 齿轮曾经发 `settings`
 *      而表里只有 `openSettings`，于是"点了没反应"且没有任何报错。
 *
 * 这套规则对**两个壳**都跑：驾驶舱（`data-act` + `data-action="act"`）与 HUD（`data-action=命令 id`）。
 */
import * as assert from 'node:assert';
import { initialCockpitState } from '../features/cockpit/state';
import { cockpitSinglePageHtml, cardRowHtml } from '../features/cockpit/singlepage/shell';
import { EMPTY_FACTS, singlePageModelFrom } from '../features/cockpit/singlepage/modelFrom';
import { COMMAND_FOR_ACTION, commandForAction } from '../features/cockpit/singlepage/actions';
import { type HudModel, defaultHudActions, hudHtml } from '../features/hud/hudModel';

/** 剥掉 `<script>…</script>`：脚本里满是属性名字面量，不剥会把"检查"本身当成页面元素。 */
function stripScripts(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, '');
}

/** 页面里所有"可点"的标签（带三个交互属性之一），已剥掉脚本区。 */
function clickableTags(html: string): string[] {
  return [...stripScripts(html).matchAll(/<[a-z]+\b[^>]*>/gi)]
    .map((m) => m[0])
    .filter((t) => /\bdata-(act|action|copilot)=/.test(t));
}

const attrOf = (tag: string, name: string): string | undefined =>
  new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];

const hasClass = (tag: string, cls: string): boolean =>
  (attrOf(tag, 'class') ?? '').split(/\s+/).includes(cls);

function hudModel(): HudModel {
  return {
    title: 'mylib2',
    health: 92,
    running: null,
    lastBuildOk: true,
    test: { passed: 7, failed: 0, skipped: 1 },
    coverage: 87,
    buildAgo: '3 分钟前',
    provider: { label: 'Linux · 托管车道', coverage: 'full' },
    runtime: 'conan 2.32',
    env: [
      { label: 'conan', value: '2.32', tone: 'ok', path: '~/x/conan', action: 'het.envPrepare', actionLabel: '准备环境' },
      { label: 'lcov', value: '可选', tone: 'plain' },
    ],
    actions: defaultHudActions(),
    templateBehind: 0,
  };
}

describe('按钮可达性（F.31：发射端 ↔ 处理端契约）', () => {
  const cockpit = cockpitSinglePageHtml(singlePageModelFrom(initialCockpitState(), EMPTY_FACTS));

  it('驾驶舱：每个卡片按钮都带 `data-action="act"`（否则处理端第一行就 return）', () => {
    const tags = clickableTags(cockpit);
    assert.ok(tags.length >= 15, `扫到的可点元素太少（${tags.length}）→ 门禁本身失效了`);

    const withAct = tags.filter((t) => attrOf(t, 'data-act') !== undefined);
    assert.ok(withAct.length >= 10, `带 data-act 的按钮太少（${withAct.length}）`);
    const dead = withAct.filter((t) => attrOf(t, 'data-action') !== 'act');
    assert.deepStrictEqual(
      dead,
      [],
      `这些按钮只有 data-act、没有 data-action="act" → 点了没反应：\n${dead.join('\n')}`,
    );
  });

  it('驾驶舱：每个动作 id 在 host 的命令表里都认得（齿轮曾发 `settings`）', () => {
    const ids = clickableTags(cockpit)
      .map((t) => attrOf(t, 'data-act'))
      .filter((x): x is string => x !== undefined);
    const unknown = [...new Set(ids)].filter((id) => commandForAction(id) === undefined);
    assert.deepStrictEqual(
      unknown,
      [],
      `这些动作 id 没在 COMMAND_FOR_ACTION 里登记 → 点下去静默丢弃：${unknown.join('、')}`,
    );
    assert.ok(Object.keys(COMMAND_FOR_ACTION).length >= 15, '命令表本身不该被掏空');
  });

  it('驾驶舱：分支要的参数一个都不能少（toggle/jump 必须有 data-section，act 必须有 data-act）', () => {
    const known = new Set(['toggle', 'jump', 'act', 'slot-close']);
    for (const t of clickableTags(cockpit)) {
      const action = attrOf(t, 'data-action');
      if (action === undefined) {
        continue; // Copilot 分支（data-copilot）在先，不需要 data-action
      }
      assert.ok(known.has(action), `出现脚本接不住的 data-action="${action}"（拼写/新增分支没接）`);
      if (action === 'toggle' || action === 'jump') {
        assert.ok(attrOf(t, 'data-section'), `data-action="${action}" 少了 data-section → 分支里 return`);
        assert.strictEqual(attrOf(t, 'data-act'), undefined, 'toggle/jump 不该带 data-act（会误导阅读）');
      }
      if (action === 'act') {
        assert.ok(attrOf(t, 'data-act'), 'data-action="act" 少了 data-act → 分支里 return');
      }
    }
  });

  it('Copilot 按钮走的是另一条分支：值是 `/het-*` 入口，且不带 data-act', () => {
    const cps = clickableTags(cockpit).filter((t) => attrOf(t, 'data-copilot') !== undefined);
    assert.ok(cps.length >= 3, `Copilot 入口不该少（现在 ${cps.length} 个）`);
    for (const t of cps) {
      assert.match(attrOf(t, 'data-copilot')!, /^\/het-[a-z]+$/u, '必须是模板里的 /het-* 斜杠命令');
      assert.strictEqual(attrOf(t, 'data-act'), undefined, 'Copilot 按钮不该再带 data-act（两条分支会打架）');
    }
  });

  it('HUD 用命令协议：卡片按钮发的是命令 id，不是动作 id、也不该出现 data-act', () => {
    const hud = hudHtml(hudModel(), 13.5);
    const tags = clickableTags(hud);
    assert.ok(tags.length >= 3, `HUD 可点元素太少（${tags.length}）`);
    assert.deepStrictEqual(
      tags.filter((t) => attrOf(t, 'data-act') !== undefined),
      [],
      'HUD 的脚本把 data-action 的值直接当命令 post → 不许出现 data-action="act" / data-act',
    );
    assert.deepStrictEqual(
      tags.filter((t) => attrOf(t, 'data-copilot') !== undefined),
      [],
      'HUD 没有 Copilot 分支（单会话守卫只在驾驶舱）→ 不许在 HUD 里发 Copilot 按钮',
    );
    for (const t of tags) {
      const action = attrOf(t, 'data-action') ?? '';
      assert.match(action, /^het\.[A-Za-z]+$/u, `HUD 只接受规范命令 id，收到「${action}」`);
    }
  });

  it('同一个发射器喂两个壳：协议参数必须显式选（否则 HUD 会把 `act` 当命令跑）', () => {
    const model = singlePageModelFrom(initialCockpitState(), EMPTY_FACTS);
    const first = model.cards.find((c) => c.action);
    assert.ok(first, '模型里至少要有一张带动作的卡');
    assert.ok(cardRowHtml(first!).includes('data-action="act"'), '默认（驾驶舱协议）');
    assert.ok(cardRowHtml(first!, 'command').includes('data-action="het.'), 'command 协议要给命令 id');
    assert.ok(!cardRowHtml(first!, 'command').includes('data-act='), 'command 协议不该再发 data-act');
  });

  it('次级按钮同样是活的（`class="secondary"` 不影响可达性）', () => {
    const tags = clickableTags(cockpit).filter((t) => hasClass(t, 'secondary'));
    assert.ok(tags.length >= 1, '模型里有次级按钮（如「移除…」）');
    for (const t of tags) {
      const ok = attrOf(t, 'data-copilot') !== undefined || attrOf(t, 'data-action') !== undefined;
      assert.ok(ok, `次级按钮不可达：${t}`);
    }
  });
});
