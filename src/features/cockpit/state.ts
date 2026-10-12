/**
 * Cockpit top-strip state（新 UI）。
 *
 * 纯粹的一个 reducer，无 vscode 依赖。旧 UI 的"当前页 / 抽屉 / 向导"已经归档
 * （`_archive/`）—— 新 UI 里 L1 只需要：项目名 · 健康分 · 忙点 · 模板落后，
 * 外加构建结果与问题计数（供卡片复用）。
 */

export type DrawerKind = 'none' | 'log' | 'issues';

export interface CockpitDrawer {
  kind: DrawerKind;
  expanded: boolean;
  title: string;
  /** log lines (streamed, capped at 200). */
  lines: string[];
}

export interface CockpitTop {
  projectName: string;
  health: number | null;
  running: string | null;
  /**
   * 模板落后多少提交。
   *
   * **`undefined` = 本会话还没查过**（与 `0`（真查过、与模板一致）是两件事）——
   * 「模板同步」卡据此决定说什么：`0` 才敢说"与模板一致"。
   */
  templateBehind?: number;
}

export interface CockpitState {
  top: CockpitTop;
  drawer: CockpitDrawer;
  lastBuildOk: boolean | null;
  issueCount: number;
}

export type CockpitEvent =
  | { type: 'drawer:toggle'; expand: boolean }
  | { type: 'log:start'; title: string }
  | { type: 'log:append'; line: string }
  | { type: 'log:done'; ok: boolean }
  | { type: 'issue:summary'; count: number }
  | {
      /**
       * 模板落后多少提交。
       *
       * **`behind` 省略 = 这次没比成**（没有标记文件 / 拿不到模板副本）—— 与 `0`
       * （真比过、一致）是两件事：早期版本把"没比成"也发 0，于是界面上会说"与模板一致"，
       * 那是编造（真机截图里被看见过）。
       */
      type: 'template:update';
      behind?: number;
    }
  | { type: 'health'; score: number }
  | { type: 'project'; name: string };

const LOG_CAP = 200;

export function initialCockpitState(): CockpitState {
  return {
    top: { projectName: '', health: null, running: null },
    drawer: { kind: 'none', expanded: false, title: '', lines: [] },
    lastBuildOk: null,
    issueCount: 0,
  };
}

export function reduceCockpit(state: CockpitState, event: CockpitEvent): CockpitState {
  switch (event.type) {
    case 'drawer:toggle':
      return { ...state, drawer: { ...state.drawer, expanded: event.expand } };
    case 'log:start':
      return {
        ...state,
        top: { ...state.top, running: event.title },
        drawer: { kind: 'log', expanded: true, title: event.title, lines: [] },
      };
    case 'log:append':
      if (state.drawer.kind !== 'log') {
        return state;
      }
      return {
        ...state,
        drawer: { ...state.drawer, lines: [...state.drawer.lines, event.line].slice(-LOG_CAP) },
      };
    case 'log:done':
      // Keep the drawer open so the tail of the run stays visible; the
      // controller collapses it 3 s later (or the user toggles it).
      return {
        ...state,
        top: { ...state.top, running: null },
        lastBuildOk: event.ok,
      };
    case 'issue:summary':
      return {
        ...state,
        issueCount: event.count,
        drawer:
          event.count > 0
            ? { kind: 'issues', expanded: true, title: `${event.count} 个错误已映射到“问题”面板`, lines: [] }
            : state.drawer.kind === 'issues'
              ? { ...state.drawer, expanded: false }
              : state.drawer,
      };
    case 'template:update':
      return { ...state, top: { ...state.top, templateBehind: event.behind } };
    case 'health':
      return { ...state, top: { ...state.top, health: event.score } };
    case 'project':
      return { ...state, top: { ...state.top, projectName: event.name } };
    default:
      return state;
  }
}
