/**
 * J 块门禁：**任务中心 = 只读观测**（计划 §6-J / G21）。
 *
 * 三条要钉住的（错了都会静默变坏）：
 *   1. **模型只来自事实**：结论/耗时/进度/归属全部从 Task（或 CI 事实）推导 ——
 *      门禁用"哨兵值"证明渲染是数据驱动的，而不是把文案写死在 HTML 里；
 *   2. **动作按钮 ≤1 种**：渲染出来的 `data-act` 只允许 `taskCancel`。要构建/测试/发布
 *      就去对应段 —— 这里多一个按钮，任务中心就变成了第二个操作面板（计划明确不做）；
 *   3. **拿不到 CI 状态要显式说明**（原因 + 怎么办），不许留空白（§F.43 的口径）。
 */
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  RECENT_LIMIT,
  agoText,
  ciGlyph,
  durationText,
  taskCenterModel,
  type CiInput,
} from '../core/taskCenter';
import { TaskStore, STATE_TEXT, exitWord } from '../core/tasks';
import { INTENTS } from '../core/intents';
import { chipHoverActions } from '../features/statusChip';
import { taskCenterHtml } from '../features/tasks/html';
import { taskCenterPageHtml } from '../features/tasks/page';
import { COCKPIT_RESERVED_TYPES } from '../features/slots/protocol';

const NOW = 1_700_000_000_000;

function store(): TaskStore {
  return new TaskStore(() => NOW);
}

/** 一个"正在跑"的任务 + 一个"已完成"的任务（走真实状态机，不手搓对象）。 */
function twoTasks(): TaskStore {
  const s = store();
  s.dispatch({ action: 'build', label: '编译打包', owner: 'card', deadlineKind: 'build' });
  s.start('build');
  s.heartbeat('build', 42, '编译中');
  s.dispatch({ action: 'envCheck', label: '检查环境', owner: 'card', deadlineKind: 'misc' });
  s.start('envCheck');
  s.succeed('envCheck', {
    message: '检查环境完成（1.0s）',
    artifacts: [{ label: '环境快照', path: '/tmp/env.json' }],
  });
  return s;
}

