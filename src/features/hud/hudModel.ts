/**
 * V4-6 Level-2 HUD card —— **与单页驾驶舱共用同一套组件**（决策 6A：HUD = L1 渲染器 + ≤2 行摘要）。
 *
 * 这里只做"把 HUD 的模型映射到共享组件"，不再自己画一套皮肤：
 * - 顶部状态条 = `singlepage/shell › l1Html`（与驾驶舱 L1 同一渲染器、同一 token）；
 * - 环境行 = `singlepage/shell › cardRowHtml`（同一张卡片的样子，`path` 落到卡片的次级行）；
 * - CSS = `singlepage/tokens › hudCss`（只有我们自己的 `--het-*` / VS Code 变量，无色值字面量）；
 * - 外壳 = `pageShell`（一个文档只取一次 API + 全局 `send/post`），交互走**事件委托**。
 *
 * 保留的原因与边界：HUD 仍有自己的消息协议（`command`/`close`/`snooze`/`hideHud`）与
 * 快捷键（1–9 / Esc）—— 那是它的**功能**，不是"另一套皮"。模型仍是纯函数，可单测。
 */
import { esc, pageShell } from '../ui';
import { hudCss } from '../cockpit/singlepage/tokens';
import { cardRowHtml, l1Html } from '../cockpit/singlepage/shell';
import { hudKeyHint } from './keys';
import type { CardRow, CardState, L1Item } from '../cockpit/singlepage/model';

export type Tone = 'ok' | 'warn' | 'fail' | 'plain';

/** One interactive action (button + optional 1..9 shortcut). */
export interface HudAction {
  /** 1..9 — keyboard shortcut (undefined = click-only). */
  digit?: number;
  /** fcpp gitmoji glyph where the action maps to a CI semantic; else visual. */
  icon: string;
  label: string;
  detail?: string;
  cmd: string;
}

export interface HudEnvRow {
  label: string;
  value: string;
  tone: Tone;
  /** V5-7 dual-line: the REAL binding — absolute/lane path or source note. */
  path?: string;
  /** Optional per-row action label (e.g. 详情/打开). */
  actionLabel?: string;
  /** Command to run when the row action is clicked. */
  action?: string;
}

export interface HudModel {
  title: string;
  health: number | null;
  running: string | null;
  /** 正在跑的动作 id（§F.35）：HUD 与 chip 用同一份仓库级状态。 */
  runningAction?: string | null;
  lastBuildOk: boolean | null;
  test: { passed: number; failed: number; skipped: number } | null;
  coverage: number | null;
  buildAgo: string | null;
  /** V4-1 provider decision line. */
  provider: { label: string; coverage: 'full' | 'partial' | 'none' } | null;
  runtime: string | null;
  env: HudEnvRow[];
  actions: HudAction[];
  templateBehind: number;
}

/** The 10 monitor actions (mirror of the v3 chip QuickPick). */
export function defaultHudActions(): HudAction[] {
  return [
    { digit: 1, icon: '🏠', label: '打开仪表盘', detail: '健康分 · 环境 · 动作', cmd: 'het.dashboard' },
    { digit: 2, icon: '🍺', label: '构建并测试', detail: 'conan create + GTest', cmd: 'het.test' },
    { digit: 3, icon: '🏗️', label: '仅构建', detail: 'conan create', cmd: 'het.build' },
    { digit: 4, icon: '🧩', label: '依赖', detail: 'QuickPick 搜索添加', cmd: 'het.addDependency' },
    { digit: 5, icon: '📖', label: '文档中心', detail: 'Doxygen + Sphinx', cmd: 'het.docs' },
    { digit: 6, icon: '🛡️', label: '质量与安全', detail: 'format/tidy/schema/commitlint', cmd: 'het.quality' },
    { digit: 7, icon: '💬', label: '提交助手', detail: 'type(:emoji:) 规范提交', cmd: 'het.commit' },
    { digit: 8, icon: '📦', label: '发布', detail: 'Preflight + 门禁', cmd: 'het.release' },
    { digit: 9, icon: '📋', label: '测试结果', detail: '最近一次运行明细', cmd: 'het.showTestResults' },
    { icon: '❤️', label: '一键体检', detail: '全维度健康检查', cmd: 'het.healthCheck' },
  ];
}

function toneToState(t: Tone): CardState {
  return t === 'ok' ? 'ok' : t === 'fail' ? 'fail' : t === 'warn' ? 'warn' : 'na';
}

/** HUD 的环境行 → 共享卡片模型（视觉语言与单页一致；`path` 落到卡片的次级行）。 */
export function envCardOf(r: HudEnvRow, index: number): CardRow {
  return {
    id: `env-${index}-${r.label}`,
    tab: 'overview',
    label: r.label,
    state: toneToState(r.tone),
    fact: r.value,
    ...(r.path ? { next: r.path } : {}),
    ...(r.action
      ? { action: { id: r.action, label: r.actionLabel ?? '打开', kind: 'action' as const } }
      : {}),
    stage: 'inline',
    lazy: false,
  };
}

/**
 * HUD 顶部状态条 = 共享 L1 组件（五项：健康 · 构建 · 测试 · 覆盖率 · 环境）。
 * 值与单页 L1 保持同一种写法（`92/100`、`7/8`、`87%`）—— 两处看到的数字应该是同一个说法。
 */
