/**
 * **术语门禁**（计划 §5 / §6-E）。
 *
 * 为什么要有这个文件：用词不是审美问题 —— 用户的实际反馈是
 * 「用词必须专业（fcpp 领域概念，禁"现在"这类泛词）」、
 * 「点进去看到一屏不知道自己在哪一层」。
 * 这两件事都能**机器可查**，所以不该靠 review 记住：
 *
 * 1. **黑名单扫**：rail / 段名 / 按钮 / 悬停文案里不许出现占位泛词
 *    （现在 / 更多 / 其他 / 杂项 / 高级 / 泛指的"工具" / 二义的"构建并测试"）；
 * 2. **白名单一致**：一个概念全库一个写法 —— rail 定稿名 == 悬停域行名 == Slot 标题前缀；
 * 3. **状态词表**：进行时文案只说"正在做什么"（成功/失败属于**历史结果**，不许混进进行时）；
 * 4. **模块入口**：§5.1/C6 的「AI 框架设计&实现」必须带着设计稿维度（PRD + PlantUML 回填 tag）。
 */
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { BUSY_ACTIONS, type BusyAction } from '../core/outputChannels';
import { statusText } from '../core/status';
import { HOVER_DOMAIN_ORDER } from '../core/statusItem';
import { chipSpec, type ChipModel } from '../features/statusChip';
import { COPILOT_ENTRIES, copilotEntryFor, prefillText } from '../features/cockpit/singlepage/copilotEntry';
import { OUTPUT_CHANNEL_NAME } from '../core/outputChannels';
import { SECTIONS, allCards, railSections } from '../features/cockpit/singlepage/sections';
import { SLOT_TITLES } from '../features/slots/titles';

/**
 * 黑名单。`allow` 是"这个词只是更长词的一部分"的例外（否则 `工具链` 会被 `工具` 误伤）。
 *
 * 每条都要写清**为什么**：术语门禁最容易退化成"某个人的口味"，写明原因才知道什么时候该删。
 */
const BLACKLIST: readonly { word: string; allow?: RegExp; why: string }[] = [
  { word: '现在', why: '占位泛词：时间副词不构成层级名（要说"环境车道/构建验证"这种领域名）' },
  { word: '更多', why: '垃圾桶式导航：用户不知道里面有什么' },
  { word: '其他', why: '同上 —— 没有归属的东西应该被归类，不是堆在"其他"里' },
  { word: '杂项', why: '同上' },
  { word: '高级', why: '"高级"没有信息量：要么说清它做什么，要么就别放出来' },
  { word: '工具', allow: /工具链/u, why: '泛指词：要说具体是哪个（conan/cmake/gcc/lcov…）' },
  { word: '构建并测试', why: '二义（用户实测第 6 条）：拆成「编译打包」（产出物）与「全量测试」（结论）' },
];

/** 用户能看到的文案（= 术语门禁的扫描面，含悬停）。 */
function visibleCopy(): { where: string; text: string }[] {
  const out: { where: string; text: string }[] = [];
  for (const sec of SECTIONS) {
    out.push({ where: `段 ${sec.id} 名`, text: sec.label });
    out.push({ where: `rail ${sec.id} 短名`, text: sec.railLabel });
    out.push({ where: `段 ${sec.id} 提示`, text: sec.hint });
    for (const c of sec.cards) {
      out.push({ where: `卡 ${c.id} 标题`, text: c.label });
      for (const [k, v] of [
        ['sub', c.sub],
        ['fact', c.fact],
        ['next', c.next],
      ] as const) {
        if (v) {
          out.push({ where: `卡 ${c.id} ${k}`, text: v });
        }
      }
      for (const a of [c.action, c.secondary, ...(c.extra ?? [])]) {
        if (a) {
          out.push({ where: `卡 ${c.id} 按钮`, text: a.label });
        }
      }
    }
  }
  for (const [id, title] of Object.entries(SLOT_TITLES)) {
    out.push({ where: `Slot ${id} 标题`, text: title });
  }
  for (const e of COPILOT_ENTRIES) {
    out.push({ where: `Copilot ${e.command} 预期`, text: e.expect });
  }
  return out;
}