describe('§J 任务中心：模型（事实 → 行）', () => {
  it('在跑的进 running、跑完的进 recent；顺序按开始/结束时间', () => {
    const m = taskCenterModel({ tasks: twoTasks().list(), ci: null, now: NOW });
    assert.deepStrictEqual(m.running.map((r) => r.id), ['build']);
    assert.deepStrictEqual(m.recent.map((r) => r.id), ['envCheck']);
    assert.strictEqual(m.running[0].stateText, STATE_TEXT.running);
    assert.strictEqual(m.running[0].glyph, '⟳');
    assert.strictEqual(m.recent[0].stateText, STATE_TEXT.succeeded);
    assert.strictEqual(m.recent[0].glyph, '✓');
  });

  it('数字来自 Task：进度只在真有进度时出现，耗时是算出来的', () => {
    const m = taskCenterModel({ tasks: twoTasks().list(), ci: null, now: NOW });
    assert.strictEqual(m.running[0].progressText, '42%');
    assert.strictEqual(m.running[0].durationText, '0 秒');
    const noProgress = store();
    noProgress.dispatch({ action: 'test', label: '全量测试', owner: 'card', deadlineKind: 'test' });
    noProgress.start('test');
    const m2 = taskCenterModel({ tasks: noProgress.list(), ci: null, now: NOW });
    assert.strictEqual(m2.running[0].progressText, undefined, '没有进度就不许假装有（不写 0%）');
  });

  it('进行中不给"原因"行（心跳文案不是失败原因）', () => {
    const m = taskCenterModel({ tasks: twoTasks().list(), ci: null, now: NOW });
    assert.strictEqual(m.running[0].reasonText, undefined);
    assert.strictEqual(m.running[0].progressText, '42%');
  });

  it('进行中不给"原因"行（心跳文案不是失败原因）', () => {
    const m = taskCenterModel({ tasks: twoTasks().list(), ci: null, now: NOW });
    assert.strictEqual(m.running[0].reasonText, undefined);
    assert.strictEqual(m.running[0].progressText, '42%');
  });

  it('失败给原因 + 下一步；取消/超时**不给**下一步（那是用户/环境造成的）', () => {
    const s = store();
    s.dispatch({ action: 'build', label: '编译打包', owner: 'card', deadlineKind: 'build' });
    s.start('build');
    s.fail('build', { message: '编译打包失败：undefined reference to `main`', errorTail: 'undefined reference to `main`\nline2', nextStep: '看输出通道的完整 tail' });
    s.dispatch({ action: 'test', label: '全量测试', owner: 'card', deadlineKind: 'test' });
    s.start('test');
    s.cancel('test', '用户取消');
    const m = taskCenterModel({ tasks: s.list(), ci: null, now: NOW });
    const failed = m.recent.find((r) => r.id === 'build');
    const cancelled = m.recent.find((r) => r.id === 'test');
    assert.strictEqual(failed?.reasonText, 'undefined reference to `main`', '原因只取第一行（面板一行给结论）');
    assert.strictEqual(failed?.nextStep, '看输出通道的完整 tail');
    assert.strictEqual(cancelled?.stateText, STATE_TEXT.cancelled);
    assert.strictEqual(cancelled?.nextStep, undefined, '取消不该再劝人排错');
    assert.strictEqual(cancelled?.reasonText, '用户取消');
  });

  it('最近完成最多 10 条；动作名取 Intent 术语（不是内部 id）', () => {
    const s = store();
    for (let i = 0; i < 14; i++) {
      const id = `task${i}`;
      s.dispatch({ action: 'build', label: '编译打包', owner: 'card', deadlineKind: 'build', target: id });
      s.start(`build·${id}`);
      s.succeed(`build·${id}`, { message: 'ok' });
    }
    const m = taskCenterModel({ tasks: s.list(), ci: null, now: NOW });
    assert.strictEqual(m.recent.length, RECENT_LIMIT);
    assert.strictEqual(m.recent[0].label, '编译打包', '领域术语名来自 Intent 表');
    assert.ok(!m.recent.some((r) => r.label.includes('·')), '不显示内部幂等键');
  });

  it('产物链接来自 Task.artifacts（面板不猜目录）', () => {
    const m = taskCenterModel({ tasks: twoTasks().list(), ci: null, now: NOW });
    assert.deepStrictEqual(
      m.recent[0].artifacts.map((a) => a.label),
      ['环境快照'],
    );
    assert.strictEqual(m.recent[0].artifacts[0].path, '/tmp/env.json');
  });

  it('时间/结论的口径是纯函数（可复现，不依赖本地时区）', () => {
    assert.strictEqual(durationText(8_000), '8 秒');
    assert.strictEqual(durationText(65_000), '1 分 5 秒');
    assert.strictEqual(durationText(3_600_000), '1 小时 0 分');
    assert.strictEqual(agoText(3_000), '刚刚');
    assert.strictEqual(agoText(3 * 60_000), '3 分钟前');
    assert.strictEqual(ciGlyph('success'), '✓');
    assert.strictEqual(ciGlyph('failure'), '✗');
    assert.strictEqual(ciGlyph('cancelled'), '⊘');
    assert.strictEqual(ciGlyph('', 'in_progress'), '⟳');
    assert.strictEqual(ciGlyph('weird'), '·');
  });
});

