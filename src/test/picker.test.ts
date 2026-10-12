/**
 * **有界选择器契约**（G11 / G12：大集合控件不许把屏幕撑爆）。
 *
 * 这个文件重点做一件以前没做过的事：**把浏览器端源码装进 Node 跑**，与 TS 侧纯函数
 * 用同一张查询表逐条对账 —— 因为"筛选语义两端各写一遍"正是最容易悄悄漂移的地方
 * （漂移后的症状是：页面里搜得到、提交时校验不过，或者反过来）。
 */
import * as assert from 'node:assert';
import {
  MATCH_PREDICATE_JS,
  PICKER_CSS,
  PICKER_DEFAULT_PAGE_SIZE,
  PICKER_PAGE_SIZES,
  TOTAL_LABEL_JS,
  assertPageSize,
  clampPage,
  itemMatches,
  pageCountOf,
  pageSlice,
  pickerHtml,
  pickerScript,
  totalLabel,
} from '../features/picker';
import { SCALE_SIZES, countRows, scalePickerItems } from './support/scale';

interface BrowserSide {
  match: (item: { label: string; note?: string }, q: string) => boolean;
  total: (n: number, q: string, noun?: string) => string;
}

/** 把 picker.ts 里的浏览器端源码装进 Node —— `new Function` 只出现在测试里，为的是两端同义。 */
function browserSide(): BrowserSide {
  const factory = new Function(
    `${MATCH_PREDICATE_JS}\n${TOTAL_LABEL_JS}\nreturn { match: pickerMatch, total: pickerTotalLabel };`,
  ) as () => BrowserSide;
  return factory();
}