/** 悬停/芯片文案（另一大块用户可见文字，同样过术语表）。 */
function hoverCopy(): { where: string; text: string }[] {
  const rich: ChipModel = {
    projectName: 'mylib2',
    health: 92,
    running: '构建中',
    runningAction: 'build',
    lastBuildOk: true,
    test: { passed: 7, failed: 0, skipped: 1 },
    templateBehind: 0,
    buildAgo: '3 分钟前',
    buildType: 'Release',
    envSummary: 'linux-managed · 车道 ready',
    docs: 'ok',
    coverageEnabled: true,
    coverageFound: true,
    coverageLine: 87.5,
    coverageFunc: 91.2,
    healthVerdict: '良好',
    healthGaps: ['缺 lcov'],
    cache: { sizeText: '12.4 GB', archs: 3, lastCleanAgo: '2 天前' },
  };
  const spec = chipSpec(rich);
  assert.ok(spec, '有项目时必须有 chip 文案（否则下面的扫描是空的）');
  return [
    { where: 'chip 文字', text: spec.text },
    { where: 'chip 悬停', text: spec.tooltip },
  ];
}

describe('§5 术语：黑名单（rail / 段 / 按钮 / 悬停）', () => {
  it('用户可见文案里不出现占位泛词', () => {
    const bad: string[] = [];
    for (const { where, text } of [...visibleCopy(), ...hoverCopy()]) {
      for (const { word, allow, why } of BLACKLIST) {
        const probe = allow ? text.replace(allow, '·') : text;
        if (probe.includes(word)) {
          bad.push(`${where}「${text}」里出现「${word}」—— ${why}`);
        }
      }
    }
    assert.deepStrictEqual(bad, [], `术语黑名单命中：\n${bad.join('\n')}`);
  });

  it('唯一页签标题与唯一通道名可以带品牌名，其它文案前缀不许带', () => {
    const allowed = new Set([OUTPUT_CHANNEL_NAME]);
    for (const [id, title] of Object.entries(SLOT_TITLES)) {
      // 例外只有一个，且写清理由：**输出视图的标题就是那个唯一的通道名**（§5.3 允许）。
      if (allowed.has(title.split('：')[1] ?? '')) {
        continue;
      }
      assert.ok(!title.includes('HeT DevTools'), `Slot ${id} 的标题不许带品牌前缀：${title}`);
    }
    for (const c of allCards()) {
      assert.ok(!c.label.includes('HeT DevTools'), `卡片 ${c.id} 的标题不许带品牌前缀`);
    }
    assert.deepStrictEqual([...allowed], ['HeT DevTools'], '通道名只有一个（D 块）');
  });
});

describe('§5 术语：白名单一致（一个概念全库一个写法）', () => {
  it('rail 定稿名 == 悬停域行名（同一串字，不许各写各的）', () => {
    assert.deepStrictEqual(
      railSections().map((s) => s.label),
      [...HOVER_DOMAIN_ORDER],
      'rail（环境车道/构建验证/模块文档/质量安全/交付发布）与悬停行名必须逐字一致',
    );
    assert.deepStrictEqual(
      railSections().map((s) => s.label),
      ['环境车道', '构建验证', '模块文档', '质量安全', '交付发布'],
      '§5.1 定稿：五个名字、四个字、不带"与"',
    );
  });

  it('Slot 标题 = `<rail 定稿名>：<对象>`（跨域控制台用中性前缀；品牌名只留在唯一页签上）', () => {
    // 「输出」与「任务」是**跨域**的（不属于任何一条 rail 车道），所以它们有中性前缀；
    // 这条例外比“给每个视图发一个前缀”安全：允许集合就两个来源（rail 名 / 跨域名单）。
    const known = new Set([...railSections().map((s) => s.label), '设置', '输出', '任务']);
    for (const [id, title] of Object.entries(SLOT_TITLES)) {
      const prefix = title.split('：')[0];
      assert.ok(
        known.has(prefix),
        `Slot ${id} 的标题「${title}」前缀不在定稿名单里（${[...known].join(' / ')}）`,
      );
      assert.strictEqual(title.split('：').length, 2, `Slot ${id} 的标题形状应为「领域：对象」`);
    }
  });

  it('段名/card 名不许出现"与"（rail 定稿名的硬规矩）', () => {
    for (const sec of railSections()) {
      assert.ok(!sec.label.includes('与'), `段名「${sec.label}」不许带"与"（§5.1）`);
    }
  });
});

