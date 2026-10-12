/**
 * 测试用的 HTML 事实提取（**不参与产品构建**，只在 `src/test` 下使用）。
 *
 * 为什么需要它：页面 HTML 里到处有**注释**（我们在注释里写下了不变式，比如
 * "同一文档只能 `acquireVsCodeApi()` 一次"、`片段禁止自带 <script>`），
 * 直接 `includes()`/`split()` 数关键字会被注释和 CSS 选择器误伤（F.29/F.30 一路踩过）。
 * 所以统一：**先剥注释，再数**。
 */

/**
 * 剥掉 `//` 行注释与 `/* *\/` 块注释（保留换行，避免行号错位）。
 *
 * **语义**：连**字符串里的**注释也剥。给"数调用次数"这类需求用 —— 我们要数的是"真的调了
 * 几次 `acquireVsCodeApi()`"，而 `pageShell` 里的 JS 字符串中含有一段解释性注释提到了它，
 * 那段提及必须一起消失（F.29 门禁就靠这个语义）。
 *
 * 另见 `stripCommentsCode`：扫"注册/结构"时要用那个（字符串里的 `/*` 不是注释）。
 */
export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

/**
 * 剥注释（**字符串感知**）—— 用于"扫代码结构"（比如找 registerCommand 字面量）。
 *
 * 踩过的坑：产品代码里有 conan 包模式 `fmt/*:*`，非字符串感知的实现看到 `/*` 就当块注释
 * 开始，把**后面整段代码**吃掉 —— §F.47 曾因此漏检 7 个命令。
 * 注释优先于字符串判定（中文注释里的撇号会让"先认字符串"的实现误入字符串状态，
 * 再也不剥注释）。
 */
export function stripCommentsCode(text: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  const isLineComment = (at: number): boolean => text.startsWith('//', at) && text[at - 1] !== ':';
  while (i < text.length) {
    const ch = text[i];
    if (quote) {
      out += ch;
      if (ch === '\\' && i + 1 < text.length) {
        out += text[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      i += 1;
      continue;
    }
    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      const chunk = end >= 0 ? text.slice(i, end + 2) : text.slice(i);
      out += chunk.replace(/[^\n]/gu, '');
      i += chunk.length;
      continue;
    }
    if (isLineComment(i)) {
      const end = text.indexOf('\n', i);
      i = end >= 0 ? end : text.length;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** 数"真的调用了"几次 `acquireVsCodeApi()`（注释里的提及不算）。 */
export function apiCalls(text: string): number {
  return countMatches(stripComments(text), /acquireVsCodeApi\s*\(/g);
}

/** 通用计数（正则必须带 `g`）。 */
export function countMatches(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
}

/** 数某个属性的取值出现次数（只看标签属性，不受 CSS 选择器影响）。 */
export function attrCount(html: string, tag: string, attr: string, value: string): number {
  const re = new RegExp(`<${tag}\\b[^>]*\\b${attr}="${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'g');
  return countMatches(html, re);
}
