/**
 * §A 门禁：**页签恒为 1**（驾驶舱）。细节视图全部画在驾驶舱页内的互斥 Slot 里。
 *
 * （本文件取代原来的 `detailHost.test.ts`：那一版允许"驾驶舱 + 细节"两个页签并留着
 * `het.detail.pin` 逃生门；V2 把这两条都推翻了，所以断言整体重写而不是打补丁。）
 *
 * 演进（都是实测反馈逼出来的）：
 *   · V1 初版：16 处 `createWebviewPanel`，点几下工作区就成一排页签（"像页游广告"）；
 *   · V1.5：收敛到"最多两个页签"，但留了 `het.detail.pin` —— 那是**为绕开我自己引入的
 *     限制**买的保险，用户从没用过也看不懂；
 *   · V2：**只有驾驶舱一个页签**，细节视图 = 页内互斥折叠 Slot，pin 删除。
 *
 * 盯五件事（错了都会静默变乱）：
 *   1. `createWebviewPanel` 只允许驾驶舱（+ 白名单，逐项写明理由）；
 *   2. 细节面板必须走 `slots/host`，且必须**接住**订阅并交回宿主撤销；
 *   3. 切换 Slot 的顺序：先撤销旧接线/旧处理器 → 再注入新片段；
 *   4. 旧模块 `features/detail/host.ts` 必须已删（留着就会被重新 import）；
 *   5. pin 的痕迹清干净（半删最糟：manifest 留着命令但代码没了 = "命令未注册"）。
 */
import * as assert from 'node:assert';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { stripComments } from './support/htmlFacts';

const SRC = 'src';
const SLOT_HOST = join(SRC, 'features', 'slots', 'host.ts');
const COCKPIT = join(SRC, 'features', 'cockpit', 'controller.ts');
const HUD = join(SRC, 'features', 'hud', 'panel.ts');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walk(p, out);
    } else if (name.endsWith('.ts') && !name.endsWith('.d.ts') && !p.includes(`${sep}test${sep}`)) {
      out.push(p);
    }
  }
  return out;
}

