/**
 * L1 阶段带（Spine）门禁（V3 计划 §4.1 / §7.1）。
 *
 * 三条硬约束：
 * 1. **结构重排不许丢卡**：8 站卡片并集 ∪ 非站卡片 = `SECTIONS` 全部卡片（双向对账）；
 * 2. **站状态只能聚合自卡片**（不许自己读事实，否则会出现"站说绿、卡说红"）；
 * 3. **"下一步"只有一条来源**（第一个未完成站的第一个有主动作的卡）。
 */
import * as assert from 'assert';
import {
  NON_SPINE_CARD_IDS,
  PLANNED_CAPABILITY_CONSUMERS,
  SPINE_STATIONS,
  cardVisible,
  hiddenCards,
  spineFrom,
  spineNextStep,
  spineOf,
  stationOfCard,
  stationState,
  visibleCards,
} from '../features/cockpit/singlepage/spine';
import { SECTIONS, allCards } from '../features/cockpit/singlepage/sections';
import { deriveCapabilities } from '../core/capability';
import type { CardAction, CardRow, CardState } from '../features/cockpit/singlepage/model';

function card(id: string, state: CardState, action?: CardAction, show: CardRow['show'] = 'always'): CardRow {
  return {
    id,
    tab: 'overview',
    label: id,
    state,
    fact: '—',
    stage: 'inline',
    lazy: false,
    show,
    ...(action ? { action } : {}),
  };
}

