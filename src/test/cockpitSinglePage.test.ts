import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_FOLDED,
  L1_IDS,
  normalizeFolded,
  stateIcon,
  type CardRow,
  type SinglePageModel,
} from '../features/cockpit/singlepage/model';
import {
  LEGACY_TABS,
  SECTIONS,
  allCards,
  cardSection,
  railLabelOf,
  railSections,
  railWidthCss,
  tabsCovered,
} from '../features/cockpit/singlepage/sections';
import { HET_TOKEN_VARS, singlePageCss } from '../features/cockpit/singlepage/tokens';
import { cockpitSinglePageBody, cockpitSinglePageHtml } from '../features/cockpit/singlepage/shell';
import { apiCalls, attrCount, countMatches, stripComments } from './support/htmlFacts';
import type { LegacyTabId } from '../features/cockpit/singlepage/model';

/**
 * 单页 cockpit（A 批换壳）的门禁。
 *
 * 三类断言，对应计划的三条硬约束：
 * 1. **信息不丢**：旧 11 个 tab 每个都在新页面上有归属；
 * 2. **抗拖拽**：布局只允许"单列 + 定宽 + flex-wrap"，禁止一切会随宽度重排/溢出的原语；
 * 3. **协议与纪律**：一个文档一次 API、片段不带脚本、交互走委托、乐观锁（折叠/忙）齐全。
 */
