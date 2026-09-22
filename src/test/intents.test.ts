/**
 * **Intent Registry 门禁**（计划 §3.4 / §6-I / G19·G20·G16·G22）。
 *
 * 这块的门禁价值在于：**新增一个动作只要填一行表**，而"填漏了"必须当场红。
 * 以前动作信息散在四处（卡片按钮 / 悬停 label / 命令面板 / Copilot 入口），
 * 用户看到的是"点了没反应、状态不变、不知道该去哪看输出"—— 全是可机器检查的。
 *
 * 覆盖：
 *   · G19  字段齐全（五件套：status / output / prompt-or-none / slot? / vscode / onFail / ci）
 *   · G20  要么有 prompt，要么**显式**声明"本动作无 prompt"（禁止哑动作）
 *   · G16  CI 映射与模板里真实的 workflow/job 对账
 *   · G22  必备输入 tag 必须真的出现在预填里
 *   · 入口一致：卡片动作 / 悬停动作 / Copilot 入口 / 卡片预期文案 全部来自同一张表
 */
import * as assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEADLINE_KINDS } from '../core/deadlines';
import { INTENTS, ciSubtitle, intentFor, intentGaps } from '../core/intents';
import { BUSY_ACTIONS } from '../core/outputChannels';
import { HOVER_DOMAIN_ORDER } from '../core/statusItem';
import { chipHoverActions } from '../features/statusChip';
import { COPILOT_ENTRIES, prefillText } from '../features/cockpit/singlepage/copilotEntry';
import { allCards } from '../features/cockpit/singlepage/sections';

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
  contributes: { commands: { command: string; title: string }[] };
};
const declaredCommands = new Set(pkg.contributes.commands.map((c) => c.command));

/** 模板里真实的 workflow → job 名单（与用户仓库同一份来源）。 */
function workflowJobs(workflow: string): string[] {
  const file = join('assets', 'template', '.github', 'workflows', workflow);
  if (!existsSync(file)) {
    return [];
  }
  // job 定义形如 `  <job-id>:`（两个空格缩进）；workflow_call / on 等不算
  return [...readFileSync(file, 'utf8').matchAll(/^ {2}([a-z][a-z0-9_-]*):$/gmu)].map((m) => m[1]);
}

describe('G19 Intent 表字段齐全（缺一即失败）', () => {
  it('每条 Intent 的"定向落地契约"都不缺项', () => {
    const bad: string[] = [];
    for (const it of INTENTS) {
      const gaps = intentGaps(it);
      if (gaps.length) {
        bad.push(`${it.id}：${gaps.join('；')}`);
      }
    }
    assert.deepStrictEqual(bad, [], `Intent 表有缺口：\n${bad.join('\n')}`);
  });

  it('id / 命令唯一，幂等键不许空', () => {
    const ids = INTENTS.map((it) => it.id);
    assert.strictEqual(new Set(ids).size, ids.length, 'Intent id 不能重复');
    const idems = INTENTS.map((it) => it.idem);
    assert.strictEqual(new Set(idems).size, idems.length, `幂等键不能重复（重复点击会被当成同一件事）：${idems.join(',')}`);
    const commands = INTENTS.map((it) => it.command);
    assert.strictEqual(new Set(commands).size, commands.length, '同一命令不能让两条 Intent 都占（否则分不清是谁在跑）');
  });

  it('超时类别只引用 §3.5 定稿表（不在 Intent 里复制数字）', () => {
    for (const it of INTENTS) {
      assert.ok(
        (DEADLINE_KINDS as readonly string[]).includes(it.deadline),
        `${it.id} 的超时类别 ${it.deadline} 不在 deadlines.ts 定稿表里`,
      );
    }
  });

  it('所有非导航动作都声明了输出域（禁止"跑完不知道去哪看"）', () => {
    const missing = INTENTS.filter((it) => it.kind !== 'nav' && !it.output).map((it) => it.id);
    assert.deepStrictEqual(missing, [], `这些动作没有输出域：${missing.join('、')}`);
  });
});

describe('G20 prompt 出口：有 prompt 或显式说明"无"', () => {
  it('不存在哑动作（既没有 prompt，又没写清为什么没有）', () => {
    const mute = INTENTS.filter((it) => !it.prompt && !it.promptNone).map((it) => it.id);
    assert.deepStrictEqual(mute, [], `哑动作：${mute.join('、')}`);
  });

  it('"无 prompt"的动作必须给出替代路径（不是一句"没有"）', () => {
    for (const it of INTENTS.filter((x) => !x.prompt)) {
      assert.ok(
        (it.promptNone ?? '').length >= 12,
        `${it.id} 的 promptNone 太短：要说清"结论/产物在哪看"`,
      );
    }
  });

  it('/het-* 入口全部来自 Intent 表（命令、预填、预期产物同源）', () => {
    assert.ok(COPILOT_ENTRIES.length >= 5, '入口表不能退化成空壳');
    for (const e of COPILOT_ENTRIES) {
      const it = intentFor(e.action);
      assert.ok(it, `${e.action} 必须是登记过的 Intent`);
      assert.strictEqual(it!.prompt?.command, e.command, `${e.action} 的命令要与 Intent 一致`);
      assert.strictEqual(it!.prompt?.expect, e.expect, `${e.action} 的预期产物要与 Intent 一致`);
      assert.strictEqual(it!.prompt?.hint, e.hint, `${e.action} 的预填正文要与 Intent 一致`);
    }
    // 反向：Intent 表里的 Copilot 动作不许漏进入口表
    const copilotIntents = INTENTS.filter((it) => it.kind === 'copilot').map((it) => it.id);
    const inEntries = COPILOT_ENTRIES.map((e) => e.action);
    assert.deepStrictEqual(
      copilotIntents.filter((id) => !inEntries.includes(id)),
      [],
      'Copilot 类 Intent 必须出现在入口表里（否则按钮发出去没人接）',
    );
  });
});