describe('G. 有界选择器（筛选 / 分页 / 计数 / 键盘）', () => {
  const items = scalePickerItems(200);

  it('**两端同义**：浏览器端谓词与 TS 侧 itemMatches 在同一张查询表上逐条一致', () => {
    const js = browserSide();
    const queries = ['', '   ', 'pkg-0001', 'PKG-0001', '规模夹具', '不存在的包 xyz', '第 007 项'];
    for (const q of queries) {
      const tsHits = items.filter((it) => itemMatches(it, q)).map((it) => it.value);
      const jsHits = items.filter((it) => js.match(it, q)).map((it) => it.value);
      assert.deepStrictEqual(jsHits, tsHits, `查询「${q}」两端结果不一致 —— 页面能搜到/提交却不过`);
    }
    assert.ok(queries.some((q) => items.filter((it) => itemMatches(it, q)).length > 0));
    assert.ok(items.filter((it) => itemMatches(it, '不存在的包 xyz')).length === 0);
  });

  it('**两端同义**：命中计数文案一致（有查询说"命中"，无查询说总量）', () => {
    const js = browserSide();
    const cases: [number, string, string][] = [
      [0, '', '个包'],
      [1900, '', '个包'],
      [3, 'fmt', '个包'],
      [2000, '   ', '个包'],
      [7, '日志', '项'],
    ];
    for (const [n, q, noun] of cases) {
      assert.strictEqual(
        js.total(n, q, noun),
        totalLabel(n, q, noun),
        `计数文案两端不一致：n=${n} q=「${q}」`,
      );
    }
  });

  it('分页数学：总数/页数/切片都是"有界"的（2000 项也只渲染一页）', () => {
    const many = scalePickerItems(SCALE_SIZES.stress);
    const first = pageSlice(many, '', 0, PICKER_DEFAULT_PAGE_SIZE);
    assert.strictEqual(first.total, 2000);
    assert.strictEqual(first.pageCount, 100);
    assert.strictEqual(first.items.length, 20);
    assert.strictEqual(first.items[0].label, 'pkg-0000');

    const last = pageSlice(many, '', 99, PICKER_DEFAULT_PAGE_SIZE);
    assert.strictEqual(last.items.length, 20);
    assert.strictEqual(last.items.at(-1)!.label, 'pkg-1999');

    const clamped = pageSlice(many, '', 500, PICKER_DEFAULT_PAGE_SIZE);
    assert.strictEqual(clamped.page, 99, '越界页号要收敛到最后一页，不能空白');
    assert.strictEqual(clampPage(-3, 2000, 20), 0, '负数收敛到第一页');
    assert.strictEqual(pageCountOf(0, 20), 1, '空集合也要 1 页（避免"第 1/0 页"）');

    const filtered = pageSlice(many, 'pkg-1999', 0, 20);
    assert.strictEqual(filtered.total, 1);
    assert.strictEqual(filtered.items.length, 1);
  });

  it('分页档位是**登记制**：未登记的档位直接抛错（新增档位必须同步补规模测试）', () => {
    assert.doesNotThrow(() => assertPageSize(PICKER_DEFAULT_PAGE_SIZE));
    assert.throws(() => assertPageSize(30), /未登记的分页大小/u);
    assert.throws(() => pageSlice(items, '', 0, 1000), /未登记的分页大小/u);
  });

  it('渲染契约：滚动容器（max-height + overflow）、命中计数、分页控件、可访问性属性', () => {
    const html = pickerHtml({
      id: 'demo',
      label: '包名',
      placeholder: '搜索',
      items,
      noun: '个包',
    });
    assert.match(html, /data-picker-id="demo"/u);
    assert.ok(html.includes('role="combobox"'), '输入框要声明 combobox 角色');
    assert.ok(html.includes('aria-expanded="false"'), '首帧不许自动展开（用户没点就弹是打扰）');
    assert.ok(html.includes('data-total'), '必须有命中总数的锚点（G12）');
    assert.ok(html.includes('data-page-size'), '必须声明每页条数（G12）');
    assert.ok(html.includes('class="picker-list"'), '列表容器要有统一类名（边界写在 CSS 里）');
    assert.ok(
      PICKER_CSS.includes('max-height') && PICKER_CSS.includes('overflow'),
      '列表容器必须有界（G11）—— max-height 定高度、overflow 定可滚',
    );
    assert.ok(html.includes('data-picker-nav="prev"') && html.includes('data-picker-nav="next"'));
    assert.strictEqual(countRows(html, 'picker-item'), PICKER_DEFAULT_PAGE_SIZE, '首帧就只画一页');
    assert.ok(html.includes('共 200 个包'), '首帧计数要写清总量');
    assert.ok(!/<datalist/u.test(html), '原生 datalist 已全局禁用（它没有滚动/计数/键盘）');
    // 每页档位必须与登记表一致
    const sizes = [...html.matchAll(/<option value="(\d+)"/gu)].map((m) => Number(m[1]));
    assert.deepStrictEqual(sizes, [...PICKER_PAGE_SIZES]);
  });

  it('规模门禁：×1000（2000 项）时渲染体积仍与规模无关', () => {
    const small = pickerHtml({ id: 'a', label: 'x', placeholder: 'p', items: scalePickerItems(20) });
    const huge = pickerHtml({ id: 'a', label: 'x', placeholder: 'p', items: scalePickerItems(2000) });
    assert.strictEqual(countRows(huge, 'picker-item'), 20);
    // 数据脚本按设计随规模增长（它是数据，不是 DOM）；DOM 结构部分不许长
    const domOf = (h: string): string =>
      h.replace(/<script type="application\/json"[\s\S]*?<\/script>/gu, '').replace(/\d+/gu, '#');
    assert.strictEqual(domOf(huge).length, domOf(small).length, 'DOM 结构必须与规模无关（数字归一化后）');
    assert.ok(huge.includes('共 2000 项'), '计数要写总量（默认量词为“项”）');
    // 数据脚本按设计随规模增长（它是数据，不是 DOM），但必须仍可解析
    const data = /<script type="application\/json" id="a-data">([\s\S]*?)<\/script>/u.exec(huge);
    assert.ok(data, '数据脚本要在');
    assert.strictEqual(JSON.parse(data[1].replace(/\\u003c/gu, '<')).length, 2000);
  });

  it('脚本契约：每个分页按钮都有接线，键盘路径完整，且不用 inline onclick', () => {
    const js = pickerScript();
    assert.ok(!/onclick=/u.test(js), '不许 inline onclick');
    for (const nav of ['prev', 'next']) {
      assert.ok(js.includes(`${nav}.addEventListener('click'`), `data-picker-nav="${nav}" 没有接线`);
    }
    for (const key of ['ArrowDown', 'ArrowUp', 'Enter', 'Escape']) {
      assert.ok(js.includes(`'${key}'`), `键盘路径缺 ${key}（"能不能只用手"那一问）`);
    }
    assert.ok(js.includes('window.onPickerSelect'), '选中后要回调页面（联动做在页面里）');
    assert.ok(js.includes('pickerMatch') && js.includes('pickerTotalLabel'), '两端同义的两个函数要真的被用上');
    assert.ok(js.includes('data-idx'), '点击选中靠 data-idx（与渲染一致）');
    assert.ok(js.includes('querySelectorAll') && js.includes('wirePicker'), '通用脚本要接管页面上所有选择器');
  });
});
