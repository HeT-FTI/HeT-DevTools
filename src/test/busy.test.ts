import * as assert from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import {
  beginBusy,
  busyActions,
  endBusy,
  isBusy,
  resetBusy,
  runWithBusy,
  type BusyHost,
} from '../core/busy';
import { intentForBusy } from '../core/intents';
import {
  BUSY_ACTIONS,
  CHANNELS,
  OUTPUT_CHANNEL_NAME,
  channelDef,
  nextStepHint,
  outputChannelNames,
} from '../core/outputChannels';

/** 假 host：把"输出通道 / 忙点 / 完成提示 / 时钟"都记在内存里，便于断言（0 人工）。 */
function fakeHost(start = 1_000): BusyHost & {
  lines: string[];
  busy: string[];
  done: string[];
  at: number;
} {
  const lines: string[] = [];
  const busy: string[] = [];
  const done: string[] = [];
  const self = {
    at: start,
    lines,
    busy,
    done,
    now: () => self.at,
    outputChannel: (name: string) => ({
      appendLine: (line: string) => {
        lines.push(`${name}| ${line}`);
      },
    }),
    notifyBusy: (action: string, on: boolean) => {
      busy.push(`${on ? 'on' : 'off'}:${action}`);
    },
    notifyDone: (action: string, ok: boolean, message: string) => {
      done.push(`${ok ? 'ok' : 'fail'}:${action}:${message}`);
    },
  };
  return self;
}

/**
 * §7「长耗时动作统一语义」的门禁（repo-level）。
 *
 * 用户诉求（材料第 2 条 + 需求 2/8）：**不能让用户以为卡死而反复点击**。
 * 所以这里把"转圈 + 禁用 + 输出有字 + 忙点 + 完成通知 + 幂等"六件事全部断言下来。
 */
