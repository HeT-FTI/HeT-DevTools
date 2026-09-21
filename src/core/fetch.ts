/**
 * 下载 → 校验 → 原子改名的**公共 IO**（G22 收口）。
 *
 * 抽出来的原因：`core/wslRootfs.ts`（340MB 级 rootfs）与 `core/templateFetch.ts`（3MB 级模板）
 * 本来各写了一遍**字节级相同**的循环（`.part` → 流式 sha256 → gzip 探针 → 原子改名），
 * 注释里还各抄了一段"为什么必须这样"。同一份纪律写两遍就会漂移，所以收到这里。
 *
 * 这里只放**与业务无关**的零件；"候选链怎么走、失败给用户看什么话"留在各自模块里
 * （两边的用户话术不同：rootfs 要说"内网镜像让管理员核对"，模板要说"改用哪个前缀了"）。
 *
 * 纪律（两边都不能违反）：
 *   1. 先写 `<final>.part`，校验通过才 `rename` —— 断网/中断不会留下"看起来已缓存"的半个文件；
 *   2. 缓存命中也要重算 sha256（用户可能手改/磁盘坏块），不一致就当没有；
 *   3. 失败清掉 `.part`，但**不清缓存目录**（下次能续上）；
 *   4. sha256 不可跳过 —— 没有"信任缓存"这个选项。
 *
 * 依赖只有 node:fs / node:crypto / fetch，**无 vscode**，所以本机（Linux）就能真实验证：
 * `src/test/wslRootfs.test.ts`（8 条，含"下到 HTML 错误页""缓存被改坏""本地源"）
 * 与 `src/test/templateFetch.live.test.ts`（`HET_TEMPLATE_LIVE=1`，真联网下载 → 校验 → 命中缓存）。
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export interface FetchProgress {
  received: number;
  total?: number;
}

export interface FileDigest {
  bytes: number;
  /** 小写十六进制 sha256。 */
  digest: string;
}

/** `<final>.part`：半成品路径。写完 + 校验通过才改名，避免"半个文件被当成缓存"。 */
export function partPathFor(finalPath: string): string {
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

/** 本地路径源（`file://` 或绝对路径 / 盘符 / UNC）—— 空气隔离与内网共享盘的用法。 */
export function localSourcePath(url: string): string | undefined {
  if (url.startsWith('file://')) {
    return decodeURIComponent(url.slice('file://'.length));
  }
  if (isAbsolute(url) || /^[a-zA-Z]:[\\/]/u.test(url) || /^[\\/]{2}[^\\/]+[\\/]/u.test(url)) {
    return url;
  }
  return undefined;
}

/** 头 2 字节是不是 gzip（拦住"下到 HTML 错误页"）。 */
export async function headIsGzipFile(path: string): Promise<boolean> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(2);
    const { bytesRead } = await fh.read(buf, 0, 2, 0);
    return isGzipMagic(buf.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}

/** 把本地文件（内网共享盘/离线包）流式写到 `.part`，顺便算 sha256。 */
export async function copyLocalToPart(opts: {
  srcPath: string;
  partPath: string;
  onProgress?: (p: FetchProgress) => void;
}): Promise<FileDigest> {
  const total = (await stat(opts.srcPath)).size;
  const hash = createHash('sha256');
  const fh = await open(opts.srcPath, 'r');
  const out = createWriteStream(opts.partPath, { flags: 'w' });
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
      opts.onProgress?.({ received, total });
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

export interface DownloadToPartOptions {
  url: string;
  partPath: string;
  /** 拿不到 `content-length` 时用于进度显示的期望字节数。 */
  bytes?: number;
  /** 无人值守：**给了才**加超时。rootfs 这种 340MB 的不给（慢链路会误杀），模板给 120s。 */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  onProgress?: (p: FetchProgress) => void;
}

/**
 * HTTP(S) 下载到 `.part`，顺便算 sha256。
 *
 * 抛出的错误**只描述传输层**（`HTTP 404 Not Found` / `响应没有 body`）—— 加 URL 或业务前缀
 * 是调用方的事，这样两边的用户话术可以各说各的。
 */
export async function downloadToPart(opts: DownloadToPartOptions): Promise<FileDigest> {
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(opts.url, {
    redirect: 'follow',
    ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  if (!res.body) {
    throw new Error('响应没有 body');
  }
  const total = Number(res.headers.get('content-length') ?? '') || opts.bytes;
  const hash = createHash('sha256');
  const out = createWriteStream(opts.partPath, { flags: 'w' });
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