export function hudL1(m: HudModel): L1Item[] {
  const health: CardState =
    m.health === null ? 'idle' : m.health >= 80 ? 'ok' : m.health >= 50 ? 'warn' : 'fail';
  const build: CardState = m.lastBuildOk === null ? 'idle' : m.lastBuildOk ? 'ok' : 'fail';
  const test: CardState = m.test ? (m.test.failed > 0 ? 'fail' : 'ok') : 'idle';
  const cov: CardState = m.coverage === null ? 'idle' : 'ok';
  const env: CardState = m.provider
    ? m.provider.coverage === 'full'
      ? 'ok'
      : m.provider.coverage === 'partial'
        ? 'warn'
        : 'fail'
    : 'idle';
  return [
    { id: 'health', label: '健康', value: m.health === null ? '—' : `${m.health}/100`, state: health },
    {
      id: 'build',
      label: '构建',
      value: m.lastBuildOk === null ? '未运行' : m.lastBuildOk ? '成功' : '失败',
      state: build,
    },
    {
      id: 'test',
      label: '测试',
      value: m.test ? `${m.test.passed}/${m.test.passed + m.test.failed + m.test.skipped}` : '—',
      state: test,
    },
    { id: 'coverage', label: '覆盖率', value: m.coverage === null ? '—' : `${m.coverage}%`, state: cov },
    { id: 'env', label: '环境', value: m.provider?.label ?? m.runtime ?? '—', state: env },
  ];
}

/**
 * HUD 卡片 HTML。
 *
 * 结构固定为：共享 L1 条 → **≤2 行摘要** → 环境卡片（共享卡片渲染器）→ 动作 → 快捷键提示。
 * 摘要行数是硬约束（6A 的原话），由门禁数出来（`hud-line` 元素 ≤ 2）。
 */
export function hudHtml(m: HudModel, fontSize: number): string {
  // 'command' 协议：HUD 的脚本把 `data-action` 的值直接当命令 post（它的 env 行本来就是命令 id）
  const envCards = m.env.map((r, i) => cardRowHtml(envCardOf(r, i), 'command')).join('');
  const actions = m.actions
    .map(
      (a) =>
        `<button class="hud-act" data-action="${esc(a.cmd)}"${a.digit ? ` data-key="${a.digit}"` : ''} title="${esc(a.detail ?? '')}">` +
        `${a.digit ? `<span class="hud-key">${a.digit}</span>` : ''}<span class="ic">${a.icon}</span>${esc(a.label)}</button>`,
    )
    .join('');
  const behind = m.templateBehind > 0 ? `模板可更新 ${m.templateBehind} 个提交` : '模板一致';
  const inner = `
  <div class="hud" style="font-size: ${Math.max(10, Math.min(20, fontSize))}px">
    <div class="hud-head">
      <h1>◇ ${esc(m.title)}</h1>
      <button class="hud-act" data-action="het.dashboard">🏠 仪表盘</button>
    </div>
    <header class="l1" data-l1>${l1Html(hudL1(m), m.running)}</header>
    <div class="hud-lines">
      <div class="hud-line">${esc(m.provider ? m.provider.label : '环境车道：未知（点「一键体检」看看）')}</div>
      <div class="hud-line">${esc(`${behind}${m.coverage === null ? '' : ` · 覆盖率 ${m.coverage}%`}${m.runtime ? ` · ${m.runtime}` : ''}`)}</div>
    </div>
    <h2 class="hud-h2">环境与工具链</h2>
    <div class="cards">${envCards || '<div class="card st-na"><span class="ic">·</span><span class="nm">未就绪</span><span class="fact">先准备环境</span></div>'}</div>
    <h2 class="hud-h2">动作</h2>
    <div class="hud-acts">${actions}</div>
    <div class="hud-prefs">
      <button class="hud-link" id="btn-snooze">👁 暂时隐藏监控 chip 5 分钟</button>
      <button class="hud-link" id="btn-hide-hud">用快捷列表替代 HUD</button>
      <button class="hud-link" data-action="het.dashboard">⚙️ 打开环境与工具链</button>
    </div>
    <div class="hud-foot">
      <span>${esc(hudKeyHint())}</span>
      <span>快捷键与驾驶舱共用同一套状态色</span>
    </div>
  </div>
  <script>
    (function () {
      // 交互一律事件委托（F.29/F.30 纪律）：页面只取一次 API（pageShell 的 <head>），
      // 片段里不再自己 acquireVsCodeApi()。
      document.addEventListener('click', function (ev) {
        var el = ev.target instanceof Element ? ev.target : null;
        if (!el) { return; }
        var b = el.closest('[data-action]');
        if (b) { post(b.getAttribute('data-action')); }
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { send({ type: 'close' }); return; }
        if (/^[1-9]$/.test(e.key)) {
          var t = document.querySelector('[data-key="' + e.key + '"]');
          if (t) { t.click(); }
        }
      });
      var sn = document.getElementById('btn-snooze');
      if (sn) { sn.addEventListener('click', function () { send({ type: 'snooze' }); }); }
      var hd = document.getElementById('btn-hide-hud');
      if (hd) { hd.addEventListener('click', function () { send({ type: 'hideHud' }); }); }
    })();
  </script>`;
  return pageShell('HeT 监控卡', `${hudCss()}${inner}`);
}

/** Pure: value used by the host to disable the HUD (falls back to QuickPick). */
export function hudEnabled(cfgValue: unknown): boolean {
  return cfgValue !== true;
}
