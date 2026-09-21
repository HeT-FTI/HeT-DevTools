import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { explainCiFetchFailure } from '../core/ciStatus';
import { defaultHudActions, hudHtml } from '../features/hud/hudModel';
import {
  HUD_CLOSE_COMMAND,
  HUD_DIGITS,
  actionForDigit,
  digitCommand,
  digitOfCommand,
  hudKeyCommands,
  hudKeyHint,
  isHudKeyCommand,
} from '../features/hud/keys';

const read = (p: string): string => readFileSync(join('src', p), 'utf8');
const manifest = (): {
  contributes: {
    commands: { command: string; title: string }[];
    keybindings: { command: string; key: string; when?: string }[];
  };
} => JSON.parse(readFileSync('package.json', 'utf8')) as never;

const sampleModel = {
  title: 'demo',
  health: 90,
  running: null,
  lastBuildOk: true,
  test: null,
  coverage: null,
  buildAgo: null,
  provider: null,
  runtime: null,
  env: [],
  actions: defaultHudActions(),
  templateBehind: 0,
  docsRunning: false,
};

describe('§F.43 HUD 按键真的能按（实测反馈：写着 1–9 直达却没反应）', () => {
  it('键位与动作表同源：1–9 都能在动作表里找到', () => {
    const actions = defaultHudActions();
    for (const d of HUD_DIGITS) {
      const a = actionForDigit(actions, d);
      assert.ok(a, `${d} 没有对应动作 —— 按了就是没反应`);
      assert.ok(a!.cmd.startsWith('het.'), `${d} → ${a!.cmd} 必须是本扩展命令`);
    }
    assert.strictEqual(actionForDigit(actions, 0), undefined);
  });

  it('命令 id ↔ 数字双向可逆（宿主注册与按键解耦）', () => {
    for (const d of HUD_DIGITS) {
      assert.strictEqual(digitOfCommand(digitCommand(d)), d);
      assert.ok(isHudKeyCommand(digitCommand(d)));
    }
    assert.strictEqual(digitOfCommand(HUD_CLOSE_COMMAND), null);
    assert.ok(isHudKeyCommand(HUD_CLOSE_COMMAND));
    assert.ok(!isHudKeyCommand('het.build'));
    assert.deepStrictEqual(hudKeyCommands().map((k) => k.key), ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'escape']);
  });

  it('page 内提示与命令表同源（不再手写"按键 1–9"文案）', () => {
    const html = hudHtml(sampleModel as never, 13);
    assert.ok(html.includes(hudKeyHint()), '提示行来自 keys.ts');
    assert.ok(html.includes('data-key="1"'), '按钮要带 data-key 供页面内按键命中');
    assert.ok(hudKeyHint().includes('Esc'), '关闭键也要写出来');
  });

  it('manifest 声明齐：10 条命令 + 10 条快捷键，且限定 HUD 面板激活', () => {
    const pkg = manifest();
    const commands = new Set(pkg.contributes.commands.map((c) => c.command));
    for (const { command } of hudKeyCommands()) {
      assert.ok(commands.has(command), `package.json 未声明 ${command}（按键不会生效）`);
    }
    const bindings = pkg.contributes.keybindings.filter((k) => k.command.startsWith('het.hud.'));
    assert.strictEqual(bindings.length, 10, `要 10 条键位，实际 ${bindings.length}`);
    for (const b of bindings) {
      assert.strictEqual(
        b.when,
        'activeWebviewPanelId == het.hud',
        `${b.command} 的 when 必须限定 HUD 面板（否则 1–9 会在编辑器里抢输入）`,
      );
    }
    assert.ok(bindings.some((b) => b.key === 'escape'));
  });

  it('宿主侧接线：按键走同一张动作表，且面板没开时什么都不做', () => {
    const panel = read('features/hud/panel.ts');
    assert.ok(panel.includes('actionForDigit(model.actions, digit)'), '按键要查动作表');
    assert.ok(panel.includes('hudPanelOpen'), '要能判断卡片是否开着');
    const ext = read('extension.ts');
    assert.match(ext, /hudKeyCommands\(\)\.map\(/u, '命令按同一份键位表注册');
    assert.ok(ext.includes('pressHudKey('), '按键交给面板执行');
    assert.ok(ext.includes('closeHudPanel()'), 'Esc 要能关卡片');
    assert.ok(!/registerCommand\('het\.hud\.d1'[\s\S]{0,200}vscode\.commands\.executeCommand\('het\.build'\)/u.test(ext), '按键命令不许硬编码某个动作（会与动作表脱节）');
  });
});

describe('§F.43 CI 拿不到远端状态时要说清"为什么 + 怎么办"', () => {
  it('没装 gh：给出安装与登录命令', () => {
    const e = explainCiFetchFailure({ ghPresent: false });
    assert.match(e.reason, /gh CLI/u);
    assert.ok(e.fix.some((f) => f.includes('gh auth login')), '要给出可复制命令');
    assert.strictEqual(e.authRelated, true);
  });

  it('401/403 → 凭据/权限；404 → 仓库不可见；都带原始 stderr 片段', () => {
    const e401 = explainCiFetchFailure({ ghPresent: true, code: 401, stderr: 'HTTP 401: Bad credentials (https://api.github.com)' });
    assert.match(e401.reason, /401/u);
    assert.ok(e401.reason.includes('Bad credentials'), '要带上原始信息，别只翻译');
    assert.ok(e401.fix.some((f) => f.includes('gh auth login')));
    const e404 = explainCiFetchFailure({ ghPresent: true, code: 404, stderr: 'HTTP 404: Not Found' });
    assert.match(e404.reason, /404/u);
    assert.match(e404.fix.join(' '), /私有仓库|owner\/repo/u);
  });

  it('超时/无法启动 → 网络类解释 + 兜底办法（面板里还能干嘛）', () => {
    const e = explainCiFetchFailure({ ghPresent: true, error: 'command timed out after 15000ms' });
    assert.match(e.reason, /timed out/u);
    assert.ok(e.fix.some((f) => f.includes('🔄 刷新')), '要告诉用户刷新的入口');
    assert.strictEqual(e.authRelated, false);
  });

  it('面板渲染"为什么/怎么办"两个小节，且不再是一句空话', () => {
    const html = read('features/ci/panel.ts');
    assert.ok(html.includes('为什么：'), '要显示原因');
    assert.ok(html.includes('怎么办：'), '要显示下一步');
    assert.ok(html.includes('界面里还能做什么'), '要说明降级后仍可用的部分');
    assert.ok(!/当前无法访问 GitHub（离线或无网络代理）/u.test(html), '旧的一句话说不出可操作性');
    const ext = read('extension.ts');
    assert.ok(ext.includes('explainCiFetchFailure({'), '失败事实要采集（不再静默 catch）');
    assert.ok(/else if \(!\(res\.code === 0/u.test(ext), 'gh 非零退出码也要解释');
  });
});
