/**
 * 单页 cockpit 的**视觉 token + 布局 CSS**（纯字符串，**不 import vscode**）。
 *
 * 规则（计划 §12）：
 * - 具体色值只允许出现在本文件（`--het-*` 的定义处），其它样式一律 `var(--het-*)`；
 * - 布局只允许"单列 + 定宽 900 + flex-wrap"（§5），禁止 `auto-fit` 多列、`@media` 改列数、
 *   `overflow-x:auto`、裸 `vh`、`position:fixed`、`<table>`；
 * - 这三条都由 `src/test/cockpitSinglePage.test.ts` 机器校验。
 */
import { railWidthCss } from './sections';

/** `--het-*` → VS Code 主题变量（跟随深浅色，不自己造配色）。 */
export const HET_TOKEN_VARS: Readonly<Record<string, string>> = {
  '--het-fg': 'var(--vscode-foreground)',
  '--het-fg-dim': 'var(--vscode-descriptionForeground)',
  '--het-bg': 'var(--vscode-editor-background)',
  '--het-card-bg': 'var(--vscode-editorWidget-background)',
  '--het-border': 'var(--vscode-widget-border, var(--vscode-panel-border))',
  '--het-link': 'var(--vscode-textLink-foreground)',
  '--het-accent': 'var(--vscode-textLink-foreground)',
  '--het-hover': 'var(--vscode-list-hoverBackground)',
  '--het-active-bg': 'var(--vscode-list-activeSelectionBackground)',
  '--het-active-fg': 'var(--vscode-list-activeSelectionForeground)',
  '--het-ok': 'var(--vscode-testing-iconPassed, var(--het-fg))',
  '--het-warn': 'var(--vscode-editorWarning-foreground, var(--het-fg))',
  '--het-fail': 'var(--vscode-errorForeground, var(--het-fg))',
  '--het-na': 'var(--het-fg-dim)',
  '--het-gap': '8px',
  '--het-pad-card': '10px 12px',
  '--het-radius': '8px',
  '--het-rail-w': railWidthCss(),
  '--het-page-w': '900px',
  '--het-font-sm': '12px',
  '--het-font-xs': '11px',
};

function tokenBlock(): string {
  return Object.entries(HET_TOKEN_VARS)
    .map(([k, v]) => `    ${k}: ${v};`)
    .join('\n');
}

/** 布局 CSS：只有单列、定宽、flex-wrap、带上限的滚动盒。 */
export const SINGLE_PAGE_LAYOUT_CSS = `
  .sp { display: flex; flex-direction: column; gap: var(--het-gap); }
  .l1 { position: sticky; top: 0; z-index: 3; display: flex; flex-wrap: wrap; gap: 10px;
    align-items: center; padding: 6px 10px; border: 1px solid var(--het-border);
    border-radius: var(--het-radius); background: var(--het-card-bg); font-size: var(--het-font-sm); }
  .l1-item { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
  .l1-item .k { color: var(--het-fg-dim); }
  .sp-body { display: flex; align-items: flex-start; gap: var(--het-gap); }
  .rail { position: sticky; top: 0; display: flex; flex-direction: column; gap: 2px;
    width: var(--het-rail-w); flex: 0 0 var(--het-rail-w); }
  /* 实测反馈第 2 条：rail 从"12345"改成"图标 + 等长两字短名"，宽度跟着最长标签走。 */
  .rail-item { display: flex; align-items: center; justify-content: flex-start; gap: 4px;
    width: 100%; padding: 0 6px; box-sizing: border-box;
    height: 30px; border: 0; background: transparent; color: var(--het-fg);
    border-radius: 6px; cursor: pointer; opacity: .7; font-size: var(--het-font-sm); }
  .rail-ic { flex: 0 0 auto; line-height: 1; }
  .rail-tx { flex: 1 1 auto; text-align: left; white-space: nowrap; }
  .rail-item:hover { background: var(--het-hover); opacity: 1; }
  .rail-item[aria-current="true"] { background: var(--het-active-bg); color: var(--het-active-fg); opacity: 1; }
  .page { flex: 1 1 auto; min-width: 0; max-width: var(--het-page-w); }
  .sec { border: 1px solid var(--het-border); border-radius: var(--het-radius);
    background: var(--het-card-bg); margin-bottom: var(--het-gap); }
  .sec-head { display: flex; align-items: center; gap: 6px; width: 100%; border: 0;
    background: transparent; color: var(--het-fg); cursor: pointer; text-align: left;
    padding: 8px 10px; font-size: var(--het-font-sm); font-weight: 600; }
  .sec-head:hover { background: var(--het-hover); }
  /* 卡片副标题：静态语义（"这张卡跑的是哪条链"），比结果文字更弱。 */
  .card .sub { color: var(--het-fg-dim); font-size: var(--het-font-xs); opacity: .85; }
  /* jump 链接：导航，不是动作 —— 刻意长得不像按钮。 */
  .card .acts a, .card button.link { border: 0; background: none; color: var(--het-link);
    cursor: pointer; padding: 0; font-size: var(--het-font-sm); text-decoration: underline; }
  .sec-body { padding: 0 10px 10px; }
  .sec[data-collapsed="1"] .sec-body { display: none; }
  .cards { display: flex; flex-direction: column; gap: 2px; }
  .card { display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
    padding: var(--het-pad-card); border-top: 1px solid var(--het-border); min-width: 0; }
  .card > * { min-width: 0; }
  .card .ic { flex: 0 0 auto; width: 14px; text-align: center; }
  .card .nm { flex: 0 0 auto; font-weight: 600; }
  .card .fact { flex: 1 1 auto; color: var(--het-fg-dim); font-size: var(--het-font-sm); }
  .card .next { flex: 1 1 100%; color: var(--het-fg-dim); font-size: var(--het-font-xs); }
  .card .acts { flex: 0 0 auto; display: flex; gap: 6px; }
  .st-ok { color: var(--het-ok); } .st-warn { color: var(--het-warn); }
  .st-fail { color: var(--het-fail); } .st-na, .st-idle { color: var(--het-na); }
  /* §F.35："正在忙什么"要一眼看到、且**固定贴右**（吸顶右侧状态位）——以前只是灰字，
     构建时几乎看不见，用户就会去猜"到底有没有在跑"。 */
  .busy { display: inline-flex; align-items: center; gap: 6px; color: var(--het-accent);
    margin-left: auto; padding: 1px 9px; border: 1px solid var(--het-accent);
    border-radius: 999px; font-weight: 600; white-space: nowrap; }
  .busy[hidden] { display: none; }
  @keyframes het-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  .spin { display: inline-block; animation: het-spin 1s linear infinite; }
  button[disabled] { opacity: .6; cursor: default; }
  .sec-body .kv { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 2px 10px; }
  pre, code { overflow-wrap: anywhere; }
  .scrollbox { max-height: min(60vh, 420px); overflow: auto; }
  /* A 块：页内 Slot（细节视图画在这里，页签恒为 1）。容器必须有界：max-height + overflow */
  .slot { margin-top: var(--het-gap); border-top: 2px solid var(--het-border); }
  .slot-head { display: flex; align-items: center; gap: 8px; padding: 8px 0 4px; }
  .slot-title { font-weight: 600; }
  .slot-spacer { flex: 1; }
  .slot-body { max-height: min(70vh, 640px); overflow: auto; }
  @container (max-width: 460px) { .sec-body .kv { grid-template-columns: 1fr; } }
`;

export function singlePageCss(): string {
  return `<style>
  :root {
${tokenBlock()}
  }
${SINGLE_PAGE_LAYOUT_CSS}
</style>`;
}
