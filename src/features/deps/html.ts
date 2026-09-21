/**
 * 依赖管理器页面的**纯 HTML 生成**（不 import vscode，可单测）。
 *
 * 三条硬规矩（都是实测反馈的直接产物）：
 *
 * 1. **一个控件都不能"点了没反应"**：不再用 `onclick=`，一律 `data-action` + 事件委托；
 *    提交前的校验由 `model.ts` 的 `validateAddInput` 给一句人话，并在 `#note` 里回显。
 * 2. **搜索式下拉 + 版本联动**：包名用 `<input list=…>`（原生可搜索），版本来自索引快照，
 *    换包就重填版本候选；索引里没有的包自动切到"自定义…"。
 * 3. **局部刷新**：只有首帧整页渲染，之后 `#list` / `#note` 由消息替换（F.29 家族教训）。
 */
import { esc, pageShell } from '../ui';
import type { DependencyView } from '../../core/dependencyService';
import {
  CUSTOM_VERSION,
  catalogSnapshot,
  groupRows,
  versionsFor,
} from './model';

export interface DepPanelState {
  views: DependencyView[];
  issues: string[];
}

export function depsNoteHtml(note: string): string {
  return note ? `<div class="note" id="note-inner">${esc(note)}</div>` : '';
}

function rowHtml(v: DependencyView): string {
  const targets = v.targets.length ? v.targets.join(', ') : '—';
  return `<div class="row dep" data-dep-row>
    <span class="chip">${esc(v.displayKey)}</span>
    <span class="tag">${esc(v.version ?? '版本未知')}</span>
    <span class="dim">targets: ${esc(targets)}</span>
    <span class="spacer"></span>
    <button class="secondary" data-action="remove" data-bucket="${esc(v.bucket)}" data-key="${esc(v.displayKey)}">移除</button>
  </div>`;
}

/** 已装依赖清单（分桶）。 */
export function depsListHtml(state: DepPanelState): string {
  const issues = state.issues.map((i) => `<div class="fail">⚠ ${esc(i)}</div>`).join('');
  const groups = groupRows(state.views)
    .map(
      (g) => `<h2>${esc(g.label)} <span class="tag">${g.rows.length}</span></h2>
      <div class="card">${g.rows.length ? g.rows.map(rowHtml).join('') : '<div class="row"><span class="tag">（空）</span></div>'}</div>`,
    )
    .join('');
  return `${issues}${groups}`;
}

/** 添加入口：搜索框（可搜索下拉）× 版本（联动）× 归属桶（按索引预选）。 */
export function depsFormHtml(): string {
  const options = catalogSnapshot();
  const datalist = options
    .map((o) => `<option value="${esc(o.conan)}">${esc(o.note)}</option>`)
    .join('');
  const json = JSON.stringify(options).replace(/</gu, '\\u003c');
  return `<h2>添加依赖</h2>
    <div class="card">
      <div class="row">
        <input id="q" list="dep-list" placeholder="搜索包名或用途（如 fmt / 日志）" style="flex:2" autocomplete="off"/>
        <datalist id="dep-list">${datalist}</datalist>
        <select id="ver" style="flex:1" title="版本（随包名联动）"><option value="${CUSTOM_VERSION}">自定义…</option></select>
      </div>
      <div class="row">
        <span class="dim">归属桶</span>
        <select id="bucket" style="flex:1">
          <option value="cpp">仅 C++ (cpp)</option>
          <option value="common">C/C++ 共用 (common)</option>
          <option value="c">仅 C (c)</option>
          <option value="infra">基础设施 (infra)</option>
        </select>
        <input id="targets" placeholder="CMake target（可空，如 fmt::fmt）" style="flex:2"/>
      </div>
      <div class="row">
        <input id="ver-custom" placeholder="自定义版本（如 12.0.0）" style="flex:1; display:none"/>
        <span class="dim" id="hint">选择包名后会自动填版本与桶；一个包只能归一个桶。</span>
      </div>
      <div class="row">
        <button data-action="add" class="primary">＋ 添加（预览并确认）</button>
        <button data-action="refresh" class="secondary">↻ 刷新</button>
        <span class="dim">键盘路径：命令面板 → <code>het.addDependency</code>（同一套索引与写入）</span>
      </div>
      <script type="application/json" id="dep-catalog">${json}</script>
    </div>`;
}

