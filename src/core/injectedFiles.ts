/**
 * 模板注入文件的**防呆清理**（实测反馈第 6 条附带项）。
 *
 * 背景（上游 `test_package/conanfile.py` 的行为）：
 *   · `generate()` 里 `_add_entries()` 会往 `test/unit/main.cpp`、`test/stress/main.cpp`
 *     写一个 GTest main；开了覆盖率时还会把每个测试拷成 `test/unit/ucov_<原名>.cpp`；
 *   · 只有在 `_run_ctest_suite()` 的 `finally` 里才 `_remove_entries()`。
 *
 * 于是**构建阶段就失败 / 被中断**的那次运行，会把注入文件留在工作区；下一次：
 *   · `_add_entries()` 看到 `main.cpp` 已存在就不再重写（内容可能是旧的）；
 *   · CMake 仍会把 `ucov_*.cpp` 当额外测试源编进去 → 重复定义，**从此每次必失败**。
 *
 * 我们这一侧的防呆：**每次跑构建/测试之前**，先把上一轮留下的注入文件清掉。只删
 * "一看就是系统生成"的文件（名字 + 内容双条件），用户自己写的 `main.cpp`/测试文件
 * 一律不碰。
 *
 * 纯逻辑 + 注入式 IO，便于 0 人工单测。
 */
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { baseName } from '../utils/paths';

/** 上游注入块的特征行（两个都要命中，避免误判用户文件）。 */
const MARK_MAIN = 'int main(int argc, char **argv) {';
const MARK_RUN = '::testing::InitGoogleTest(&argc, argv);';

export interface StaleFileIo {
  listDir: (dir: string) => string[];
  read: (file: string) => string;
  remove: (file: string) => void;
  isFile: (p: string) => boolean;
}

/** 默认 IO（真实文件系统）。 */
export const realStaleIo: StaleFileIo = {
  listDir: (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
  read: (file) => {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  },
  remove: (file) => {
    try {
      rmSync(file, { force: true });
    } catch {
      /* 删不掉就算了：不能因为清理失败就拦住构建 */
    }
  },
  isFile: (p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  },
};

/** 内容里是否带上游注入的 GTest main 块。 */
export function hasInjectedMain(text: string): boolean {
  return text.includes(MARK_MAIN) && text.includes(MARK_RUN);
}

/**
 * 纯注入的 `main.cpp`：有注入块，且**没有**任何 `TEST(` 用例（ucov_ 拷贝是"用例 + 注入块"，
 * 这里只认"光一个 main"的那种）。
 */
export function isInjectedMain(text: string): boolean {
  return hasInjectedMain(text) && !/\bTEST(_F)?\s*\(/u.test(text);
}

/** `ucov_*.cpp`：文件名前缀 + 内容带注入块（两个条件都要，别按名字乱删）。 */
export function isInjectedUcovFile(name: string, text: string): boolean {
  return name.startsWith('ucov_') && name.endsWith('.cpp') && hasInjectedMain(text);
}

/**
 * 找出"上一轮可能留下的注入文件"（不删，只列）。
 *
 * 只看模板规定的三处：`test/unit/main.cpp`、`test/stress/main.cpp`、`test/unit/ucov_*.cpp`。
 */
export function staleInjectionFiles(
  projectRoot: string,
  io: Pick<StaleFileIo, 'listDir' | 'read' | 'isFile'> = realStaleIo,
): string[] {
  const out: string[] = [];
  const unit = join(projectRoot, 'test', 'unit');
  const stress = join(projectRoot, 'test', 'stress');
  const mainUnit = join(unit, 'main.cpp');
  const mainStress = join(stress, 'main.cpp');
  if (io.isFile(mainUnit) && isInjectedMain(io.read(mainUnit))) {
    out.push(mainUnit);
  }
  if (io.isFile(mainStress) && isInjectedMain(io.read(mainStress))) {
    out.push(mainStress);
  }
  for (const name of io.listDir(unit)) {
    if (!name.startsWith('ucov_') || !name.endsWith('.cpp')) {
      continue;
    }
    const file = join(unit, name);
    if (io.isFile(file) && isInjectedUcovFile(name, io.read(file))) {
      out.push(file);
    }
  }
  return out;
}

export interface StaleCleanupResult {
  removed: string[];
  /** 被跳过的同名文件（用户自己写的）——列出来是为了"看见了但没动"。 */
  skipped: string[];
}

/**
 * 跑构建/测试之前调用：清掉上一轮残留的注入文件。
 *
 * 返回相对路径列表（日志友好）；`skipped` 是"名字像但内容是用户自己写的"，不删。
 */
export function cleanupStaleInjection(
  projectRoot: string,
  io: StaleFileIo = realStaleIo,
): StaleCleanupResult {
  const unit = join(projectRoot, 'test', 'unit');
  const candidates = [
    join(unit, 'main.cpp'),
    join(projectRoot, 'test', 'stress', 'main.cpp'),
    ...io
      .listDir(unit)
      .filter((n) => n.startsWith('ucov_') && n.endsWith('.cpp'))
      .map((n) => join(unit, n)),
  ];
  const removed: string[] = [];
  const skipped: string[] = [];
  for (const file of candidates) {
    if (!io.isFile(file)) {
      continue;
    }
    const text = io.read(file);
    const name = baseName(file);
    const injected = name.startsWith('ucov_')
      ? isInjectedUcovFile(name, text)
      : isInjectedMain(text);
    if (injected) {
      io.remove(file);
      removed.push(file);
    } else {
      skipped.push(file);
    }
  }
  return { removed, skipped };
}
