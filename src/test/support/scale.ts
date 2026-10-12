/**
 * **规模夹具**（§11.3 / G12）：把任意索引灌到 N 项，供"大集合控件"门禁复用。
 *
 * 为什么需要它：32 项时"看起来没问题"的控件，在 1,900+ 项（ConanCenter 量级）时会把
 * 屏幕撑爆 —— 实测反馈就是这么来的。所以规模不是"以后再说"，而是**每个控件交付前必答**的
 * 那一问（×1 / ×100 / ×1000），这里给出可复用的构造器。
 */
import type { CuratedEntry } from '../../data/conanIndex';
import type { PickerItem } from '../../features/picker';

/** 三档规模：小（回归基线）/ 现实（ConanCenter 量级）/ 压力（比现实再高一档）。 */
export const SCALE_SIZES = {
  small: 20,
  realistic: 1900,
  stress: 2000,
} as const;

export function scalePickerItems(n: number, prefix = 'pkg'): PickerItem[] {
  const width = String(n - 1).length;
  return Array.from({ length: n }, (_, i) => {
    const id = String(i).padStart(width, '0');
    return {
      value: `${prefix}-${id}`,
      label: `${prefix}-${id}`,
      note: i % 7 === 0 ? '日志/压测类（用于命中说明的匹配）' : `规模夹具第 ${id} 项`,
    };
  });
}

export function scaleCurated(n: number): CuratedEntry[] {
  return scalePickerItems(n).map((it) => ({
    conan: it.value,
    versions: ['1.0.0', '0.9.0'],
    bucket: 'cpp' as const,
    note: it.note ?? '',
  }));
}

/** 数一数渲染出来的行数（门禁用它断言"每页有界"）。 */
export function countRows(html: string, cls: string): number {
  const re = new RegExp(`<div class="${cls}"`, 'gu');
  return (html.match(re) ?? []).length;
}
