/**
 * §D 门禁：**工作区最多两个页签**（驾驶舱 + 细节），逃生门是 pin。
 *
 * 背景（2026-09-20 实测反馈）：16 处 `createWebviewPanel` 里只有 2 处是单例，其余每次调用都
 * 新开一个页签 —— 点几下工作区就成了一排页签。现在全部细节面板走 `features/detail/host.ts`：
 * 一个页签、内容跟着域切换、标题跟着变。
 *
 * 这一组断言盯四件事（都是"错了就静默变乱"的那种）：
 *   1. `createWebviewPanel` 只允许出现在 host / 驾驶舱 / HUD（+ 一张**会自我清理**的待迁移名单）；
 *   2. 面板模块必须走 `showDetailPanel`，且必须**接住** `onDidReceiveMessage` 的订阅
 *      （不接住 = 切视图时旧 handler 不会撤销 → 两个视图同时收消息）；
 *   3. host 里"先撤销旧接线、再接新视图"的**顺序**不许反（反了旧 handler 会多收一轮）；
 *   4. 逃生门（pin）命令与菜单必须在 manifest 里声明（否则用户没有出口）。
 */
import * as assert from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { stripComments } from './support/htmlFacts';

const SRC = 'src';
const HOST = join(SRC, 'features', 'detail', 'host.ts');

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

describe('§D：细节面板共用一个页签（最多两个页签）', () => {
  const read = (p: string): string => readFileSync(p, 'utf8');
  const files = walk(SRC);

  it('`createWebviewPanel` 只允许出现在 host / 驾驶舱 / HUD（+ 待迁移名单，且名单自清理）', () => {
    // 还没迁移的：必须逐项写清"为什么还在自己开页签"，迁移完必须从这里删掉（下面的断言会逼你删）
    // 名单已清空（§F.45：体检明细是最后一个 —— 现在全仓只有 host / 驾驶舱 / HUD 三处开页签）。
    const notYetMigrated: Readonly<Record<string, string>> = {};
    const allowed = new Set([
      HOST,
      join(SRC, 'features', 'cockpit', 'controller.ts'), // 驾驶舱：整体那个页签
      join(SRC, 'features', 'hud', 'panel.ts'), // HUD：监控卡，有意常驻、独立（用户已确认）
      ...Object.keys(notYetMigrated),
    ]);
    const callers = files.filter((f) => stripComments(read(f)).includes('createWebviewPanel('));
    const unexpected = callers.filter((f) => !allowed.has(f));
    assert.deepStrictEqual(
      unexpected,
      [],
      `这些文件自己开页签了（§D 只允许 host/驾驶舱/HUD）：${unexpected.join('、')}`,
    );
    assert.deepStrictEqual(
      Object.keys(notYetMigrated).filter((f) => !callers.includes(f)),
      [],
      '待迁移名单里的文件已经不开页签了 → 请把它从名单里删掉（名单必须与事实一致）',
    );
    assert.deepStrictEqual(Object.keys(notYetMigrated), [], '待迁移名单必须为空：所有面板都走细节页签');
  });

  it('细节面板都走 host，且接住了消息订阅（不接住 = 切视图后两个 handler 同时收）', () => {
    const panels = files.filter(
      (f) => f.includes(`${sep}features${sep}`) && f.endsWith(join('panel.ts')) && read(f).includes('showDetailPanel('),
    );
    assert.ok(panels.length >= 12, `走 host 的面板太少（${panels.length}）—— 迁移漏了？`);
    for (const f of panels) {
      const src = read(f);
      assert.ok(
        /const sub = panel\.webview\.onDidReceiveMessage\(/u.test(src),
        `${f}: 必须接住 onDidReceiveMessage 的订阅（const sub = …），否则切视图时旧 handler 不会撤销`,
      );
      // §F.45：允许**组合式**返回（`vscode.Disposable.from(sub, 别的订阅)`）——
      // 面板自己还订阅了"状态变化"时要一起撤销，光返回 `sub` 会漏掉那一份。
      assert.ok(
        /return sub;/u.test(src) || /return vscode\.Disposable\.from\(sub\b/u.test(src),
        `${f}: 要把订阅返回给 host（切走时由 host 撤销）`,
      );
    }
  });

  it('host 的顺序：先撤销旧接线，再接新视图（反了旧 handler 会多收一轮）', () => {
    const host = read(HOST);
    const disposeAt = host.indexOf('detailWire?.dispose();');
    const wireAt = host.indexOf('detailWire = wire(detailPanel);');
    assert.ok(disposeAt > 0 && wireAt > 0, 'host 里必须同时有"撤销旧接线"和"接上新视图"');
    assert.ok(disposeAt < wireAt, 'F.29 教训：撤销必须排在接线之前');
    assert.ok(host.includes('panel.onDidDispose('), '面板被用户关掉时要清掉引用（否则下次不会重建）');
  });

  it('逃生门（pin）在 manifest 里声明了命令与菜单（否则用户没有出口）', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      contributes: {
        commands: { command: string; title: string }[];
        menus: Record<string, { command: string; when?: string }[]>;
      };
    };
    const cmd = pkg.contributes.commands.find((c) => c.command === 'het.detail.pin');
    assert.ok(cmd, '必须声明 het.detail.pin（把当前细节视图固定成独立页签）');
    assert.match(cmd!.title, /^%cmd\.detailPin%$/u, '标题要走 nls');
    const inTitle = (pkg.contributes.menus['editor/title'] ?? []).some(
      (m) => m.command === 'het.detail.pin',
    );
    assert.ok(inTitle, '要在编辑器标题栏给"固定成独立页签"一个入口');
    for (const nls of ['package.nls.json', 'package.nls.zh-cn.json']) {
      const dict = JSON.parse(readFileSync(nls, 'utf8')) as Record<string, string>;
      assert.ok(dict['cmd.detailPin'], `${nls} 缺 cmd.detailPin 文案`);
    }
  });

  it('host 里 pin 语义明确：被钉住的视图不再占用细节页签（同一内容不重复显示）', () => {
    const host = stripComments(read(HOST));
    assert.ok(
      /const pinnedEntry = pinned\.get\(view\.id\);\s*if \(pinnedEntry && !view\.pinned\)/u.test(host),
      '入口要先看该视图是否被 pin：被 pin 就直接去它自己的页签',
    );
    assert.ok(host.includes('pinnedDetailViews'), '要能查询"哪些视图被钉住"（诊断/测试用）');
  });
});