describe('长耗时动作的统一语义（§7）', () => {
  it('幂等：同一动作进行中，重复调用被跳过（不排队、不重跑）', async () => {
    resetBusy();
    assert.strictEqual(beginBusy('build'), true);
    assert.strictEqual(beginBusy('build'), false, '第二个调用必须被拒');
    assert.strictEqual(isBusy('build'), true);
    assert.strictEqual(endBusy('build'), true);
    assert.strictEqual(isBusy('build'), false, '结束后可再次开始');
    assert.strictEqual(beginBusy('build'), true);
    resetBusy();
  });

  it('不同动作互不阻塞（构建在跑时仍能检查环境）', () => {
    resetBusy();
    assert.strictEqual(beginBusy('build'), true);
    assert.strictEqual(beginBusy('envCheck'), true);
    assert.deepStrictEqual(busyActions(), ['build', 'envCheck'], '按开始时间排序');
    resetBusy();
  });

  it('成功：开始行含动作名与时间、结束行含耗时；忙点开→关；有完成通知', async () => {
    resetBusy();
    const host = fakeHost();
    const res = await runWithBusy(host, 'build', async () => 'ok', 'conan create');
    assert.strictEqual(res.status, 'done');
    assert.strictEqual(res.out, 'ok');
    // 动作名来自 Intent 表（§5.2 定稿：`build` = 「编译打包」），不再由调用方传字串
    assert.match(host.lines[0], /▶ 编译打包 — conan create/, '开始行带动作名与细节');
    assert.ok(/\[\d{2}:\d{2}:\d{2}\]/.test(host.lines[0]), '开始行带时间戳');
    host.at += 1500;
    assert.deepStrictEqual(host.busy, ['on:build', 'off:build'], '忙点开→关');
    assert.strictEqual(host.done.length, 1);
    assert.match(host.done[0], /^ok:build:编译打包完成/);
    assert.strictEqual(isBusy('build'), false, '结束后注册表必须清空（否则永久禁用）');
  });

  it('失败：把错误写进输出、给出"下一步"、并**清空忙状态**（不卡死）', async () => {
    resetBusy();
    const host = fakeHost();
    const res = await runWithBusy(host, 'envPrepare', async () => {
      throw new Error('apt 不可用');
    });
    assert.strictEqual(res.status, 'failed');
    assert.match(res.error?.message ?? '', /apt 不可用/);
    // 失败行 = `[hh:mm:ss] [env] ✗ 准备托管环境失败（…）：apt 不可用`
    assert.ok(
      host.lines.some((l) => /\[env\] ✗ 准备托管环境失败/u.test(l)),
      `失败行：${host.lines.join(' | ')}`,
    );
    assert.ok(host.lines.some((l) => l.includes('下一步：')), '必须给下一步（§7 第 5 条）');
    assert.deepStrictEqual(host.busy, ['on:envPrepare', 'off:envPrepare']);
    assert.strictEqual(isBusy('envPrepare'), false, '失败也要恢复（否则按钮永久禁用）');
  });

  it('重复点击：第二次返回 skipped，且**不产生第二轮输出/忙点**', async () => {
    resetBusy();
    const host = fakeHost();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const first = runWithBusy(host, 'test', async () => {
      await gate;
      return 1;
    });
    const second = await runWithBusy(host, 'test', async () => 2);
    assert.strictEqual(second.status, 'skipped');
    assert.match(second.message, /正在执行：全量测试/, '告诉用户"已经在跑了"（动作名来自 Intent 表）');
    release?.();
    const done = await first;
    assert.strictEqual(done.status, 'done');
    assert.strictEqual(host.lines.length, 2, '只有第一轮的两行（开始 + 结束）');
    assert.deepStrictEqual(host.busy, ['on:test', 'off:test']);
  });

  it('耗时按注入时钟计算（无人值守下时间断言可复现）', async () => {
    resetBusy();
    const host = fakeHost();
    const p = runWithBusy(host, 'docsBuild', async () => {
      host.at += 2500;
      return null;
    });
    const res = await p;
    assert.strictEqual(res.durationMs, 2500);
    assert.match(res.message, /2\.5s/);
  });

  it('每个动作都登记了输出去处与中文动作名（新增长动作漏登记即失败）', () => {
    assert.ok(BUSY_ACTIONS.length >= 14, '动作清单不能退化成空壳');
    for (const a of BUSY_ACTIONS) {
      const def = CHANNELS[a];
      assert.ok(def, `${a} 必须在 CHANNELS 里登记`);
      assert.ok(def.label.length > 0 && def.label.length <= 8, `${a} 的动作名要短（≤8 字）`);
      assert.ok(nextStepHint(a).length > 0, `${a} 失败时必须能给"下一步"`);
    }
    // D 块：**只有一个** Output 通道（域的区分回到行首标签）
    assert.deepStrictEqual(outputChannelNames(), ['HeT DevTools'], 'Output 下拉里只允许一个名字');
    assert.strictEqual(OUTPUT_CHANNEL_NAME, 'HeT DevTools');
    assert.strictEqual(channelDef('nope'), undefined);
  });

  it('质量门禁走终端、Copilot 入口走 Chat（不是 Output）', () => {
    assert.strictEqual(CHANNELS.quality.kind, 'terminal');
    for (const a of ['commitCopilot', 'docsCopilot', 'testgenCopilot', 'setupCopilot'] as const) {
      assert.strictEqual(CHANNELS[a].kind, 'chat', `${a} 必须由 Copilot 执行`);
    }
  });

  it('登记了输出去处的长动作，必须真的走统一 helper（§7 / §15-3）', () => {
    // 为什么这条门禁要收紧：老断言只是"全仓至少一处用了 runWithBusy" —— 于是
    // `envPrepare` / `build` / `test` / `docsBuild` **压根没接**忙语义，门禁却是绿的
    // （2026-09-20 同事实测："创建环境直接运行不了，output 也没回显，没有忙语义"）。
    // 现在分三段查：显式接线 / 动态接线（Copilot 那四个是数据驱动的）/ 写明理由的例外。
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          walk(p);
        } else if (name.endsWith('.ts') && !p.includes(`${sep}core${sep}busy.ts`)) {
          files.push(p);
        }
      }
    };
    walk(join('src'));
    const text = files.map((f) => readFileSync(f, 'utf8')).join('\n');
    const wired = (id: string): boolean =>
      new RegExp(`runWithBusy\\(\\s*(?:busyHost|host)\\(\\)\\s*,\\s*'${id}'`).test(text);

    assert.deepStrictEqual(
      Object.keys(CHANNELS).sort(),
      [...BUSY_ACTIONS].sort(),
      '两张表必须同一批动作 id（否则"登记了但没人用"会重新长出来）',
    );
    // ① 显式接线：这些是用户直接点的入口，必须逐条在源码里找到
    const explicit = [
      'build',
      'test',
      'envCheck',
      'envPrepare',
      'envRemove',
      'docsBuild',
      'board',
      'cacheClean',
      'targetSwitch',
    ];
    const notWired = explicit.filter((id) => !wired(id));
    assert.deepStrictEqual(notWired, [], `这些长动作没接忙语义：${notWired.join('、')}`);
    // ② 动态接线：Copilot 四个走控制器里的 `runWithBusy(host(), def.action, …)`
    const ctl = readFileSync(join('src', 'features', 'cockpit', 'controller.ts'), 'utf8');
    assert.ok(ctl.includes('runWithBusy('), 'Copilot 入口必须在控制器里走统一 helper');
    assert.match(
      ctl.replace(/\s+/gu, ' '),
      /runWithBusy\( host\(\), def\.action,/u,
      'Copilot 入口是数据驱动（def.action）——形状变了就得同步这条门禁',
    );
    // ③ 例外必须写清理由，且名单不许变长、不许留"已经接好了还挂在名单上"的
    const exceptions: Readonly<Record<string, string>> = {
      clean: '与 build 共用 `het.build` 命令（clean 只是 UI 上的叫法）',
      wslImport: '由 envPrepare 的 provisionLane 内部触发，不是用户直接点的入口',
      quality: '质量门禁直接在终端里跑（kind: terminal），不由扩展托管那段执行',
    };
    const declared = Object.keys(CHANNELS).filter((id) => !explicit.includes(id));
    // I 块后：**唯一的动作表是 `core/intents.ts`** —— 凡是在 Intent 表里登记过的动作，
    // 就已经声明了"输出去哪、超时多少、失败怎么办"，不必再在忙语义里重复接线。
    // 这条门禁的作用因此变成：每个忙动作要么是 Intent，要么在例外名单里写清理由。
    const unexplained = declared.filter(
      (id) => intentForBusy(id) === undefined && exceptions[id] === undefined,
    );
    assert.deepStrictEqual(unexplained, [], `这些动作既不是 Intent 也没写理由：${unexplained.join('、')}`);
    assert.deepStrictEqual(
      Object.keys(exceptions).filter((id) => wired(id)),
      [],
      '已经接线的动作不许继续挂在例外名单里（名单要自我清理）',
    );
    assert.ok(Object.keys(exceptions).length <= 3, '例外名单只允许这三条并写清理由');
    assert.ok(BUSY_ACTIONS.length >= 14, '动作清单不能退化成空壳');
  });

  it('§F.35 忙语义只有一份：chip / 吸顶 / 单页都从 busy 注册表推导', () => {
    const read = (p: string): string => readFileSync(join('src', p), 'utf8');
    const ext = read('extension.ts');

    // ① 状态行（chip 悬停 / 吸顶）的 `running` 必须来自 `currentStatus()`，不许再直接读 log 抽屉的字段
    //    （直读的后果：纯 runWithBusy 动作永远点不亮状态栏）
    const bare = ext.match(/^\s*running: st\.top\.running,\s*$/gmu) ?? [];
    assert.deepStrictEqual(bare, [], 'running 必须走 currentStatus()');
    assert.ok(
      (ext.match(/running: currentStatus\(\)\?\.text/gu) ?? []).length >= 1,
      '状态行要接同一份状态',
    );

    // ② 控制器不许自己造状态文案：忙/闲只能由 `currentStatus()` 判定
    const ctl = read('features/cockpit/controller.ts');
    assert.ok(ctl.includes('currentStatus()'), 'notifySinglePageBusy 要读单一来源');
    assert.match(
      ctl.replace(/\s+/gu, ' '),
      /setSinglePageFacts\(\{ status: st \? /u,
      '忙状态写回 facts 的形状变了就得同步这条门禁',
    );
    assert.ok(
      !/postMessage\(\{ type: 'busy', on: true/u.test(ctl),
      'busy 开关必须由注册表推导（`st !== null`），不许硬编码 on:true',
    );

    // ③ 单页 L1 的忙位必须"有字"（只留一个转圈图标等于没告诉用户在忙什么），
    //    而且 J 块之后它**可点**（→ 任务中心："正在跑什么"就在眼前，点它看全局）
    const shell = read('features/cockpit/singlepage/shell.ts');
    assert.match(
      shell,
      /data-busy data-action="nav" data-nav="openTasks"[^>]*>[\s\S]{0,80}?\$\{esc\(busy\)\}/u,
      'L1 忙位要带文字、且可点进任务中心（§F.35 + J 块）',
    );
    // ⑤ §F.36：动作收尾（注册表排空）必须补一次取数 —— 否则从悬停链接 / 命令面板 /
    //    HUD 触发的动作跑完了，卡片上的数字还要等下一次交互才更新。
    assert.match(
      ctl.replace(/\s+/gu, ' '),
      /if \(had && !st\) \{ requestFacts\(\); \}/u,
      '忙结束时要统一补一次事实刷新（§F.36）',
    );

    // ④ 贴右 + 胶囊化：忙位是"吸顶右侧状态位"，不是行尾灰字
    const tokens = read('features/cockpit/singlepage/tokens.ts');
    const busyCss = /\.busy \{([^}]*)\}/u.exec(tokens)?.[1] ?? '';
    assert.ok(busyCss.includes('margin-left: auto'), '忙位要贴右（吸顶右侧状态位）');
    assert.ok(busyCss.includes('border-radius'), '忙位要做成胶囊，别和正文混在一起');
  });

});