describe('§A：只有 1 个页签（细节视图 = 驾驶舱页内 Slot）', () => {
  const read = (p: string): string => readFileSync(p, 'utf8');
  const files = walk(SRC);

  it('`createWebviewPanel` 只允许驾驶舱（HUD 是最后一个待并入项，理由写在白名单里）', () => {
    const allowed: Readonly<Record<string, string>> = {
      [COCKPIT]: '驾驶舱：唯一页签',
      [HUD]: 'HUD 监控卡：待 C/E 块并入"悬停档"，届时必须从这里删掉',
    };
    const callers = files.filter((f) => stripComments(read(f)).includes('createWebviewPanel('));
    const unexpected = callers.filter((f) => !(f in allowed));
    assert.deepStrictEqual(
      unexpected,
      [],
      `这些文件自己开页签了（§A 只允许驾驶舱）：${unexpected.join('、')}`,
    );
    assert.ok(callers.includes(COCKPIT), '驾驶舱必须自己开页签（否则白名单逻辑失效）');
    assert.ok(Object.keys(allowed).every((f) => existsSync(f)), '白名单里的文件必须真实存在');
    assert.ok(callers.length <= 2, `开页签的地方变多了（${callers.join('、')}）—— 页签数不再是 1`);
  });

  it('细节面板全部走 slots/host，且都接住了消息订阅并交回宿主撤销', () => {
    const panels = files.filter(
      (f) =>
        f.includes(`${sep}features${sep}`) &&
        f.endsWith('panel.ts') &&
        stripComments(read(f)).includes('showDetailPanel('),
    );
    assert.ok(panels.length >= 13, `走 Slot 宿主的视图太少（${panels.length}）—— 迁移漏了？`);
    for (const f of panels) {
      const src = read(f);
      assert.ok(src.includes("from '../slots/host'"), `${f}: 必须从 slots/host 引入`);
      assert.ok(
        /const sub = panel\.webview\.onDidReceiveMessage\(/u.test(src),
        `${f}: 必须接住 onDidReceiveMessage（不接住 = 切走时旧 handler 继续收消息）`,
      );
      assert.ok(
        /return sub;/u.test(src) || /return vscode\.Disposable\.from\(sub\b/u.test(src),
        `${f}: 要把订阅交回宿主（切走时由宿主撤销）`,
      );
      assert.ok(!/: vscode\.WebviewPanel\b/u.test(src), `${f}: 返回类型应为 SlotPanel，不再是页签`);
    }
  });

  it('宿主顺序：先撤销旧接线/旧处理器，再注入新片段（反了旧处理器会多收一轮）', () => {
    const host = stripComments(read(SLOT_HOST));
    const openAt = host.indexOf('closeSlot();');
    const wireAt = host.indexOf('open.wire = wire(panel);');
    assert.ok(openAt > 0 && wireAt > 0, '宿主里必须同时有"关掉旧 Slot"和"接上新视图"');
    assert.ok(openAt < wireAt, 'F.29 教训：撤销必须排在接线之前');

    const closeFn = host.slice(
      host.indexOf('function closeSlot('),
      host.indexOf('export function showDetailPanel'),
    );
    const wireDispose = closeFn.indexOf('open.wire.dispose();');
    const handlerDispose = closeFn.indexOf('open.handler.dispose();');
    const postClose = closeFn.indexOf('postToCockpit({ type: SLOT_CLOSE');
    assert.ok(
      wireDispose > 0 && handlerDispose > 0 && postClose > 0,
      '关 Slot 要：撤销接线 + 撤销处理器 + 通知页面卸载',
    );
    assert.ok(
      wireDispose < postClose && handlerDispose < postClose,
      '先撤销再通知页面卸载（反了会有一瞬间两个处理器同时活着）',
    );
    assert.ok(
      host.includes('fragmentOf('),
      '整页 HTML 必须切成片段再注入（pageShell 的 head 会抛 API 重复获取）',
    );
    assert.ok(
      host.includes('onSlotCloseRequest('),
      '页内"关闭"按钮要能触发宿主撤销接线（否则处理器泄漏）',
    );
  });

  it('旧宿主模块已经删掉（留着就会被重新 import，页签又会回来）', () => {
    assert.ok(
      !existsSync(join(SRC, 'features', 'detail', 'host.ts')),
      'features/detail/host.ts 必须已删除',
    );
    const stray = files.filter((f) => read(f).includes('features/detail/host'));
    assert.deepStrictEqual(stray, [], '不许再引用旧宿主模块');
  });

  it('pin 逃生门清干净：命令/菜单/nls/函数都不留（半删会让用户点到"命令未注册"）', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      contributes: {
        commands: { command: string }[];
        menus: Record<string, { command: string }[]>;
      };
    };
    assert.ok(
      !pkg.contributes.commands.some((c) => c.command === 'het.detail.pin'),
      'manifest 里不许再有 het.detail.pin',
    );
    for (const [menu, items] of Object.entries(pkg.contributes.menus)) {
      assert.ok(
        !items.some((m) => m.command === 'het.detail.pin'),
        `${menu} 菜单里不许再有 pin 入口`,
      );
    }
    for (const nls of ['package.nls.json', 'package.nls.zh-cn.json']) {
      const dict = JSON.parse(readFileSync(nls, 'utf8')) as Record<string, string>;
      assert.ok(!dict['cmd.detailPin'], `${nls} 里还留着 pin 文案`);
    }
    const hits = files.filter((f) =>
      /pinCurrentDetail|pinnedDetailViews|het\.detail\.pin/u.test(stripComments(read(f))),
    );
    assert.deepStrictEqual(hits, [], `这些文件的代码里还提到 pin：${hits.join('、')}`);
    assert.ok(
      read(join(SRC, 'extension.ts')).includes("registerCommand('het.detail.close'"),
      '关掉当前 Slot 要有命令出口（替代原来的 pin 位置）',
    );
  });
});
