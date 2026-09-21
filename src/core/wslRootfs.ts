/**
 * T17b: rootfs 获取（下载 → 校验 → 缓存）—— 计划附录 G.3。
 *
 * 为什么单独成模块：这是**唯一会往用户机器写 340MB** 的地方，且"校验"是安全边界
 * （内网镜像内容未必与官方一致）。所以：
 *   · 校验**不可跳过**：`het.env.wslRootfsUrl` 覆盖时必须同时给出 sha256（在 wslDistro.ts 里判）；
 *   · 先写 `.part` 再原子改名 → 中断/断电不会留下"看起来已缓存但其实是半个文件"的假缓存；
 *   · 缓存按 sha256 命名 → 重复修复、换名导入（T17a 的同名冲突路径）都不重新下载；
 *   · 缓存命中也要重新校验一次 sha256（用户可能手改/磁盘坏块），不一致就当没有。
 *
 * 传输层（`.part` / 流式 sha256 / 原子改名）现在与模板共用 `core/fetch.ts` —— 越共用越要有
 * 真实链路的证明，所以本机（Linux）就能对它做真实验证：
 *   · `src/test/wslRootfs.test.ts`（8 条，注入 fetch：`.part`、sha 不匹配、HTML 错误页、
 *     HTTP 404、缓存被改坏、`file://` 本地源）；
 *   · `src/test/wslRootfsLive.test.ts`（`HET_ROOTFS_LIVE=1`：真的下 340MB → 复算 sha256
 *     → `.part` 清干净 → 第二次命中缓存）。
 */

import { existsSync } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  copyLocalToPart,
  downloadToPart,
  headIsGzipFile,
  localSourcePath,
  partPathFor,
  sha256File,
  type FetchProgress,
} from './fetch';

// 旧 import 路径仍然是 `./wslRootfs`（模板侧与测试都从这里取），实现已收到 `./fetch`。
export { isGzipMagic, localSourcePath, sha256File } from './fetch';

export interface RootfsProgress {
  received: number;
  total?: number;
}

export interface EnsureRootfsOptions {
  /** 源：http(s):// 或 file:// 或本地绝对路径（空气隔离/内网镜像）。 */
  url: string;
  /** 期望的 sha256（小写十六进制）。**必填** —— 没有"跳过校验"的用法。 */
  sha256: string;
  /** 缓存目录（`%LOCALAPPDATA%\het-fti\wsl\cache`）。 */
  cacheDir: string;
  /** 期望字节数（仅用于进度与日志）。 */
  bytes?: number;
  onProgress?: (p: RootfsProgress) => void;
  onLog?: (line: string) => void;
  /** 测试注入用；默认全局 fetch。 */
  fetchImpl?: typeof fetch;
}

export interface EnsureRootfsResult {
  ok: boolean;
  /** 缓存里的最终路径（ok 时必有）。 */
  path?: string;
  /** true = 复用已有缓存（未重新下载）。 */
  cached?: boolean;
  bytes?: number;
  reason?: string;
}

/**
 * 半成品路径：写完 + 校验通过才改名，避免"半个文件被当成缓存"。
 * （实现已收到 `./fetch` 的 `partPathFor()`，这里保留旧名字给调用方与测试。）
 */
export function rootfsPartFilePath(finalPath: string): string {
  return partPathFor(finalPath);
}

/** 缓存文件按 sha256 命名（换名/重试都不重复下载）。 */
export function rootfsCacheFilePath(cacheDir: string, sha256: string): string {
  return join(cacheDir, `${sha256}.tar.gz`);
}


/**
 * 确保 rootfs 已在缓存里且**校验通过**，返回缓存路径。
 *
 * 行为：缓存存在 → 重算 sha256（命中即返回 cached=true，不一致就丢弃重下）；
 * 否则写 `.part` → 校验 → gzip 探针 → 原子改名。任何失败都清掉 `.part`（不留脏数据）。
 */
export async function ensureRootfs(opts: EnsureRootfsOptions): Promise<EnsureRootfsResult> {
  const log = opts.onLog ?? ((): void => undefined);
  const expected = opts.sha256.toLowerCase();
  const final = rootfsCacheFilePath(opts.cacheDir, expected);
  const part = rootfsPartFilePath(final);

  if (existsSync(final)) {
    const got = await sha256File(final);
    if (got === expected) {
      log(`rootfs_cache:hit(${expected.slice(0, 12)}…)`);
      return { ok: true, path: final, cached: true, bytes: (await stat(final)).size };
    }
    log(`rootfs_cache:stale(实际 ${got.slice(0, 12)}… ≠ 期望 ${expected.slice(0, 12)}…) → 丢弃重下`);
    await rm(final, { force: true });
  }

  await mkdir(opts.cacheDir, { recursive: true });
  const local = localSourcePath(opts.url);
  try {
    // 传输层（写 .part + 流式 sha256）已收到 `./fetch`；这里只留"业务话术"：
    // rootfs 的报错必须能让内网管理员看出"镜像内容不对"，所以给传输错误加前缀与 URL。
    // 注：rootfs 不设下载超时（340MB 级、慢链路会误杀），要超时得由调用方显式给。
    let bytes: number;
    let digest: string;
    if (local) {
      ({ bytes, digest } = await copyLocalToPart({
        srcPath: local,
        partPath: part,
        onProgress: opts.onProgress as ((p: FetchProgress) => void) | undefined,
      }));
    } else {
      try {
        ({ bytes, digest } = await downloadToPart({
          url: opts.url,
          partPath: part,
          bytes: opts.bytes,
          fetchImpl: opts.fetchImpl,
          onProgress: opts.onProgress as ((p: FetchProgress) => void) | undefined,
        }));
      } catch (err) {
        throw new Error(`下载失败：${(err as Error).message}（${opts.url}）`);
      }
    }
    if (digest !== expected) {
      await rm(part, { force: true });
      return {
        ok: false,
        reason:
          `rootfs sha256 不匹配：期望 ${expected}，实际 ${digest}（源文件内容与官方不一致 —— ` +
          '内网镜像请让管理员核对，或显式更新 het.env.wslRootfsSha256）',
      };
    }
    if (!(await headIsGzipFile(part))) {
      await rm(part, { force: true });
      return { ok: false, reason: 'rootfs 不是 gzip/tar.gz（可能是错误页或半截文件）' };
    }
    await rename(part, final);
    log(`rootfs_cache:stored(${bytes} B, ${expected.slice(0, 12)}…)`);
    return { ok: true, path: final, cached: false, bytes };
  } catch (err) {
    await rm(part, { force: true });
    return { ok: false, reason: `rootfs 获取失败：${(err as Error).message}` };
  }
}
