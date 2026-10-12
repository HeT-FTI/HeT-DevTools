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
import { SECTIONS, railSections, type SectionDef } from './sections';
import { singlePageCss } from './tokens';
import { factText } from './infoBudget';
import { hiddenCards, spineNextStep, spineOf } from './spine';
import { COCKPIT_RESERVED_TYPES } from '../../slots/protocol';
import {
  SECTION_IDS,
  cardStateText,
  stateIcon,
  type CardRow,
  type SectionId,
  type SinglePageModel,
  type SpineNextStep,
} from './model';
import type { CapabilityFact } from '../../../core/capability';

/**
 * 顶部常驻条上的**高频动作**（V3 §4.4：顺序 = 频率）。
 *
 * 协议与卡片按钮完全一致（`data-action="act"` / `data-copilot`）—— 所以 host 侧一行不改，
 * 门禁 `buttonReachability.test.ts` 也直接盖到它们。
 */
export interface BarAction {
  id: string;
  label: string;
  title: string;
  copilot?: boolean;
}

export const BAR_ACTIONS: readonly BarAction[] = [
  { id: 'build', label: '⚙ 编译打包', title: 'conan create：编译并打包本包（= CI ci-build-test › build-and-test）' },
  { id: 'test', label: '▶ 全量测试', title: '与 CI 同一条链：GTest/CTest + 覆盖率（= full-test-automation › auto-testing）' },
  { id: '/het-commit', label: '✎ 智能提交', title: 'Copilot 生成拆分提交预览（不 push）', copilot: true },
];

/**
 * 常驻条内容（V3 §4.4）。
 *
 * 以前这里是 4 个"状态格"（构建/测试/覆盖率/环境）—— 那是**同一份事实的第二次投影**
 * （阶段带 8 站已各带状态），而真正高频的动作反倒埋在折叠里。现在反过来：
 * **动作常驻、状态去阶段带**。
 *
 * 第 4 项（任务中心）由**忙点**承担：忙时才出现（"正在跑什么"那一刻才值得看），
 * 空闲时它是空的 —— 不为了凑满四项而常驻一个无处可去的入口（P7）。
 */
export function barHtml(busy: string | null): string {
  const btns = BAR_ACTIONS.map((a) =>
    a.copilot
      ? `<button class="bar-act" data-copilot="${esc(a.id)}" title="${esc(a.title)}">${esc(a.label)}</button>`
      : `<button class="bar-act" data-action="act" data-act="${esc(a.id)}" title="${esc(a.title)}">${esc(a.label)}</button>`,
  ).join('');
  // 忙点可点 → 任务中心（"正在跑什么"就在眼前，点它去看全局）。空闲时隐藏。
  const busyHtml = busy
    ? `<button class="busy" data-busy data-action="nav" data-nav="openTasks" ` +
      `title="打开任务中心（在跑什么 · 跑过什么）"><span class="spin">⟳</span>${esc(busy)}</button>`
    : `<span class="busy" data-busy hidden><span class="spin">⟳</span></span>`;
  return `${btns}${busyHtml}`;
}

/**
 * 产物能力行（§5.2）：**只在真有产物能力时出现**，且每条都带着"它推出的动作"（title）。
 *
 * 这不是回显领域（§5.1 已否决），而是回答"这个产物有哪些对外承诺、于是必须做什么"。
 */
