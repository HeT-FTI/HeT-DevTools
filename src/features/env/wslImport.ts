/**
 * T17b（执行层）：把 Canonical 的 rootfs 变成**我们自己的** WSL 发行版。
 *
 * 分工：所有"决定"都在 `core/wslDistro.ts`（命名/同名冲突/接管判据/状态机/校验）与
 * `core/wslRootfs.ts`（下载/校验/缓存）里，且已被单测锁死；这里只做"跑命令 + 落文件"。
 *
 * 三条硬约束（计划附录 G.2）：
 *   I1 只碰带我们双标记的发行版（`adoptionVerdict` 是唯一入口）
 *   I2 从不改别人的发行版（不 `--set-default`、不对非我们的发行版 `--unregister`）
 *   I3 一切落在 `%LOCALAPPDATA%\het-fti\wsl\`，可被 `het.envRemove` 完全撑销
 *
 * 失败一律**保留现场**（退出码、输出尾、缓存路径）+ 给 A/C 两条路，绝不静默转 MSVC。
 */

import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { run } from '../../utils/exec';
import { decodeWslOutput, parseWslList, wslExePath, wslRunArgs } from '../../core/wslHost';
import { ensureRootfs, type RootfsProgress } from '../../core/wslRootfs';
import {
  adoptionVerdict,
  isOurDistroName,
  laneBootstrapScript,
  laneFailureHint,
  laneOwnerMarkerPath,
  laneWslInstallDir,
  mergeWslConf,
  planWslDistro,
  type DistroPlan,
  wslImportArgs,
  wslTerminateArgs,
  wslUnregisterArgs,
} from '../../core/wslDistro';
import { runWslScript } from './wslLane';

const WSL_TIMEOUT_MS = 20 * 60_000;

export interface DistroPlanOptions {
  /** `%LOCALAPPDATA%`（Windows）。 */
  localAppData: string;
  rootfs?: { url?: string; sha256?: string };
}

export interface ImportOptions extends DistroPlanOptions {
  extensionVersion: string;
  onProgress?: (p: RootfsProgress) => void;
  onLog?: (line: string) => void;
  /** 只做决定 + 下载校验，不执行 `wsl --import`（CI/预演用）。 */
  dryRun?: boolean;
}

export interface ImportOutcome {
  ok: boolean;
  plan: DistroPlan;
  distro?: string;
  /** 真实执行了 import 吗（dryRun=false 且成功）。 */
  imported?: boolean;
  cachePath?: string;
  /** 回读双标记二次确认（I1）。 */
  ownerVerified?: boolean;
  /** 发行版 bootstrap 打印的证据行（`lane_distro*`）。 */
  evidence?: string[];
  reason?: string;
}

/**
 * `%LOCALAPPDATA%`（托管发行版的落点，I3）。集中在这里，避免扩展/探针各自拼一遍
 * （拼错一次就会去错的地方找标记 → 把别人的发行版当成自己的）。
 */
export function laneLocalAppData(): string {
  return process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
}


export async function wslExeAvailable(): Promise<boolean> {
  try {
    const r = await run(wslExePath(), ['--status'], { timeoutMs: 20_000 });
    return (r.code ?? 1) === 0 || /wsl|kernel|版本|Default/i.test(`${wslText(r.stdout)}${wslText(r.stderr)}`);
  } catch {
    return false;
  }
}

/** `wsl -l -q`（UTF-16LE → 解析成名字列表）。 */
export async function listDistros(): Promise<string[]> {
  const r = await run(wslExePath(), ['-l', '-q'], { timeoutMs: 20_000 });
  return parseWslList(decodeWslOutput(`${r.stdout}`));
}

/** 读发行版内的文件（不存在/读不到 → undefined，不抛错）。 */
export async function readDistroFile(distro: string, path: string): Promise<string | undefined> {
  const r = await run(wslExePath(), wslRunArgs(distro, 'cat', [path]), { timeoutMs: 30_000 }).catch(() => null);
  return r && (r.code ?? 1) === 0 ? r.stdout : undefined;
}

