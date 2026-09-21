/**
 * 车道为**系统包**留下的台账（ADR-8，2026-09-16）。
 *
 * Linux 车道的本体（私有 venv + 私有 CONAN_HOME + 生成的 profile）是**用户级**的；只有
 * "缺编译器 / lcov / make / 文档工具"这类**系统包**才需要 root apt。用户拍板的行为是：
 *
 * · 建车道时照建（不因无 root 而放弃）；
 * · 装过什么**如实记账**；
 * · 「移除托管环境」时**列出清单 + 给卸载命令，绝不自动卸载**（apt 包可能被别的软件依赖）。
 *
 * 台账落在车道 home 内（`~/.het-fti/managed-env/.apt-installed.json`），随车道一起删除，
 * 不污染用户其它目录。只记我们自己发起的 `apt-get install`，不做任何反查。
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const APT_LOG_FILE = '.apt-installed.json';

interface AptLog {
  version: 1;
  /** 包名（去重、排序），以及首次记录时间（epoch ms）。 */
  packages: Record<string, number>;
}

function logPath(laneHome: string): string {
  return join(laneHome, APT_LOG_FILE);
}

/** 读台账；文件缺失/损坏都当"没有记录"（绝不因此让移除流程失败）。 */
export function readAptLog(laneHome: string): string[] {
  try {
    const file = logPath(laneHome);
    if (!existsSync(file)) {
      return [];
    }
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<AptLog>;
    return Object.keys(parsed?.packages ?? {}).sort();
  } catch {
    return [];
  }
}

/**
 * 记账（幂等）。返回**新增**的包名（调用方据此只提"这次装了什么"）。
 * 写失败**不抛** —— 记账不能反过来打断环境准备。
 */
export function recordAptInstall(laneHome: string, pkgs: readonly string[], now = Date.now()): string[] {
  const wanted = [...new Set(pkgs.map((p) => p.trim()).filter(Boolean))];
  if (wanted.length === 0) {
    return [];
  }
  try {
    const file = logPath(laneHome);
    let existing: AptLog = { version: 1, packages: {} };
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<AptLog>;
        existing = { version: 1, packages: { ...(parsed?.packages ?? {}) } };
      } catch {
        existing = { version: 1, packages: {} };
      }
    }
    const added = wanted.filter((p) => !(p in existing.packages));
    if (added.length === 0) {
      return [];
    }
    for (const p of added) {
      existing.packages[p] = now;
    }
    mkdirSync(laneHome, { recursive: true });
    writeFileSync(file, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
    return added;
  } catch {
    return [];
  }
}

/** 给用户的可选卸载命令（**不自动执行**）。空清单 → 空串。 */
export function aptUninstallHint(pkgs: readonly string[]): string {
  if (pkgs.length === 0) {
    return '';
  }
  return (
    '\n本次为车道 apt 安装过的系统包（**不会**自动卸载，如确需还原可自行执行）：\n' +
    `  sudo apt-get remove --auto-remove ${pkgs.join(' ')}`
  );
}
