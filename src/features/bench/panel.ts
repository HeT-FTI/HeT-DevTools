import * as vscode from 'vscode';
import { esc, pageShell } from '../ui';
import { BenchField, BenchPlatform, BenchCase } from '../../core/benchmark';
import { showDetailPanel } from '../detail/host';

export interface BenchState {
  projectName: string;
  platform: BenchPlatform;
  fields: BenchField[];
  values: Record<string, string>;
  configRel: string;
}

export interface BenchParseResult {
  ok: boolean;
  message: string;
  cases: BenchCase[];
  complete: boolean;
}

export interface BenchDeps {
  getState: () => Promise<BenchState>;
  saveConfig: (values: Record<string, string>) => Promise<{ ok: boolean; message: string }>;
  buildNoFlash: () => Promise<{ ok: boolean; message: string }>;
  parseSim: (text: string) => BenchParseResult;
  openConfig: () => Promise<void>;
}

const SIM_SAMPLE = `[boot] target ready
BENCHMARK_START
RESULT|vec_add_f32_1k|487
RESULT|vec_sub_f32_1k|523
RESULT|mat_mul_8x8|1201
BENCHMARK_END`;

export function showBenchPanel(context: vscode.ExtensionContext, deps: BenchDeps): vscode.WebviewPanel {
  // §D：细节面板共用一个页签（切视图换内容）——实现原样搬进来，只把"谁来持有面板"交给 host。
  return showDetailPanel(context, { id: 'bench', title: 'HeT DevTools — 上板测试' }, (panel) => {

    const render = async (resultHtml = ''): Promise<void> => {
      const state = await deps.getState();
      panel.webview.html = buildHtml(state, resultHtml);
    };

    const sub = panel.webview.onDidReceiveMessage(async (message: { type: string; values?: Record<string, string>; text?: string }) => {
      if (message.type === 'refresh') {
        await render();
      } else if (message.type === 'saveConfig' && message.values) {
        const r = await deps.saveConfig(message.values);
        void vscode.window.showInformationMessage(r.message);
        await render();
      } else if (message.type === 'buildNoFlash') {
        const r = await deps.buildNoFlash();
        void vscode.window.showInformationMessage(r.message);
        await render();
      } else if (message.type === 'parseSim' && typeof message.text === 'string') {
        const r = deps.parseSim(message.text);
        await render(buildResultHtml(r));
      } else if (message.type === 'openConfig') {
        await deps.openConfig();
      }
    });

    void render().catch((e) => console.error('[het] bench render failed', e));
    return sub;
  });
}

function buildFieldHtml(f: BenchField, value: string): string {
  return `<label class="fld">${esc(f.label)}${f.hint ? `<span class="hint">${esc(f.hint)}</span>` : ''}
    <input data-key="${esc(f.key)}" value="${esc(value)}" /></label>`;
}

function buildResultHtml(r: BenchParseResult): string {
  if (!r.ok) {
    return `<div class="warn">${esc(r.message)}</div>`;
  }
  const rows = r.cases
    .map(
      (c, i) =>
        `<tr><td>${esc(c.name)}</td><td>${c.value}</td><td>${i % 2 === 0 ? '✓' : '⚠ 超出目标'}</td></tr>`,
    )
    .join('');
  return `<h2>结果（${r.complete ? '协议完整' : '未收到 BENCHMARK_END'} · ${r.cases.length} 例）</h2>
    <table><tr><th>用例</th><th>实测</th><th>状态</th></tr>${rows || '<tr><td colspan="3">无解析结果</td></tr>'}</table>
    <div class="tag">状态列仅为演示占位：目标值/偏差需按 case 目标表校准。</div>`;
}

function buildHtml(s: BenchState, resultHtml: string): string {
  const noProject = s.projectName.length === 0;
  const platformLabel = s.platform === 'm' ? 'Cortex-M 裸机' : s.platform === 'a' ? 'Cortex-A Linux' : '未知';
  const fields = s.fields.map((f) => buildFieldHtml(f, s.values[f.key] ?? '')).join('');
  return pageShell(
    '上板测试',
    `
    <style>
      .fld { display: inline-block; width: 31%; margin: 4px 1%; font-size: 12px; vertical-align: top; }
      .fld .hint { display: block; font-size: 10px; opacity: .6; }
      input, textarea { width: 100%; padding: 5px; margin-top: 3px;
        background: var(--vscode-input-background); color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border,#555); border-radius: 4px; }
      table { width: 100%; border-collapse: collapse; font-size: 12px; margin: 4px 0; }
      th, td { border: 1px solid var(--vscode-widget-border,#333); padding: 4px 8px; text-align: left; }
      .warn { background: rgba(226,192,141,.12); border: 1px solid #e2c08d; border-radius: 6px;
        padding: 8px 10px; margin: 6px 0; font-size: 12px; white-space: pre-wrap; }
    </style>
    <div class="card">
      <h1>上板测试</h1>
      <div class="sub">项目：${esc(s.projectName || '—')} · 平台：${platformLabel} · 配置：${esc(s.configRel)}</div>
      ${noProject ? '<div class="warn">未检测到 fcpp 项目。</div>' : ''}
      <div class="row">
        <button data-action="buildNoFlash">🔨 只构建（--no-flash）</button>
        <button data-action="openConfig" class="secondary">打开 bench_config.json</button>
        <button data-action="refresh" class="secondary">🔄 刷新</button>
      </div>
      <h2>板卡配置（字段级写回，保留注释）</h2>
      <div id="fields">${fields || '<div class="warn">未能解析 bench_config.json（请先在 fcpp 模板配置好）。</div>'}</div>
      <div class="row"><button data-action="saveConfig" class="primary">💾 保存配置</button></div>
      <h2>无硬件冒烟：解析模拟串口输出</h2>
      <textarea id="sim" rows="6">${esc(SIM_SAMPLE)}</textarea>
      <div class="row"><button data-action="parseSim" class="secondary">解析输出</button></div>
      <div id="result">${resultHtml}</div>
    </div>
    <script>
      (function () {
        const collect = () => {
          const out = {};
          document.querySelectorAll('input[data-key]').forEach((i) => { out[i.getAttribute('data-key')] = i.value; });
          return out;
        };
        document.querySelectorAll('button[data-action]').forEach((b) =>
          b.addEventListener('click', () => {
            const act = b.getAttribute('data-action');
            if (act === 'saveConfig') { send({ type: 'saveConfig', values: collect() }); }
            else if (act === 'parseSim') { send({ type: 'parseSim', text: document.getElementById('sim').value }); }
            else { send({ type: act }); }
          }));
      })();
    </script>
    `,
  );
}