function readWindowsMarker(localAppData: string, name: string): string | undefined {
  try {
    return readFileSync(laneOwnerMarkerPath(localAppData, name), 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * I1 的唯一入口：从 `wsl -l -q` 的名字里挑出"确实是我们的"那些（双标记 + 三者一致）。
 * 任何异常都当作"不是我们的"（保守：宁可不用自己的旧发行版，也不碰别人的）。
 */
export async function ourDistroNames(names: readonly string[], localAppData: string): Promise<string[]> {
  const ours: string[] = [];
  for (const name of names) {
    if (!isOurDistroName(name)) {
      continue;
    }
    const inDistro = await readDistroFile(name, '/etc/het-lane.json');
    const v = adoptionVerdict({
      name,
      isListed: true,
      ownerInDistro: inDistro,
      ownerOnWindows: readWindowsMarker(localAppData, name),
    });
    if (v.adopt) {
      ours.push(name);
    }
  }
  return ours;
}

/** 只看决策（UI/计划层用）：不下载、不改任何东西。 */
export async function getLaneDistroPlan(opts: DistroPlanOptions): Promise<DistroPlan> {
  const hasWsl = await wslExeAvailable();
  const distros = hasWsl ? await listDistros() : [];
  const ours = hasWsl ? await ourDistroNames(distros, opts.localAppData) : [];
  return planWslDistro({ wslExe: hasWsl, distros, ourDistros: ours, rootfs: opts.rootfs });
}

function tailOf(text: string, lines = 12): string {
  return text
    .split(/\r?\n/u)
    .filter((l) => l.trim().length > 0)
    .slice(-lines)
    .join('\n');
}

/**
 * `wsl.exe` 自己的消息是 **UTF-16LE**（`wsl -l -q` 也是如此），直接拼进错误文本会变成
 * `T\u0000h\u0000e\u0000…` —— 用户看到的就是这串乱码（2026-09-15 的 `windows-wsl-import`
 * 首跑实测：真实原因 "The imported file is not a valid Linux distribution" 被藏在了 NUL
 * 之间）。凡是要把 wsl.exe 的输出给人看的地方，都先过这一道。
 */
function wslText(raw: string): string {
  return decodeWslOutput(raw ?? '');
}

/**
 * 失败时的统一尾巴（见 `core/wslDistro › laneFailureHint`）—— 本模块头部的契约是
 * “失败一律保留现场 + 给 A/C 两条路，绝不静默转 MSVC”，而它此前只在 `wsl --import`
 * 失败时给出；bootstrap 失败对用户是同一个处境（车道用不了），所以共用一段文案。
 */
const LANE_ROUTE_HINT = laneFailureHint();

/**
 * 完整流程：决定 → 确保 rootfs（下载+校验+缓存）→ `wsl --import` → bootstrap → 双标记 → 回读确认。
 */
export async function importLaneDistro(opts: ImportOptions): Promise<ImportOutcome> {
  const log = opts.onLog ?? ((): void => undefined);
  const plan = await getLaneDistroPlan({ localAppData: opts.localAppData, rootfs: opts.rootfs });

  if (plan.kind === 'win-wsl2-ready') {
    return { ok: true, plan, distro: plan.distroName, imported: false, ownerVerified: true };
  }
  if (plan.kind !== 'win-wsl-import') {
    // 无 wsl / 无虚拟化 / 内核旧 / 换名用尽 / rootfs 配置非法 —— 都把可读原因带出去（T17c 渲染成卡片）。
    return { ok: false, plan, reason: plan.message };
  }

  const name = plan.distroName;
  const cacheDir = `${opts.localAppData}\\het-fti\\wsl\\cache`;
  log(`rootfs: ${plan.url}`);
  const rootfs = await ensureRootfs({
    url: plan.url,
    sha256: plan.sha256,
    cacheDir,
    bytes: plan.bytes,
    onProgress: opts.onProgress,
    onLog: log,
  });
  if (!rootfs.ok || !rootfs.path) {
    return { ok: false, plan, reason: rootfs.reason ?? 'rootfs 获取失败' };
  }

  if (opts.dryRun) {
    return { ok: true, plan, distro: name, imported: false, cachePath: rootfs.path, reason: 'dry-run：未执行 wsl --import' };
  }

  const installDir = laneWslInstallDir(opts.localAppData, name);
  mkdirSync(installDir, { recursive: true });
  const imp = await run(wslExePath(), wslImportArgs(name, installDir, rootfs.path), { timeoutMs: WSL_TIMEOUT_MS }).catch((err: Error) => ({ code: -1, stdout: '', stderr: err.message }));
  if ((imp.code ?? 1) !== 0) {
    return {
      ok: false,
      plan,
      cachePath: rootfs.path,
      reason:
        `wsl --import 失败（exit=${imp.code}）：\n${tailOf(`${wslText(imp.stdout)}\n${wslText(imp.stderr)}`)}\n` +
        `常见原因：虚拟化/虚拟机平台未开启、磁盘空间不足、同名发行版被占用。${LANE_ROUTE_HINT}`,
    };
  }

  // bootstrap：读现成的 wsl.conf → 合并（保留厂商设置）→ 落盘 + 装镜像缺的包 + 写 owner 标记。
  const vendorConf = await readDistroFile(name, '/etc/wsl.conf');
  const script = laneBootstrapScript({
    name,
    sha256: plan.sha256,
    extensionVersion: opts.extensionVersion,
    wslConf: mergeWslConf(vendorConf ?? ''),
  });
  const boot = await runWslScript(name, script, WSL_TIMEOUT_MS);
  if (boot.code !== 0) {
    return {
      ok: false,
      plan,
      cachePath: rootfs.path,
      reason: `发行版 bootstrap 失败（exit=${boot.code}）：\n${tailOf(`${boot.stdout}\n${boot.stderr}`)}\n${LANE_ROUTE_HINT}`,
    };
  }

  // Windows 侧标记（I1 的另一半）：只有两侧都在且一致，下次才会被"复用"而不是"换名重建"。
  const ownerPath = laneOwnerMarkerPath(opts.localAppData, name);
  mkdirSync(laneWslInstallDir(opts.localAppData, name), { recursive: true });
  writeFileSync(
    ownerPath,
    JSON.stringify(
      { lane: 'wsl2-managed', name, rootfsSha256: plan.sha256, extensionVersion: opts.extensionVersion, createdAt: new Date().toISOString() },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  // 回读确认（不信任"我刚写的文件"）：两侧标记必须一致才认账。
  const verify = adoptionVerdict({
    name,
    isListed: true,
    ownerInDistro: await readDistroFile(name, '/etc/het-lane.json'),
    ownerOnWindows: readWindowsMarker(opts.localAppData, name),
  });
  const evidence = boot.stdout
    .split(/\r?\n/u)
    .filter((l) => l.trim().startsWith('lane_distro'))
    .map((l) => l.trim());
  return {
    ok: verify.adopt,
    plan,
    distro: name,
    imported: true,
    cachePath: rootfs.path,
    ownerVerified: verify.adopt,
    evidence,
    reason: verify.adopt ? undefined : `自建完成但双标记校验未通过：${verify.reason}\n${LANE_ROUTE_HINT}`,
  };
}

/**
 * 撤销（I3）：只在本发行版通过 I1 校验时执行；`--terminate`/`--unregister`/删目录/可选清缓存。
 * 返回给人看的步骤（T16 的 `het.envRemove` 接它，不自动注销用户发行版）。
 */
export async function teardownLaneDistro(opts: {
  localAppData: string;
  keepCache?: boolean;
  onLog?: (line: string) => void;
}): Promise<{ ok: boolean; removed?: string[]; reason?: string }> {
  const log = opts.onLog ?? ((): void => undefined);
  const names = await listDistros();
  const ours = await ourDistroNames(names, opts.localAppData);
  if (ours.length === 0) {
    return { ok: true, removed: [], reason: '没有属于我们的托管发行版（无需清理）' };
  }
  const removed: string[] = [];
  for (const name of ours) {
    await run(wslExePath(), wslTerminateArgs(name), { timeoutMs: 60_000 }).catch(() => null);
    const un = await run(wslExePath(), wslUnregisterArgs(name), { timeoutMs: 5 * 60_000 }).catch((err: Error) => ({ code: -1, stderr: err.message, stdout: '' }));
    if ((un.code ?? 1) !== 0) {
      return { ok: false, removed, reason: `wsl --unregister ${name} 失败：${tailOf(`${wslText(un.stdout)}\n${wslText(un.stderr)}`, 6)}` };
    }
    rmSync(laneWslInstallDir(opts.localAppData, name), { recursive: true, force: true });
    removed.push(name);
    log(`removed:${name}`);
  }
  if (!opts.keepCache) {
    rmSync(`${opts.localAppData}\\het-fti\\wsl\\cache`, { recursive: true, force: true });
  }
  return { ok: true, removed };
}
