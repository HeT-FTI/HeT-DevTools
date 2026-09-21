import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HudModel, defaultHudActions, hudHtml, hudL1 } from '../features/hud/hudModel';
import { hudCss } from '../features/cockpit/singlepage/tokens';
import { l1Html } from '../features/cockpit/singlepage/shell';
import { apiCalls, attrCount, countMatches, stripComments } from './support/htmlFacts';

/**
 * G15 / 决策 6A：**HUD = L1 渲染器 + ≤2 行摘要，只留一套皮**。
 *
 * 这条决策的可判据不是"看着像"，而是三件能数出来的事：
 * 1. HUD 的顶部状态条与环境行**确实来自共享渲染器**（源码级 import + 结构一致）；
 * 2. HUD **自己产出的那部分**再没有色值字面量 / 会随宽度重排的网格（第二套皮的痕迹）；
 * 3. 摘要 ≤ 2 行；一个文档仍只取一次 API；交互仍走事件委托。
 */
describe('HUD 与单页共用一套皮（G15 / 6A）', () => {
  const read = (p: string): string => readFileSync(join('src', p), 'utf8');

  function model(over: Partial<HudModel> = {}): HudModel {
    return {
      title: 'mylib2',
      health: 92,
      running: null,
      lastBuildOk: true,
      test: { passed: 7, failed: 0, skipped: 1 },
      coverage: 87,
      buildAgo: '3 分钟前',
      provider: { label: 'Linux · 托管车道（gcc + lcov 全语义）', coverage: 'full' },
      runtime: 'conan 2.32',
      env: [
        { label: 'conan', value: '2.32', tone: 'ok', path: '~/.het-fti/managed-env/venv/bin/conan' },
        { label: 'lcov', value: '可选', tone: 'plain' },
      ],
      actions: defaultHudActions(),
      templateBehind: 0,
      ...over,
    };
  }

  /** 我们自己产出的部分（pageShell 会带旧 BASE_CSS 进来，不能连它一起扫）。
   *
   * HUD 用的是 `hudCss() + inner`，所以从**第二段** `<style>` 开始（第一段是 pageShell 的 BASE_CSS）。
   */
  function ours(html: string): string {
    const all = [...html.matchAll(/<style>/g)].map((m) => m.index ?? -1);
    assert.ok(all.length >= 2, '应当有 pageShell 的 BASE_CSS + HUD 自己的 CSS');
    return stripComments(html.slice(all[1]));
  }

  it('共享渲染器：L1 条与卡片行都来自单页模块（不再是第二套实现）', () => {
    const src = read(join('features', 'hud', 'hudModel.ts'));
    assert.ok(src.includes("from '../cockpit/singlepage/shell'"), 'HUD 要用单页的渲染器');
    assert.ok(src.includes('l1Html'), '顶部状态条 = L1 渲染器');
    assert.ok(src.includes('cardRowHtml'), '环境行 = 同一张卡片');
    assert.ok(src.includes("from '../cockpit/singlepage/tokens'"), '样式要来自 token 层');
    assert.ok(src.includes('pageShell('), '整页外壳用 pageShell（一处取 API）');

    const html = hudHtml(model(), 13);
    // L1 的语义与单页一致：构建/测试/覆盖率/环境 四项都在（外加 HUD 特有的健康）
    const items = hudL1(model());
    for (const id of ['build', 'test', 'coverage', 'env', 'health']) {
      assert.ok(items.some((i) => i.id === id), `L1 缺 ${id}`);
    }
    const shared = l1Html(items, null);
    assert.ok(html.includes(shared), 'HUD 里的 L1 必须逐字来自共享渲染器');
    assert.ok(html.includes('data-l1'), '仍是同一个 L1 容器（协议不变）');
    // 环境行落到共享卡片上（`.card`/`.ic`/`.nm`/`.fact`，双行信息走 `.next`）
    for (const cls of ['class="card st-ok"', 'class="nm"', 'class="fact"', 'class="next"']) {
      assert.ok(ours(html).includes(cls), `环境卡片缺 ${cls}`);
    }
  });

  it('摘要 ≤ 2 行（6A 的原话），且拿不到的信息不编造', () => {
    const html = hudHtml(model(), 13);
    assert.ok(countMatches(ours(html), /class="hud-line"/g) <= 2, '摘要行数必须 ≤ 2');
    assert.strictEqual(countMatches(ours(html), /class="hud-line"/g), 2, '正常情况就是两行');
    const none = hudHtml(model({ provider: null, runtime: null, coverage: null }), 13);
    assert.ok(ours(none).includes('未知'), '没有车道信息时说"未知"并给出下一步');
    assert.ok(!/覆盖率 \d/.test(ours(none)), '没有覆盖率读数时不许显示数字');
  });

  it('一套皮：我们自己的输出里没有色值字面量 / 重排网格 / 固定定位', () => {
    const o = ours(hudHtml(model(), 13));
    const forbidden: [RegExp, string][] = [
      [/#[0-9a-fA-F]{3,8}\b/, '色值字面量（要用 token）'],
      [/\brgba?\(|\bhsla?\(/, 'rgb()/hsl() 字面量'],
      [/auto-fit|auto-fill/, '自适应多列（拖宽度会跳列）'],
      [/repeat\(/, 'repeat() 网格'],
      [/@media/, '@media 断点（只允许容器查询）'],
      [/position\s*:\s*fixed/, 'position:fixed'],
      [/<table/i, '<table>'],
    ];
    for (const [re, why] of forbidden) {
      assert.ok(!re.test(o), `HUD 不该出现：${why}`);
    }
    assert.ok(o.includes('var(--het-'), 'HUD 要引用共享 token');
    assert.ok(hudCss().includes('var(--het-'), 'HUD 的 CSS 也从 token 层来');
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(hudCss()), 'token 层之外的 HUD CSS 不许有色值');
  });

  it('纪律与功能都不退化：一处 API、事件委托、1–9 与 Esc 仍可用', () => {
    const html = hudHtml(model(), 13);
    assert.strictEqual(apiCalls(html), 1, '一个文档只取一次 API');
    assert.strictEqual(countMatches(stripComments(html), /<script\b/g), 2, 'pageShell 一段 + 页面体一段');
    assert.ok(html.includes("document.addEventListener('click'"), '交互走事件委托');
    assert.ok(!/querySelectorAll\('button[^']*'\)\.forEach\([^)]*addEventListener/.test(html), '禁止逐个按钮绑事件');
    // 快捷键与 Esc（功能契约，别在"统一皮肤"时弄丢）
    const o = ours(html);
    for (let d = 1; d <= 9; d++) {
      assert.ok(o.includes(`data-key="${d}"`), `缺数字快捷键 ${d}`);
    }
    assert.ok(o.includes('Escape'), 'Esc 要能关');
    assert.ok(o.includes("post(b.getAttribute('data-action'))"), '动手势走 pageShell 的 post(cmd)（HUD host 协议不变）');
    assert.ok(attrCount(o, 'button', 'data-action', 'het.test') >= 1, '动作按钮要用 data-action 携带命令');
    assert.ok(countMatches(o, /<button[^>]*data-action=/g) >= 4, '十个动作都还在');
  });
});