describe('§5.5 状态词表：进行时只说"正在做什么"', () => {
  it('进行时文案里不许混入历史结果词（成功/失败/通过）', () => {
    const bad: string[] = [];
    for (const action of BUSY_ACTIONS as readonly BusyAction[]) {
      const text = statusText(action);
      if (/成功|失败|通过|完成/u.test(text)) {
        bad.push(`${action} → 「${text}」：进行时文案里不许出现历史结果词`);
      }
    }
    assert.deepStrictEqual(bad, [], bad.join('\n'));
  });

  it('每个忙动作都有进行时文案（退回 id 也算一种"没写"）', () => {
    for (const action of BUSY_ACTIONS as readonly BusyAction[]) {
      const text = statusText(action);
      assert.ok(text !== action, `${action} 没有进行时文案（不该退回 id）`);
      assert.ok(text.length >= 2, `${action} 的进行时文案太短：${text}`);
    }
  });
});

describe('§5.1 / C6 模块入口：AI 框架设计&实现（带设计稿维度）', () => {
  const card = allCards().find((c) => c.id === 'moduleAgent');

  it('卡片名就是定稿名，且写清输入/产物/落盘', () => {
    assert.ok(card, 'moduleAgent 卡必须存在');
    assert.strictEqual(card!.label, 'AI 框架设计&实现', '§5.1 定稿名');
    const sub = card!.sub ?? '';
    for (const [what, re] of [
      ['输入', /输入[:：]/u],
      ['产物', /产物[:：]/u],
      ['落盘', /落盘[:：]/u],
    ] as const) {
      assert.match(sub, re, `卡片要说清「${what}」：${sub}`);
    }
    assert.match(sub, /PlantUML/u, '输入维度里要有设计框图（PlantUML）');
    assert.match(sub, /PRD/u, '输入维度里要有 PRD');
  });

  it('预填带**设计稿回填 tag**，口径与 /het-module 技能一致', () => {
    const entry = copilotEntryFor('/het-module');
    assert.ok(entry, '/het-module 必须在入口表里');
    const text = prefillText(entry!);
    assert.ok(text.startsWith('/het-module '), '命令必须在最前（否则斜杠命令不生效）');
    assert.match(text, /\[workspace\/design\/\*\.md\]/u, '必须给出设计稿路径回填 tag（如 [workspace/design/*.md]）');
    assert.match(text, /PRD/u, '预填要说清 PRD 维度');
    assert.match(text, /PlantUML/u, '预填要说清设计框图维度');
    assert.match(text, /确认后/u, '落盘前必须有人确认（越权写盘不可接受）');
    assert.strictEqual(card!.fact, entry!.expect, '卡片预期与入口表必须同源');
  });

  it('命令面板里的标题也不许出现黑名单词（它是用户可见文案）', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      contributes: { commands: { command: string; title: string }[] };
    };
    const bad = pkg.contributes.commands
      .filter((c) => BLACKLIST.some(({ word, allow }) => (allow ? c.title.replace(allow, '·') : c.title).includes(word)))
      .map((c) => `${c.command} → ${c.title}`);
    assert.deepStrictEqual(bad, [], `命令标题命中术语黑名单：\n${bad.join('\n')}`);
  });
});
