/**
 * V4-2/V4-8 host provisioner: prepare/status/remove a MANAGED environment.
 *
 * Everything is created under extension storage (see core/managedEnv) so it is
 * removed on uninstall. The first working bootstrap is: system python/uv →
 * venv (tools/py) → pip install conan/cmake/ninja → CONAN_HOME redirected →
 * marker written. Compilers stay provider-owned (system gcc/clang or, later, a
 * managed gcc); the profile pins their exact paths so nothing is "detected".
 *
 * Consent is handled by the caller (command layer): automation passes yes=true
 * (HET_NO_UI), real users confirm once.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run, type ExecResult } from '../../utils/exec';
import { withDeadline } from '../../core/deadlines';
import {
  ManagedLayout,
  ManagedMarker,
  ManagedState,
  envWithManaged,
  gcManagedEnv,
  managedLayout,
  readMarker,
  removeManagedEnv,
  requiredReadyFiles,
  venvBinDir,
  venvTool,
  writeMarker,
} from '../../core/managedEnv';

export interface ManagedStatus {
  state: ManagedState;
  provider?: string;
  tools: Record<string, string>;
  note?: string;
}

export interface PrepareOptions {
  storageRoot: string;
  isWin: boolean;
  /** Base PATH to extend (usually process.env.PATH). */
  basePath: string;
  /** Allow running installs (consent given by the user/automation). */
  yes: boolean;
  onProgress?: (message: string) => void;
}

export interface PrepareResult {
  ok: boolean;
  state: ManagedState;
  message: string;
}

function progress(o: PrepareOptions | undefined, m: string): void {
  o?.onProgress?.(m);
}

export function currentManagedStatus(storageRoot: string, isWin: boolean): ManagedStatus {
  const layout = managedLayout(storageRoot);
  const marker = readMarker(layout);
  if (!marker) {
    return { state: 'absent', tools: {} };
  }
  const missing = requiredReadyFiles(layout, isWin).filter((f) => !existsSync(f));
  const state: ManagedState = missing.length === 0 ? (marker.state === 'ready' ? 'ready' : marker.state) : 'error';
  return {
    state,
    provider: marker.provider,
    tools: marker.tools,
    note: missing.length > 0 ? `环境损坏：缺少 ${missing.map((f) => f.split(/[\\/]/).pop()).join('、')}` : marker.note,
  };
}

async function bootstrapPython(isWin: boolean): Promise<string> {
  const candidates = isWin ? ['python', 'py'] : ['python3', 'python'];
  for (const c of candidates) {
    try {
      const r = await run(c, ['--version'], { timeoutMs: 8000 });
      if (r.code === 0) {
        return c;
      }
    } catch {
      /* try next */
    }
  }
  return '';
}

function venvPython(layout: ManagedLayout, isWin: boolean): string {
  return join(venvBinDir(layout, isWin), isWin ? 'python.exe' : 'python');
}

