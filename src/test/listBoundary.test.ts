/**
 * **大集合边界门禁**（G11 / G12 的"机器可查"部分，§11.3）。
 *
 * 背景（实测反馈）：依赖搜索用的是原生 `<datalist>` —— 内置索引 32 项时"看着挺好"，
 * 一旦 `het.refreshConanIndex` 把 ConanCenter（1,900+ 包）灌进来，候选面板就**没有滚动条、
 * 没有命中计数、键盘也选不动**，直接把屏幕撑爆。
 *
 * 结论不是"这次改掉"，而是**让这类控件不可能再被写出来**：
 *   1. 产品代码里禁止 `<datalist>`（它的面板由浏览器画，我们没有任何边界控制权）；
 *   2. 渲染"列表容器"的文件必须自带 `max-height` + `overflow`（有界是结构约束，不是可选项）；
 *   3. `data-page-size` / `data-total` 只能由 `features/picker.ts` 产出（要新的枚举控件就复用它，
 *      不要另起一套"看起来也行"的实现）；
 *   4. 用规模夹具（20 / 1,900 / 2,000 项）实际渲染一遍，断言"渲染体积与规模无关"。
 */
import * as assert from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PICKER_CSS, PICKER_PAGE_SIZES } from '../features/picker';
import { depsPageHtml } from '../features/deps/html';
import { SCALE_SIZES, countRows, scaleCurated } from './support/scale';

const ROOT = 'src';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walk(p, out);
    } else if (p.endsWith('.ts')) {
      out.push(p);
    }
  }
  return out;
}

/** 产品代码（测试不算 —— 它们本来就该提到 datalist 这个名字）。 */
const PRODUCT_FILES = walk(ROOT).filter((p) => !p.startsWith(join(ROOT, 'test')));
const rel = (p: string): string => p.split(/[\\/]/u).join('/');

/**
 * 剥掉注释再扫：门禁管的是**代码**，不是文档里解释“为什么不用它”的那句话。
 * （曾经的假阳性就是这么来的：自己的注释把自己红了。）
 */
export function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
}

/** 探测器本身：拿一个“注入错误”的样本自证能识别（避免门禁写对了个空集）。 */
function detectsDatalist(src: string): boolean {
  return /<datalist/u.test(stripComments(src));
}

describe('G. 大集合边界门禁（G11 / G12）', () => {
  it('产品代码里禁止 `<datalist>`（它没有滚动条/计数/键盘，规模一大就是事故）', () => {
    assert.ok(PRODUCT_FILES.length >= 50, `扫到的产品文件太少（${PRODUCT_FILES.length}）→ 门禁自身失效`);
    // 先自证探测器能失败：注入一段带 datalist 的代码，必须被识别
    assert.strictEqual(detectsDatalist('<input list="x"/><datalist id="x"></datalist>'), true, '探测器对注入样本无感 → 门禁是假的');
    assert.strictEqual(detectsDatalist('/* 注释里提 <datalist> 不算 */'), false, '注释里的名字不该被算作违规');
    const bad = PRODUCT_FILES.filter((p) => detectsDatalist(readFileSync(p, 'utf8')));
    assert.deepStrictEqual(bad.map(rel), [], '这些文件还在用 <datalist>：改成 features/picker.ts 的有界选择器');
    // `list="…"` 属性必须配套 datalist，禁掉它才能保证"没有漏网的"
    const orphan = PRODUCT_FILES.filter((p) =>
      /<input[^>]*\blist="/u.test(stripComments(readFileSync(p, 'utf8'))),
    );
    assert.deepStrictEqual(orphan.map(rel), [], 'input 上残留 list="…"（原生候选源已废弃）');
  });

  it('列表容器必须有界：定义滚动列表的文件必须同时给出 max-height 与 overflow', () => {
    assert.ok(
      PICKER_CSS.includes('max-height') && PICKER_CSS.includes('overflow'),
      'picker 的列表容器必须自己声明边界',
    );
    const listClass = /\.(picker-list|menu-list|list-scroll)\b/u;
    const offenders = PRODUCT_FILES.filter((p) => {
      const src = readFileSync(p, 'utf8');
      return listClass.test(src) && !(src.includes('max-height') && src.includes('overflow'));
    });
    assert.deepStrictEqual(
      offenders.map(rel),
      [],
      '这些文件画了滚动列表却没写 max-height/overflow —— 列表高度会随数据长',
    );
  });

  it('分页与计数是**配对契约**，且只能由 picker 一处实现（禁止各写一套）', () => {
    const withPageSize = PRODUCT_FILES.filter((p) => readFileSync(p, 'utf8').includes('data-page-size'));
    assert.deepStrictEqual(
      withPageSize.map(rel),
      ['src/features/picker.ts'],
      'data-page-size 只允许 picker.ts 产出（新的枚举控件请复用 pickerHtml）',
    );
    const pickerSrc = readFileSync('src/features/picker.ts', 'utf8');
    assert.ok(pickerSrc.includes('data-total'), '有分页就必须有命中计数（用户要知道"这是不是全部"）');
    assert.ok(
      pickerSrc.includes('PICKER_PAGE_SIZES') && pickerSrc.includes('assertPageSize'),
      '分页档位必须是登记制（未登记的档位要抛错）',
    );
    assert.deepStrictEqual([...PICKER_PAGE_SIZES], [20, 50], '档位变更要同步更新本节规模断言');
  });

  it('规模：20 / 1,900 / 2,000 项渲染出来的行数与体积都不随规模增长', () => {
    const render = (n: number): string =>
      depsPageHtml({ views: [], issues: [] }, '', scaleCurated(n));
    const small = render(SCALE_SIZES.small);
    const realistic = render(SCALE_SIZES.realistic);
    const stress = render(SCALE_SIZES.stress);
    for (const [n, html] of [
      [SCALE_SIZES.small, small],
      [SCALE_SIZES.realistic, realistic],
      [SCALE_SIZES.stress, stress],
    ] as const) {
      assert.strictEqual(countRows(html, 'picker-item'), 20, `${n} 项时首帧行数必须仍是一页`);
      assert.ok(html.includes(`共 ${n} 个包`), `${n} 项时命中计数要写总量`);
    }
    // 结构部分（除数据脚本外）不该随规模增长；夹具的补零/计数位数差异一并归一化
    const skeleton = (html: string): string =>
      html.replace(/<script type="application\/json"[\s\S]*?<\/script>/gu, '').replace(/\d+/gu, '#');
    assert.strictEqual(
      skeleton(stress).length,
      skeleton(small).length,
      '去掉数据脚本后，2,000 项与 20 项的页面结构必须一模一样',
    );
  });

  it('依赖页把计数写在"首帧就能看到"的位置，而不是等脚本跑完', () => {
    const html = depsPageHtml({ views: [], issues: [] }, '', scaleCurated(SCALE_SIZES.realistic));
    const head = /<span class="dim" id="dep-total" data-total>([^<]*)</u.exec(html);
    assert.ok(head, '首帧就要有计数节点');
    assert.strictEqual(head[1], '共 1900 个包', '首帧计数要写总量（脚本跑之前也不能是空的）');
  });
});
