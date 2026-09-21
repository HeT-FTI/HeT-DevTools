import * as assert from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import {
  CHAT_OPEN_COMMAND,
  COPILOT_CHANNEL,
  COPILOT_DEDUPE_MS,
  COPILOT_ENTRIES,
  COPILOT_PROMPT_MARKER,
  COPILOT_SESSION_TITLE,
  FORBIDDEN_CHAT_COMMANDS,
  RENAME_COMMANDS,
  TITLED_STATE_KEY,
  assertAllowedChatCommand,
  chatOpenArgs,
  copilotEntryFor,
  copilotEntryForCard,
  prefillText,
  renameAttemptOrder,
  shouldHandleEntry,
} from '../features/cockpit/singlepage/copilotEntry';
import { BUSY_ACTIONS, nextStepHint } from '../core/outputChannels';
import { allCards } from '../features/cockpit/singlepage/sections';
import { commandForAction } from '../features/cockpit/singlepage/actions';
import { cockpitSinglePageBody } from '../features/cockpit/singlepage/shell';
import { singlePageModelFrom, EMPTY_FACTS } from '../features/cockpit/singlepage/modelFrom';
import { initialCockpitState } from '../features/cockpit/state';

/**
 * Copilot 入口族 + **单一会话**（G10/G21）的门禁。
 *
 * 用户第二轮第 1 条是硬约束：「session 只开一个，点多少次开多少个就炸了」——
 * 所以这里大部分断言不是"功能对不对"，而是"**不可能**炸出第二个会话"。
 */