export async function managedPrepare(opts: PrepareOptions): Promise<PrepareResult> {
  const layout = managedLayout(opts.storageRoot);
  const existing = currentManagedStatus(opts.storageRoot, opts.isWin);
  if (existing.state === 'ready') {
    return { ok: true, state: 'ready', message: '托管环境已就绪。' };
  }
  if (!opts.yes) {
    return { ok: false, state: existing.state, message: '需要一次同意：将下载工具链到扩展存储（可随时一键移除）。' };
  }
  try {
    writeMarker(layout, {
      version: 1,
      state: 'provisioning',
      provider: 'managed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      tools: {},
      note: '正在准备…',
    });
    progress(opts, '定位系统 Python/uv…');
    const py = await bootstrapPython(opts.isWin);
    if (!py) {
      writeMarker(layout, { version: 1, state: 'error', provider: 'managed', createdAt: Date.now(), updatedAt: Date.now(), tools: {}, note: '未找到 python/uv，无法自举。' });
      return { ok: false, state: 'error', message: '未找到系统 python/uv。请先安装 Python，或稍后重试。' };
    }
    progress(opts, `创建托管 venv（${venvBinDir(layout, opts.isWin)}）…`);
    const vpy = venvPython(layout, opts.isWin);
    if (!existsSync(vpy)) {
      const venv = await run(py, ['-m', 'venv', layout.pyVenv], { timeoutMs: 180000 });
      if (venv.code !== 0) {
        writeMarker(layout, { version: 1, state: 'error', provider: 'managed', createdAt: Date.now(), updatedAt: Date.now(), tools: {}, note: 'venv 创建失败' });
        return { ok: false, state: 'error', message: `venv 创建失败：${(venv.stderr || venv.stdout).slice(-300)}` };
      }
    }
    progress(opts, '安装 conan / cmake / ninja（首次较慢）…');
    // §3.5 / G2：首次装工具链是最容易“挂了不回来”的一步（曾经 timeoutMs: 0）→ 走 45min 有界阈值
    let install: ExecResult;
    try {
      install = await withDeadline(
        '安装 conan / cmake / ninja',
        'envPrepare',
        (timeoutMs) =>
          run(vpy, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', 'conan', 'cmake', 'ninja'], {
            timeoutMs,
            env: { ...process.env, ...envWithManaged(layout, opts.isWin, opts.basePath) },
          }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeMarker(layout, { version: 1, state: 'error', provider: 'managed', createdAt: Date.now(), updatedAt: Date.now(), tools: {}, note: message });
      return { ok: false, state: 'error', message: `工具安装未完成：${message}` };
    }
    if (install.code !== 0) {
      writeMarker(layout, { version: 1, state: 'error', provider: 'managed', createdAt: Date.now(), updatedAt: Date.now(), tools: {}, note: 'pip 安装失败（可能离线）' });
      return { ok: false, state: 'error', message: `工具安装失败：${(install.stderr || install.stdout).slice(-300)}` };
    }
    mkdirSync(layout.conanHome, { recursive: true });
    writeFileSync(join(layout.conanHome, '.conan_home_marker'), 'managed by het-devtools\n', 'utf8');
    mkdirSync(layout.profilesDir, { recursive: true });

    const tools: Record<string, string> = {};
    for (const name of ['conan', 'cmake', 'ninja']) {
      const exe = venvTool(layout, opts.isWin, name);
      try {
        const v = await run(exe, ['--version'], { timeoutMs: 15000, env: { ...process.env, ...envWithManaged(layout, opts.isWin, opts.basePath) } });
        tools[name] = (v.stdout || '').split('\n')[0].trim() || '?';
      } catch {
        tools[name] = '?';
      }
    }
    const marker: ManagedMarker = {
      version: 1,
      state: 'ready',
      provider: 'managed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      tools,
      note: 'conan/cmake/ninja 已托管（CONAN_HOME 指向扩展存储）',
    };
    writeMarker(layout, marker);
    progress(opts, '就绪。');
    return { ok: true, state: 'ready', message: '托管环境已就绪。' };
  } catch (err) {
    writeMarker(layout, { version: 1, state: 'error', provider: 'managed', createdAt: Date.now(), updatedAt: Date.now(), tools: {}, note: err instanceof Error ? err.message : String(err) });
    return { ok: false, state: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

export function managedRemove(storageRoot: string): { ok: boolean; message: string } {
  try {
    removeManagedEnv(managedLayout(storageRoot));
    return { ok: true, message: '托管环境已移除（globalStorage 内全部清理）。' };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** V4-8: run activation GC — remove pure leftovers, keep retryable trees. */
export function managedGc(storageRoot: string): ManagedStatus {
  const layout = managedLayout(storageRoot);
  const d = gcManagedEnv(layout);
  if (d.action === 'remove') {
    removeManagedEnv(layout);
  }
  return currentManagedStatus(storageRoot, process.platform === 'win32');
}
