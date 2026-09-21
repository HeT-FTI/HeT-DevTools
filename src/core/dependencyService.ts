import { FcppDependencyBuckets, FcppMetadata } from '../types';
import { parseRequirements, removeRequirement, upsertRequirement } from './conandataService';

/**
 * Dependency governance across metadata.json + conandata.yml (T-2.3).
 * Pure logic — enforces the fcpp dependency contract:
 *   - one package in exactly one bucket (common = C/C++ shared)
 *   - GTest only in infra
 *   - pybind11 gated by enable_python_bindings
 */

export type DepBucket = keyof FcppDependencyBuckets;

export interface DependencyView {
  /** Canonical display key in metadata.json (e.g. ZLIB, Eigen3). */
  displayKey: string;
  /** Conan package name in conandata.yml (e.g. zlib, eigen). */
  conanName: string;
  bucket: DepBucket;
  targets: string[];
  version?: string;
}

export interface AddDependencyInput {
  conanName: string;
  version: string;
  bucket: DepBucket;
  targets?: string[];
}

export interface RemoveDependencyInput {
  bucket: DepBucket;
  displayKey: string;
}

export interface DependencyEditResult {
  ok: boolean;
  issues: string[];
  nextMetadata?: FcppMetadata;
  nextConandataText?: string;
  /** 实际落盘的桶（可能与输入不同：规则固定桶会覆盖）。 */
  appliedBucket?: DepBucket;
  /** 是否被"规则固定桶"改写了归属（回执要如实说明，不许静默）。 */
  coerced?: boolean;
}

/**
 * **规则固定桶**（模板硬规则）：这些包只能落在指定桶里。
 *
 * 单一来源：`data/conanIndex.ts` 的索引条目与 `addDependency` 的写入都读这里 ——
 * 以前索引写 `gtest → common`、写入却强行改 `infra`，于是面板预选的值是错的。
 */
export const FORCED_BUCKET: Readonly<Record<string, DepBucket>> = {
  gtest: 'infra',
  pybind11: 'infra',
};

/** conandata.yml package name → metadata.json display key. */
const KEY_BY_CONAN: Record<string, string> = {
  zlib: 'ZLIB',
  pcre2: 'PCRE2',
  eigen: 'Eigen3',
  gtest: 'GTest',
  catch2: 'Catch2',
  pybind11: 'pybind11',
};

/** CMake target overrides (fcpp conan_targets), else `<conanName>::<conanName>`. */
const TARGET_OVERRIDES: Record<string, string> = {
  zlib: 'ZLIB::ZLIB',
  eigen: 'Eigen3::Eigen',
  catch2: 'Catch2::Catch2',
};

export function displayKeyFor(conanName: string): string {
  return KEY_BY_CONAN[conanName.toLowerCase()] ?? conanName;
}

export function defaultTargets(conanName: string): string[] {
  const lower = conanName.toLowerCase();
  return [TARGET_OVERRIDES[lower] ?? `${conanName}::${conanName}`];
}

/** Flatten all buckets into a lookup keyed by display key (case-insensitive). */
export function flattenDependencies(meta: FcppMetadata): Map<string, DependencyView> {
  const map = new Map<string, DependencyView>();
  const buckets = meta.dependencies ?? {};
  for (const bucket of ['common', 'c', 'cpp', 'infra'] as DepBucket[]) {
    const group = buckets[bucket] ?? {};
    for (const [displayKey, targets] of Object.entries(group)) {
      map.set(displayKey.toLowerCase(), {
        displayKey,
        conanName: conanToNameGuess(displayKey),
        bucket,
        targets: Array.isArray(targets) ? targets : [],
      });
    }
  }
  return map;
}

function conanToNameGuess(displayKey: string): string {
  const byKey = Object.entries(KEY_BY_CONAN).find(([, v]) => v === displayKey);
  return byKey ? byKey[0] : displayKey.toLowerCase();
}

function withBucket(meta: FcppMetadata, bucket: DepBucket, fn: (group: Record<string, string[]>) => Record<string, string[]>): FcppMetadata {
  const deps: FcppDependencyBuckets = { ...(meta.dependencies ?? {}) };
  const group = { ...(deps[bucket] ?? {}) };
  deps[bucket] = fn(group);
  return { ...meta, dependencies: deps };
}

/** Add a dependency to metadata.json + conandata.yml (validated). */
export function addDependency(
  meta: FcppMetadata,
  conandataText: string,
  input: AddDependencyInput,
): DependencyEditResult {
  const issues: string[] = [];
  const conanName = input.conanName.trim();
  const lower = conanName.toLowerCase();
  const forced = FORCED_BUCKET[lower];
  const bucket = forced ?? input.bucket;
  // 被规则改桶时**不静默**：回执里会说"已按规则归到 X 桶"（调用方从 appliedBucket 取）。
  const coerced = forced !== undefined && input.bucket !== forced;

  if (!conanName || !input.version) {
    return { ok: false, issues: ['缺少包名或版本'] };
  }
  if (lower === 'pybind11' && meta.enable_python_bindings !== true) {
    issues.push('需要先开启 enable_python_bindings = true 才能引入 pybind11');
  }

  const existing = flattenDependencies(meta);
  const displayKey = displayKeyFor(conanName);
  if (existing.has(displayKey.toLowerCase())) {
    issues.push(`依赖 ${displayKey} 已存在（${existing.get(displayKey.toLowerCase())?.bucket} 桶）`);
  }
  if (issues.length > 0) {
    return { ok: false, issues };
  }

  const targets = input.targets && input.targets.length > 0 ? input.targets : defaultTargets(conanName);
  const nextMetadata = withBucket(meta, bucket, (group) => ({ ...group, [displayKey]: targets }));
  const nextConandataText = upsertRequirement(conandataText, conanName, input.version).text;
  return { ok: true, issues: [], nextMetadata, nextConandataText, appliedBucket: bucket, coerced };
}

/** Remove a dependency from metadata.json + conandata.yml. */
export function removeDependency(
  meta: FcppMetadata,
  conandataText: string,
  input: RemoveDependencyInput,
): DependencyEditResult {
  const existing = flattenDependencies(meta).get(input.displayKey.toLowerCase());
  if (!existing) {
    return { ok: false, issues: [`依赖 ${input.displayKey} 不存在`] };
  }
  const nextMetadata = withBucket(meta, existing.bucket, (group) => {
    const next = { ...group };
    delete next[existing.displayKey];
    return next;
  });
  const nextConandataText = removeRequirement(conandataText, existing.conanName).text;
  return { ok: true, issues: [], nextMetadata, nextConandataText };
}

/** Merge conandata versions into a list view (version may be unknown). */
export function listDependencies(meta: FcppMetadata, conandataText: string): DependencyView[] {
  const reqs = new Map(parseRequirements(conandataText).map((r) => [r.pkg.toLowerCase(), r.version]));
  return [...flattenDependencies(meta).values()].map((d) => ({
    ...d,
    version: reqs.get(d.conanName.toLowerCase()),
  }));
}
