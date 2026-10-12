import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_FOLDED,
  SECTION_IDS,
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
  sectionForTab,
  tabsCovered,
} from '../features/cockpit/singlepage/sections';
import { HET_TOKEN_VARS, singlePageCss } from '../features/cockpit/singlepage/tokens';
import { singlePageModelFrom } from '../features/cockpit/singlepage/modelFrom';
import { initialCockpitState } from '../features/cockpit/state';
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
    // V3 L1 起：**模型里没有的卡就不渲染**（能力显隐靠这条生效）。
    // 所以"无事实"的模型也必须带上全部静态卡（就是 `SECTIONS` 展开的样子）。
    cards: SECTIONS.flatMap((s) => s.cards),
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

  it('旧 tab → 站：同名组优先（否则 `settings` 会被"网络与源"卡抢到就绪站）', () => {
    // c10 在真宿主里抽出的那条：`het.dashboard 'settings'` 必须落在**设置组**。
    assert.strictEqual(sectionForTab('settings'), 'settings');
    assert.strictEqual(sectionForTab('overview'), 'ready');
    assert.strictEqual(sectionForTab('deps'), 'build');
    assert.strictEqual(sectionForTab('bench'), 'deliver');
    for (const tab of LEGACY_TABS) {
      assert.ok(sectionForTab(tab), `旧 tab ${tab} 必须有归属（否则老链接会变成死路）`);
    }
  });

  it('组与卡片定义自洽：rail 8 站 + 齿轮、序号 1..8、卡片 id 唯一', () => {
    const rail = SECTIONS.filter((s) => !s.gear);
    assert.strictEqual(rail.length, 8, 'rail 八项（动作序列 8 站）');
    assert.deepStrictEqual(railSections().map((s) => s.order), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepStrictEqual(
      rail.map((s) => s.label),
      ['就绪', '构建', '测试', '文档', '质量', '提交', '发布', '交付'],
      '站名 = 动作序列（顺序就是"我下一步该干什么"）',
    );
    assert.deepStrictEqual(SECTIONS.map((s) => s.id), [
      'ready',
      'build',
      'test',
      'docs',
      'quality',
      'commit',
      'release',
      'deliver',
      'settings',
    ]);
    const ids = allCards().map((c) => c.id);
    assert.strictEqual(new Set(ids).size, ids.length, '卡片 id 不能重复');
    assert.strictEqual(SECTIONS.filter((s) => !s.foldedByDefault).length, 1, '手风琴：默认只展开一站');
    assert.strictEqual(SECTIONS[0].foldedByDefault, false);
    assert.strictEqual(SECTIONS[0].id, 'ready', '默认展开的是「就绪」站');
    // 组名里不许出现"与"（E 块定稿的硬规矩，继续适用于站名）
    for (const s of SECTIONS) {
      assert.ok(!s.label.includes('与'), `${s.id}: 站名不许出现"与"`);
    }
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
      `send({ type: 'folded', id: sec, expand: false })`,
      `send({ type: 'folded', id: sec, expand: true, exclusive: true })`,
      `send({ type: 'section:open', id: sec })`,
      `send({ type: 'action', action: id`,
      `send({ type: 'copilot', command:`,
      `m.type === 'l1'`,
      `m.type === 'section'`,
      `m.type === 'busy'`,
    ]) {
      assert.ok(html.includes(frag), `协议缺失：${frag}`);
    }
    assert.ok(html.includes('collapseOthers('), '手风琴要有页内立即生效的实现（不等宿主回包）');
    assert.ok(
      html.includes("m.type === 'folded'") && html.includes('applyFolded('),
      '页面必须接受宿主下发的折叠状态（否则深链只改宿主、页面还显示旧站开着）',
    );
    assert.ok(
      html.includes(`send({ type: 'folded', id: sec, expand: true, exclusive: true })`),
      '页内展开时要告诉宿主"这是互斥展开"（两处规则必须同源）',
    );
    assert.ok(html.includes('data-rail'), '有 rail 容器');
    // §F.37（实测反馈第 2 条）：rail 不许再是"12345" —— 必须是"图标 + 等长两字短名"
    const rails = [...html.matchAll(/class="rail-item[^"]*"[^>]*data-section="([^"]+)"[^>]*>(.*?)<\/button>/gsu)];
    assert.strictEqual(rails.length, 9, 'rail 九格（8 站 + 齿轮）');
    for (const [, id, inner] of rails) {
      assert.ok(/<span class="rail-ic"[^>]*>[^<]+<\/span>/u.test(inner), `${id} 要有图标`);
      const tx = /<span class="rail-tx">([^<]+)<\/span>/u.exec(inner)?.[1] ?? '';
      assert.strictEqual([...tx].length, 2, `${id} 的 rail 短名要两个字（等长），得到「${tx}」`);
      assert.ok(!/<span class="rail-tx">\d/u.test(inner), `${id} 不许只显示序号`);
      // 渲染内容必须来自组定义（单一来源），不是页面里另写一份短名
      const def = SECTIONS.find((d) => d.id === id)!;
      assert.ok(inner.includes(`>${railLabelOf(def).split(' ')[0]}<`), `${id} 的图标来自组定义`);
      assert.ok(inner.includes(`<span class="rail-tx">${def.railLabel}</span>`), `${id} 的短名来自组定义`);
    }
    // §6.0 第 4 条："第几段"是我们自己的分类法，不进 title/aria
    assert.ok(!/aria-label="\d/u.test(html), 'rail 上不许出现序号（§6.0 第 4 条）');
    assert.ok(html.includes('aria-label="就绪"'), 'rail 要有可读标签（无障碍 + 悬浮提示）');
    assert.ok(html.includes('data-page'), '有内容容器');
  });

  it('手风琴：默认只开 ① 就绪站；折叠状态可归一化且最多只开一站（老数据不炸）', () => {
    assert.strictEqual(DEFAULT_FOLDED.length, 8, '九个组里只开一个');
    assert.ok(!DEFAULT_FOLDED.includes('ready'), '默认开的是就绪站');
    assert.ok(DEFAULT_FOLDED.includes('settings'), '设置默认折叠');
    assert.strictEqual(attrCount(html, 'section', 'data-collapsed', '1'), 8, '八组默认折叠');
    assert.strictEqual(attrCount(html, 'section', 'data-collapsed', '0'), 1, '一组默认展开');
    // 归一化：认不出的组 id（含改名前的 now/code/config）直接丢掉
    const onlyDocs = normalizeFolded(['docs', 'docs', 'nope', 1]);
    assert.ok(onlyDocs.includes('docs'), 'docs 是"已折叠"，不该被打开');
    assert.deepStrictEqual(SECTION_IDS.filter((id) => !onlyDocs.includes(id)), ['ready'], '其余收起 → 只剩就绪站开着');
    assert.deepStrictEqual(normalizeFolded(['now', 'code', 'config']), [...DEFAULT_FOLDED], '旧组名一律不认（全丢掉 = 回到默认）');
    assert.deepStrictEqual(normalizeFolded(undefined), [...DEFAULT_FOLDED]);
    assert.deepStrictEqual(normalizeFolded('junk'), [...DEFAULT_FOLDED]);
    // 旧版"六个领域段"的名字迁到新站名（持久化数据不能因为改名全丢）
    assert.ok(normalizeFolded(['env']).includes('ready'), 'env → ready；旧的"环境车道开着"不会被丢掉');
    assert.ok(normalizeFolded(['module']).includes('docs'), 'module → docs（那一段当时就叫"模块文档"）');
    // 手风琴：持久化里原本多段同开 → 只保留页面顺序最靠前的那一组
    const many = normalizeFolded(['ready', 'build', 'test']);
    const open = SECTION_IDS.filter((id) => !many.includes(id));
    assert.deepStrictEqual(open, ['docs'], '多段同开时只留页面顺序最靠前的那一站');
  });

  it('常驻条 = 高频动作（不是状态）；忙点可点、闲时隐藏', () => {
    const acts = [...html.matchAll(/class="bar-act"[^>]*>(.*?)<\/button>/gsu)].map((m) => m[1]);
    assert.deepStrictEqual(acts, ['⚙ 编译打包', '▶ 全量测试', '✎ 智能提交'], '常驻条三项高频动作');
    // 协议必须与卡片一致（否则 host 认不出来 → 点了没反应）
    assert.ok(/data-action="act" data-act="build"/u.test(html), '编译打包走动作协议');
    assert.ok(/data-action="act" data-act="test"/u.test(html), '全量测试走动作协议');
    assert.ok(/data-copilot="\/het-commit"/u.test(html), '智能提交走 Copilot 协议');
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

  it('每站带状态点（状态只在阶段带一处）；站头不给序号也不重复按钮', () => {
    // 8 站每站一个状态点
    assert.strictEqual(html.split('class="rail-dot ').length - 1, 8, '8 个站状态点');
    // 站头：状态 + 站名 + 说明，且**没有**第二个动作按钮（动作只在卡上有一份）
    const heads = [...html.matchAll(/<button class="sec-head"[^>]*>(.*?)<\/button>/gsu)].map((m) => m[1]);
    assert.strictEqual(heads.length, 9, '八个站 + 设置');
    for (const head of heads) {
      assert.ok(/class="st st-/u.test(head), '站头要有状态');
      assert.ok(!/<button/u.test(head), '站头里不许再塞按钮');
    }
  });

  it('被产物能力藏起来的卡要**说清楚**（哪一张、缺什么、怎么才会出现）', () => {
    // 走**真实模型路径**（过滤是 modelFrom 的职责；手写 model 字面量会绕过它）。
    const state = initialCockpitState();
    const single = singlePageModelFrom(state, { metadata: { name: 'mylib' }, artifacts: { buildMatrix: false } });
    const singleHtml = cockpitSinglePageHtml(single);
    // 单目标 + 非嵌入式 → 交叉编译与上板两张卡不渲染，但要有解释行
    assert.ok(!/data-card-row="crossBuild"/u.test(singleHtml), '没有多目标事实 → 不渲染交叉编译卡');
    assert.ok(!/data-card-row="board"/u.test(singleHtml), '非嵌入式 → 不渲染上板卡');
    assert.ok(singleHtml.includes('data-hidden-cards'), '隐藏必须有一行解释');
    assert.ok(/缺多目标/u.test(singleHtml) && /缺裸机/u.test(singleHtml), '要写出缺的是哪个能力');
    // 有能力时：卡回来了，解释行消失（P7：不留占位）
    const embedded = cockpitSinglePageHtml(
      singlePageModelFrom(state, {
        metadata: { name: 'mylib', baremetal_white_list: ['etl'] },
        artifacts: { buildMatrix: true },
      }),
    );
    assert.ok(/data-card-row="crossBuild"/u.test(embedded), '有多目标事实 → 交叉编译卡在');
    assert.ok(/data-card-row="board"/u.test(embedded), '嵌入式 → 上板卡在');
    // 解释行只列**真的被藏了**的那张（嵌入式这份里只剩覆盖率卡被藏 —— 它没开覆盖率）
    const hiddenText = /data-hidden-cards>([\s\S]*?)<\//u.exec(embedded)?.[1] ?? '';
    assert.ok(!hiddenText.includes('交叉编译'), `有多目标事实时不该说藏了交叉编译：${hiddenText}`);
    assert.ok(!hiddenText.includes('上板'), `嵌入式不该说藏了上板：${hiddenText}`);
    assert.ok(hiddenText.includes('覆盖率'), `这份里被藏的应该是覆盖率卡：${hiddenText}`);
    // 未知（读不到 metadata）：一张不藏、也不解释
    const unknown = cockpitSinglePageHtml(singlePageModelFrom(state, {}));
    assert.ok(/data-card-row="crossBuild"/u.test(unknown), '未知时一张不许藏');
    assert.ok(!unknown.includes('data-hidden-cards'), '未知时不该有解释行');
  });

  it('卡片行数 = 27，且按站归位；模板落后由「模板同步」卡说出来', () => {
    assert.strictEqual(allCards().length, 30, 'V3 L6e 起是 30 张（新增「编译期成本」）；卡片数变化必须在这里同步');
    // 能力**未知**（这份 fixture 没给 metadata）→ 一张都不藏：30 张都在（"未知 ≠ 没有"）
    assert.strictEqual(html.split('data-card-row=').length - 1, 30);
    // 能力已知且**没有 bench 入口** → 性能基线卡不渲染（它只在真能跑 bench 的库上有意义）
    const noBench = cockpitSinglePageHtml(
      singlePageModelFrom(initialCockpitState(), { metadata: { name: 'mylib' }, artifacts: {} }, [...DEFAULT_FOLDED]),
    );
    assert.ok(!/data-card-row="perfBaseline"/u.test(noBench), '没有 benchmark/ 事实 → 不渲染性能基线卡');
    const withBench = cockpitSinglePageHtml(
      singlePageModelFrom(
        initialCockpitState(),
        { metadata: { name: 'mylib' }, artifacts: { benchmark: true } },
        [...DEFAULT_FOLDED],
      ),
    );
    assert.ok(/data-card-row="perfBaseline"/u.test(withBench), '有 bench 入口 → 卡在');
    // 「导出符号」：共享库 / C 接口才显示（纯头文件库没有符号可谈）
    const withShared = cockpitSinglePageHtml(
      singlePageModelFrom(
        initialCockpitState(),
        { metadata: { name: 'mylib', is_shared: true }, artifacts: {} },
        [...DEFAULT_FOLDED],
      ),
    );
    assert.ok(/data-card-row="abiSymbols"/u.test(withShared), '共享库 → 导出符号卡在');
    const headerOnly = cockpitSinglePageHtml(
      singlePageModelFrom(
        initialCockpitState(),
        { metadata: { name: 'mylib', is_header: true }, artifacts: {} },
        [...DEFAULT_FOLDED],
      ),
    );
    assert.ok(!/data-card-row="abiSymbols"/u.test(headerOnly), '纯头文件库 → 不显示导出符号卡');
    // §6.0 第 5 条收口：站内那行**静态文字**已删（不然同一件事会写两遍）
    assert.ok(!html.includes('data-template-behind'), '旧的站内提示行不许再回来（那行不参与站状态）');
    const behind = singlePageModelFrom(initialCockpitState(), { template: { behind: 64 } }, [...DEFAULT_FOLDED]);
    const card = behind.cards.find((c) => c.id === 'templateSync');
    assert.strictEqual(card?.fact, '落后上游 64 个提交', '落后时必须说得出来');
    assert.strictEqual(card?.state, 'warn');
    assert.strictEqual(behind.spine?.find((s) => s.id === 'ready')?.state, 'warn', '① 就绪站跟着变黄（G5）');
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
