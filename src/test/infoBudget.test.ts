/**
 * L1 信息预算门禁（V3 计划 §6.0 / G11 / G12）。
 *
 * 这是把用户的硬约束（P7/P8）变成**可执行**的地方：
 * - 每张卡必须声明显示条件（`show`）；
 * - 副标题有字数额度，**只许减不许增**；
 * - 副标题里不许出现内部机制词；
 * - 空事实不渲染占位符。
 */
import * as assert from 'assert';
import {
  ABS_SUB_CEILING,
  INTERNAL_WORDS,
  SUB_CEILING,
  SUB_QUOTA,
  factText,
  subtitleBudgetViolations,
  subtitleViolations,
} from '../features/cockpit/singlepage/infoBudget';
import { SECTIONS } from '../features/cockpit/singlepage/sections';
import { CAPABILITY_LABELS } from '../core/capability';

const cards = SECTIONS.flatMap((s) => s.cards);

describe('L1 · 信息预算（P7：UI 显示是有代价的）', () => {
  it('每张卡都必须声明显示条件（`always` 或真实能力 id）', () => {
    for (const c of cards) {
      assert.ok(c.show !== undefined, `${c.id}: 缺少 show 声明（新增卡必须回答"什么时候显示"）`);
      if (c.show !== 'always') {
        assert.ok(Array.isArray(c.show) && c.show.length > 0, `${c.id}: show 要么是 'always'、要么是非空能力数组`);
        for (const id of c.show) {
          assert.ok(id in CAPABILITY_LABELS, `${c.id}: show 引用了不存在的能力 id「${id}」`);
        }
      }
    }
  });

  it('副标题字数额度：额度表与卡片**双向对账**，且额度只许减不许增', () => {
    const ids = cards.map((c) => c.id).sort();
    const quotaIds = Object.keys(SUB_QUOTA).sort();
    assert.deepStrictEqual(ids, quotaIds, '额度表必须与卡片集合完全一致（多了=废弃条目，少了=没设上限）');
    for (const [id, quota] of Object.entries(SUB_QUOTA)) {
      assert.ok(quota > 0 && quota <= ABS_SUB_CEILING, `${id}: 额度 ${quota} 不合法（1..${ABS_SUB_CEILING}）`);
      assert.strictEqual(Number.isInteger(quota), true, `${id}: 额度必须是整数`);
    }
    assert.strictEqual(SUB_CEILING, 32, '新卡默认上限 = 一句话说清"这卡跑的是哪条链"');
    assert.deepStrictEqual(subtitleBudgetViolations(cards), [], '现有卡片必须全部在额度内');
  });

  it('副标题里不许出现内部机制词（G12：别把"我们内部怎么做"讲给用户）', () => {
    for (const word of INTERNAL_WORDS) {
      assert.strictEqual(subtitleViolations('probe', `这是${word}测试`).length, 1, `词表必须真的能拦住「${word}」`);
    }
    for (const c of cards) {
      assert.deepStrictEqual(subtitleViolations(c.id, c.sub), [], `${c.id}: 副标题含内部机制词或超预算`);
    }
  });

  it('**弄红自证**：加长一个副标题 / 塞一个内部词，门禁必须红', () => {
    const long = subtitleViolations('health', 'x'.repeat(SUB_QUOTA.health + 1));
    assert.strictEqual(long.length, 1, '超一个字就应该红');
    assert.match(long[0], /额度/u);
    const leak = subtitleViolations('health', '依赖双写一致性检查');
    assert.strictEqual(leak.length, 1, '出现内部词就应该红');
    assert.match(leak[0], /内部机制词/u);
    // 额度表里没有的卡按新卡上限（不许"忘了设上限"变成无限）
    assert.strictEqual(subtitleViolations('brand-new-card', 'x'.repeat(SUB_CEILING)).length, 0);
    assert.strictEqual(subtitleViolations('brand-new-card', 'x'.repeat(SUB_CEILING + 1)).length, 1);
  });

  it('空事实不渲染：占位符/空串 → null（占一格视觉位置却零信息）', () => {
    assert.strictEqual(factText('—'), null);
    assert.strictEqual(factText('-'), null);
    assert.strictEqual(factText(''), null);
    assert.strictEqual(factText('   '), null);
    assert.strictEqual(factText(undefined), null);
    assert.strictEqual(factText(null), null);
    assert.strictEqual(factText('3 个文件未提交'), '3 个文件未提交');
    assert.strictEqual(factText(' 84 · 2 项建议 '), '84 · 2 项建议', '去首尾空白，不改内容');
  });
});
