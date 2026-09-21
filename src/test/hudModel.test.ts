import * as assert from 'node:assert';
import {
  HudModel,
  defaultHudActions,
  hudEnabled,
  hudHtml,
} from '../features/hud/hudModel';
import { hudKeyHint } from '../features/hud/keys';

function model(over: Partial<HudModel> = {}): HudModel {
  return {
    title: 'mylib2',
    health: 92,
    running: null,
    lastBuildOk: true,
    test: { passed: 7, failed: 0, skipped: 1 },
    coverage: 87,
    buildAgo: '3 分钟前',
    provider: { label: 'Windows · WSL2 托管 distro（gcc + lcov 全语义）', coverage: 'full' },
    runtime: 'conan 2.32 · conda env build（启发式推断 · 极可能）',
    env: [
      { label: 'conan', value: '2.32', tone: 'ok' },
      { label: 'gtest', value: 'conan 托管（构建时获取）', tone: 'ok' },
      { label: 'lcov', value: '可选', tone: 'plain' },
    ],
    actions: defaultHudActions(),
    templateBehind: 0,
    ...over,
  };
}

describe('V4-6 hudModel (Level-2 HUD card)', () => {
  it('default actions: ten entries, first nine carry 1..9 digits', () => {
    const a = defaultHudActions();
    assert.strictEqual(a.length, 10);
    for (let i = 0; i < 9; i++) {
      assert.strictEqual(a[i].digit, i + 1, `action ${i} must be digit ${i + 1}`);
    }
    assert.strictEqual(a[9].digit, undefined, '10th action is click-only');
    // fcpp-native trigger glyphs on the CI-semantic actions
    const byCmd = new Map(a.map((x) => [x.cmd, x.icon]));
    assert.strictEqual(byCmd.get('het.test'), '🍺');
    assert.strictEqual(byCmd.get('het.build'), '🏗️');
    assert.strictEqual(byCmd.get('het.docs'), '📖');
    assert.strictEqual(byCmd.get('het.quality'), '🛡️');
    assert.strictEqual(byCmd.get('het.release'), '📦');
  });

  it('renders stat cards, provider line, env rows and digit hint', () => {
    const html = hudHtml(model(), 14);
    assert.ok(html.includes('mylib2'));
    assert.ok(html.includes('92/100'), 'health stat');
    assert.ok(html.includes('7/8'), 'test stat');
    assert.ok(html.includes('87%'), 'coverage badge');
    assert.ok(html.includes('WSL2'), 'provider line');
    assert.ok(html.includes('conan 托管'), 'env row value');
    // §F.43：提示行不再手写"按键 1–9"，而是与命令表同源（`hudKeyHint()`），
    // 并注明"卡片聚焦或在编辑器里都可按"（实测反馈：只按页面内 keydown 时按键常常无效）。
    assert.ok(html.includes(hudKeyHint()), 'digit hint 与键位表同源');
    assert.ok(hudKeyHint().includes('1–9'), '要写清键位范围');
    assert.ok(html.includes('Esc'), '要写清关闭键');
    assert.ok(html.includes("send({ type: 'close' })"), 'Esc wiring');
  });

  it('font-size setting is honoured (clamped 10..20)', () => {
    const small = hudHtml(model(), 6);
    assert.ok(small.includes('font-size: 10px'));
    const large = hudHtml(model(), 999);
    assert.ok(large.includes('font-size: 20px'));
    const mid = hudHtml(model(), 14.5);
    assert.ok(mid.includes('font-size: 14.5px'));
  });

  it('V5-7 dual-line env rows render the real binding path', () => {
    const html = hudHtml(
      model({
        env: [
          { label: 'Conan', value: 'WSL2 车道 venv · Conan version 2.32.0', tone: 'ok', path: 'WSL2 车道 · ~/.het-fti/managed-env/venv/bin/conan' },
          { label: 'CMake', value: 'WSL2 车道 venv · cmake 4.4.3', tone: 'ok', path: 'WSL2 车道 · ~/.het-fti/managed-env/venv/bin/cmake' },
        ],
      }),
      13,
    );
    assert.ok(html.includes('class="next"'), 'dual-line path element present（共用卡片的次级行）');
    assert.ok(html.includes('~/.het-fti/managed-env/venv/bin/conan'), 'lane conan path shown');
    assert.ok(html.includes('~/.het-fti/managed-env/venv/bin/cmake'), 'lane cmake path shown');
  });

  it('env tones map onto the shared card states（不再有自己的 dot 皮肤）', () => {
    const html = hudHtml(
      model({
        env: [
          { label: 'conan', value: 'ok', tone: 'ok' },
          { label: 'x', value: 'warn', tone: 'warn' },
          { label: 'y', value: 'fail', tone: 'fail' },
          { label: 'z', value: 'plain', tone: 'plain' },
        ],
      }),
      13,
    );
    for (const cls of ['card st-ok', 'card st-warn', 'card st-fail', 'card st-na']) {
      assert.ok(html.includes(cls), `缺 ${cls}`);
    }
  });

  it('hudEnabled: only an explicit true disables the HUD', () => {
    assert.strictEqual(hudEnabled(undefined), true);
    assert.strictEqual(hudEnabled(false), true);
    assert.strictEqual(hudEnabled(true), false);
  });
});
