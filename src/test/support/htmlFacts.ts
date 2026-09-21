/**
 * 测试用的 HTML 事实提取（**不参与产品构建**，只在 `src/test` 下使用）。
 *
 * 为什么需要它：页面 HTML 里到处有**注释**（我们在注释里写下了不变式，比如
 * "同一文档只能 `acquireVsCodeApi()` 一次"、`片段禁止自带 <script>`），
 * 直接 `includes()`/`split()` 数关键字会被注释和 CSS 选择器误伤（F.29/F.30 一路踩过）。
 * 所以统一：**先剥注释，再数**。
 */

/** 剥掉 `//` 行注释与 `/* *\/` 块注释（保留换行，避免行号错位）。 */
export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
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
