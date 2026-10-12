/**
 * 工程快照采集（V3 · L5 / G4）—— **只读、纯 node**（不 import vscode，可直接单测/预览）。
 *
 * 为什么单独一层：判据（`core/newLibAudit.ts`）与"读工程"（这里）分开以后，
 * 预览生成器、单测、扩展三处都能用**同一份**读取逻辑 —— 否则就会出现
 * "单测里的快照形状"与"真跑时的快照形状"不一致，门禁在假对象上绿。
 *
 * 两条硬规矩：
 * 1. **读不到的东西不放**（判定侧看到 `undefined` 会如实说"读不到"，而不是当成失败）；
 * 2. 只读判定要用的文件（按扩展名白名单），不把整个工程塞进内存。
 */
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { readText } from '../utils/fs';
import { normalizeSlashes } from '../utils/paths';
import { ciInstalledPackages, type LibSnapshot } from './newLibAudit';
import { bindingsSourceFrom, CONVENTION_BINDINGS } from './pythonBindings';

/** 合同文件在**用户工程里**的相对路径（模板会带过去）。 */
export const CONTRACT_REL = '.github/misc/Codegen-Starter.txt';

export interface SnapshotDeps {
  metadata?: LibSnapshot['metadata'];
  templateLicense?: string;
  templateNotice?: string;
  templateName?: string;
  buildOk?: boolean;
}

/** 读一遍工程 → 判定用的快照。 */
export async function collectLibSnapshot(root: string, deps: SnapshotDeps): Promise<LibSnapshot> {
  const paths: string[] = [];
  const wanted: string[] = [];

  /** 走一遍工程（跳过重目录，目录以 `/` 结尾 —— 判定侧按前缀找东西）。 */
  const walk = async (dir: string, depth = 0): Promise<void> => {
    if (depth > 5) {
      return;
    }
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      // `.github` 例外：合同与 workflow 都在里面；其余点目录（.git/.vscode…）跳过
      if (e.name.startsWith('.') && e.name !== '.github') {
        continue;
      }
      if (e.name === 'build' || e.name === 'node_modules' || e.name === 'out') {
        continue;
      }
      const abs = join(dir, e.name);
      const rel = normalizeSlashes(relative(root, abs));
      if (e.isDirectory()) {
        paths.push(`${rel}/`);
        await walk(abs, depth + 1);
        continue;
      }
      paths.push(rel);
      // 判定要用到内容的文件才读进内存（保持"读得少、判得准"）。
      // **无扩展名的文本文件也要读**：LICENSE / NOTICE 就是这类（合同第 19 条要逐字比对）。
      if (/\.(h|hpp|hh|hxx|c|cc|cpp|cxx|dox|rst|po|md|json|txt|yml|yaml|py)$/u.test(rel) || !e.name.includes('.')) {
        wanted.push(rel);
      }
    }
  };
  await walk(root);

  const files: Record<string, string> = {};
  await Promise.all(
    wanted.map(async (rel) => {
      try {
        files[rel] = await readText(join(root, rel));
      } catch {
        /* 二进制/读不动 → 不放 */
      }
    }),
  );

  // conandata.yml 的 requirements（只认最朴素的 `- "pkg/version"` 形态）
  let conandata: string[] | undefined;
  const cd = files['conandata.yml'];
  if (cd !== undefined) {
    const reqs = /requirements:\s*\n((?:\s*[-#].*\n?)*)/u.exec(cd);
    if (reqs) {
      conandata = [...reqs[1].matchAll(/^\s*-\s*"([^"]+)"/gmu)].map((m) => m[1]);
    }
  }

  // CI 里装过系统头的包（G6 与这里共用同一份解析）
  const wfPaths = paths.filter((p) => p.startsWith('.github/workflows/') && /\.ya?ml$/u.test(p));
  const ciInstalled = wfPaths.flatMap((p) => ciInstalledPackages(files[p] ?? ''));

  return {
    files,
    paths,
    ...(deps.metadata ? { metadata: deps.metadata } : {}),
    ...(conandata ? { conandata } : {}),
    ...(ciInstalled.length > 0 ? { ciInstalled: [...new Set(ciInstalled)].sort() } : {}),
    ...(deps.templateLicense !== undefined ? { templateLicense: deps.templateLicense } : {}),
    ...(deps.templateNotice !== undefined ? { templateNotice: deps.templateNotice } : {}),
    ...(deps.templateName !== undefined ? { templateName: deps.templateName } : {}),
    ...(deps.buildOk !== undefined ? { buildOk: deps.buildOk } : {}),
  };
}

/**
 * Python 绑定对账要读的文件（V3 · L6c / G9）：**只读用得上的那三样**
 * （根 `CMakeLists.txt`、`include/` 下的头、CMake 指明的绑定源）——
 * 不整工程 walk，界面上每次刷新都跑得起。
 *
 * 与 `collectLibSnapshot` 同样"读不到就不放"：判定侧看到缺项会说"读不到"，
 * 而不是当成"没有"。
 */
export async function collectPyBindFiles(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const read = async (rel: string): Promise<void> => {
    try {
      out[rel] = await readText(join(root, rel));
    } catch {
      /* 读不到 → 不放 */
    }
  };
  await read('CMakeLists.txt');
  await read(bindingsSourceFrom(out['CMakeLists.txt']) ?? CONVENTION_BINDINGS);
  try {
    for (const e of await readdir(join(root, 'include'), { withFileTypes: true })) {
      if (e.isFile() && /\.(h|hpp|hh|hxx)$/u.test(e.name)) {
        await read(`include/${e.name}`);
      }
    }
  } catch {
    /* 没有 include/ 目录 */
  }
  return out;
}