describe('G22 必备输入 tag 真的进了预填', () => {
  it('每个 prompt 的 required tag 都在预填文本里', () => {
    const bad: string[] = [];
    for (const e of COPILOT_ENTRIES) {
      const it = intentFor(e.action)!;
      const text = prefillText(e);
      for (const tag of it.prompt!.required) {
        if (!text.includes(tag)) {
          bad.push(`${e.command} 的预填缺必备 tag ${tag}`);
        }
      }
    }
    assert.deepStrictEqual(bad, [], bad.join('\n'));
  });

  it('设计类入口必须带设计稿维度（PRD + PlantUML 回填 tag）', () => {
    const module = copilotEntryOf('/het-module');
    assert.match(module, /\[design: workspace\/design\/\*\.md\]/u, '设计稿 tag 必须出现在预填里');
    assert.match(module, /\[uml: \*\.puml\]/u, '框图 tag 必须出现在预填里');
    assert.match(module, /PRD/u);
    assert.match(module, /PlantUML/u);
  });
});

describe('G16 CI 映射与模板里真实 workflow/job 对账', () => {
  it('每条 ci 映射都指向真实存在的 workflow 与 job', () => {
    const bad: string[] = [];
    for (const it of INTENTS) {
      if (!it.ci) {
        continue;
      }
      const jobs = workflowJobs(it.ci.workflow);
      if (jobs.length === 0) {
        bad.push(`${it.id} → ${it.ci.workflow} 不存在（模板里没这个 workflow）`);
        continue;
      }
      if (!jobs.includes(it.ci.job)) {
        bad.push(`${it.id} → ${it.ci.workflow} 里没有 job 「${it.ci.job}」（实际：${jobs.join(' / ')}）`);
      }
    }
    assert.deepStrictEqual(bad, [], `CI 映射对不上：\n${bad.join('\n')}`);
  });

  it('本地动作显式声明"无 CI 对应"（而不是留空让人猜）', () => {
    for (const it of INTENTS.filter((x) => !x.ci)) {
      assert.ok(it.localOnly === true, `${it.id} 没有 CI 映射时必须显式声明 localOnly`);
      assert.strictEqual(ciSubtitle(it), '仅本地 · 无 CI 对应', '副标题要写出来');
    }
    for (const it of INTENTS.filter((x) => x.ci)) {
      assert.strictEqual(it.localOnly, undefined, `${it.id} 有 CI 映射就不该再标 localOnly`);
      assert.match(ciSubtitle(it), /^CI: .+ › .+$/u, '有 CI 的动作副标题必须点出 workflow › job');
    }
  });
});

describe('入口一致：卡片 / 悬停 / 忙语义 都指向同一张表', () => {
  it('卡片上的每个动作都能在 Intent 表里查到', () => {
    const missing = new Set<string>();
    for (const c of allCards()) {
      for (const [where, a] of Object.entries({ action: c.action, secondary: c.secondary })) {
        if (a && a.kind === 'action' && !intentFor(a.id)) {
          missing.add(`${c.id}.${where}=${a.id}`);
        }
      }
      for (const a of c.extra ?? []) {
        if (a.kind === 'action' && !intentFor(a.id)) {
          missing.add(`${c.id}.extra=${a.id}`);
        }
      }
    }
    assert.deepStrictEqual([...missing], [], `卡片动作没登记为 Intent：${[...missing].join('、')}`);
  });

  it('悬停动作 ⊆ Intent 表，且域行名与 rail 定稿名一致', () => {
    const { actions, nav } = chipHoverActions();
    for (const a of [...actions, ...nav]) {
      assert.ok(intentFor(a.id), `悬停动作 ${a.id} 没登记为 Intent（悬停能做、页内不知道为什么做）`);
    }
    assert.deepStrictEqual(
      [...HOVER_DOMAIN_ORDER],
      ['环境车道', '构建验证', '模块文档', '质量安全', '交付发布'],
      '悬停的五行就是 rail 定稿名（同一串字，不许各写各的）',
    );
  });

  it('每个忙动作都能反查到 Intent（否则状态项说不清"这是谁在跑"）', () => {
    const orphans = (BUSY_ACTIONS as readonly string[]).filter(
      (a) => !INTENTS.some((it) => it.id === a || it.busy === a),
    );
    // 两个**有理由**的例外（不许默默变长）：
    //   · clean —— 没有卡片入口，它就是 `het.build` 的 UI 叫法（与 build 同一条命令）；
    //   · wslImport —— 由环境准备流程内部触发，没有独立入口。
    assert.deepStrictEqual(
      orphans.sort(),
      ['clean', 'wslImport'],
      `忙动作与 Intent 的对应关系变了：${orphans.join('、')}（要么补 Intent，要么在这里写清理由）`,
    );
  });

  it('命令面板里声明了的动作命令，Intent 表里都认（防改名后两边漂移）', () => {
    for (const it of INTENTS) {
      if (!it.command.startsWith('het.')) {
        continue;
      }
      assert.ok(declaredCommands.has(it.command), `Intent ${it.id} 的命令 ${it.command} 没在 package.json 声明`);
    }
  });
});

/** 取某个 /het-* 入口的预填正文（门禁用的小工具）。 */
function copilotEntryOf(command: string): string {
  const e = COPILOT_ENTRIES.find((x) => x.command === command);
  assert.ok(e, `${command} 必须在入口表里`);
  return prefillText(e!);
}
