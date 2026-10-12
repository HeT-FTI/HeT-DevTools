/**
 * **有界选择器**（bounded picker）—— 所有"枚举型"控件的**唯一形态**（§6-G / G11 / G12）。
 *
 * 为什么不用原生 `<datalist>`（实测反馈的原话：下拉把屏幕撑爆、没滚动条）：
 *   · `datalist` 的候选面板**由浏览器画**，我们没有 `max-height`/`overflow` 的控制权；
 *   · 没有**命中总数**（索引 32 项时无感，涨到 ConanCenter 量级的 1,900+ 项时用户不知道
 *     "我看到的是一部分还是全部"）；
 *   · 没有**键盘导航**（↑/↓ 在部分宿主里被输入法吃掉）、没有分页，也无法用纯键盘完成"选包"。
 *
 * 这个模块提供三样东西，缺一不可：
 *   1. **纯函数**（筛选 / 分页 / 文案）—— TS 侧单一来源，可单测；
 *   2. 与之**同义**的浏览器端源码（`MATCH_PREDICATE_JS` / `TOTAL_LABEL_JS`）—— 由
 *      `picker.test.ts` 用 `new Function` 把两端放一起跑同一张查询表，**两端不同义就红**；
 *   3. 渲染函数（`pickerHtml` + `pickerScript`），把"有界"这个约束写死在结构里：
 *      `max-height` + `overflow` 的滚动容器、每页条数下拉、命中计数、键盘可达。
 *
 * 约定：选中一项后，脚本把值写回输入框，并调用页面上的 `window.onPickerSelect(id, value)`
 * （页面自己决定联动：依赖面板要重填版本候选与归属桶）。
 */
import { esc } from './ui';

export interface PickerItem {
  /** 提交时用的值（依赖面板 = conan 包名）。 */
  value: string;
  /** 显示/匹配用的主标签（通常与 value 相同）。 */
  label: string;
  /** 一行说明（依赖面板 = 索引里的用途提示），**也参与匹配**。 */
  note?: string;
}

/** 参与匹配的最小形状（纯函数与浏览器端同义断言的输入）。 */
export type Matchable = Pick<PickerItem, 'label' | 'note'>;

/** 允许的分页档位：只登记两档，改这里要同时改 G12 的规模测试。 */
export const PICKER_PAGE_SIZES = [20, 50] as const;
export const PICKER_DEFAULT_PAGE_SIZE: number = PICKER_PAGE_SIZES[0];
export const PICKER_DEFAULT_NOUN = '项';

export function assertPageSize(pageSize: number): void {
  if (!(PICKER_PAGE_SIZES as readonly number[]).includes(pageSize)) {
    throw new Error(
      `未登记的分页大小：${pageSize}（只允许 ${PICKER_PAGE_SIZES.join(' / ')}）—— 要新增请同时补 G12 的规模测试`,
    );
  }
}

/** 大小写不敏感子串匹配（包名或用途说明命中即可；空查询给全部）。 */
export function itemMatches(item: Matchable, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) {
    return true;
  }
  return (
    item.label.toLowerCase().includes(q) ||
    (item.note ?? '').toLowerCase().includes(q)
  );
}

export function filterItems<T extends Matchable>(
  items: readonly T[],
  query: string,
): T[] {
  return items.filter((it) => itemMatches(it, query));
}

export function pageCountOf(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(Math.max(0, total) / Math.max(1, pageSize)));
}

export function clampPage(page: number, total: number, pageSize: number): number {
  return Math.min(Math.max(0, Math.trunc(page)), pageCountOf(total, pageSize) - 1);
}

export interface PickerPage<T> {
  query: string;
  /** 0-based（**收敛后**的真实页号）。 */
  page: number;
  pageSize: number;
  /** 命中总数（不是本页条数 —— 界面必须显示它）。 */
  total: number;
  pageCount: number;
  items: T[];
}

