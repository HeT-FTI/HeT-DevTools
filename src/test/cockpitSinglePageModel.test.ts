import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initialCockpitState, reduceCockpit } from '../features/cockpit/state';
import { SECTIONS, allCards } from '../features/cockpit/singlepage/sections';
import { DEFAULT_FOLDED } from '../features/cockpit/singlepage/model';
import { EMPTY_FACTS, sectionsWithProblems, singlePageModelFrom } from '../features/cockpit/singlepage/modelFrom';
import { COMMAND_FOR_ACTION, actionsUsingCommand, commandForAction } from '../features/cockpit/singlepage/actions';
import { cockpitSinglePageBody, cockpitSinglePageHtml } from '../features/cockpit/singlepage/shell';

/**
 * A 批第 2 块（控制器接线的纯逻辑部分）：
 * - **动作必须接线**：卡片按钮 → 真实命令，漏接就是"点了没反应"；
 * - **事实 → 模型**：有值就摆上去，没值一律 `—`（不编造）；"是否需人工介入"必须可见（材料第 1 条）；
 * - **单页是唯一 UI**：旧开关 `het.ui.legacyTabs`（含中英文案）已随旧 UI 归档，不留"双 UI"歧义。
 */
describe('单页模型映射（A 批 · 块 2）', () => {
  const state = initialCockpitState();

  it('没有任何事实时：25 张卡都在、全是 idle、L1 全 —（不编造数字）', () => {
    const model = singlePageModelFrom(state, EMPTY_FACTS);
    assert.strictEqual(model.cards.length, allCards().length);
    assert.ok(model.cards.every((c) => c.state === 'idle'), '未知就保持 idle');
    assert.deepStrictEqual(model.l1.map((i) => i.value), ['—', '—', '—', '—']);
    assert.deepStrictEqual(model.folded, [...DEFAULT_FOLDED], '默认只展开段 1');
  });

  it('事实摆到 L1 与卡片上（构建/测试/覆盖率/环境）', () => {
    const model = singlePageModelFrom(state, {
      build: { ok: true, ago: '2 分钟前', buildType: 'Release' },
      test: { passed: 3, failed: 1 },
      coverage: { pct: 76.9, at: '12 分钟前' },
      env: { provider: 'linux-managed', label: '车道 ready', ready: true, selfHeal: false },
    });
    const l1 = Object.fromEntries(model.l1.map((i) => [i.id, i]));
    assert.deepStrictEqual(
      [l1.build.value, l1.build.state],
      ['2 分钟前', 'ok'],
    );
    assert.deepStrictEqual([l1.test.value, l1.test.state], ['3/4', 'fail'], '有失败就是 fail');
    assert.deepStrictEqual([l1.coverage.value, l1.coverage.state], ['76.9%', 'ok']);
    assert.deepStrictEqual([l1.env.value, l1.env.state], ['车道 ready', 'ok']);

    const card = (id: string): (typeof model.cards)[number] => {
      const c = model.cards.find((x) => x.id === id);
      assert.ok(c, `卡片 ${id} 必须存在`);
      return c;
    };
    assert.strictEqual(card('build').fact, '2 分钟前 · Release');
    assert.strictEqual(card('test').fact, '3/4 · 1 failed');
    assert.strictEqual(card('coverage').fact, '76.9% · 行覆盖');
    assert.strictEqual(card('coverageDetail').fact, '76.9% · 12 分钟前');
    assert.match(card('env').fact, /车道 ready · 自愈不可用/, '自愈能力必须如实显示（ADR-8）');
  });

  it('缺工具 → 卡片标 warn 且给出"需要你执行"（材料第 1 条）', () => {
    const model = singlePageModelFrom(state, { docs: { missingTool: 'doxygen', pages: null } });
    const docs = model.cards.find((c) => c.id === 'docs');
    assert.ok(docs);
    assert.strictEqual(docs.state, 'warn');
    assert.match(docs.fact, /缺 doxygen/);
    assert.match(docs.next ?? '', /需要你执行：安装 doxygen/, '必须说清"要不要人、怎么装"');
    const build = model.cards.find((c) => c.id === 'docsBuild');
    assert.strictEqual(build?.state, 'warn', '编译侧也要如实标黄');
  });

  it('质量/提交/发布/CI/网络/上板的事实映射', () => {
    const model = singlePageModelFrom(state, {
      quality: { ready: 3, total: 6, failing: '静态检查' },
      deps: { direct: 4, indirect: 12 },
      commit: { dirty: 3 },
      release: { notReady: 2 },
      ci: { lastRun: 'ok', branch: 'main' },
      network: { profile: 'cn' },
      board: { mode: '--no-flash', collected: false },
      template: { behind: 64 },
    });
    const fact = (id: string): string => model.cards.find((c) => c.id === id)?.fact ?? '';
    assert.strictEqual(fact('quality'), '✗ 静态检查 · 工具 3/6 就绪');
    assert.strictEqual(fact('deps'), '直接 4 · 间接 12');
    assert.strictEqual(fact('commit'), '3 个文件未提交');
    assert.strictEqual(fact('release'), '2 项未就绪');
    assert.strictEqual(fact('ci'), '上次 绿 · main');
    assert.strictEqual(fact('network'), '国内源');
    assert.strictEqual(fact('board'), '--no-flash · 未采集');
    assert.strictEqual(model.templateBehind, 64, '模板落后要透传到 L1 上方提示');
  });

  it('折叠状态与"有问题的段"（rail 打点用）', () => {
    const model = singlePageModelFrom(state, { quality: { failing: '静态检查' } }, ['code']);
    assert.deepStrictEqual(model.folded, ['code']);
    assert.deepStrictEqual(sectionsWithProblems(model), ['code']);
    const clean = singlePageModelFrom(state, EMPTY_FACTS);
    assert.deepStrictEqual(sectionsWithProblems(clean), []);
  });

  it('CockpitState 的 running 会变成 L1 忙点（无需额外事实）', () => {
    const busyState = reduceCockpit(state, { type: 'log:start', title: '检查环境' });
    const model = singlePageModelFrom(busyState, EMPTY_FACTS);
    assert.strictEqual(model.busy, '检查环境');
    const html = cockpitSinglePageHtml(model);
    assert.ok(html.includes('检查环境'), '忙点要显示动作名');
  });

  it('§F.35 仓库级状态优先于 log 抽屉的 running，且两者都不丢', () => {
    // 纯 `runWithBusy` 动作（构建）：facts.status 有值、state.top.running 为空
    const built = singlePageModelFrom(state, {
      ...EMPTY_FACTS,
      status: { action: 'build', text: '构建中' },
    });
    assert.strictEqual(built.busy, '构建中');
    // 文档构建：两个来源同时有值 → 取仓库级状态（谁先结束都不会把对方清掉）
    const docs = reduceCockpit(state, { type: 'log:start', title: '正在编译文档' });
    const both = singlePageModelFrom(docs, {
      ...EMPTY_FACTS,
      status: { action: 'docsBuild', text: '编译文档' },
    });
    assert.strictEqual(both.busy, '编译文档');
    // 状态清空后 debug 抽屉的 running 仍能兜底（老路径不回归）
    const fallback = singlePageModelFrom(docs, { ...EMPTY_FACTS, status: null });
    assert.strictEqual(fallback.busy, '正在编译文档');
  });

  it('动作接线：每个 action/secondary（action 类）都有真实命令，且不指向不存在的命令', () => {
    const commands = new Set(Object.values(COMMAND_FOR_ACTION));
    assert.ok(commands.size >= 12, '命令映射不能退化成空壳');
    for (const c of allCards()) {
      for (const a of [c.action, c.secondary, ...(c.extra ?? [])]) {
        if (!a) {
          continue;
        }
        if (a.kind === 'copilot') {
          assert.ok(a.id.startsWith('/het-'), `${c.id} 的 Copilot 入口必须是 /het-*`);
        } else if (a.kind === 'jump') {
          // jump 是导航：目标是**段 id**，必须真实存在（点空了等于断链）
          assert.ok(
            SECTIONS.some((sec) => sec.id === a.id),
            `${c.id} 的跳转目标 ${a.id} 不是真实段`,
          );
        } else {
          const cmd = commandForAction(a.id);
          assert.ok(cmd, `卡片动作 ${a.id}（${c.label}）没有接线 —— 点了会没反应`);
          assert.ok(cmd.startsWith('het.'), `${a.id} → ${cmd} 必须是本扩展的命令`);
        }
      }
    }
    assert.deepStrictEqual(actionsUsingCommand('het.envPrepare'), ['envPrepare']);

    // §F.38：**同一个动作只允许出现在一个段**（段 1 只读、执行入口唯一）——
    // "两套构建语义"的根因就是同一个动作在两段里各有一个按钮（名字还不一样）。
    const actionOwners = new Map<string, string[]>();
    for (const sec of SECTIONS) {
      for (const c of sec.cards) {
        for (const a of [c.action, c.secondary, ...(c.extra ?? [])]) {
          if (a?.kind === 'action') {
            actionOwners.set(a.id, [...(actionOwners.get(a.id) ?? []), sec.id]);
          }
        }
      }
    }
    const crossSection = [...actionOwners.entries()]
      .filter(([, secs]) => new Set(secs).size > 1)
      .map(([id]) => id);
    assert.deepStrictEqual(crossSection, [], `这些动作被两个段各放了一个按钮：${crossSection.join('、')}`);

    // 段 1 = 只读摘要：允许 jump 链接 + Copilot 解释入口 + **只属于摘要的自足动作**
    // （体检 = 刷新摘要本身）；但凡执行段里也有的动作，段 1 一律不许再放按钮。
    const nowCards = SECTIONS.find((x) => x.id === 'now')!.cards;
    const buttonIds = (cards: typeof nowCards): string[] =>
      cards
        .flatMap((c) => [c.action, c.secondary, ...(c.extra ?? [])])
        .filter((a) => a?.kind === 'action')
        .map((a) => a!.id);
    const executed = buttonIds(nowCards);
    const elsewhere = new Set(
      buttonIds(SECTIONS.filter((x) => x.id !== 'now').flatMap((x) => x.cards)),
    );
    const duplicated = executed.filter((id) => elsewhere.has(id));
    assert.deepStrictEqual(
      duplicated,
      [],
      `段 1 只读：这些动作在执行段里已经有一个按钮了，摘要卡上别再放一份：${duplicated.join('、')}`,
    );
    assert.ok(executed.includes('health'), '体检属于"刷新摘要"的自足动作，留在段 1');
    for (const c of nowCards) {
      // 每张摘要卡都要给"去哪儿执行"（或它是体检/解释这类自足动作）
      if (['health'].includes(c.id)) {
        continue;
      }
      const jumps = (c.extra ?? []).filter((a) => a.kind === 'jump');
      assert.ok(jumps.length >= 1, `${c.id} 摘要卡要有跳转链接（否则用户没路走）`);
      assert.ok(jumps.every((a) => SECTIONS.some((s2) => s2.id === a.id)), `${c.id} 跳转目标要真实`);
    }
  });

  it('动作映射与 package.json 里真实声明的命令一致（防拼错）', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      contributes: { commands: { command: string }[] };
    };
    const declared = new Set(pkg.contributes.commands.map((c) => c.command));
    for (const [action, cmd] of Object.entries(COMMAND_FOR_ACTION)) {
      assert.ok(declared.has(cmd), `${action} → ${cmd} 未在 package.json 里声明`);
    }
  });

  it('次级按钮进页面（env 的「移除…」、构建卡的「构建并测试」）', () => {
    const html = cockpitSinglePageHtml(singlePageModelFrom(state, EMPTY_FACTS));
    assert.ok(html.includes('class="secondary"'), '次级按钮要有弱化样式');
    assert.ok(html.includes('data-act="envRemove"'), '环境卡要有"移除…"');
    assert.ok(html.includes('data-act="test"'), '构建卡要有"构建并测试"');
    const body = cockpitSinglePageBody(singlePageModelFrom(state, EMPTY_FACTS));
    // F.31：卡片按钮现在同时带 `data-action="act"` 与 `data-act`（只带 data-act 会被处理端
    // 第一行的 `closest('[data-action]')` 挡掉）。这里数"主按钮"= 非 secondary 的动作/Copilot 按钮。
    const buttons = [...body.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);
    const isSecondary = (b: string): boolean => /class="secondary"/.test(b);
    const primary = buttons.filter((b) => !isSecondary(b) && /data-(act|copilot)=/.test(b)).length;
    assert.ok(primary >= 10, `主按钮不应少于 10 个，实际 ${primary}`);
  });

  it('单页唯一路径：旧开关 `het.ui.legacyTabs` 已彻底移除（声明与文案）', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      contributes: { configuration: { properties: Record<string, unknown> } };
    };
    assert.ok(
      !('het.ui.legacyTabs' in pkg.contributes.configuration.properties),
      '单页已是唯一 UI，旧开关不能留在设置里（否则用户以为还能切回去）',
    );
    for (const nls of ['package.nls.json', 'package.nls.zh-cn.json']) {
      const dict = JSON.parse(readFileSync(nls, 'utf8')) as Record<string, string>;
      assert.ok(!dict['config.uiLegacyTabs'], `${nls} 不该再留旧开关文案`);
    }
  });

  it('事实来源与旧「概览」页同源（不第二次取数），且只喂拿得到的事实', () => {
    const ext = readFileSync(join('src', 'extension.ts'), 'utf8');
    assert.ok(ext.includes('feedSinglePageFacts('), '概览适配器要喂单页事实');
    for (const key of ['health:', 'tools:', 'plan,', 'buildOk:', 'test:']) {
      assert.ok(ext.includes(key), `事实字段缺失：${key}`);
    }
    assert.ok(ext.includes('setSinglePageFacts('), '要通过 controller 暴露的入口喂');
    // 拿不到的事实不许编造：覆盖率读数走 `parseCoveragePct`、CI 状态还没接
    for (const forbidden of ['coveragePct:', 'ci: {']) {
      assert.ok(!ext.includes(forbidden), `不该编造事实：${forbidden}`);
    }
    // 未提交数是真测量（git status --porcelain），允许
    assert.ok(ext.includes('dirty: parsePorcelain(res.stdout).length'), '未提交数要真的数');
  });

  it('§7 额外事实（覆盖率读数 + 未提交数）：拿不到就不传（不编造）', () => {
    const ext = readFileSync(join('src', 'extension.ts'), 'utf8');
    assert.ok(ext.includes('async function feedExtraSinglePageFacts'), '额外事实函数要在');
    assert.ok(!ext.includes('isSinglePageMode'), '旧 UI 已归档，不该再有旧模式判断（事实总是要的）');
    assert.ok(ext.includes('findCoverageReport(root)') && ext.includes('readCoveragePct('), '覆盖率读数用既有单一来源');
    assert.ok(ext.includes('parsePorcelain(res.stdout)'), '未提交数用既有解析器');
    assert.ok(ext.includes('timeoutMs: 8000'), 'git 调用必须有超时（无人值守不能卡住）');
    assert.ok(/catch\s*\{[\s\S]{0,80}不传/.test(ext), '取不到就不传（不编造）');
  });

  it('§9/G14：MegaLinter 文案不再是 advisory（上游 v0.1.2 起是阻塞门禁）', () => {
    const ext = readFileSync(join('src', 'extension.ts'), 'utf8');
    const megaLines = ext.split('\n').filter((l) => /megalinter|MegaLinter/.test(l));
    assert.ok(megaLines.length > 0, '应当能找到 MegaLinter 相关行');
    for (const l of megaLines) {
      // 允许"（不是 advisory）"这种**否定**表述；不允许把 MegaLinter 说成 advisory
      const withoutNegation = l.replace(/[不非][^a-zA-Z]{0,8}advisory/gi, '');
      assert.ok(
        !/advisory/i.test(withoutNegation),
        `MegaLinter 行不得把它当 advisory：${l.trim().slice(0, 60)}`,
      );
    }
    // 文案单点维护后落在 core/toolMatrix.ts（面板与卡片共用），两处都查
    const matrix = readFileSync(join('src', 'core', 'toolMatrix.ts'), 'utf8');
    assert.ok(/阻塞门禁/.test(matrix), '要说清"CI 里会拦"（矩阵内）');
    assert.ok(/megalinter/.test(matrix), 'MegaLinter 要在矩阵里登记');
  });

  it('控制器接线：读开关、用单页壳、路由动作；且**不出现任何"新建会话"命令**（§8.1 铁律 1）', () => {
    const ctl = readFileSync(join('src', 'features', 'cockpit', 'controller.ts'), 'utf8');
    assert.ok(ctl.includes('setFactsCollector('), '事实收集器要能被 host 注册');
    assert.ok(ctl.includes('requestFacts()'), '懒加载入口要触发事实刷新');
    assert.ok(!ctl.includes('legacyTabs'), '旧 UI 开关已随旧 UI 归档');
    assert.ok(ctl.includes('cockpitSinglePageHtml('), '单页壳要接进面板');
    assert.ok(ctl.includes('commandForAction('), '动作要经映射表');
    assert.ok(ctl.includes("postMessage({ type: 'l1'"), 'L1 要能局部刷新');
    assert.ok(!ctl.includes('buildCockpitHtml'), '旧渲染器已归档，控制器不该再引用');
    for (const forbidden of ['github.copilot.cli.newSession', 'workbench.action.chat.openNewSessionSidebar']) {
      assert.ok(!ctl.includes(forbidden), `禁止出现"新建会话"命令：${forbidden}`);
    }
    assert.strictEqual(SECTIONS.length, 5);
  });
});