describe('Copilot 入口与单会话守卫（G10/G21）', () => {
  const read = (p: string): string => readFileSync(join('src', p), 'utf8');

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        walk(p, out);
      } else if (name.endsWith('.ts')) {
        out.push(p);
      }
    }
    return out;
  }

  it('入口齐备：斜杠命令 / 忙语义动作 / 卡片 三者互相认得', () => {
    assert.strictEqual(COPILOT_ENTRIES.length, 5, '§8 的四个 + §F.44 的 /het-module');
    const cards = new Set(allCards().map((c) => c.id));
    const actions = new Set<string>(BUSY_ACTIONS);
    for (const e of COPILOT_ENTRIES) {
      assert.ok(e.command.startsWith('/het-'), `${e.command} 必须是 /het-* 斜杠命令`);
      assert.ok(actions.has(e.action), `${e.action} 必须在 core/outputChannels 登记（否则没有输出去处）`);
      assert.ok(cards.has(e.card), `${e.card} 必须是 sections.ts 里真实存在的卡片`);
      assert.ok(e.expect.length > 0, `${e.command} 要说清预期产物（§8 Phase 1）`);
      assert.ok(e.hint.length > 0, `${e.command} 要有上下文提示`);
    }
    assert.deepStrictEqual(
      COPILOT_ENTRIES.map((e) => e.command),
      ['/het-commit', '/het-docs', '/het-testgen', '/het-module', '/het-setup'],
    );
    assert.strictEqual(copilotEntryFor('/het-nope'), undefined);
    assert.strictEqual(copilotEntryForCard('env')?.command, '/het-setup');
  });

  it('预填正文：命令在最前（否则斜杠命令不生效），标记在末尾', () => {
    for (const e of COPILOT_ENTRIES) {
      const text = prefillText(e);
      assert.ok(text.startsWith(`${e.command} `), `${e.command} 必须在最前，实际：${text.slice(0, 20)}`);
      assert.ok(!text.startsWith(COPILOT_PROMPT_MARKER), '标记放最前会让 /het-* 变成普通文本 —— 不许放最前');
      assert.ok(text.trimEnd().endsWith(COPILOT_PROMPT_MARKER), '标记要留在文末（可检索）');
    }
    assert.deepStrictEqual(chatOpenArgs('x'), { query: 'x', isPartialQuery: true }, '预填而不自动发送');
  });

  it('§8.1 铁律 1：只允许 workbench.action.chat.open，且禁止清单一个都不能被执行', () => {
    assertAllowedChatCommand(CHAT_OPEN_COMMAND); // 不抛
    assert.strictEqual(CHAT_OPEN_COMMAND, 'workbench.action.chat.open');
    assert.ok(FORBIDDEN_CHAT_COMMANDS.length >= 5, '禁止清单不能退化成空壳');
    for (const bad of FORBIDDEN_CHAT_COMMANDS) {
      assert.throws(() => assertAllowedChatCommand(bad), /铁律 1/, `${bad} 必须被拒`);
      assert.ok(!RENAME_COMMANDS.includes(bad), `${bad} 不能混进改名候选`);
      assert.notStrictEqual(bad, CHAT_OPEN_COMMAND);
    }
    assert.throws(() => assertAllowedChatCommand('workbench.action.chat.somethingElse'), /铁律 1/);
  });

  it('§8.1 铁律 1（源码级）：除声明处外，非测试代码不得出现任何"新建会话"命令', () => {
    const decl = join('src', 'features', 'cockpit', 'singlepage', 'copilotEntry.ts');
    const offenders: string[] = [];
    for (const file of walk(join('src'))) {
      // 测试里当然要写出这些名字才能"证明它们被禁了"（声明处同理）
      if (file === decl || file.includes(`${sep}test${sep}`)) {
        continue;
      }
      const text = read(file.slice(join('src').length + 1));
      for (const bad of FORBIDDEN_CHAT_COMMANDS) {
        if (text.includes(bad)) {
          offenders.push(`${file} → ${bad}`);
        }
      }
      for (const pat of ['openNewSession', 'openNewChat', 'newSessionSidebar']) {
        if (text.includes(pat)) {
          offenders.push(`${file} → ${pat}`);
        }
      }
    }
    assert.deepStrictEqual(offenders, [], '铁律 1 破功：出现了新建会话/新建聊天入口');
    // 控制器不许自己拼命令字符串（必须用常量），否则改名/换命令会漏改
    const ctl = read(join('features', 'cockpit', 'controller.ts'));
    assert.ok(!ctl.includes(`'${CHAT_OPEN_COMMAND}'`), '控制器要用 CHAT_OPEN_COMMAND 常量，不要写字符串');
  });

  it('§8.1 铁律 2：同一入口 1.5s 内只当一次；不同入口 / 过了窗口照常放行', () => {
    assert.strictEqual(COPILOT_DEDUPE_MS, 1500);
    let gate = { lastAt: 0, lastCommand: '' };
    const t0 = 1_000_000;
    const first = shouldHandleEntry(gate, '/het-commit', t0);
    assert.strictEqual(first.handle, true);
    gate = first.next;
    const second = shouldHandleEntry(gate, '/het-commit', t0 + 200);
    assert.strictEqual(second.handle, false, '200ms 内重复点击必须被吞掉');
    assert.ok(second.reason?.includes('重复点击'));
    assert.deepStrictEqual(second.next, gate, '被吞掉的点击不能推进闸门（否则连点永远进不去）');
    const other = shouldHandleEntry(gate, '/het-docs', t0 + 300);
    assert.strictEqual(other.handle, true, '换一条命令不算重复（还是同一个会话）');
    const later = shouldHandleEntry(other.next, '/het-commit', t0 + 2000);
    assert.strictEqual(later.handle, true, '过了窗口要能再点');
  });

  it('§8.1 铁律 3：改名只按优先级试"本机真的存在"的命令', () => {
    assert.strictEqual(renameAttemptOrder([]).length, 0, '没有就一个都不调（别赌）');
    assert.deepStrictEqual(renameAttemptOrder([RENAME_COMMANDS[1]]), [RENAME_COMMANDS[1]]);
    assert.deepStrictEqual(
      renameAttemptOrder([RENAME_COMMANDS[1], RENAME_COMMANDS[0], 'other.command']),
      [RENAME_COMMANDS[0], RENAME_COMMANDS[1]],
      '按优先级，不看输入顺序',
    );
    assert.ok(TITLED_STATE_KEY.startsWith('het.'), '记账键要在 het.* 命名空间');
    assert.ok(COPILOT_SESSION_TITLE.includes('HeT DevTools Agent'), '标题就是用户要求那一个');
  });

  it('卡片上的"预期产物"与入口定义同源（不许两处文案各说一套）', () => {
    const model = singlePageModelFrom(initialCockpitState(), EMPTY_FACTS);
    for (const e of COPILOT_ENTRIES) {
      const card = model.cards.find((c) => c.id === e.card);
      assert.ok(card, `${e.card} 必须在模型里`);
      if (e.card === 'env') {
        // /het-setup 挂在环境卡的**次级**按钮上（那张卡的 fact 是运行时事实，不能被预期覆盖）
        assert.strictEqual(card.fact, '—', '没有事实时就是 —（不编造）');
        assert.deepStrictEqual(
          card.extra?.map((a) => a.id),
          ['/het-setup'],
          '环境卡要有"让 Copilot 讲清楚"；E 块删了"去准备环境"跳转（只读摘要段没了，执行入口就在这一段）',
        );
        continue;
      }
      assert.strictEqual(card.stage, 'chat', `${e.card} 的详情去处是 Chat`);
      assert.strictEqual(card.fact, e.expect, `${e.card} 的预期产物要与 COPILOT_ENTRIES 一致`);
      assert.strictEqual(card.action?.kind, 'copilot', `${e.card} 的主按钮是 Copilot 入口`);
      assert.strictEqual(card.action?.id, e.command, `${e.card} 的主按钮要指向 ${e.command}`);
    }
  });

  it('回执：点过之后卡片给出「发了什么 + 什么时候」；失败给"需要你执行"（§6 / §19.1 ①）', () => {
    const okModel = singlePageModelFrom(initialCockpitState(), {
      copilot: { card: 'commit', ok: true, at: '14:05:01', command: '/het-commit' },
    });
    const okCard = okModel.cards.find((c) => c.id === 'commit')!;
    assert.strictEqual(okCard.state, 'ok');
    assert.ok(okCard.fact.includes('/het-commit'), `①：要说清发了哪条命令，实际：${okCard.fact}`);
    assert.ok(okCard.fact.includes('14:05:01'), `①：要给时间戳，实际：${okCard.fact}`);
    const badModel = singlePageModelFrom(initialCockpitState(), {
      copilot: { card: 'commit', ok: false, at: '14:05:01', command: '/het-commit' },
    });
    const badCard = badModel.cards.find((c) => c.id === 'commit')!;
    assert.strictEqual(badCard.state, 'warn');
    assert.ok(badCard.next?.startsWith('需要你执行：'), `失败要给人工步骤，实际：${badCard.next}`);
    assert.ok(badCard.next?.includes('/het-commit'), '人工步骤里要有可复制的命令');
    // 回执不许"串台"：只覆盖被点的那张卡；也不能覆盖运行时事实（环境卡）
    const other = badModel.cards.find((c) => c.id === 'docsAuthoring')!;
    assert.strictEqual(other.fact, copilotEntryFor('/het-docs')!.expect);
    const envModel = singlePageModelFrom(initialCockpitState(), {
      env: { provider: 'linux-managed', ready: true, selfHeal: true },
      copilot: { card: 'env', ok: true, at: '14:05:01' },
    });
    const envCard = envModel.cards.find((c) => c.id === 'env')!;
    assert.ok(!envCard.fact.includes('已打开'), `环境卡的运行时事实不能被入口回执覆盖：${envCard.fact}`);
  });

  it('页面接线：Copilot 分支必须在 data-action 判定之前（否则点了没反应）', () => {
    const body = cockpitSinglePageBody(singlePageModelFrom(initialCockpitState(), EMPTY_FACTS));
    const cpIdx = body.indexOf("closest('[data-copilot]')");
    const actIdx = body.indexOf("closest('[data-action]')");
    assert.ok(cpIdx > 0 && actIdx > 0, '两个分支都要在');
    assert.ok(cpIdx < actIdx, 'F.29 教训：分支顺序错了按钮就是死的（copilot 只带 data-copilot）');
    assert.ok(body.includes(`send({ type: 'copilot', command:`), '要有 copilot 上报');
    assert.ok(body.includes(`m.type === 'copilotResult'`), '宿主回执要有处理（含失败态）');
    assert.ok(body.includes('让 Copilot 讲清楚'), '环境卡要有 /het-setup 入口（第二轮第 7 条）');
    assert.ok(body.includes('data-copilot="/het-setup"'), '它就是走 copilot 协议的按钮');
    assert.ok(!body.includes('进行中…</button>'), '不要把"进行中…"写死在页面里');
  });

  it('控制器接线：走统一忙语义 + 单会话守卫 + 回执', () => {
    const ctl = read(join('features', 'cockpit', 'controller.ts'));
    assert.ok(ctl.includes('runWithBusy('), 'Copilot 入口要走统一忙语义（§7）');
    assert.ok(ctl.includes('shouldHandleEntry('), '要用闸门（§8.1 铁律 2）');
    assert.ok(ctl.includes('ensureSessionTitle('), '要有命名尝试（§8.1 铁律 3）');
    assert.ok(ctl.includes('assertAllowedChatCommand(CHAT_OPEN_COMMAND)'), '执行前要过守卫');
    assert.ok(ctl.includes('copilotEntryFor('), '命令必须在入口表里登记过');
    assert.ok(ctl.includes(`type: 'copilotResult'`), '要回执给页面');
    assert.ok(ctl.includes('copilot: { card:'), '要回执到卡片事实');
    assert.ok(ctl.includes('clipboard.writeText('), '自动打开不可用时要能退化为剪贴板');
    assert.ok(ctl.includes('vscode.commands.getCommands('), '改名命令要先探测存在性');
    assert.ok(!ctl.includes('createOutputChannel('), '通道创建只在 busyHost 一处');
  });

  it('G11 文档双入口：Copilot 补注释与本地编译是两张卡，各走各的路', () => {
    const body = cockpitSinglePageBody(singlePageModelFrom(initialCockpitState(), EMPTY_FACTS));
    assert.ok(body.includes('data-copilot="/het-docs"'), '补注释卡要发 Copilot 入口');
    assert.ok(body.includes('data-act="docsRun"'), '编译卡要走本地文档命令');
    const model = singlePageModelFrom(initialCockpitState(), EMPTY_FACTS);
    const author = model.cards.find((c) => c.id === 'docsAuthoring')!;
    const build = model.cards.find((c) => c.id === 'docsBuild')!;
    assert.strictEqual(author.action?.kind, 'copilot');
    assert.strictEqual(build.action?.kind, 'action', '编译文档不能反过来变成 Copilot 入口');
    assert.ok(build.fact.includes('不经 Chat'), `要让用户看出本地编译不需要 Chat：${build.fact}`);
  });

  it('G12 智能提交：主按钮是 Copilot，旧面板只做兜底；③ 只能"提示"不能自动 push', () => {
    const model = singlePageModelFrom(initialCockpitState(), EMPTY_FACTS);
    const commit = model.cards.find((c) => c.id === 'commit')!;
    const manual = model.cards.find((c) => c.id === 'commitManual')!;
    assert.strictEqual(commit.action?.id, '/het-commit');
    assert.ok(manual.label.includes('兜底'), `旧提交面板必须自认兜底，实际：${manual.label}`);
    assert.ok(
      allCards().findIndex((c) => c.id === 'commit') < allCards().findIndex((c) => c.id === 'commitManual'),
      '兜底要排在智能提交后面（§19.1）',
    );
    // ③ 的 Phase 1 形态：一个 "推送提示" 按钮，且它只能开终端写注释
    assert.deepStrictEqual(commit.extra?.map((a) => a.id), ['pushHint']);
    assert.strictEqual(commandForAction('pushHint'), 'het.pushHint');
    const ext = read(join('extension.ts'));
    assert.ok(ext.includes(`registerCommand('het.pushHint'`), '命令要真的注册');
    assert.ok(ext.includes('sendText(') && ext.includes(', false);'), '只写不回车（不执行、不 push）');
    assert.ok(
      !/sendText\([^)]*git push[^)]*true\)/.test(ext),
      '绝不允许自动执行 git push（§19.1 ③）',
    );
  });

  it('G13 测试生成去 A/B：用户可见文案只见「从代码 / 从蓝图」', () => {
    const model = singlePageModelFrom(initialCockpitState(), EMPTY_FACTS);
    const card = model.cards.find((c) => c.id === 'testgen')!;
    assert.ok(card.fact.includes('从代码') && card.fact.includes('从蓝图'), `实际：${card.fact}`);
    const entry = copilotEntryFor('/het-testgen')!;
    for (const text of [card.fact, entry.hint, entry.expect]) {
      assert.ok(!/Mode\s*[AB]|模式\s*[AB]|A\/B/.test(text), `不许再出现 A/B 术语：${text}`);
    }
  });

  it('busyHost：通道创建单点、不抢焦点、Copilot 记账通道不 reveal', () => {
    const h = read(join('features', 'busyHost.ts'));
    assert.ok(h.includes('vscode.window.createOutputChannel('), '通道在这里创建');
    assert.ok(h.includes('ch.show(true)'), 'show(true) = preserveFocus，别打断用户');
    assert.ok(h.includes('name !== COPILOT_CHANNEL'), 'Copilot 记账通道不许抢焦点（会盖住刚打开的 Chat）');
    assert.ok(h.includes('register?.(ch)'), '通道要能交给调用方释放');
  });

  it('设置项 `het.copilot.renameSession`：默认开、中英文案齐全', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      contributes: { configuration: { properties: Record<string, { default?: unknown }> } };
    };
    const prop = pkg.contributes.configuration.properties['het.copilot.renameSession'];
    assert.ok(prop, '设置项必须声明（否则读了也是 undefined）');
    assert.strictEqual(prop.default, true, '默认要尝试命名（用户明确要这个标题）');
    for (const nls of ['package.nls.json', 'package.nls.zh-cn.json']) {
      const dict = JSON.parse(readFileSync(nls, 'utf8')) as Record<string, string>;
      assert.ok(dict['config.copilotRenameSession'], `${nls} 缺文案`);
      assert.ok(
        dict['config.copilotRenameSession'].includes('HeT DevTools Agent'),
        `${nls} 文案要点明标题是什么`,
      );
    }
    const ctl = read(join('features', 'cockpit', 'controller.ts'));
    assert.ok(ctl.includes("getConfiguration('het.copilot')"), '控制器要真的读这个设置');
  });

  it('失败要给出人工下一步（每个 Copilot 入口都有）', () => {
    for (const e of COPILOT_ENTRIES) {
      const hint = nextStepHint(e.action);
      assert.ok(hint.includes(e.command), `${e.action} 的下一步要点名命令：${hint}`);
      assert.ok(hint.includes('Chat'), `${e.action} 的下一步要说在哪儿执行`);
    }
    assert.strictEqual(COPILOT_CHANNEL, 'HeT DevTools · Copilot');
  });
});