export function pageSlice<T extends Matchable>(
  items: readonly T[],
  query: string,
  page: number,
  pageSize: number = PICKER_DEFAULT_PAGE_SIZE,
): PickerPage<T> {
  assertPageSize(pageSize);
  const hits = filterItems(items, query);
  const total = hits.length;
  const p = clampPage(page, total, pageSize);
  return {
    query,
    page: p,
    pageSize,
    total,
    pageCount: pageCountOf(total, pageSize),
    items: hits.slice(p * pageSize, p * pageSize + pageSize),
  };
}

/** 命中计数文案：有查询说"命中"，无查询说总量（用户任何时候都知道"这是不是全部"）。 */
export function totalLabel(
  total: number,
  query: string,
  noun: string = PICKER_DEFAULT_NOUN,
): string {
  return query.trim() ? `共 ${total} 命中` : `共 ${total} ${noun}`;
}

/** 浏览器端匹配谓词（与 `itemMatches` 同义；同义性由 picker.test.ts 断言）。 */
export const MATCH_PREDICATE_JS = `function pickerMatch(item, q) {
  q = String(q == null ? '' : q).trim().toLowerCase();
  if (!q) { return true; }
  var label = String(item && item.label != null ? item.label : '').toLowerCase();
  var note = String(item && item.note != null ? item.note : '').toLowerCase();
  return label.indexOf(q) >= 0 || note.indexOf(q) >= 0;
}`;

/** 浏览器端计数文案（与 `totalLabel` 同义）。 */
export const TOTAL_LABEL_JS = `function pickerTotalLabel(n, q, noun) {
  return String(q == null ? '' : q).trim() ? ('共 ' + n + ' 命中') : ('共 ' + n + ' ' + (noun || '项'));
}`;

/** 有界容器的样式：`max-height` + `overflow` 是**结构约束**，不是可选项。 */
export const PICKER_CSS = `
<style>
  .picker { position: relative; flex: 2; min-width: 0; }
  .picker input { width: 100%; }
  .picker .dim { opacity: .75; font-size: 12px; }
  .picker .spacer { flex: 1; }
  .picker-menu { position: absolute; z-index: 30; left: 0; right: 0; top: 100%;
    border: 1px solid var(--vscode-dropdown-border, #444); border-radius: 6px;
    background: var(--vscode-dropdown-background, #252526); box-shadow: 0 4px 14px rgba(0,0,0,.35); }
  .picker-head, .picker-foot { display: flex; align-items: center; gap: 8px; padding: 4px 8px; }
  /* 列表必须有界（G11）：max-height 决定高度，overflow 决定可滚 —— 两者都在这一行 */
  .picker-list { max-height: 240px; overflow-y: auto; overflow-x: hidden; }
  .picker-item { display: flex; gap: 8px; padding: 3px 8px; cursor: pointer; align-items: baseline; }
  .picker-item.hi, .picker-item:hover { background: var(--vscode-list-activeSelectionBackground, #094771); }
  .picker-item .mono { font-family: var(--vscode-editor-font-family, monospace); }
  .picker-empty { padding: 6px 8px; }
</style>`;

export function pickerRowsHtml(items: readonly PickerItem[]): string {
  if (!items.length) {
    return '<div class="picker-empty">没有匹配的项 —— 可直接手输（仍会写入目标文件）</div>';
  }
  return items
    .map(
      (it, i) =>
        `<div class="picker-item" role="option" data-idx="${i}"><span class="mono">${esc(it.label)}</span><span class="dim">${esc(it.note ?? '')}</span></div>`,
    )
    .join('');
}

export interface PickerOptions {
  /** 控件 id（DOM id 前缀 + `onPickerSelect` 回调的第一个参数）。 */
  id: string;
  /** 输入框 id（默认 `<id>-input`；依赖面板沿用 `q` 以保持既有脚本/测试口径）。 */
  inputId?: string;
  label: string;
  placeholder: string;
  items: readonly PickerItem[];
  pageSize?: number;
  /** 计数文案里的量词（依赖面板 = `个包`）。 */
  noun?: string;
}