describe('§J 任务中心：CI 区块（拿不到就显式说明）', () => {
  const base: CiInput = { online: true, repoLabel: 'HeT-FTI/HeT-DevTools', runs: [], actionsUrl: 'https://x/actions' };

  it('在线且有运行记录 → 一行：结论 + 时间 + 链接', () => {
    const m = taskCenterModel({
      tasks: [],
      now: NOW,
      ci: { ...base, runs: [{ name: 'verify', branch: 'main', status: 'completed', conclusion: 'success', createdAt: new Date(NOW - 120_000).toISOString(), url: 'https://x/run/1' }] },
    });
    assert.deepStrictEqual(
      { glyph: m.ci?.glyph, conclusion: m.ci?.conclusion, when: m.ci?.whenText, url: m.ci?.url },
      { glyph: '✓', conclusion: 'success', when: '2 分钟前', url: 'https://x/run/1' },
    );
    assert.strictEqual(m.ciNote, undefined, '拿得到就不写理由');
  });

  it('在线但没有运行记录 → 说明"还没跑过 workflow"，并给可照做的下一步', () => {
    const m = taskCenterModel({ tasks: [], now: NOW, ci: base });
    assert.strictEqual(m.ci, null);
    assert.match(m.ciNote?.reason ?? '', /没有运行记录/u);
    assert.ok((m.ciNote?.fix ?? []).length > 0);
  });

  it('离线/未登录 → 保留上游给的原因与修法（不吞掉、也不留空白）', () => {
    const m = taskCenterModel({
      tasks: [],
      now: NOW,
      ci: { ...base, online: false, reason: 'gh 未登录（401）', fix: ['gh auth login'] },
    });
    assert.strictEqual(m.ci, null);
    assert.strictEqual(m.ciNote?.reason, 'gh 未登录（401）');
    assert.deepStrictEqual(m.ciNote?.fix, ['gh auth login']);
  });

  it('根本没配 origin（`ci: null`）→ 不显示外部区块的结论，也不假装离线', () => {
    const m = taskCenterModel({ tasks: [], now: NOW, ci: null });
    assert.strictEqual(m.ci, null);
    assert.strictEqual(m.ciNote, undefined);
  });
});