export function capsHtml(caps: readonly CapabilityFact[] | undefined): string {
  const list = caps ?? [];
  if (list.length === 0) {
    return '';
  }
  const items = list.map((c) => `<span class="cap" title="${esc(c.implies)}">${esc(c.label)}</span>`).join(' · ');
  return `<div class="caps" data-caps>产物能力：${items}</div>`;
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
export function cardRowHtml(c: CardRow, isNext = false): string {
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
  // G11：空事实不渲染 —— 占位符 `—` 是零信息却占掉卡片上最贵的一格（§6.0）。
  // 仍然留着 `data-card-fact` 容器，让 Slot 刷新只换内容时不会把整张卡重画。
  const fact = factText(c.fact);
  return `<div class="card st-${esc(c.state)}${isNext ? ' is-next' : ''}" data-card-row="${esc(c.id)}"${isNext ? ' data-next="1"' : ''}>
        <span class="ic">${esc(stateIcon(c.state))}</span>
        <span class="nm">${esc(c.label)}</span>${sub}
        <span class="fact" data-card-fact="${esc(c.id)}">${fact === null ? '' : esc(fact)}</span>
        ${acts.length ? `<span class="acts">${acts.join('')}</span>` : ''}
        ${next}
      </div>`;
}

/** 站标题（rail/深链 tooltip 用；找不到就退回 id）。 */
function sectionLabel(id: string): string {
  return SECTIONS.find((s) => s.id === id)?.label ?? id;
}

/**
 * 一个站（V3 §4.1）：头部 = 折叠箭头 + **站状态** + 站名 + （是下一步时）标记，尾部是站内说明；
 * 正文 = 该站的卡（卡本身就是"事实 + 唯一主动作 + 下一步"）。
 *
 * 两处刻意不用编号也不用进位字：§6.0 第 4 条 —— "第几段"是**我们自己的分类法**，
 * 用户不需要知道；状态点已经把"该看哪一站"说清楚了。
 */
function sectionHtml(
  def: SectionDef,
  cards: CardRow[],
  model: SinglePageModel,
  next: SpineNextStep | undefined,
): string {
  const isFolded = model.folded.includes(def.id);
  const view = spineOf(model).find((s) => s.id === def.id);
  const state = view?.state ?? 'na';
  const isNext = next?.station === def.id;
  const body = cards.map((c) => cardRowHtml(c, isNext && next?.cardId === c.id)).join('');
  // 被产物能力藏起来的卡要**说清楚**（否则用户只会觉得"功能没了"）：一行里同时给
  // "藏了谁"与"怎么才能让它出现"。没有隐藏卡片时这一行不存在（P7：不占位）。
  const hidden = hiddenCards(def.cards, model.caps).filter(
    (h) => !cards.some((c) => c.id === h.cardId),
  );
  const hiddenLine =
    hidden.length > 0
      ? `<div class="sub" data-hidden-cards>${hidden
          .map((h) => `${esc(cardLabelOf(h.cardId))}（缺${esc(h.reasons.join('/'))}）`)
          .join(' · ')} —— 需要时补上对应事实就会出现</div>`
      : '';
  return `<section class="sec" id="sec-${esc(def.id)}" data-section="${esc(def.id)}" data-collapsed="${isFolded ? '1' : '0'}" data-station-state="${esc(state)}">
      <button class="sec-head" data-action="toggle" data-section="${esc(def.id)}" aria-expanded="${isFolded ? 'false' : 'true'}">
        <span class="ic">${isFolded ? '▸' : '▾'}</span>
        <span class="st st-${esc(state)}" title="本站状态：${esc(cardStateText(state))}">${esc(stateIcon(state))}</span>
        <span class="sec-label">${esc(def.label)}</span>
        ${isNext ? '<span class="next-chip">下一步</span>' : ''}
        <span class="hint">${esc(def.hint)}</span>
      </button>
      <div class="sec-body" data-sec-body="${esc(def.id)}" data-busy="${model.busy ? esc(model.busy) : ''}">
        ${hiddenLine}
        <div class="cards">${body}</div>
      </div>
    </section>`;
}

/** 卡片展示名（"隐藏了什么"那一行用；找不到退回 id）。 */
function cardLabelOf(cardId: string): string {
  for (const s of SECTIONS) {
    const c = s.cards.find((x) => x.id === cardId);
    if (c) {
      return c.label;
    }
  }
  return cardId;
}

/** rail：8 站 + 齿轮。每格带**站状态点**（顶部不再单开一条状态格 —— 那份信息的唯一位置）。 */
function railHtml(model: SinglePageModel): string {
  // 模型里没算好阶段带时**现算一份**（纯函数）：不然状态点会因为调用方漏填而全部消失。
  const stateOf = new Map(spineOf(model).map((s) => [s.id as string, s.state]));
  const items = railSections()
    .map((s) => {
      const st = stateOf.get(s.id);
      const dot = st
        ? `<span class="rail-dot st-${esc(st)}" title="${esc(cardStateText(st))}">${esc(stateIcon(st))}</span>`
        : '';
      return `<button class="rail-item" data-action="jump" data-section="${esc(s.id)}" title="${esc(`${s.label} · ${s.hint}`)}" aria-label="${esc(s.label)}" aria-current="${model.folded.includes(s.id) ? 'false' : 'true'}"><span class="rail-ic" aria-hidden="true">${s.rail}</span><span class="rail-tx">${esc(s.railLabel)}</span>${dot}</button>`;
    })
    .join('');
  // 齿轮 = 设置段（**不进 rail 计数**）。动作 id 必须是 `COMMAND_FOR_ACTION` 里有的
  // （曾是 `settings` → 表里没有 → 点了没反应），这里用 `jump` 滚到设置段。
  const gearDef = SECTIONS.find((s) => s.gear);
  // 图标/短名一律取自组定义（页面上不许另写一份）—— 以前齿轮里的 `⚙︎` 是硬编的，
  // 和定义里的 `⚙️` 是两个不同码位，门禁一查就红。
  const gear = gearDef
    ? `<button class="rail-item rail-gear" data-action="jump" data-section="${esc(gearDef.id)}" title="设置（${esc(gearDef.hint)}）" aria-label="设置"><span class="rail-ic" aria-hidden="true">${esc(gearDef.rail)}</span><span class="rail-tx">${esc(gearDef.railLabel)}</span></button>`
    : '';
  return `${items}${gear}`;
}

/** 按站把卡片分组（模型里卡片顺序无所谓，页面顺序由 `SECTIONS` 决定）。 */
export function cardsBySection(model: SinglePageModel): Record<SectionId, CardRow[]> {
  const out = Object.fromEntries(SECTION_IDS.map((id) => [id, [] as CardRow[]])) as Record<
    SectionId,
    CardRow[]
  >;
  for (const def of SECTIONS) {
    for (const defCard of def.cards) {
      const live = model.cards.find((c) => c.id === defCard.id);
      // 能力显隐（§5.2）：**模型里没有的卡就不渲染**。
      // 以前这里是 `live ? {...} : defCard` —— 那意味着"被过滤掉的卡"会以静态定义
      // 的形式又冒出来（拿默认 fact），隐藏根本不会生效。
      if (!live) {
        continue;
      }
      out[def.id].push({ ...defCard, ...live });
    }
  }
  return out;
}

export function cockpitSinglePageBody(model: SinglePageModel): string {
  const grouped = cardsBySection(model);
  // "下一步"只算一次，所有站共用（唯一来源，不许各站自己猜）。
  const next = spineNextStep(spineOf(model), model.cards);
  // §6.0 第 5 条收口（L5b）：模板落后以前是站内一行**静态文字** —— 它不参与站状态，
  // 落后再多那一站也不会变黄。现在这是「模板同步」卡的**事实**（卡状态 → 站状态），
  // 所以这里不再另写一行（P7：同一件事不写两处）。
  const sections = SECTIONS.map((s) => sectionHtml(s, grouped[s.id] ?? [], model, next)).join('');
  return `${singlePageCss()}
    <div class="sp">
      <header class="l1" data-l1>${barHtml(model.busy)}${capsHtml(model.caps)}</header>
      <div class="sp-body">
        <nav class="rail" data-rail>${railHtml(model)}</nav>
        <main class="page" data-page>
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
        // 宿主下发的折叠状态（深链/手风琴改了宿主侧状态时必须让页面跟上，
        // 否则会出现"宿主认为测试站开着、用户看到就绪站开着"）。
        function applyFolded(folded) {
          var openId = null;
          var all = document.querySelectorAll('.sec[data-section]');
          for (var i = 0; i < all.length; i++) {
            var sec = all[i];
            var id = sec.getAttribute('data-section');
            var isFolded = folded.indexOf(id) >= 0;
            sec.setAttribute('data-collapsed', isFolded ? '1' : '0');
            if (!isFolded) { openId = id; }
            var head = sec.querySelector('.sec-head');
            if (head) {
              head.setAttribute('aria-expanded', isFolded ? 'false' : 'true');
              var ic = head.querySelector('.ic');
              if (ic) { ic.textContent = isFolded ? '▸' : '▾'; }
            }
          }
          if (openId) { setActive(openId); }
        }
        // 手风琴（V3 §4.3）：同时只开一站。展开某站时把其它站**立即**收起，
        // 不等宿主回包 —— 否则用户会看到"两项同时展开"（2026-09-30 实测的那个现象）。
        function collapseOthers(keep) {
          var all = document.querySelectorAll('.sec[data-section]');
          for (var i = 0; i < all.length; i++) {
            var sec = all[i];
            if (sec.getAttribute('data-section') === keep) { continue; }
            if (sec.getAttribute('data-collapsed') === '1') { continue; }
            sec.setAttribute('data-collapsed', '1');
            var head = sec.querySelector('.sec-head');
            if (head) {
              head.setAttribute('aria-expanded', 'false');
              var ic = head.querySelector('.ic');
              if (ic) { ic.textContent = '▸'; }
            }
          }
        }
        function expand(sec) {
          var node = document.getElementById('sec-' + sec);
          if (!node) { return; }
          collapseOthers(sec);
          node.setAttribute('data-collapsed', '0');
          var head = node.querySelector('.sec-head');
          if (head) {
            head.setAttribute('aria-expanded', 'true');
            var ic = head.querySelector('.ic');
            if (ic) { ic.textContent = '▾'; }
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
            var wasFolded = node.getAttribute('data-collapsed') === '1';
            if (wasFolded) {
              expand(sec); // 手风琴：展开自己、收起其它
              send({ type: 'folded', id: sec, expand: true, exclusive: true });
              if (!opened[sec]) { opened[sec] = 1; send({ type: 'section:open', id: sec }); }
            } else {
              node.setAttribute('data-collapsed', '1');
              btn.setAttribute('aria-expanded', 'false');
              btn.querySelector('.ic').textContent = '▸';
              send({ type: 'folded', id: sec, expand: false });
            }
            return;
          }
          if (act === 'jump' && sec) {
            // 跳站 = 滚过去 + **展开它**（手风琴）+ 高亮。
            // 以前只滚不动折叠 —— 于是"点了 rail 却看到别的站开着"（§4.3 第 3 条）。
            expand(sec);
            setActive(sec);
            send({ type: 'folded', id: sec, expand: true, exclusive: true });
            if (!opened[sec]) { opened[sec] = 1; send({ type: 'section:open', id: sec }); }
            var target = document.getElementById('sec-' + sec);
            if (target) { target.scrollIntoView({ block: 'start' }); }
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
          if (m.type === 'folded' && Array.isArray(m.folded)) {
            applyFolded(m.folded.map(String));
            return;
          }
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
            var btns = document.querySelectorAll('.card button, .bar-act');
            for (var i = 0; i < btns.length; i++) { btns[i].disabled = !!m.on; }
            if (!m.on) { restore('.card button, .bar-act'); }
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
