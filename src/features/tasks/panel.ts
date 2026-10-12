/**
 * 页内「任务」视图（J 块）= 任务中心的宿主侧。
 *
 * 只做四件事（每件都只有一个来源）：
 *   · **取模型**：`core/taskCenter.ts` 把 Task 事实（`core/busy.ts` 的仓库）与 CI 事实
 *     （`ciState()`）拼成模型 —— 面板自己不取数、不判断结论；
 *   · **渲染**：`features/tasks/html.ts`（纯函数）；首屏整页，之后只换 `#tc-root` 片段；
 *   · **实时**：订阅 Task 变更（状态一变就重画）+ 有任务在跑时每 5 秒重画一次（让"已用时"
 *     在动）；心跳/进度不算"状态变化"，否则每个心跳都重画一遍；
 *   · **唯一的动作**：取消（`cancelBusy`）。产物/CI 只是"打开"，不是"发起"。
 */
import * as vscode from 'vscode';
import { showDetailPanel, type SlotPanel } from '../slots/host';
import { cancelBusy, taskStore } from '../../core/busy';
import { taskCenterModel, type CiInput, type TaskCenterModel } from '../../core/taskCenter';
import { taskCenterHtml } from './html';
import { taskCenterPageHtml } from './page';

/** 有任务在跑时的刷新节拍（只为了让"已用时"在动）。 */
const TICK_MS = 5_000;

/**
 * CI 事实的短缓存（60 秒）。
 *
 * 为什么必须有：任务中心在跑起来时每 5 秒重画一次，如果每次都去问一次 GitHub（`gh api`）
 * —— 一个**只读面板**把网络打成了心跳。CI 结论本来也不是秒级事实（一次 run 几分钟），
 * 60 秒的陈旧完全可接受。
 */
const CI_TTL_MS = 60_000;

export interface TaskCenterDeps {
  /** CI 事实（与「CI 状态」面板**同一份**取值器 —— 不许第二套）。 */
  getCi: () => Promise<CiInput | null>;
  /** 打开产物：给了 command 走命令（必要时带 arg），否则直接打开 path。 */
  openArtifact: (a: { label: string; command?: string; arg?: string; path?: string }) => Promise<void>;
  /** 打开 GitHub Actions（CI 那一行的链接）。 */
  openCi: (url: string) => Promise<void>;
}

/** 任务的"状态签名"：只有它变了才重画（心跳/进度不在此列）。 */
function taskSignature(): string {
  return taskStore()
    .list()
    .map((t) => `${t.id}:${t.state}`)
    .join(',');
}

export function showTaskCenterPanel(context: vscode.ExtensionContext, deps: TaskCenterDeps): SlotPanel {
  return showDetailPanel(context, { id: 'tasks', title: '任务：正在运行与最近完成' }, (panel) => {
    let disposed = false;
    let signature = '';
    let ciAt = 0;
    let ciValue: CiInput | null = null;
    const timer = setInterval(() => {
      if (taskStore().active().length > 0) {
        void push();
      }
    }, TICK_MS);

    const build = async (): Promise<TaskCenterModel> => {
      if (Date.now() - ciAt > CI_TTL_MS) {
        ciValue = await deps.getCi().catch(() => null);
        ciAt = Date.now();
      }
      return taskCenterModel({ tasks: taskStore().list(), ci: ciValue, now: Date.now() });
    };

    /** 片段刷新（保留滚动位置与焦点）。 */
    async function push(): Promise<void> {
      if (disposed) {
        return;
      }
      const model = await build();
      if (disposed) {
        return;
      }
      signature = taskSignature();
      void panel.webview.postMessage({ type: 'taskCenter', html: taskCenterHtml(model) });
    }

    const off = taskStore().onChange(() => {
      const next = taskSignature();
      if (next !== signature) {
        void push();
      }
    });

    const sub = panel.webview.onDidReceiveMessage(
      async (message: { type?: string; id?: string; index?: number }) => {
        if (message.type === 'task:cancel' && message.id) {
          const ok = cancelBusy(message.id, '用户在任务中心取消');
          if (!ok) {
            // 不静默：取消失败也要给回执（否则就是"点了没反应"）
            void vscode.window.showInformationMessage('这个任务已经结束了，无需取消。');
          }
          void push();
        } else if (message.type === 'task:artifact' && message.id) {
          const art = taskStore().get(message.id)?.artifacts?.[message.index ?? 0];
          if (art) {
            await deps.openArtifact(art).catch(() => undefined);
          }
        } else if (message.type === 'task:ci') {
          const model = await build();
          if (model.ci?.url) {
            await deps.openCi(model.ci.url).catch(() => undefined);
          }
        }
      },
    );

    panel.onDidDispose(() => {
      disposed = true;
      off();
      clearInterval(timer);
    });

    void build().then(
      (model) => {
        if (!disposed) {
          signature = taskSignature();
          panel.webview.html = taskCenterPageHtml(model);
        }
      },
      (e) => console.error('[het] task center render failed', e),
    );
    return sub;
  });
}
