/**
 * apt 换源（计划 §10 / G22 的最后一块）—— **纯函数**，生成的是 shell 片段，所以可单测。
 *
 * 为什么只在这里做：apt 改的是 `/etc/apt/**`，**必须有 root**。我们唯一拥有 root 的地方就是
 * **自己自建的 WSL 发行版**（`het-lane-*`）—— 所以在它的 bootstrap 里一次做好，
 * 比"用户第一次安装失败后再想办法"确定得多。用户自己的发行版 / 本机 system 车道**一律不动**。
 *
 * 三条纪律：
 * 1. **先备份再改**（且只备份一次：重复 bootstrap 不能把已改过的文件当"原件"备份）；
 * 2. **失败不阻断**（换源是优化，不是前提：`sed` 挂了也要能继续装包）；
 * 3. **留证据 + 可撤销**（`lane_apt_mirror=` 证据行 + `lane_apt_mirror_restore=` 复原命令）。
 */
export interface AptMirrorRef {
  /** 镜像基址，例如 `https://mirror.nju.edu.cn/ubuntu`。 */
  url: string;
  /** 人话标签（NJU / TUNA / 阿里 / 自定义）。 */
  label: string;
}

/** 备份后缀（复原就是把 backup 盖回去）。 */
export const APT_MIRROR_BACKUP_SUFFIX = '.het-backup';

/** Ubuntu 24.04 (noble) 起用 deb822 格式；老格式仍要兼容。 */
export const APT_SOURCES_DEB822 = '/etc/apt/sources.list.d/ubuntu.sources';
export const APT_SOURCES_CLASSIC = '/etc/apt/sources.list';

/** 只接受"干净的 http(s) URL"（要拼进 sed 表达式，不能有引号/换行/空白）。 */
export function isValidMirrorUrl(url: string): boolean {
  const u = (url ?? '').trim();
  return /^https?:\/\/[A-Za-z0-9._:/-]+$/.test(u) && !u.endsWith('/');
}

/** 把 `-ports`（arm/其它架构）也映射到镜像上（镜像是同路径的，例如 NJU 也有 ubuntu-ports）。 */
export function portsMirrorUrl(mirror: string): string {
  return `${mirror.replace(/\/+$/, '')}-ports`;
}

/** 只改 Ubuntu 官方地址，别的一概不碰（第三方的 deb 源原样保留）。 */
export function isUbuntuArchiveUrl(url: string): boolean {
  return /^https?:\/\/(archive|security)\.ubuntu\.com\/ubuntu/u.test(url) || /^https?:\/\/ports\.ubuntu\.com\/ubuntu-ports/u.test(url);
}

/**
 * 生成 apt 换源片段。`m` 为空 → 返回空数组（调用方原样拼接，等于"什么都不做"）。
 */
export function aptMirrorLines(m?: AptMirrorRef): string[] {
  if (!m || !isValidMirrorUrl(m.url)) {
    return [];
  }
  const mirror = m.url.trim();
  const backup = (file: string): string => `${file}${APT_MIRROR_BACKUP_SUFFIX}`;
  const sedExpr = `s#https\\?://\\(archive\\|security\\)\\.ubuntu\\.com/ubuntu#${mirror}#g; s#https\\?://ports\\.ubuntu\\.com/ubuntu-ports#${portsMirrorUrl(mirror)}#g`;
  const rewrite = (file: string): string[] => [
    `if [ -f ${file} ]; then`,
    // 只备份一次：重复 bootstrap 时不许把"已经换过源的版本"当成原件存下来
    `  [ -f ${backup(file)} ] || cp -a ${file} ${backup(file)} 2>/dev/null || true`,
    `  sed -i -E '${sedExpr}' ${file} 2>/dev/null || true`,
    'fi',
  ];
  return [
    `# —— apt 换源（${m.label}）：只在我们自建的发行版里做，先备份后改，失败不阻断 ——`,
    ...rewrite(APT_SOURCES_DEB822),
    ...rewrite(APT_SOURCES_CLASSIC),
    `echo lane_apt_mirror:${m.label}`,
    `echo lane_apt_mirror_url:${mirror}`,
    `echo lane_apt_mirror_restore:cp -a ${backup(APT_SOURCES_DEB822)} ${APT_SOURCES_DEB822}`,
  ];
}
