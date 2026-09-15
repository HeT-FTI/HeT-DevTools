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
 * 只依赖 node:fs / node:crypto / fetch —— 无 vscode、无 Windows 专属逻辑（可在任何平台跑），
 * 所以本机（Linux）就能对它做真实验证：见 `src/test/wslRootfsLive.test.ts`（HET_ROOTFS_LIVE=1）。
 */

import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

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

/** 缓存文件按 sha256 命名（换名/重试都不重复下载）。 */
export function rootfsCacheFilePath(cacheDir: string, sha256: string): string {
  return join(cacheDir, `${sha256}.tar.gz`);
}

/** 半成品路径：写完 + 校验通过才改名，避免"半个文件被当成缓存"。 */
export function rootfsPartFilePath(finalPath: string): string {
  return `${finalPath}.part`;
}

/** gzip magic（`1f 8b`）：花 2 字节就能拦住"下到了 HTML 错误页"这种最常见的错。 */
export function isGzipMagic(buf: Uint8Array): boolean {
  return buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

/** 流式计算文件的 sha256（大文件不占内存）。 */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (bytesRead <= 0) {
        break;
      }
      hash.update(buf.subarray(0, bytesRead));
    }
  } finally {
    await fh.close();
  }
  return hash.digest('hex');
}

/** 本地路径源（file:// 或绝对路径）—— 空气隔离/内网共享盘的用法。 */
export function localSourcePath(url: string): string | undefined {
  if (url.startsWith('file://')) {
    return decodeURIComponent(url.slice('file://'.length));
  }
  // POSIX 绝对路径 / Windows 盘符 / UNC 共享（内网共享盘：\\server\share\x.tar.gz）
  if (isAbsolute(url) || /^[a-zA-Z]:[\\/]/u.test(url) || /^[\\/]{2}[^\\/]+[\\/]/u.test(url)) {
    return url;
  }
  return undefined;
}

async function copyLocal(srcPath: string, partPath: string, onProgress?: (p: RootfsProgress) => void): Promise<{ bytes: number; digest: string }> {
  const total = (await stat(srcPath)).size;
  const hash = createHash('sha256');
  const fh = await open(srcPath, 'r');
  const out = createWriteStream(partPath, { flags: 'w' });
  let received = 0;
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (bytesRead <= 0) {
        break;
      }
      const chunk = buf.subarray(0, bytesRead);
      hash.update(chunk);
      received += bytesRead;
      onProgress?.({ received, total });
      if (!out.write(Buffer.from(chunk))) {
        await new Promise<void>((resolve) => out.once('drain', () => resolve()));
      }
    }
  } finally {
    await fh.close();
    await new Promise<void>((resolve, reject) => {
      out.end(() => resolve());
      out.once('error', reject);
    });
  }
  return { bytes: received, digest: hash.digest('hex') };
}

async function downloadHttp(url: string, partPath: string, opts: EnsureRootfsOptions): Promise<{ bytes: number; digest: string }> {
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`下载失败：HTTP ${res.status} ${res.statusText}（${url}）`);
  }
  if (!res.body) {
    throw new Error(`下载失败：响应没有 body（${url}）`);
  }
  const total = Number(res.headers.get('content-length') ?? '') || opts.bytes;
  const hash = createHash('sha256');
  const out = createWriteStream(partPath, { flags: 'w' });
  let received = 0;
  try {
    // Node 22 的全局 fetch 返回 web ReadableStream；逐块读并做背压处理。
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      const buf = Buffer.from(chunk);
      hash.update(buf);
      received += buf.length;
      opts.onProgress?.({ received, total });
      if (!out.write(buf)) {
        await new Promise<void>((resolve) => out.once('drain', () => resolve()));
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      out.end(() => resolve());
      out.once('error', reject);
    });
  }
  return { bytes: received, digest: hash.digest('hex') };
}

/** 头 2 字节是不是 gzip（拦住"下到 HTML 错误页"）。 */
async function headIsGzip(path: string): Promise<boolean> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(2);
    const { bytesRead } = await fh.read(buf, 0, 2, 0);
    return isGzipMagic(buf.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
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
    const { bytes, digest } = local
      ? await copyLocal(local, part, opts.onProgress)
      : await downloadHttp(opts.url, part, opts);
    if (digest !== expected) {
      await rm(part, { force: true });
      return {
        ok: false,
        reason:
          `rootfs sha256 不匹配：期望 ${expected}，实际 ${digest}（源文件内容与官方不一致 —— ` +
          '内网镜像请让管理员核对，或显式更新 het.env.wslRootfsSha256）',
      };
    }
    if (!(await headIsGzip(part))) {
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
