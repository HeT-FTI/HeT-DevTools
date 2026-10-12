import * as vscode from 'vscode';
import { ModuleLanguage, ModulePlan } from '../../core/moduleTemplate';
import {
  wizardIssueHtml,
  wizardNoticeHtml,
  wizardPageHtml,
  wizardPreviewHtml,
} from './wizardHtml';
import { showDetailPanel, type SlotPanel } from '../slots/host';

// F.30：页面 HTML 全部搬到 ./wizardHtml（纯函数、可单测）。**页面只生成一次**，
// 之后只往 `#preview` 推片段 —— 任何整页重渲染都会把用户填的表单冲回默认值。

/** Wizard form values collected from the webview. */
export interface ModulePanelInput {
  moduleName: string;
  description: string;
  language: ModuleLanguage;
  since: string;
  extraDeclarations?: string;
}

export interface ModuleWizardDeps {
  /** Live preview: returns plan plus conflict warnings per file. */
  plan: (input: ModulePanelInput) => Promise<{ plan: ModulePlan; conflicts: string[] }>;
  /** Confirm + write files, then refresh host state. */
  create: (input: ModulePanelInput) => Promise<{ ok: boolean; message: string }>;
}

export function showModuleWizardPanel(context: vscode.ExtensionContext, deps: ModuleWizardDeps): SlotPanel {
  // §D：细节面板共用一个页签（切视图换内容）——实现原样搬进来，只把"谁来持有面板"交给 host。
  return showDetailPanel(context, { id: 'moduleWizard', title: 'HeT DevTools — 新增模块向导' }, (panel) => {

    /** 只更新 `#preview` 一块内容 —— 表单是用户的输入，不能被任何刷新碰掉。 */
    const post = (html: string): void => {
      void panel.webview.postMessage({ type: 'update', html });
    };

    const sub = panel.webview.onDidReceiveMessage(async (message: { type: string; input?: ModulePanelInput }) => {
      const input = message.input;
      if (!input) {
        return;
      }
      try {
        if (message.type === 'plan') {
          const { plan, conflicts } = await deps.plan(input);
          post(plan.ok ? wizardPreviewHtml(plan, conflicts) : wizardIssueHtml(plan.issues));
        } else if (message.type === 'create') {
          const result = await deps.create(input);
          void vscode.window.showInformationMessage(result.message);
          // 成败都回片段：以前失败只弹 toast，面板里没有任何痕迹，看起来就像"点了没用"。
          post(result.ok ? wizardNoticeHtml(result.message) : wizardIssueHtml([result.message]));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        post(wizardIssueHtml([`执行失败：${msg}`]));
      }
    });

    panel.webview.html = wizardPageHtml();
    return sub;
  });
}
