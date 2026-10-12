/**
 * 模板 tarball 的**获取与解压**（G17 的 IO 层）：候选链 → `.part` → sha256 → 原子改名 → 解压校验。
 *
 * 与 `core/wslRootfs.ts` 同一条纪律（那边是 340MB 的 rootfs，这边是 3MB 的模板，规矩一样）：
 *   · 先写 `.part`，校验通过才改名 —— 断网/中断不会留下"看起来已缓存"的半个文件；
 *   · 缓存按 sha256 命名，命中也要**重算一次**（用户可能手改/磁盘坏块）；
 *   · 失败不清空缓存目录（下次能续上），但 `.part` 一定清掉；
 *   · 校验不可跳过：我们 pin 的 sha256 是**唯一**判据（实测：官方与 gh-proxy 前缀字节相同）。
 *
 * 只依赖 node:fs / node:crypto / fetch / 系统 tar —— 无 vscode，可在本机真实验证
 * （`src/test/templateFetch.live.test.ts`，需 `HET_TEMPLATE_LIVE=1`）。
 */
import { existsSync } from 'node:fs';
import type { LogFn } from '../core/outputChannels';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { run } from '../utils/exec';
import {
  copyLocalToPart,
  downloadToPart,
  headIsGzipFile,
  localSourcePath,
  partPathFor,
  sha256File,
  type FetchProgress,
} from './fetch';
import {
  TarballCandidate,
  templateCacheName,
  verifyTemplateEntries,
  type TarballShape,
} from './templateTarball';

export interface TarballProgress {
  received: number;
  total?: number;
}

export interface EnsureTemplateTarballOptions {
  candidates: readonly TarballCandidate[];
  /** 期望的 sha256（我们 pin 的那个）。**必填**。 */
  sha256: string;
  cacheDir: string;
  bytes?: number;
  onLog?: LogFn;
  onProgress?: (p: TarballProgress) => void;
  /** 每个候选的下载超时（无人值守：不许无限等）。 */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface EnsureTemplateTarballResult {
  ok: boolean;
  /** 缓存里的最终路径。 */
  path?: string;
  /** 实际用的候选标签（用了加速前缀时要说出来）。 */
  via?: string;
  cached?: boolean;
  /** 主源失败退到备用时的一句话（**不静默降级**）。 */
  degraded?: string;
  /** 失败的候选（诊断用）。 */
  tried: string[];
  reason?: string;
}


/**
 * 确保模板 tarball 在缓存里且**校验通过**，返回缓存路径。
 *
 * 候选**按顺序**试；某个失败就在日志里说明"已改用下一个"（不静默）。
 */
export async function ensureTemplateTarball(opts: EnsureTemplateTarballOptions): Promise<EnsureTemplateTarballResult> {
  const log = opts.onLog ?? ((): void => undefined);
  const expected = opts.sha256.toLowerCase();
  const final = join(opts.cacheDir, templateCacheName(expected));
  const part = partPathFor(final);
  const tried: string[] = [];
  await mkdir(opts.cacheDir, { recursive: true });

  // 缓存命中也要重算 sha（不做"信任缓存"的假设）。
  if (existsSync(final)) {
    const got = await sha256File(final);
    if (got === expected) {
      log('template', `命中缓存 ${final}`);
      return { ok: true, path: final, via: '缓存', cached: true, tried };
    }
    log('template', `缓存 sha256 不一致（期望 ${expected.slice(0, 12)}…，实际 ${got.slice(0, 12)}…）→ 丢弃重下`);
    await rm(final, { force: true });
  }

  let lastError = '未知错误';
  for (const [i, cand] of opts.candidates.entries()) {
    tried.push(cand.label);
    try {
      log('template', `候选 ${i + 1}/${opts.candidates.length}：${cand.label} → ${cand.url}`);
      // 传输层（写 .part + 流式 sha256）在 `./fetch`；候选链与"降级要说出来"留在这里。
      const progress = opts.onProgress as ((p: FetchProgress) => void) | undefined;
      const local = localSourcePath(cand.url);
      const got = local
        ? await copyLocalToPart({ srcPath: local, partPath: part, onProgress: progress })
        : await downloadToPart({
            url: cand.url,
            partPath: part,
            timeoutMs: opts.timeoutMs ?? 120_000,
            bytes: opts.bytes,
            fetchImpl: opts.fetchImpl,
            onProgress: progress,
          });
      if (got.digest.toLowerCase() !== expected) {
        throw new Error(`sha256 不一致（期望 ${expected.slice(0, 12)}…，实际 ${got.digest.slice(0, 12)}…）`);
      }
      if (!(await headIsGzipFile(part))) {
        throw new Error('不是 gzip（很可能下到了 HTML 错误页）');
      }
      await rename(part, final);
      const degraded = i > 0 ? `主源失败，已改用「${cand.label}」（${tried.slice(0, -1).join(' → ')} 都不可用）` : undefined;
      if (degraded) {
        log('template', `${degraded}`);
      }
      log('template', `校验通过：sha256 ${expected.slice(0, 12)}… · ${got.bytes} 字节 → ${final}`);
      return { ok: true, path: final, via: cand.label, ...(degraded ? { degraded } : {}), tried };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      log('template', `✗ ${cand.label} 失败：${lastError}${i + 1 < opts.candidates.length ? ' → 试下一个' : ''}`);
      await rm(part, { force: true });
    }
  }
  return {
    ok: false,
    tried,
    reason: `模板下载失败（${tried.length} 个候选都不可用）：${lastError}`,
  };
}

export interface ExtractTemplateOptions {
  tarPath: string;
  destDir: string;
  onLog?: LogFn;
  /** 注入用（测试/干跑）。 */
  runImpl?: typeof run;
  timeoutMs?: number;
}

/**
 * 解压 + 形状校验。
 *
 * 解压**前**先 `tar -tzf` 列出条目做校验：顶层目录必须唯一、必备文件必须在
 * —— 不合格的包不解压（不留半个工程）。
 */
export async function extractTemplateTarball(opts: ExtractTemplateOptions): Promise<TarballShape & { destDir?: string }> {
  const log = opts.onLog ?? ((): void => undefined);
  const runner = opts.runImpl ?? run;
  const timeoutMs = opts.timeoutMs ?? 180_000;

  const listing = await runner('tar', ['-tzf', opts.tarPath], { timeoutMs });
  if ((listing.code ?? 1) !== 0) {
    return { ok: false, missing: [], reason: `tar -tzf 失败（exit=${listing.code}）：${listing.stderr.trim().slice(0, 200)}` };
  }
  const shape = verifyTemplateEntries(listing.stdout.split('\n'));
  if (!shape.ok) {
    return shape;
  }
  await mkdir(opts.destDir, { recursive: true });
  // 顶层目录唯一 → 剥掉一层，destDir 直接就是工程根（用户看到的路径没有多余嵌套）。
  const un = await runner('tar', ['-xzf', opts.tarPath, '-C', opts.destDir, '--strip-components=1'], { timeoutMs });
  if ((un.code ?? 1) !== 0) {
    return { ok: false, top: shape.top, missing: [], reason: `解压失败（exit=${un.code}）：${un.stderr.trim().slice(0, 200)}` };
  }
  log('template', `解压完成：${shape.top} → ${opts.destDir}`);
  return { ...shape, destDir: opts.destDir };
}