/** 首帧完整页面（之后 `#list` / `#note` 由宿主消息局部替换）。 */
export function depsPageHtml(state: DepPanelState, note = ''): string {
  return pageShell(
    'HeT DevTools — 依赖管理器',
    `
    <style>
      .dep { border-bottom: 1px solid var(--vscode-widget-border,#333); padding: 3px 0; gap: 8px; }
      .dim { opacity: .75; font-size: 12px; }
      .spacer { flex: 1; }
      .note { border-left: 3px solid var(--vscode-focusBorder,#3a7cff); padding: 4px 8px;
        margin: 6px 0; font-size: 12px; background: rgba(58,124,255,.08); }
    </style>
    <h1>依赖管理器</h1>
    <div class="sub">添加/移除都会**同时**写入 <code>conandata.yml</code> 与 <code>metadata.json</code>（确认后生效），
      并回显到本页与驾驶舱卡片。</div>
    <div id="note">${depsNoteHtml(note)}</div>
    <div id="list">${depsListHtml(state)}</div>
    ${depsFormHtml()}
    <script>
      var CATALOG = (function () {
        try { return JSON.parse(document.getElementById('dep-catalog').textContent || '[]'); }
        catch (e) { return []; }
      })();
      function byName(name) {
        for (var i = 0; i < CATALOG.length; i++) { if (CATALOG[i].conan === name) { return CATALOG[i]; } }
        return null;
      }
      // 版本联动：换包名 → 重填版本候选 + 预选归属桶（索引里没有就切"自定义"）
      function syncPackage() {
        var name = document.getElementById('q').value.trim();
        var item = byName(name);
        var ver = document.getElementById('ver');
        ver.innerHTML = '';
        var list = item ? item.versions.slice() : [];
        list.push('${CUSTOM_VERSION}');
        for (var i = 0; i < list.length; i++) {
          var o = document.createElement('option');
          o.value = list[i];
          o.textContent = list[i] === '${CUSTOM_VERSION}' ? '自定义…' : list[i];
          ver.appendChild(o);
        }
        if (item) { document.getElementById('bucket').value = item.bucket; }
        var hint = document.getElementById('hint');
        hint.textContent = item
          ? item.note + ' · 建议归 ' + item.bucket + ' 桶'
          : (name ? '索引里没有「' + name + '」——请手动选版本与桶（仍会写入两个文件）。'
                  : '选择包名后会自动填版本与桶；一个包只能归一个桶。');
        syncCustomVersion();
      }
      function syncCustomVersion() {
        var custom = document.getElementById('ver').value === '${CUSTOM_VERSION}';
        var box = document.getElementById('ver-custom');
        box.style.display = custom ? '' : 'none';
      }
      function currentVersion() {
        var ver = document.getElementById('ver').value;
        return ver === '${CUSTOM_VERSION}' ? document.getElementById('ver-custom').value.trim() : ver;
      }
      function add() {
        send({ type: 'add', input: {
          conanName: document.getElementById('q').value.trim(),
          version: currentVersion(),
          bucket: document.getElementById('bucket').value,
          targets: document.getElementById('targets').value.trim(),
        } });
      }
      document.addEventListener('input', function (ev) {
        var el = ev.target instanceof Element ? ev.target : null;
        if (!el) { return; }
        if (el.id === 'q') { syncPackage(); }
        if (el.id === 'ver') { syncCustomVersion(); }
      });
      document.addEventListener('click', function (ev) {
        var el = ev.target instanceof Element ? ev.target : null;
        var btn = el && el.closest('[data-action]');
        if (!btn || btn.disabled) { return; }
        var act = btn.getAttribute('data-action');
        if (act === 'add') { add(); }
        else if (act === 'refresh') { send({ type: 'refresh' }); }
        else if (act === 'remove') {
          send({ type: 'remove', bucket: btn.getAttribute('data-bucket'), displayKey: btn.getAttribute('data-key') });
        }
      });
      window.addEventListener('message', function (ev) {
        var m = ev.data || {};
        if (m.type !== 'render') { return; }
        var list = document.getElementById('list');
        if (list && typeof m.listHtml === 'string') { list.innerHTML = m.listHtml; }
        var note = document.getElementById('note');
        if (note && typeof m.note === 'string') { note.innerHTML = '<div class="note" id="note-inner"></div>'; note.firstChild.textContent = m.note; }
      });
    </script>
    `,
  );
}

/** 供宿主在结果里回显"这次动了什么"（面板 + 驾驶舱卡片用同一句话）。 */
export function describeVersions(views: readonly DependencyView[]): string {
  return views.map((v) => `${v.displayKey}@${v.version ?? '?'}`).join(' · ');
}

/** `versionsFor` 的透传（面板默认包名时给一个合理初值用）。 */
export { versionsFor };