/** 输入框 + 候选菜单 + 数据脚本（首帧就渲染第一页，不依赖脚本先跑）。 */
export function pickerHtml(opts: PickerOptions): string {
  const id = opts.id;
  const inputId = opts.inputId ?? `${id}-input`;
  const pageSize = opts.pageSize ?? PICKER_DEFAULT_PAGE_SIZE;
  assertPageSize(pageSize);
  const noun = opts.noun ?? PICKER_DEFAULT_NOUN;
  const first = pageSlice(opts.items, '', 0, pageSize);
  const data = JSON.stringify(opts.items).replace(/</gu, '\\u003c');
  const sizes = PICKER_PAGE_SIZES.map(
    (n) => `<option value="${n}"${n === pageSize ? ' selected' : ''}>${n}</option>`,
  ).join('');
  return `<div class="picker" data-picker-id="${esc(id)}" data-picker-noun="${esc(noun)}">
  <input id="${esc(inputId)}" role="combobox" aria-autocomplete="list" aria-expanded="false"
    aria-controls="${esc(id)}-list" aria-label="${esc(opts.label)}"
    placeholder="${esc(opts.placeholder)}" autocomplete="off"/>
  <div class="picker-menu" id="${esc(id)}-menu" hidden>
    <div class="picker-head">
      <span class="dim" id="${esc(id)}-total" data-total>${esc(totalLabel(first.total, '', noun))}</span>
      <span class="spacer"></span>
      <label class="dim" for="${esc(id)}-size">每页</label>
      <select id="${esc(id)}-size" data-page-size title="每页条数">${sizes}</select>
    </div>
    <div class="picker-list" id="${esc(id)}-list" role="listbox" data-list>${pickerRowsHtml(first.items)}</div>
    <div class="picker-foot">
      <button type="button" class="secondary" id="${esc(id)}-prev" data-picker-nav="prev">上一页</button>
      <span class="dim" id="${esc(id)}-page">第 1/${first.pageCount} 页</span>
      <button type="button" class="secondary" id="${esc(id)}-next" data-picker-nav="next">下一页</button>
    </div>
  </div>
</div>
<script type="application/json" id="${esc(id)}-data">${data}</script>`;
}

/**
 * 通用脚本（每页放**一份**即可，自动接管页面上所有 `[data-picker-id]`）。
 * 只用 `addEventListener`（不用 `onclick=`），并在选中后调用 `window.onPickerSelect`。
 */
