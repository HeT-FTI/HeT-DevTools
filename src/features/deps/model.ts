/**
 * 依赖管理器的**纯逻辑**（不 import vscode）：索引检索、版本联动、域归属、输入校验。
 *
 * 为什么要单独一层：实测反馈里依赖面板"点不动"的直接原因是**前端控件与索引脱节**
 * （包名手打、版本手打、桶手选），于是任何一个字段对不上就静默失败。把"名字 → 版本
 * 候选 / 域归属"做成可单测的纯函数之后，面板只负责渲染与回显。
 */
import { CURATED_PACKAGES, type CuratedEntry } from '../../data/conanIndex';
import type { DepBucket, DependencyView } from '../../core/dependencyService';

export const DEP_BUCKETS: readonly DepBucket[] = ['common', 'c', 'cpp', 'infra'];

const BUCKET_LABEL: Readonly<Record<DepBucket, string>> = {
  common: 'C/C++ 共用 (common)',
  c: '仅 C (c)',
  cpp: '仅 C++ (cpp)',
  infra: '基础设施 (infra)',
};

export function bucketLabel(bucket: string): string {
  return BUCKET_LABEL[bucket as DepBucket] ?? bucket;
}

/** 模板规则：不在索引里的包默认归 C++ 桶（可改）。 */
export function bucketOf(name: string, curated: readonly CuratedEntry[] = CURATED_PACKAGES): DepBucket {
  return curated.find((c) => c.conan === name)?.bucket ?? 'cpp';
}

/**
 * 版本候选：索引给的版本 + 当前已装版本（如果不在索引里，用户至少能看到自己装的是哪个）。
 * 末尾固定加一个"自定义…"哨兵，允许索引过时的情况。
 */
export const CUSTOM_VERSION = '__custom__';

export function versionsFor(
  name: string,
  current?: string | null,
  curated: readonly CuratedEntry[] = CURATED_PACKAGES,
): string[] {
  const known = curated.find((c) => c.conan === name)?.versions ?? [];
  const out = [...known];
  if (current && !out.includes(current)) {
    out.unshift(current);
  }
  return [...out, CUSTOM_VERSION];
}

/** 索引检索：空串给全部；按包名/说明做大小写不敏感子串匹配。 */
export function searchCatalog(query: string, curated: readonly CuratedEntry[] = CURATED_PACKAGES): CuratedEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return [...curated];
  }
  return curated.filter(
    (c) => c.conan.toLowerCase().includes(q) || c.note.toLowerCase().includes(q),
  );
}

export interface AddInputDraft {
  conanName: string;
  version: string;
  bucket: string;
  targets?: string;
}

/**
 * 提交前的校验：**必须回一句人话**（实测反馈里的"点了没反应"就是这里静默 return 造成的）。
 * 返回 null = 可以提交。
 */
export function validateAddInput(draft: AddInputDraft): string | null {
  if (!draft.conanName.trim()) {
    return '请先在上方搜索框选择或输入包名（内置索引含常见 ConanCenter 包）。';
  }
  if (!draft.version.trim() || draft.version === CUSTOM_VERSION) {
    return `请选择 ${draft.conanName.trim()} 的版本（可选"自定义…"手动填写）。`;
  }
  if (!DEP_BUCKETS.includes(draft.bucket as DepBucket)) {
    return `未知的归属桶「${draft.bucket}」——只能是 ${DEP_BUCKETS.join(' / ')}。`;
  }
  return null;
}

export interface DepGroup {
  bucket: DepBucket;
  label: string;
  rows: DependencyView[];
}

/** 按固定桶顺序分组（面板顺序稳定，空桶也显示 —— "没有"本身也是信息）。 */
export function groupRows(views: readonly DependencyView[]): DepGroup[] {
  return DEP_BUCKETS.map((bucket) => ({
    bucket,
    label: bucketLabel(bucket),
    rows: views.filter((v) => v.bucket === bucket),
  }));
}

/** 面板要嵌进页面的索引快照（供版本联动用；不含索引之外的信息）。 */
export interface CatalogSnapshotItem {
  conan: string;
  versions: string[];
  bucket: DepBucket;
  note: string;
}

export function catalogSnapshot(curated: readonly CuratedEntry[] = CURATED_PACKAGES): CatalogSnapshotItem[] {
  return curated.map((c) => ({ conan: c.conan, versions: [...c.versions], bucket: c.bucket, note: c.note }));
}

/** 把清单压成一句"当前有什么"（面板提示行与 QuickPick 回执共用，口径一致）。 */
export function summarizeDeps(views: readonly DependencyView[]): string {
  if (views.length === 0) {
    return '尚无依赖（conandata.yml 的 requirements 为空）';
  }
  return `${views.length} 个：${views.map((v) => `${v.displayKey}@${v.version ?? '?'}`).join(' · ')}`;
}
