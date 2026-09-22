/**
 * 页内「任务」视图的整页 HTML（J 块）。
 *
 * 遵守 F.29：一个文档只 `acquireVsCodeApi()` 一次 —— 这里用 pageShell 暴露的 `send()`，
 * 交互走事件委托。**实时刷新走片段替换**（`#tc-root` 的 innerHTML），不是整页重渲染：
 * 任务中心在跑起来时要每秒/每次状态变化都动一下，整页重渲染会把滚动位置和焦点抖掉。
 */
import { pageShell } from '../ui';
import type { TaskCenterModel } from '../../core/taskCenter';
import { TASK_CENTER_CSS, taskCenterHtml } from './html';

export function taskCenterPageHtml(model: TaskCenterModel): string {
  return pageShell(
    '任务：正在运行与最近完成',
    `<style>${TASK_CENTER_CSS}</style>
    <div class="card">
      <h1>任务：正在运行与最近完成</h1>
      <div class="sub">只读：这里只回答"在跑什么 / 跑过什么 / 结果如何"。要发起构建、测试、
        发布，去对应的工作流段（本页唯一的动作是取消）。</div>
      <div id="tc-root">${taskCenterHtml(model)}</div>
    </div>
    <script>
      // 交互全部走事件委托（F.29/F.30）。
      document.addEventListener('click', function (ev) {
        var el = ev.target instanceof Element ? ev.target : null;
        if (!el) { return; }
        var b = el.closest('[data-act],[data-art],[data-ci]');
        if (!b) { return; }
        var task = b.getAttribute('data-task') || '';
        if (b.hasAttribute('data-act') && b.getAttribute('data-act') === 'taskCancel') {
          b.disabled = true;
          b.textContent = '取消中…';
          send({ type: 'task:cancel', id: task });
          return;
        }
        if (b.hasAttribute('data-art')) {
          send({ type: 'task:artifact', id: task, index: Number(b.getAttribute('data-art') || '0') });
          return;
        }
        if (b.getAttribute('data-ci') === 'open') {
          send({ type: 'task:ci' });
        }
      });
      // 宿主推的片段（实时刷新；内容与首屏同一个渲染函数）
      window.addEventListener('message', function (ev) {
        var m = ev.data || {};
        if (m.type === 'taskCenter' && typeof m.html === 'string') {
          var root = document.getElementById('tc-root');
          if (root) { root.innerHTML = m.html; }
        }
      });
    </script>`,
  );
}
