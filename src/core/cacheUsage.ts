/**
 * **Conan 缓存体积报表**（K 块 / §3.4.4 `cache-usage`）：把"磁盘被谁吃了"变成可读数字。
 *
 * 背景（实测场景）：先本机 x86_64 试很多次、再切 arm；今天 armv7、明天 armv8。用户的原话是
 * "清理车道内 conan 缓存成了高频刚需"，而当时**看不到任何数字** —— 只能靠 `du` 猜。
 * 这里给出三件事，且**如实标注可信度**：
 *   1. 总量与分区（`p` 包 / `b` 构建 / `s` 源码 / `d` 下载 / `t` 临时）—— 膨胀主因是 `b`；
 *   2. 按 **arch** 的分布（读每个包的 `conaninfo.txt` 里的 `settings.arch`）—— 这才回答得了
 *      "armv7 那份到底占多少"；读不到的记入 `unknown`，**不假装知道**；
 *   3. 本工程的**按目标**构建目录占用（`build/<target>/`）。
 *
 * 关于布局：Conan 2 把每个包放在 `<CONAN_HOME>/p/<name><hash>/`，其下按 `p|b|s|d|t` 分区；
 * 另有 `<CONAN_HOME>/p/b/<name><hash>/` 这种"只有构建目录"的形态。所以扫描**不假设固定深度**，
 * 而是识别"名字恰为 p/b/s/d/t 且有包目录兄弟"的目录 —— 换 conan 版本也不会静默数成 0。
 *
 * 纯逻辑：只读文件系统，不 import vscode。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type CacheAreaName = 'package' | 'build' | 'source' | 'download' | 'temp' | 'other';

export interface CacheArea {
  area: CacheAreaName;
  bytes: number;
  dirs: number;
}

export interface ArchUsage {
  arch: string;
  bytes: number;
  packages: number;
}

export interface LocalBuildUsage {
  target: string;
  bytes: number;
}

export interface CacheReport {
  root: string;
  exists: boolean;
  totalBytes: number;
  areas: CacheArea[];
  byArch: ArchUsage[];
  /** `conaninfo.txt` 读不到 arch 的那部分（如实标出，不猜）。 */
  unknownArchBytes: number;
  localBuilds: LocalBuildUsage[];
  scannedAt: number;
}

const AREA_OF_DIR: Readonly<Record<string, CacheAreaName>> = {
  p: 'package',
  b: 'build',
  s: 'source',
  d: 'download',
  t: 'temp',
};

function dirBytes(dir: string): number {
  let total = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const p = join(dir, name);
    try {
      const st = statSync(p);
      if (st.isDirectory()) {
        total += dirBytes(p);
      } else {
        total += st.size;
      }
    } catch {
      /* 权限/竞态：跳过这一个，不整体失败 */
    }
  }
  return total;
}

