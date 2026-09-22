/**
 * 单页 cockpit 的页面骨架（纯函数，**不 import vscode**）。
 *
 * 输出的 HTML 只有**一个 `<script>`**（页面脚本），API 由 `pageShell` 在 `<head>` 里取一次
 * —— 遵守 F.29：一个文档只能 `acquireVsCodeApi()` 一次，片段不得自带脚本。
 *
 * 交互全部**事件委托**（F.29/F.30）：
 * - `data-action="toggle"` + `data-section` → 折叠/展开（本地，立即生效；同时上报 host 持久化）
 * - `data-action="jump"` + `data-section` → 滚动到该段
 * - `data-action="act"` + `data-act` / `data-copilot` → 交给 host（§6 协议）
 * host → 页面：`{type:'l1'|'section'|'busy'}` 局部替换（§13：页面只生成一次）
 */
import { pageShell, esc } from '../../ui';
import { SECTIONS, railSections } from './sections';
import { singlePageCss } from './tokens';
import { COCKPIT_RESERVED_TYPES } from '../../slots/protocol';
import { stateIcon, type CardRow, type L1Item, type SectionId, type SinglePageModel } from './model';

/**
 * L1 吸顶条的内容（单页页头用）。
 */
export function l1Html(items: L1Item[], busy: string | null): string {
  const cells = items
    .map(
      (i) =>
        `<span class="l1-item st-${esc(i.state)}"><span class="ic">${esc(stateIcon(i.state))}</span>` +
        `<span class="k">${esc(i.label)}</span><span class="v">${esc(i.value)}</span></span>`,
    )
    .join('');
  // 忙点可点 → 任务中心（"正在跑什么"就在眼前，点它去看全局）。空闲时隐藏。
  const busyHtml = busy
    ? `<button class="busy" data-busy data-action="nav" data-nav="openTasks" ` +
      `title="打开任务中心（在跑什么 · 跑过什么）"><span class="spin">⟳</span>${esc(busy)}</button>`
    : `<span class="busy" data-busy hidden><span class="spin">⟳</span></span>`;
  return `${cells}${busyHtml}`;
}

/**
 * 一张卡（L2 行）的 HTML。
 *
 * 动作协议**只有一种**（`data-action="act"` + `data-act="<动作 id>"` → host 用 `COMMAND_FOR_ACTION` 翻译）。
 * E 块把 HUD 页签并入悬停档后，曾经的第二种协议（`'command'`：直接把值当命令 post）没有使用者了 ——
 * 留着一个壳都不用的分支，只会让下一个人猜“什么时候该用哪个”。
 *
 * **只发 `data-act` 不发 `data-action`：点击会掉进“没有 data-action 就 return”，按钮全死**
 * （2026-09-20 用户反馈的“仪表盘除了 Copilot 都点不动”就是这个）。
 * 门禁：`src/test/buttonReachability.test.ts`（渲染出来逐个按钮查可达性）。
 */
export function cardRowHtml(c: CardRow): string {
  const acts: string[] = [];
  const button = (a: typeof c.action, secondary: boolean): void => {
    if (!a) {
      return;
    }
    // `jump`：段内导航（去执行段做这件事），不是动作。
    if (a.kind === 'jump') {
      acts.push(
        `<button class="link" data-action="jump" data-section="${esc(a.id)}" title="跳到「${esc(sectionLabel(a.id))}」执行">${esc(a.label)} →</button>`,
      );
      return;
    }
    const attr =
      a.kind === 'copilot' ? `data-copilot="${esc(a.id)}"` : `data-action="act" data-act="${esc(a.id)}"`;
    const cls = secondary ? ' class="secondary"' : '';
    acts.push(`<button${cls} ${attr} data-card="${esc(c.id)}">${esc(a.label)}</button>`);
  };
  button(c.action, false);
  button(c.secondary, true);
  for (const a of c.extra ?? []) {
    button(a, true);
  }
  const next = c.next ? `<span class="next">${esc(c.next)}</span>` : '';
  const sub = c.sub ? `<span class="sub">${esc(c.sub)}</span>` : '';
  return `<div class="card st-${esc(c.state)}" data-card-row="${esc(c.id)}">
        <span class="ic">${esc(stateIcon(c.state))}</span>
        <span class="nm">${esc(c.label)}</span>${sub}
        <span class="fact" data-card-fact="${esc(c.id)}">${esc(c.fact)}</span>
        ${acts.length ? `<span class="acts">${acts.join('')}</span>` : ''}
        ${next}
      </div>`;
}

