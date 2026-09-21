import * as vscode from 'vscode';
import { FcppMetadata } from '../../types';
import { esc, pageShell } from '../ui';
import { showDetailPanel } from '../detail/host';

export interface SettingsFieldDef {
  key: string;
  label: string;
  group: string;
  kind: 'text' | 'select' | 'bool' | 'comma';
  options?: string[];
  hint?: string;
  placeholder?: string;
}

/** Editable fields (subset with plain-language labels; others visible as JSON). */
export const SETTINGS_FIELDS: SettingsFieldDef[] = [
  { key: 'description', label: '库描述', group: '基本信息', kind: 'text', placeholder: '一句话说明这个库做什么' },
  { key: 'license', label: '开源协议', group: '基本信息', kind: 'text', placeholder: 'Apache-2.0' },
  { key: 'build_cppstd', label: 'C++ 标准', group: '构建参数', kind: 'select', options: ['17', '20', '23'] },
  { key: 'build_cstd', label: 'C 标准', group: '构建参数', kind: 'select', options: ['11', '17'] },
  { key: 'build_type', label: '构建类型', group: '构建参数', kind: 'select', options: ['Debug', 'Release'] },
  { key: 'is_shared', label: '共享库', group: '构建参数', kind: 'bool', hint: 'Windows 下会回退为静态库' },
  { key: 'is_header', label: '纯头文件（header-only）', group: '构建参数', kind: 'bool' },
  { key: 'generate_modules_inplace', label: 'C++23 模块自动生成（实验）', group: '构建参数', kind: 'bool' },
  { key: 'std_modules', label: '模块化标准库（逗号分隔）', group: '构建参数', kind: 'text', hint: '如 iostream, vector' },
  { key: 'trigger_tests', label: '运行测试', group: '测试与覆盖', kind: 'bool', hint: '在 test_package 中构建并运行 GTest' },
  { key: 'activate_code_coverage', label: '生成覆盖率', group: '测试与覆盖', kind: 'bool', hint: '仅 GCC/Clang 支持（MSVC 不可用）' },
  { key: 'saving_tests_log', label: '保存测试日志', group: '测试与覆盖', kind: 'bool' },
  { key: 'enable_python_bindings', label: 'Python 绑定（pybind11）', group: 'Python 绑定', kind: 'bool' },
  { key: 'doc_languages', label: '文档语言（逗号分隔）', group: '文档', kind: 'text', hint: 'en / zh' },
  { key: 'doc_versions', label: '文档版本（逗号分隔）', group: '文档', kind: 'text', hint: '如 1.0, 2.0' },
  { key: 'graphviz_bin', label: 'Graphviz 目录（机器相关）', group: '文档', kind: 'text', hint: '机器相关值提交前建议还原' },
];

export interface SettingsPanelDeps {
  getMetadata: () => Promise<{ metadata?: FcppMetadata; error?: string }>;
  savePatch: (patch: Record<string, unknown>) => Promise<{ ok: boolean; message: string; diff: Array<{ field: string }> }>;
  refreshProject: () => Promise<void>;
}

export function showSettingsPanel(context: vscode.ExtensionContext, deps: SettingsPanelDeps): vscode.WebviewPanel {
  // §D：细节面板共用一个页签（切视图换内容）——实现原样搬进来，只把"谁来持有面板"交给 host。
  return showDetailPanel(context, { id: 'settings', title: 'HeT DevTools — 项目设置' }, (panel) => {

    const render = async (): Promise<void> => {
      const data = await deps.getMetadata();
      panel.webview.html = buildHtml(data.metadata, data.error);
    };
    const sub = panel.webview.onDidReceiveMessage(
      async (message: { type: string; patch?: Record<string, unknown>; refresh?: boolean }) => {
        if (message.type === 'save' && message.patch) {
          const result = await deps.savePatch(message.patch);
          await vscode.window.showInformationMessage(result.message);
          if (result.ok) {
            await deps.refreshProject();
          }
          await render();
        } else if (message.type === 'refresh') {
          await render();
        }
      },
    );

    void render().catch((e) => console.error('[het] settings render failed', e));
    return sub;
  });
}

function controlHtml(field: SettingsFieldDef, value: unknown): string {
  const val = (value as string | number | boolean | undefined) ?? '';
  const base = `data-key="${field.key}"`;
  if (field.kind === 'bool') {
    return `<label><input type="checkbox" ${base} ${val ? 'checked' : ''}/> ${esc(field.hint ?? '')}</label>`;
  }
  if (field.kind === 'select') {
    const options = (field.options ?? [])
      .map((o) => `<option value="${esc(o)}" ${String(val) === o ? 'selected' : ''}>${esc(o)}</option>`)
      .join('');
    return `<select ${base}>${options}</select>`;
  }
  if (field.kind === 'comma') {
    return `<input ${base} type="text" value="${esc(Array.isArray(val) ? val.join(', ') : val)}" placeholder="${esc(field.placeholder ?? '')}"/>`;
  }
  return `<input ${base} type="text" value="${esc(val)}" placeholder="${esc(field.placeholder ?? '')}"/>`;
}

function buildHtml(metadata?: FcppMetadata, error?: string): string {
  if (error) {
    return pageShell('项目设置', `<h1>项目设置</h1><div class="card fail">${esc(error)}</div>`);
  }
  const m = metadata ?? ({} as FcppMetadata);
  const groups = new Map<string, SettingsFieldDef[]>();
  for (const f of SETTINGS_FIELDS) {
    const list = groups.get(f.group) ?? [];
    list.push(f);
    groups.set(f.group, list);
  }

  const groupHtml = [...groups.entries()]
    .map(
      ([group, fields]) => `
    <h2>${esc(group)}</h2>
    <div class="card">
      ${fields
        .map(
          (f) => `
        <div class="row" style="flex-wrap:wrap">
          <span class="title">${esc(f.label)} <span class="tag">${esc(f.key)}</span></span>
          ${controlHtml(f, m[f.key as keyof FcppMetadata])}
        </div>`,
        )
        .join('')}
    </div>`,
    )
    .join('');

  return pageShell(
    'HeT DevTools — 项目设置',
    `<h1>项目设置 <span class="tag">metadata.json · name=${esc(m.name ?? '?')} v${esc(m.version ?? '?')}</span></h1>
     <div class="sub">保存前会校验并预览变更（diff），确认后才写回：按 fcpp 原排版手术式更新（无 .bak）。</div>
     ${groupHtml}
     <h2>依赖与 CI 开关</h2>
     <div class="card">
       <div>依赖四桶与 CI 流水线开关在「依赖管理器 / 驾驶舱」中维护。</div>
       <button onclick="save()">💾 保存更改</button>
       <button class="secondary" onclick="refresh()">↻ 重新加载</button>
     </div>
     <script>
       function refresh() { send({ type: 'refresh' }); }
       function save() {
         const patch = {};
         document.querySelectorAll('[data-key]').forEach((el) => {
           const key = el.getAttribute('data-key');
           if (el.type === 'checkbox') { patch[key] = el.checked; }
           else if (el.tagName === 'SELECT') { patch[key] = el.value; }
           else {
             const raw = el.value.trim();
             if (raw === '') { return; }
             if (['doc_languages','doc_versions'].includes(key)) { patch[key] = raw.split(',').map(s=>s.trim()).filter(Boolean); }
             else { patch[key] = raw; }
           }
         });
         send({ type: 'save', patch: patch });
       }
     </script>`,
  );
}