describe('cockpit 单页壳（A 批）', () => {
  const model: SinglePageModel = {
    l1: [
      { id: 'build', label: '构建', value: '2 分钟前', state: 'ok' },
      { id: 'test', label: '测试', value: '3/3', state: 'ok' },
      { id: 'coverage', label: '覆盖率', value: '76.9%', state: 'ok' },
      { id: 'env', label: '环境', value: '车道 ready', state: 'ok' },
    ],
    cards: [],
    busy: null,
    folded: [...DEFAULT_FOLDED],
    templateBehind: 0,
  };
  const html = cockpitSinglePageHtml(model);
  /** 只看**我们自己**产出的部分：pageShell 里的 BASE_CSS 是旧 UI 的遗留（颜色/auto-fit 都在那）。*/
  const ours = `${singlePageCss()}\n${cockpitSinglePageBody(model)}`;

  it('信息不丢：11 个旧 tab 全部有归属（且不重不漏）', () => {
    assert.strictEqual(LEGACY_TABS.length, 11, '旧 UI 的 tab 数');
    const covered = [...tabsCovered()].sort();
    assert.deepStrictEqual(covered, [...LEGACY_TABS].sort(), '每个旧 tab 至少有一张卡承载');
    for (const c of allCards()) {
      assert.ok(
        (LEGACY_TABS as readonly LegacyTabId[]).includes(c.tab),
        `卡片 ${c.id} 的 tab=${c.tab} 必须是旧 tab 之一`,
      );
      assert.ok(cardSection(c.id), `卡片 ${c.id} 必须能定位到段`);
    }
  });

  it('段与卡片定义自洽：rail 5 段 + 齿轮、序号 1..5、卡片 id 唯一', () => {
    const rail = SECTIONS.filter((s) => !s.gear);
    assert.strictEqual(rail.length, 5, 'rail 五项（§5.1 定稿）');
    assert.deepStrictEqual(railSections().map((s) => s.order), [1, 2, 3, 4, 5]);
    assert.deepStrictEqual(
      rail.map((s) => s.label),
      ['环境车道', '构建验证', '模块文档', '质量安全', '交付发布'],
      '段名就是 rail 定稿名（四个字、不带“与”）',
    );
    assert.deepStrictEqual(SECTIONS.map((s) => s.id), ['env', 'build', 'module', 'quality', 'deliver', 'settings']);
    const ids = allCards().map((c) => c.id);
    assert.strictEqual(new Set(ids).size, ids.length, '卡片 id 不能重复');
    assert.strictEqual(SECTIONS.filter((s) => !s.foldedByDefault).length, 1, '默认只展开段 1');
    assert.strictEqual(SECTIONS[0].foldedByDefault, false);
    assert.strictEqual(SECTIONS[0].id, 'env', '默认展开的是「环境车道」');
    const gear = SECTIONS.filter((s) => s.gear);
    assert.strictEqual(gear.length, 1, '齿轮只有一格');
    assert.strictEqual(gear[0].label, '设置', '齿轮就叫“设置”（不叫“更多/其他”）');
    assert.deepStrictEqual(gear[0].cards.length >= 1, true, '设置段里有卡片');
  });

  it('每张卡最多一个主按钮；Copilot 入口只指向 /het-* 命令', () => {
    for (const c of allCards()) {
      if (c.action?.kind === 'copilot') {
        assert.ok(c.action.id.startsWith('/het-'), `${c.id} 的 Copilot 命令要以 /het- 开头`);
      }
      if (c.action) {
        assert.ok(c.action.label.length > 0, `${c.id} 的按钮要有文案`);
      }
    }
  });

  it('抗拖拽：禁止一切会随宽度重排/溢出的原语', () => {
    const forbidden: [RegExp, string][] = [
      [/repeat\(|auto-fit|auto-fill/, '重复列 / 自适应多列（拖宽度会跳列 —— 决策 4A）'],
      [/overflow-x\s*:\s*auto/, '横向滚动容器'],
      [/position\s*:\s*fixed/, 'position:fixed'],
      [/<table/i, '<table>'],
      [/@media/, '@media 断点（只允许容器查询）'],
      [/max-height\s*:\s*\d+vh/, '裸 vh 高度（要 min() 限幅）'],
      [/(^|[;{\s])width\s*:\s*\d{3,}px/, '固定像素宽（表单控件要用 max-width；自定义属性 --het-*-w 不算）'],
    ];
    for (const [re, why] of forbidden) {
      assert.ok(!re.test(ours), `不应出现：${why}`);
    }
    const css = singlePageCss();
    assert.ok(css.includes('--het-page-w: 900px'), '内容定宽 900（决策 4A）');
    // 实测反馈第 2 条：rail 从"12345"换成"图标 + 等长两字短名"后，宽度由**最长标签**决定，
    // 不再是魔法数；这里断言公式与导出函数一致，避免两边各写一份。
    assert.ok(
      css.includes(`--het-rail-w: ${railWidthCss()}`),
      `rail 宽度由最长标签决定（${railWidthCss()}）`,
    );
    assert.strictEqual(railWidthCss(), 'calc(4em + 18px)', '五段短名都是两个字 → 4em + 内边距');
    assert.ok(css.includes('flex-wrap: wrap'), '横向排列一律允许换行');
    assert.ok(css.includes('min-width: 0'), '弹性子项必须 min-width:0（防溢出）');
    assert.ok(/max-height:\s*min\(/.test(css), '滚动盒高度要有上限');
    assert.ok(
      /\.kv\s*\{[^}]*grid-template-columns:\s*max-content\s+minmax\(0,\s*1fr\)/.test(css),
      '允许且只能用"显式两列 + minmax(0,1fr)"的叶子级 key/value 网格（不是多列布局）',
    );
  });

  it('样式只用 --het-* token（色值只允许出现在 tokens.ts 的定义里）', () => {
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(ours), '我们自己的 HTML/CSS 里不得出现 #rrggbb');
    assert.ok(!/\brgba?\(/.test(ours), '不得出现 rgb()/rgba()');
    assert.ok(!/\bhsla?\(/.test(ours), '不得出现 hsl()/hsla()');
    for (const [name, value] of Object.entries(HET_TOKEN_VARS)) {
      assert.ok(name.startsWith('--het-'), `${name} 必须用 --het- 前缀`);
      assert.ok(
        value.startsWith('var(--') ||
          /^[0-9]+(px|rem|em|%)(\s+[0-9]+(px|rem|em|%))*$/.test(value) ||
          // 由内容推导的尺寸：calc(<n>em + <n>px)——只允许"字号 + 固定内边距"这一种用途
          /^calc\([0-9]+em \+ [0-9]+px\)$/.test(value),
        `${name} 只能映射到 VS Code 变量、中性尺寸或 calc(<n>em + <n>px)`);
    }
    assert.ok(html.includes('var(--het-'), '布局必须引用 token');
  });

  it('webview 纪律：一个文档一次 API、页面体只有一段脚本、交互走事件委托', () => {
    assert.strictEqual(apiCalls(html), 1, 'F.29：一个文档只能取一次 API');
    assert.strictEqual(
      countMatches(stripComments(html), /<script\b/g),
      2,
      '整页只允许两段脚本：pageShell(取 API) + 页面体',
    );
    assert.strictEqual(
      countMatches(stripComments(cockpitSinglePageBody(model)), /<script\b/g),
      1,
      '我们自己的页面体只允许一段脚本',
    );
    assert.ok(html.includes(`document.addEventListener('click'`), '点击走委托');
    assert.ok(!/querySelectorAll\('button[^']*'\)\.forEach\([^)]*addEventListener/.test(html), '禁止逐个按钮绑事件');
  });

  it('协议齐备：折叠/跳转/动作/Copilot/懒加载/忙语义', () => {
    for (const frag of [
      `send({ type: 'folded', id: sec, expand: folded })`,
      `send({ type: 'section:open', id: sec })`,
      `send({ type: 'action', action: id`,
      `send({ type: 'copilot', command:`,
      `m.type === 'l1'`,
      `m.type === 'section'`,
      `m.type === 'busy'`,
    ]) {
      assert.ok(html.includes(frag), `协议缺失：${frag}`);
    }
    assert.ok(html.includes('data-rail'), '有 rail 容器');
    // §F.37（实测反馈第 2 条）：rail 不许再是"12345" —— 必须是"图标 + 等长两字短名"
    const rails = [...html.matchAll(/<button class="rail-item"[^>]*data-section="([^"]+)"[^>]*>(.*?)<\/button>/gsu)];
    assert.strictEqual(rails.length, 5, 'rail 五格');
    for (const [, id, inner] of rails) {
      assert.ok(/<span class="rail-ic"[^>]*>[^<]+<\/span>/u.test(inner), `${id} 要有图标`);
      const tx = /<span class="rail-tx">([^<]+)<\/span>/u.exec(inner)?.[1] ?? '';
      assert.strictEqual([...tx].length, 2, `${id} 的 rail 短名要两个字（等长），得到「${tx}」`);
      assert.ok(!/<span class="rail-tx">\d/u.test(inner), `${id} 不许只显示序号`);
      // 渲染内容必须来自段定义（单一来源），不是页面里另写一份短名
      const def = SECTIONS.find((d) => d.id === id)!;
      assert.ok(inner.includes(`>${railLabelOf(def).split(' ')[0]}<`), `${id} 的图标来自段定义`);
      assert.ok(inner.includes(`<span class="rail-tx">${def.railLabel}</span>`), `${id} 的短名来自段定义`);
    }
    assert.ok(html.includes('aria-label="1 环境车道"'), 'rail 要有可读标签（无障碍 + 悬浮提示）');
    assert.ok(html.includes('data-page'), '有内容容器');
  });

  it('默认折叠 = 只展开段 1；折叠状态可归一化（老数据不炸）', () => {
    assert.deepStrictEqual(DEFAULT_FOLDED, ['build', 'module', 'quality', 'deliver', 'settings']);
    assert.strictEqual(attrCount(html, 'section', 'data-collapsed', '1'), 5, '5 段默认折叠');
    assert.strictEqual(attrCount(html, 'section', 'data-collapsed', '0'), 1, '1 段默认展开');
    // 归一化：认不出的段 id（含改名前的 now/code/config）直接丢掉
    assert.deepStrictEqual(normalizeFolded(['module', 'module', 'nope', 1]), ['module']);
    assert.deepStrictEqual(normalizeFolded(['now', 'code', 'config']), [], '旧段名一律不认');
    assert.deepStrictEqual(normalizeFolded(undefined), [...DEFAULT_FOLDED]);
    assert.deepStrictEqual(normalizeFolded('junk'), [...DEFAULT_FOLDED]);
  });

  it('L1 四项 + 忙点；忙时点可见、闲时隐藏', () => {
    assert.deepStrictEqual([...L1_IDS], ['build', 'test', 'coverage', 'env']);
    assert.strictEqual(html.split('class="l1-item').length - 1, 4, 'L1 四项');
    assert.ok(html.includes('data-busy hidden'), '空闲时忙点隐藏');
    const busyHtml = cockpitSinglePageHtml({ ...model, busy: '检查环境' });
    assert.ok(/data-busy[^>]*>/.test(busyHtml), '忙时忙点展示');
    // J 块：忙点是一个“导航”入口（点开任务中心），不是把忙点做成按钮状装饰
    assert.ok(
      /data-busy data-action="nav" data-nav="openTasks"/.test(busyHtml),
      '忙点可点 → 任务中心',
    );
    assert.ok(busyHtml.includes('检查环境'), '忙时显示动作名');
  });

  it('卡片行数 = 21，且按段归位；模板落后时给一行提示', () => {
    assert.strictEqual(allCards().length, 21, '§5.1 的 21 张卡（删掉“只读摘要段”的 4 张重复卡）');
    assert.strictEqual(html.split('data-card-row=').length - 1, 21);
    assert.ok(!html.includes('模板落后上游 0'), '不落后时不提示');
    const behind = cockpitSinglePageHtml({ ...model, templateBehind: 64 });
    assert.ok(behind.includes('模板落后上游 64 个提交'), '落后时提示（§11 联动）');
  });

  it('卡片事实文本按 HTML 转义（用户内容不得注入）', () => {
    // 注：模型的 `cards` 只能**补丁已声明的卡**（SECTIONS 是唯一来源）——
    // 所以这里用一个真实存在的卡 id，把它的事实改成恶意字符串。
    const evil: CardRow = {
      id: 'buildTest',
      tab: 'buildTest',
      label: '构建',
      state: 'fail',
      fact: '<img src=x onerror=alert(1)>',
      stage: 'output',
      lazy: false,
    };
    const out = cockpitSinglePageHtml({ ...model, cards: [evil] });
    assert.ok(!out.includes('<img src=x'), '未转义的危险 HTML 不得出现');
    assert.ok(out.includes('&lt;img'), '应转义后呈现');
  });

  it('状态图标单一来源（L1/L2 共用）', () => {
    assert.deepStrictEqual(
      (['ok', 'warn', 'fail', 'na', 'idle', 'running'] as const).map(stateIcon),
      ['✓', '!', '✗', '–', '·', '⟳'],
    );
  });

  it('新壳不碰旧代码：只读依赖 layout 的类型（防止误改旧 UI）', () => {
    const files = ['model.ts', 'sections.ts', 'shell.ts', 'tokens.ts'];
    for (const f of files) {
      const src = readFileSync(join('src', 'features', 'cockpit', 'singlepage', f), 'utf8');
      assert.ok(!src.includes("from 'vscode'"), `${f} 不得 import vscode（必须可单测）`);
      assert.strictEqual(apiCalls(src), 0, `${f} 不得自取 API（F.29；注释里的提及不算）`);
      assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(src), `${f} 不得出现色值字面量（§12）`);
    }
  });
});
