/**
 * HUD 的**键盘直达**（实测反馈：HUD 上写着"按键 1–9 直达"，但按下去没反应）。
 *
 * 根因：按键只由页面内的 `keydown` 处理 —— 只有**焦点在 webview 里**时才收得到；用户
 * 通常一边看卡片一边在编辑器里干活，于是按键"看起来完全失效"。
 *
 * 修法：给 1–9 与 Esc 各注册一条 VS Code 命令 + 快捷键，`when` 限定在 HUD 面板激活时
 * （`activeWebviewPanelId == het.hud`）。两条路径（页面内 / 编辑器快捷键）最终都落到
 * **同一个动作表**（`HudAction.digit`），所以不会出现"按键做的事不一样"。
 *
 * 纯函数（不 import vscode），命令名与 package.json 声明由门禁断言。
 */
import type { HudAction } from './hudModel';

/** HUD 数字键位（1..9）。 */
export const HUD_DIGITS: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9];

/** 数字键 → 命令 id（`het.hud.d1` … `het.hud.d9`）。 */
export function digitCommand(digit: number): string {
  return `het.hud.d${digit}`;
}

/** Esc → 关闭 HUD（与页面内 Esc 同义）。 */
export const HUD_CLOSE_COMMAND = 'het.hud.esc';

/** 键位 → 命令（面板内与 package.json 的 keybindings 共用这一份）。 */
export function hudKeyCommands(): Array<{ key: string; command: string }> {
  return [
    ...HUD_DIGITS.map((d) => ({ key: String(d), command: digitCommand(d) })),
    { key: 'escape', command: HUD_CLOSE_COMMAND },
  ];
}

/** 命令 id 是 HUD 的键位命令吗（宿主注册时用，避免散落的字符串判断）。 */
export function isHudKeyCommand(command: string): boolean {
  return HUD_DIGITS.some((d) => digitCommand(d) === command) || command === HUD_CLOSE_COMMAND;
}

/**
 * 从命令 id 解出数字（非数字键命令返回 null）。
 *
 * 与 `HudAction.digit` 对齐：**动作表是唯一来源**，命令只是它的键盘外壳。
 */
export function digitOfCommand(command: string): number | null {
  const m = /^het\.hud\.d([1-9])$/u.exec(command);
  return m ? Number(m[1]) : null;
}

/** 动作表里带该数字的动作（没有就 undefined）。 */
export function actionForDigit(actions: readonly HudAction[], digit: number): HudAction | undefined {
  return actions.find((a) => a.digit === digit);
}

/** 键位提示行（页面里那行也要跟命令表同源）。 */
export function hudKeyHint(): string {
  const digits = HUD_DIGITS.filter((d) => d <= 9);
  return `按键 ${digits[0]}–${digits.at(-1)} 直达（卡片聚焦或在编辑器里都可按） · Esc 关闭`;
}