/** 从 `conaninfo.txt` 文本里取 arch（**只认 `[settings]` 段** —— 读不到就不猜，避免把 options 里的同名键当架构）。 */
export function archOfConaninfo(text: string): string | undefined {
  const settingsAt = text.indexOf('[settings]');
  if (settingsAt < 0) {
    return undefined;
  }
  const rest = text.slice(settingsAt + '[settings]'.length);
  const nextSection = rest.search(/^\[/mu);
  const scope = nextSection >= 0 ? rest.slice(0, nextSection) : rest;
  return /^arch=(\S+)\s*$/mu.exec(scope)?.[1];
}

function looksLikePackageDir(dir: string): boolean {
  try {
    const names = new Set(readdirSync(dir));
    // 包目录：至少含 p/ 或 b/ 之一（只有构建目录的形态也算）
    if (!names.has('p') && !names.has('b')) {
      return false;
    }
    return ['p', 'b', 's', 'd', 't'].some((a) => names.has(a));
  } catch {
    return false;
  }
}

function packageDirs(root: string): string[] {
  const out: string[] = [];
  let top: string[];
  try {
    top = readdirSync(root);
  } catch {
    return out;
  }
  for (const name of top) {
    const p = join(root, name);
    let isDir = false;
    try {
      isDir = statSync(p).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) {
      continue;
    }
    if (looksLikePackageDir(p)) {
      out.push(p);
      continue;
    }
    // 一级容器（`<CONAN_HOME>/p/b/<name><hash>` 这种形态）
    for (const child of readdirSync(p)) {
      const c = join(p, child);
      try {
        if (statSync(c).isDirectory() && looksLikePackageDir(c)) {
          out.push(c);
        }
      } catch {
        /* skip */
      }
    }
  }
  return out;
}

/** 扫描缓存（`root` = CONAN_HOME）。`localBuildRoot` = 本工程 `build/` 目录（可选）。 */
export function scanCache(
  root: string,
  localBuildRoot?: string,
  opts: { now?: () => number } = {},
): CacheReport {
  const now = opts.now ?? ((): number => Date.now());
  const areas = new Map<CacheAreaName, CacheArea>();
  const bump = (area: CacheAreaName, bytes: number, dirs = 0): void => {
    const cur = areas.get(area) ?? { area, bytes: 0, dirs: 0 };
    cur.bytes += bytes;
    cur.dirs += dirs;
    areas.set(area, cur);
  };

  let exists = false;
  try {
    exists = statSync(root).isDirectory();
  } catch {
    exists = false;
  }

  const archBytes = new Map<string, { bytes: number; packages: number }>();
  let unknownArchBytes = 0;
  let total = 0;

  if (exists) {
    for (const pkgDir of packageDirs(root)) {
      let pkgPayload = 0;
      let pkgArch: string | undefined;
      for (const child of readdirSync(pkgDir)) {
        const c = join(pkgDir, child);
        const area = AREA_OF_DIR[child];
        let isDir = false;
        try {
          isDir = statSync(c).isDirectory();
        } catch {
          continue;
        }
        const bytes = isDir ? dirBytes(c) : statSync(c).size;
        total += bytes;
        if (area) {
          bump(area, bytes, 1);
          if (area === 'package') {
            pkgPayload += bytes;
            try {
              pkgArch = archOfConaninfo(readFileSync(join(c, 'conaninfo.txt'), 'utf8')) ?? pkgArch;
            } catch {
              /* 没有 conaninfo（例如只下载未构建）：如实计入 unknown */
            }
          }
        } else {
          bump('other', bytes, 1);
        }
      }
      if (pkgPayload > 0) {
        if (pkgArch) {
          const cur = archBytes.get(pkgArch) ?? { bytes: 0, packages: 0 };
          cur.bytes += pkgPayload;
          cur.packages += 1;
          archBytes.set(pkgArch, cur);
        } else {
          unknownArchBytes += pkgPayload;
        }
      }
    }
  }

  const localBuilds: LocalBuildUsage[] = [];
  if (localBuildRoot) {
    try {
      for (const target of readdirSync(localBuildRoot)) {
        const p = join(localBuildRoot, target);
        if (statSync(p).isDirectory()) {
          localBuilds.push({ target, bytes: dirBytes(p) });
        }
      }
    } catch {
      /* 没有构建目录：正常（还没构建过） */
    }
  }
  localBuilds.sort((a, b) => b.bytes - a.bytes);

  return {
    root,
    exists,
    totalBytes: total,
    areas: [...areas.values()].sort((a, b) => b.bytes - a.bytes),
    byArch: [...archBytes.entries()]
      .map(([arch, v]) => ({ arch, bytes: v.bytes, packages: v.packages }))
      .sort((a, b) => b.bytes - a.bytes),
    unknownArchBytes,
    localBuilds,
    scannedAt: now(),
  };
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  }
  if (bytes >= 1024 ** 2) {
    return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${bytes} B`;
}

const AREA_LABEL: Readonly<Record<CacheAreaName, string>> = {
  package: '包（已构建产物）',
  build: '构建目录（膨胀主因）',
  source: '源码',
  download: '下载（.tgz）',
  temp: '临时文件',
  other: '其它',
};

/** 报表文本（进输出通道 / 供 `het.cacheUsage` 返回）。 */
export function cacheReportText(report: CacheReport): string {
  if (!report.exists) {
    return `缓存目录不存在：${report.root}（还没跑过 conan）`;
  }
  const lines: string[] = [];
  lines.push(`Conan 缓存：${formatBytes(report.totalBytes)} @ ${report.root}`);
  for (const area of report.areas) {
    lines.push(`  · ${AREA_LABEL[area.area]}：${formatBytes(area.bytes)}（${area.dirs} 个）`);
  }
  if (report.byArch.length > 0) {
    lines.push('按架构（来自包的 conaninfo.txt）：');
    for (const a of report.byArch) {
      lines.push(`  · ${a.arch}：${formatBytes(a.bytes)}（${a.packages} 个包）`);
    }
  }
  if (report.unknownArchBytes > 0) {
    lines.push(`  · 架构未知：${formatBytes(report.unknownArchBytes)}（读不到 conaninfo，未猜测）`);
  }
  if (report.localBuilds.length > 0) {
    lines.push('本工程构建目录（按目标）：');
    for (const b of report.localBuilds) {
      lines.push(`  · ${b.target}：${formatBytes(b.bytes)}`);
    }
  }
  return lines.join('\n');
}

/** 一句话结论（给状态项/toast 用）—— 带"该不该清"的判断依据。 */
export function cacheVerdict(report: CacheReport): string {
  if (!report.exists) {
    return '还没有 conan 缓存';
  }
  const build = report.areas.find((a) => a.area === 'build')?.bytes ?? 0;
  const local = report.localBuilds.reduce((n, b) => n + b.bytes, 0);
  const parts = [`缓存 ${formatBytes(report.totalBytes)}`];
  if (report.byArch.length > 1) {
    parts.push(`${report.byArch.length} 个架构并存`);
  }
  if (build > 0) {
    parts.push(`其中构建目录 ${formatBytes(build)}（可安全清理）`);
  }
  if (local > 0) {
    parts.push(`本工程构建目录 ${formatBytes(local)}`);
  }
  return parts.join(' · ');
}