describe('§J 任务中心：面板只读（G21 动作 ≤1 种）', () => {
  const model = taskCenterModel({ tasks: twoTasks().list(), ci: null, now: NOW });

  it('渲染出来的动作按钮只有"取消"一种', () => {
    const html = taskCenterHtml(model);
    const acts = [...html.matchAll(/data-act="([^"]+)"/gu)].map((m) => m[1]);
    assert.deepStrictEqual([...new Set(acts)], ['taskCancel'], `只允许取消：${[...new Set(acts)].join('、')}`);
    // 取消按钮只出现在"正在运行"的行上（已完成的行不该有取消）
    assert.strictEqual(acts.length, model.running.length);
    // 不许出现任何"发起动作"的入口（要跑就去对应段）
    for (const forbidden of ['het.build', 'het.test', 'het.docs', 'het.release', 'het.quality', 'het.cacheClean']) {
      assert.ok(!html.includes(forbidden), `任务中心不许出现发起动作的入口：${forbidden}`);
    }
  });

  it('数字/结论全部来自模型（哨兵值直接出现在 HTML 里）', () => {
    const html = taskCenterHtml(model);
    assert.ok(html.includes('编译打包'), '任务名来自模型');
    assert.ok(html.includes('42%'), '进度来自模型');
    assert.ok(html.includes('环境快照'), '产物来自模型');
    assert.ok(!html.includes('undefined'), '不许把 undefined 渲染出来');
  });

  it('空状态给明确文案（不是一片空白）', () => {
    const empty = taskCenterHtml(taskCenterModel({ tasks: [], ci: null, now: NOW }));
    assert.ok(empty.includes('现在没有正在跑的任务'), '正在运行的空状态');
    assert.ok(empty.includes('还没有跑完的任务'), '最近完成的空状态');
    assert.strictEqual([...empty.matchAll(/data-act=/gu)].length, 0, '空状态不该有按钮');
  });

  it('整页只有一段脚本、且不自己取 API（F.29）', () => {
    const page = taskCenterPageHtml(model);
    const code = page.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    // 数 `</script>`（pageShell 注释里提到过 `<script>`，数开始标签会自伤）：
    // pageShell 一段 + 页面体一段 = 2（多了就是页面自己又开了一段脚本）
    assert.strictEqual([...code.matchAll(/<\/script>/gu)].length, 2, 'pageShell 一段 + 页面体一段');
    assert.strictEqual([...code.matchAll(/acquireVsCodeApi\(\)/gu)].length, 1, 'API 只允许 pageShell 取一次');
    // 实时刷新走片段替换（不整页重渲染）
    assert.ok(code.includes("m.type === 'taskCenter'"), '片段刷新要走 taskCenter 消息');
    assert.ok(code.includes('tc-root'), '片段要落在固定容器上');
  });

  it('面板消息类型不与驾驶舱保留类型冲突（否则会被抢处理）', () => {
    const page = taskCenterPageHtml(model);
    const types = [...page.matchAll(/send\(\{\s*type:\s*'([^']+)'/gu)].map((m) => m[1]);
    assert.ok(types.length >= 3, `面板应当发取消/产物/CI 三条消息，实际 ${types.join('、')}`);
    for (const t of types) {
      assert.ok(!COCKPIT_RESERVED_TYPES.includes(t), `${t} 与驾驶舱保留类型同名（会被抢处理）`);
    }
    // 'nav' 是 J 块新加的保留类型（L1 忙点的入口），必须登记
    assert.ok(COCKPIT_RESERVED_TYPES.includes('nav'));
  });
});

describe('§J：入口（忙点 + 悬停）必须指向真实存在的 Intent', () => {
  it('Intent 登记齐：`openTasks` 有命令、有 slot、且不进 CI/不是任务', () => {
    const it = INTENTS.find((i) => i.id === 'openTasks');
    assert.ok(it, '任务中心必须有一条 Intent（否则页面上的入口解析不出命令）');
    assert.strictEqual(it?.kind, 'nav', '它是导航，不是长动作（不会出现"进行中"）');
    assert.strictEqual(it?.command, 'het.openTasks');
    assert.strictEqual(it?.slot, 'tasks');
    assert.strictEqual(it?.ci, null, '本地只读面板没有 CI 对应');
  });

  it('L1 忙点的 `data-nav` 与悬停导航都指向存在的 Intent（防改名后静默失效）', () => {
    const ids = new Set(INTENTS.map((i) => i.id));
    const shell = readFileSync('src/features/cockpit/singlepage/shell.ts', 'utf8');
    const navs = [...shell.matchAll(/data-nav="([\w.]+)"/gu)].map((m) => m[1]);
    assert.deepStrictEqual(navs, ['openTasks'], 'L1 忙点目前只指向任务中心（多一个就多一处要对账）');
    for (const n of navs) {
      assert.ok(ids.has(n), `data-nav="${n}" 不是任何 Intent 的 id —— 点了会没反应`);
    }
    // 悬停卡的导航区同样要对得上（那里的 label 只是文案，command 才是真身）
    for (const a of chipHoverActions().nav) {
      assert.ok(
        INTENTS.some((i) => i.id === a.id && i.command === a.command),
        `悬停导航 ${a.id} → ${a.command} 在 Intent 表里对不上`,
      );
    }
  });
});

describe('§J：终态用词只有一份（输出行与任务中心同字）', () => {
  it('`exitWord` 覆盖三个出口，且与 STATE_TEXT 同源', () => {
    assert.strictEqual(exitWord('timedOut'), STATE_TEXT.timedOut);
    assert.strictEqual(exitWord('cancelled'), STATE_TEXT.cancelled);
    assert.strictEqual(exitWord('failed'), STATE_TEXT.failed);
    // 抛错那一刻任务往往还停在 running（落终态在写日志之后）—— 那也是失败
    assert.strictEqual(exitWord('running'), STATE_TEXT.failed);
    assert.strictEqual(exitWord(undefined), STATE_TEXT.failed);
  });

  it('busy.ts 的终态行用 `exitWord`（不许自己再写一套三选一）', () => {
    const src = readFileSync('src/core/busy.ts', 'utf8');
    assert.ok(src.includes('exitWord(state)'), '终态用词必须来自 STATE_TEXT');
    assert.ok(
      !/state === 'timedOut' \? '超时'/u.test(src),
      '不许再出现手写的三选一用词（那就是第二套口径）',
    );
  });
});