/** 段标题（`jump` 链接的 tooltip 用；找不到就退回 id）。 */
function sectionLabel(id: string): string {
  return SECTIONS.find((s) => s.id === id)?.label ?? id;
}

function sectionHtml(id: SectionId, cards: CardRow[], folded: SectionId[], busy: string | null): string {
  const def = SECTIONS.find((s) => s.id === id);
  if (!def) {
    return '';
  }
  const isFolded = folded.includes(id);
  const body = cards.map((c) => cardRowHtml(c)).join('');
  return `<section class="sec" id="sec-${esc(def.id)}" data-section="${esc(def.id)}" data-collapsed="${isFolded ? '1' : '0'}">
      <button class="sec-head" data-action="toggle" data-section="${esc(def.id)}" aria-expanded="${isFolded ? 'false' : 'true'}">
        <span class="ic">${isFolded ? '▸' : '▾'}</span><span>${esc(def.order)} ${esc(def.label)}</span>
      </button>
      <div class="sec-body" data-sec-body="${esc(def.id)}" data-busy="${busy ? esc(busy) : ''}">
        <div class="cards">${body}</div>
      </div>
    </section>`;
}

function railHtml(folded: SectionId[]): string {
  const items = railSections()
    .map(
      (s) =>
        `<button class="rail-item" data-action="jump" data-section="${esc(s.id)}" title="${esc(`${s.order} ${s.label}`)}" aria-label="${esc(`${s.order} ${s.label}`)}" aria-current="${folded.includes(s.id) ? 'false' : 'true'}"><span class="rail-ic" aria-hidden="true">${s.rail}</span><span class="rail-tx">${esc(s.railLabel)}</span></button>`,
    )
    .join('');
  // 齿轮 = 设置段（§5.1：**不进 rail 计数**）。动作 id 必须是 `COMMAND_FOR_ACTION` 里有的
  // （曾是 `settings` → 表里没有 → 点了没反应），这里用 `jump` 滚到设置段。
  const gear = `<button class="rail-item rail-gear" data-action="jump" data-section="settings" title="设置（metadata · 上板）" aria-label="设置"><span class="rail-ic" aria-hidden="true">⚙︎</span><span class="rail-tx">设置</span></button>`;
  return `${items}${gear}`;
}

/** 按段把卡片分组（模型里卡片顺序无所谓，页面顺序由 `SECTIONS` 决定）。 */
export function cardsBySection(model: SinglePageModel): Record<SectionId, CardRow[]> {
  const out = { env: [], build: [], module: [], quality: [], deliver: [], settings: [] } as Record<
    SectionId,
    CardRow[]
  >;
  for (const def of SECTIONS) {
    for (const defCard of def.cards) {
      const live = model.cards.find((c) => c.id === defCard.id);
      out[def.id].push(live ? { ...defCard, ...live } : defCard);
    }
  }
  return out;
}