export function pickerScript(): string {
  return `<script>
(function () {
  ${MATCH_PREDICATE_JS}
  ${TOTAL_LABEL_JS}
  function byId(id) { return document.getElementById(id); }
  function wirePicker(host) {
    var id = host.getAttribute('data-picker-id');
    var noun = host.getAttribute('data-picker-noun') || '项';
    var input = host.querySelector('input');
    var menu = byId(id + '-menu');
    var list = byId(id + '-list');
    var totalEl = byId(id + '-total');
    var pageEl = byId(id + '-page');
    var prev = byId(id + '-prev');
    var next = byId(id + '-next');
    var sizeSel = byId(id + '-size');
    var dataEl = byId(id + '-data');
    if (!input || !menu || !list) { return null; }
    var items = [];
    try { items = JSON.parse((dataEl && dataEl.textContent) || '[]'); } catch (e) { items = []; }
    var st = { page: 0, hi: -1, pageSize: parseInt((sizeSel && sizeSel.value) || '20', 10) || 20, total: 0, pageCount: 1, slice: [] };
    function open(on) { menu.hidden = !on; input.setAttribute('aria-expanded', on ? 'true' : 'false'); }
    function render() {
      var hits = [];
      for (var i = 0; i < items.length; i++) { if (pickerMatch(items[i], input.value)) { hits.push(items[i]); } }
      st.total = hits.length;
      st.pageCount = Math.max(1, Math.ceil(hits.length / st.pageSize));
      if (st.page > st.pageCount - 1) { st.page = st.pageCount - 1; }
      if (st.page < 0) { st.page = 0; }
      st.slice = hits.slice(st.page * st.pageSize, st.page * st.pageSize + st.pageSize);
      list.innerHTML = '';
      if (!st.slice.length) {
        list.innerHTML = '<div class="picker-empty">没有匹配的项 —— 可直接手输（仍会写入目标文件）</div>';
      }
      for (var j = 0; j < st.slice.length; j++) {
        var row = document.createElement('div');
        row.className = 'picker-item' + (j === st.hi ? ' hi' : '');
        row.setAttribute('role', 'option');
        row.setAttribute('data-idx', String(j));
        var label = document.createElement('span'); label.className = 'mono'; label.textContent = st.slice[j].label;
        var note = document.createElement('span'); note.className = 'dim'; note.textContent = st.slice[j].note || '';
        row.appendChild(label); row.appendChild(note);
        list.appendChild(row);
      }
      if (totalEl) { totalEl.textContent = pickerTotalLabel(st.total, input.value, noun); }
      if (pageEl) { pageEl.textContent = '第 ' + (st.page + 1) + '/' + st.pageCount + ' 页'; }
      if (prev) { prev.disabled = st.page <= 0; }
      if (next) { next.disabled = st.page >= st.pageCount - 1; }
    }
    function select(i) {
      var item = st.slice[i];
      if (!item) { return; }
      input.value = item.value;
      st.hi = -1;
      open(false);
      if (typeof window.onPickerSelect === 'function') { window.onPickerSelect(id, item.value); }
    }
    input.addEventListener('focus', function () { open(true); render(); });
    input.addEventListener('input', function () { st.page = 0; st.hi = -1; open(true); render(); });
    input.addEventListener('keydown', function (ev) {
      var k = ev.key;
      if (k === 'ArrowDown' || k === 'ArrowUp') {
        ev.preventDefault();
        open(true);
        if (!st.slice.length) { return; }
        st.hi += (k === 'ArrowDown' ? 1 : -1);
        var last = st.slice.length - 1;
        if (st.hi < 0) { if (st.page > 0) { st.page -= 1; render(); st.hi = st.slice.length - 1; } else { st.hi = 0; } }
        else if (st.hi > last) { if (st.page < st.pageCount - 1) { st.page += 1; render(); st.hi = 0; } else { st.hi = last; } }
        render();
      } else if (k === 'Enter') {
        if (!menu.hidden && st.hi >= 0) { ev.preventDefault(); select(st.hi); }
      } else if (k === 'Escape') { open(false); }
    });
    if (sizeSel) {
      sizeSel.addEventListener('change', function () {
        st.pageSize = parseInt(sizeSel.value, 10) || 20;
        st.page = 0; st.hi = -1; render();
      });
    }
    if (prev) { prev.addEventListener('click', function () { if (st.page > 0) { st.page -= 1; st.hi = -1; render(); } }); }
    if (next) { next.addEventListener('click', function () { if (st.page < st.pageCount - 1) { st.page += 1; st.hi = -1; render(); } }); }
    list.addEventListener('click', function (ev) {
      var t = ev.target;
      while (t && t !== list && !t.getAttribute('data-idx')) { t = t.parentNode; }
      if (t && t !== list) { select(parseInt(t.getAttribute('data-idx'), 10)); }
    });
    document.addEventListener('click', function (ev) { if (!host.contains(ev.target)) { open(false); } });
    render();
    open(false); // 首帧不自动弹出（用户没点就弹是打扰）
    return st;
  }
  var hosts = document.querySelectorAll('[data-picker-id]');
  for (var i = 0; i < hosts.length; i++) { wirePicker(hosts[i]); }
})();
</script>`;
}