describe('L1 · 阶段带（spine）', () => {
  it('8 站、顺序连续 1..8、每站都有卡且站内无重复', () => {
    assert.strictEqual(SPINE_STATIONS.length, 8, '必须恰好 8 站（用户已拍板）');
    assert.deepStrictEqual(
      SPINE_STATIONS.map((s) => s.order),
      [1, 2, 3, 4, 5, 6, 7, 8],
      'order 必须连续且等于动作顺序',
    );
    const seen = new Set<string>();
    for (const s of SPINE_STATIONS) {
      assert.ok(s.cards.length > 0, `${s.id}: 空站不许存在（没有卡的站 = 没用的格子）`);
      assert.ok(s.label.length <= 4, `${s.id}: 站名「${s.label}」超过 4 字（横排会挤）`);
      for (const id of s.cards) {
        assert.ok(!seen.has(id), `${id} 被两个站同时认领`);
        seen.add(id);
      }
    }
  });

  it('**不许丢卡**：站的卡片 ∪ 非站卡片 = 卡片注册表全部卡片（双向）', () => {
    const spineIds = SPINE_STATIONS.flatMap((s) => [...s.cards]);
    const all = allCards().map((c) => c.id);
    const union = [...spineIds, ...NON_SPINE_CARD_IDS];
    assert.deepStrictEqual([...union].sort(), [...all].sort(), '重排后卡片集合必须与定义完全一致');
    assert.strictEqual(new Set(union).size, union.length, '卡片不得重复归属');
    // 反向：每个站的 card id 都必须是真实存在的卡（防止拼错 id 静默丢卡）
    const real = new Set(all);
    for (const id of spineIds) {
      assert.ok(real.has(id), `站里引用了不存在的卡：${id}`);
    }
  });

  it('每张卡都能查到它属于哪一站（悬停/深链要用；设置卡例外）', () => {
    for (const id of allCards().map((c) => c.id)) {
      const station = stationOfCard(id);
      if (NON_SPINE_CARD_IDS.includes(id)) {
        assert.strictEqual(station, undefined, `${id} 不该属于任何站（它是设置）`);
      } else {
        assert.ok(station, `${id} 查不到属地`);
      }
    }
  });

  it('站状态 = 卡片状态的聚合：fail > warn > running > ok；无信息时才回落 idle/na', () => {
    assert.strictEqual(stationState(['ok', 'ok']), 'ok');
    assert.strictEqual(stationState(['ok', 'warn']), 'warn', '一黄就黄');
    assert.strictEqual(stationState(['warn', 'fail']), 'fail', '一红就红');
    assert.strictEqual(stationState(['idle', 'ok']), 'ok', '没跑过不压过跑过');
    assert.strictEqual(stationState(['idle', 'idle']), 'idle');
    assert.strictEqual(stationState(['na', 'idle']), 'idle');
    assert.strictEqual(stationState(['na', 'na']), 'na');
    assert.strictEqual(stationState([]), 'na', '空站按"不适用"处理，不冒充绿');
    assert.strictEqual(stationState(['na', 'running']), 'running', '正在跑要压过 ok');
  });

  it('spineFrom：只算真实存在的卡（能力显隐后站内卡片会变少）', () => {
    const cards = [card('health', 'ok'), card('env', 'warn')];
    const spine = spineFrom(cards);
    const ready = spine.find((s) => s.id === 'ready');
    assert.deepStrictEqual(ready?.cards, ['health', 'env'], '不存在的卡不许出现在站里');
    assert.strictEqual(ready?.state, 'warn');
    const build = spine.find((s) => s.id === 'build');
    assert.deepStrictEqual(build?.cards, [], '一张卡都没有的站 = 空站');
    assert.strictEqual(build?.state, 'na', '空站不许显示成 ok');
  });

  it('"下一步" = 第一个未完成站里第一张有主动作的卡；全绿时没有下一步', () => {
    const cards = [
      card('health', 'ok'),
      card('env', 'ok'),
      card('lane', 'ok'),
      card('network', 'ok'),
      card('moduleAgent', 'ok'),
      card('moduleWizard', 'ok'),
      card('deps', 'ok', { id: 'openDeps', label: '打开依赖管理器', kind: 'action' }),
      card('buildTest', 'ok', { id: 'build', label: '编译打包', kind: 'action' }),
      card('testFull', 'fail', { id: 'test', label: '全量测试', kind: 'action' }),
    ];
    const spine = spineFrom(cards);
    const next = spineNextStep(spine, cards);
    assert.strictEqual(next?.station, 'test', '应该是第一个未完成的站');
    assert.strictEqual(next?.cardId, 'testFull');
    assert.strictEqual(next?.action.id, 'test');

    // 全绿 → 没有下一步（不许硬编一句"下一步：继续"）
    const allOk = cards.map((c) => (c.id === 'testFull' ? { ...c, state: 'ok' as CardState } : c));
    assert.strictEqual(spineNextStep(spineFrom(allOk), allOk), undefined);
  });

  it('能力显隐：未知（undefined）→ 一张都不隐藏；已知 → 只留满足条件的', () => {
    const cards = [
      card('buildTest', 'ok'),
      card('coverageDetail', 'ok', undefined, ['coverage']),
    ];
    assert.deepStrictEqual(
      visibleCards(cards, undefined).map((c) => c.id),
      ['buildTest', 'coverageDetail'],
      '读不到 metadata 时不许隐藏任何卡（未知 ≠ 没有）',
    );
    const none = deriveCapabilities({ metadata: { name: 'x' } });
    assert.deepStrictEqual(visibleCards(cards, none).map((c) => c.id), ['buildTest'], '没有覆盖率能力 → 隐藏覆盖率卡');
    const withCov = deriveCapabilities({ metadata: { name: 'x', activate_code_coverage: true } });
    assert.deepStrictEqual(visibleCards(cards, withCov).map((c) => c.id), ['buildTest', 'coverageDetail']);

    // 多能力 = 任一满足
    const multi = card('x', 'ok', undefined, ['coverage', 'baremetal']);
    assert.ok(!cardVisible(multi, new Set()), '都不满足 → 不显示');
    assert.ok(cardVisible(multi, new Set(['baremetal'])), '满足其一 → 显示');
  });

  it('隐藏必须**可解释**：说得出缺哪个能力、怎么才能让它出现', () => {
    const cards = [
      card('buildTest', 'ok'),
      card('crossBuild', 'ok', undefined, ['cross-target']),
      card('board', 'ok', undefined, ['baremetal']),
    ];
    // 已知但没有这两个能力 → 两张卡都被藏，且各有原因/怎么出现的说法
    const caps = deriveCapabilities({ metadata: { name: 'x', activate_code_coverage: true } });
    const hidden = hiddenCards(cards, caps);
    assert.deepStrictEqual(hidden.map((h) => h.cardId), ['crossBuild', 'board']);
    assert.ok(hidden[0].reasons.includes('多目标'), `要写出缺哪个能力：${hidden[0].reasons}`);
    assert.ok(hidden[0].howTo[0].includes('交叉编译'), `要写出怎么才会出现：${hidden[0].howTo}`);
    assert.ok(hidden[1].reasons.includes('裸机'));
    // 未知（读不到 metadata）→ 不隐藏，也就没有"隐藏说明"
    assert.deepStrictEqual(hiddenCards(cards, undefined), []);
    // 有能力 → 不隐藏
    const bareCaps = deriveCapabilities({ metadata: { name: 'x', baremetal_white_list: ['etl'] }, hasBuildMatrix: true });
    assert.deepStrictEqual(hiddenCards(cards, bareCaps), []);
  });

  it('真实的卡片表：交叉编译/上板都挂在产物事实上（不是常驻）', () => {
    const byId = new Map(allCards().map((c) => [c.id, c]));
    assert.deepStrictEqual(byId.get('crossBuild')?.show, ['cross-target'], '交叉编译只在有多目标事实时出现');
    assert.deepStrictEqual(byId.get('board')?.show, ['baremetal'], '上板只在嵌入式产物上出现');
    // 反向：常驻卡片不许被"顺手"改成能力驱动（否则单目标库会少掉构建/测试/提交）
    for (const id of ['buildTest', 'testFull', 'commit', 'release', 'quality']) {
      assert.strictEqual(byId.get(id)?.show, 'always', `${id} 必须常驻`);
    }
  });

  it('能力 → 消费点登记表：不能有"没人消费的能力"（P7：推不出动作的不进界面）', () => {
    const consumed = new Set<string>();
    for (const s of SECTIONS) {
      for (const c of s.cards) {
        if (Array.isArray(c.show)) {
          for (const id of c.show) {
            consumed.add(id);
          }
        }
      }
    }
    const planned = Object.keys(PLANNED_CAPABILITY_CONSUMERS);
    const all = new Set([...consumed, ...planned]);
    for (const id of all) {
      assert.ok(
        consumed.has(id) || planned.includes(id),
        `${id} 既没有卡片消费、也没登记到哪个块落地（不许静默积压）`,
      );
    }
    for (const [id, block] of Object.entries(PLANNED_CAPABILITY_CONSUMERS)) {
      assert.strictEqual(consumed.has(id), false, `${id} 已经有卡片消费了，必须从 PLAN 表里删掉（表只许变短）`);
      assert.ok(['L3', 'L6'].includes(String(block)), `${id}: 登记的块号必须是 L3/L6（真实存在的块）`);
    }
  });

  it('spineOf：模型里已算好的阶段带直接复用（不许两处各算一遍）', () => {
    const cards = [card('health', 'ok')];
    const model = { cards, spine: spineFrom(cards) };
    assert.deepStrictEqual(spineOf(model), model.spine);
    assert.deepStrictEqual(spineOf({ cards, spine: [] }), spineFrom(cards), '模型里没有时现算（纯函数）');
  });
});