export function cockpitSinglePageBody(model: SinglePageModel): string {
  const grouped = cardsBySection(model);
  const sections = SECTIONS.map((s) => sectionHtml(s.id, grouped[s.id], model.folded, model.busy)).join('');
  const templateHint =
    model.templateBehind > 0
      ? `<div class="sub">模板落后上游 ${esc(String(model.templateBehind))} 个提交 —— 可在「设置 › 网络与源」同步。</div>`
      : '';
  return `${singlePageCss()}
    <div class="sp">
      <header class="l1" data-l1>${l1Html(model.l1, model.busy)}</header>
      <div class="sp-body">
        <nav class="rail" data-rail>${railHtml(model.folded)}</nav>
        <main class="page" data-page>
          ${templateHint}
          ${sections}
        </main>
      </div>
    </div>
    <section class="slot" data-slot hidden>
      <header class="slot-head">
        <span class="slot-title" data-slot-title></span>
        <span class="slot-spacer"></span>
        <button class="secondary" data-action="slot-close">关闭</button>
      </header>
      <div class="slot-body" data-slot-body></div>
    </section>
    <script>
      (function () {
        var opened = {};
        // 按钮"原文案"暂存/还原：不留下"进行中…"这种假状态（F.29 教训，任何时候都要能回到可点）
        function stash(b) {
          if (b && !b.getAttribute('data-label')) { b.setAttribute('data-label', b.textContent); }
        }
        function restore(sel) {
          var bs = document.querySelectorAll(sel);
          for (var i = 0; i < bs.length; i++) {
            var lb = bs[i].getAttribute('data-label');
            if (lb) { bs[i].textContent = lb; bs[i].removeAttribute('data-label'); }
            bs[i].disabled = false;
          }
        }
        function setActive(id) {
          var items = document.querySelectorAll('.rail-item[data-section]');
          for (var i = 0; i < items.length; i++) {
            var on = items[i].getAttribute('data-section') === id;
            items[i].setAttribute('aria-current', on ? 'true' : 'false');
          }
        }
        // ── 页内 Slot（A 块）─────────────────────────────────────────────
        // 互斥折叠：同时只有一个片段在页内。两个片段的全局函数会互相覆盖（各有同名
        // helper），串台后表现为"点这个视图的按钮改的是那个视图"，所以这条约束不能松。
        var baseSend = send;
        var slotId = null;
        // 驾驶舱自己用掉的消息类型（单一来源：slots/protocol.ts）。片段消息**不许**复用它们，
        // 否则会被驾驶舱抢先处理；反过来说，驾驶舱自己的消息也不能被打上 __slot ——
        // 否则卡片动作会被路由进某个视图，表现就是"点了没反应"。
        var COCKPIT_TYPES = ${JSON.stringify(COCKPIT_RESERVED_TYPES)};
        function slotSend(msg) {
          var out = {};
          for (var k in msg) { if (Object.prototype.hasOwnProperty.call(msg, k)) { out[k] = msg[k]; } }
          if (slotId && COCKPIT_TYPES.indexOf(String(out.type)) < 0) { out.__slot = slotId; }
          return baseSend(out);
        }
        function mountSlot(id, title, html) {
          var box = document.querySelector('[data-slot]');
          var body = document.querySelector('[data-slot-body]');
          var label = document.querySelector('[data-slot-title]');
          if (!box || !body) { return; }
          slotId = id;
          window.send = slotSend;   // 片段里的 send 会被打上 __slot 标记，宿主据此路由
          if (label) { label.textContent = title || id; }
          body.innerHTML = html || '';
          // innerHTML **不执行** <script>：重建 script 节点才会跑（否则片段里的按钮全是死的）
          var scripts = body.querySelectorAll('script');
          for (var i = 0; i < scripts.length; i++) {
            var s = document.createElement('script');
            s.textContent = scripts[i].textContent;
            scripts[i].parentNode.replaceChild(s, scripts[i]);
          }
          box.hidden = false;
          box.scrollIntoView({ block: 'start' });
        }
        function unmountSlot() {
          var box = document.querySelector('[data-slot]');
          var body = document.querySelector('[data-slot-body]');
          if (body) { body.innerHTML = ''; }
          if (box) { box.hidden = true; }
          slotId = null;
          window.send = baseSend;
        }
        document.addEventListener('click', function (ev) {
          var el = ev.target instanceof Element ? ev.target : null;
          if (!el) { return; }
          // Copilot 入口优先判定：它只带 data-copilot（没有 data-action），
          // 分支顺序写错就是"点了没反应"，所以必须在 data-action 之前判。
          var cp = el.closest('[data-copilot]');
          if (cp) {
            if (!cp.disabled) {
              stash(cp);
              cp.disabled = true;
              cp.textContent = '打开中…';
              send({ type: 'copilot', command: cp.getAttribute('data-copilot'), card: cp.getAttribute('data-card') || undefined });
              setTimeout(function () { restore('[data-copilot]'); }, 2000); // 宿主不回也自愈，不能永久锁死
            }
            return;
          }
          var btn = el.closest('[data-action]');
          if (!btn) { return; }
          var act = btn.getAttribute('data-action');
          var sec = btn.getAttribute('data-section');
          if (act === 'slot-close') {
            send({ type: 'slot:close' });
            unmountSlot();
            return;
          }
          if (act === 'toggle' && sec) {
            var box = document.querySelector('[data-sec-body="' + sec + '"]');
            var node = document.getElementById('sec-' + sec);
            if (!box || !node) { return; }
            var folded = node.getAttribute('data-collapsed') === '1';
            node.setAttribute('data-collapsed', folded ? '0' : '1');
            btn.setAttribute('aria-expanded', folded ? 'true' : 'false');
            btn.querySelector('.ic').textContent = folded ? '▾' : '▸';
            send({ type: 'folded', id: sec, expand: folded }); // folded===true 表示原本折叠 → 现在展开
            if (folded && !opened[sec]) { opened[sec] = 1; send({ type: 'section:open', id: sec }); }
            return;
          }
          if (act === 'jump' && sec) {
            var target = document.getElementById('sec-' + sec);
            if (target) { target.scrollIntoView({ block: 'start' }); }
            setActive(sec);
            return;
          }
          if (act === 'nav') {
            // 导航动作：**不**改按钮文字（那是"动作"的反馈，导航没有"进行中"）。
            var nav = btn.getAttribute('data-nav');
            if (nav) { send({ type: 'nav', id: nav }); }
            return;
          }
          if (act === 'act') {
            var id = btn.getAttribute('data-act');
            if (!id) { return; }
            stash(btn);
            btn.disabled = true;
            btn.textContent = '进行中…';
            send({ type: 'action', action: id, card: btn.getAttribute('data-card') || undefined });
            setTimeout(function () { restore('[data-act]'); }, 2000); // 真正在不在跑看 L1 忙点
            return;
          }
        });
        window.addEventListener('message', function (ev) {
          var m = ev.data || {};
          if (m.type === 'l1') {
            var bar = document.querySelector('[data-l1]');
            if (bar && typeof m.html === 'string') { bar.innerHTML = m.html; }
            return;
          }
          if (m.type === 'section') {
            var body = document.querySelector('[data-sec-body="' + m.id + '"]');
            if (body && typeof m.html === 'string') { body.innerHTML = m.html; }
            return;
          }
          if (m.type === 'busy') {
            var dot = document.querySelector('[data-busy]');
            if (dot) { dot.hidden = !m.on; }
            var btns = document.querySelectorAll('.card button');
            for (var i = 0; i < btns.length; i++) { btns[i].disabled = !!m.on; }
            if (!m.on) { restore('.card button'); }
            return;
          }
          if (m.type === 'slot:open') {
            mountSlot(m.id, m.title, m.html);
            return;
          }
          if (m.type === 'slot:close') {
            unmountSlot();
            return;
          }
          if (m.type === 'slot:post') {
            // 把宿主的消息派发给片段自己的监听器（片段用 window.addEventListener('message') 接）
            window.dispatchEvent(new MessageEvent('message', { data: m.payload }));
            return;
          }
          if (m.type === 'copilotResult') {
            // 宿主对每次 Copilot 点击都会回执（成功/降级都要回）——§6 纪律
            var cb = document.querySelector('[data-copilot][data-card="' + m.card + '"]');
            if (cb) {
              stash(cb);
              cb.textContent = m.ok ? '已打开 Chat' : '需手动';
              setTimeout(function () { restore('[data-copilot]'); }, 1500);
            }
            return;
          }
        });
      })();
    </script>`;
}

/** 完整页面 = pageShell（负责取一次 API、放全局 `send()`）+ 上面的页面体。 */
export function cockpitSinglePageHtml(model: SinglePageModel): string {
  return pageShell('HeT DevTools', cockpitSinglePageBody(model));
}
