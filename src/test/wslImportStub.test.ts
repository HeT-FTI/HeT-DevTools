/**
 * T17b 执行层的**桩验证**：用 `HET_WSL_EXE` 指向一个假 wsl.exe，在非 Windows 上
 * 端到端跑"决定 → import → bootstrap → 双标记 → 回读"，并断言 0 侵入（I1/I2）。
 *
 * 为什么这条测试有价值（计划附录 G.6）：托管 Windows runner **无嵌套虚拟化**，
 * `wsl --import` 能建不能启动 —— 真机 DoD 只能在维护者的 Windows 上跑。因此 CI 能验的
 * 就是这里这些：决定链、argv、以及"绝不碰用户发行版"。
 *
 * 平台门槛：桩是 POSIX shell（用 `sha256sum`/`shasum`），Windows 上没有 shell 语义可依 ——
 * 在 Windows 上跳过（那边由 T17d 的 `windows-wsl-import` 场景用真 wsl.exe 验）。
 */

import * as assert from 'node:assert';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { laneOwnerMarkerPath } from '../core/wslDistro';
import { importLaneDistro, teardownLaneDistro } from '../features/env/wslImport';

const POSIX = process.platform !== 'win32';
const GZIP_STUB = Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08, 0x00]), Buffer.alloc(128, 3)]);
const STUB_SHA = createHash('sha256').update(GZIP_STUB).digest('hex');

interface Env {
  root: string;
  record: string;
  exe: string;
  localAppData: string;
  rootfs: string;
}

/** 造一个假 wsl.exe + 假 rootfs；每个场景一个独立沙箱。 */
function sandbox(opts: { importFail?: boolean; importFailUtf16?: boolean; bootFail?: boolean } = {}): Env {
  const root = mkdtempSync(join(tmpdir(), 'het-wslstub-'));
  const record = join(root, 'args.log');
  const exe = join(root, 'wsl-stub.sh');
  const localAppData = join(root, 'AppData');
  const rootfs = join(root, 'rootfs.tar.gz');
  writeFileSync(rootfs, GZIP_STUB);
  mkdirSync(join(root, 'distros'), { recursive: true });

  writeFileSync(
    exe,
    `#!/bin/sh
# 桩 wsl.exe：记录每次 argv，绝不碰真实发行版。
printf '%s\\n' "$*" >> "$STUB_RECORD"
case "$1" in
  --status) exit 0 ;;
  -l) printf '%s\\n' "$STUB_LIST"; exit 0 ;;
  --terminate|--unregister) exit 0 ;;
  --import)
    name="$2"; dir="$3"; tar="$4"
    mkdir -p "$dir"
    if [ "${opts.importFailUtf16 ? '1' : '0'}" = "1" ]; then
      # wsl.exe 自己的消息是 UTF-16LE：这里写真实的字节（NUL 夹在每个字符之间）
      printf 'T\0h\0e\0 \0i\0m\0p\0o\0r\0t\0e\0d\0 \0f\0i\0l\0e\0' >&2
      exit 1
    fi
    if [ "${opts.importFail ? '1' : '0'}" = "1" ]; then echo "The operation could not be started" >&2; exit 1; fi
    # 注意：coreutils 在“文件名含反斜杠/换行”时会给输出行加反斜杠前缀；
    # 本测试沙箱的缓存路径（Windows 分隔符）在 Linux 上就是这种文件名 → 从 stdin 读可避免。
    sha=$(sha256sum < "$tar" | cut -d' ' -f1)
    printf '{"lane":"wsl2-managed","name":"%s","rootfsSha256":"%s","extensionVersion":"0.4.0","createdAt":"2026-09-15T00:00:00Z"}\n' "$name" "$sha" > "$STUB_ROOT/$name.marker.json"
    exit 0 ;;
  -d)
    name="$2"; shift 2
    [ "$1" = "--" ] && shift
    cmd="$1"; arg="$2"
    if [ "$cmd" = "cat" ]; then
      if [ "$arg" = "/etc/het-lane.json" ]; then cat "$STUB_ROOT/$name.marker.json" 2>/dev/null || exit 1; exit 0; fi
      if [ "$arg" = "/etc/wsl.conf" ]; then cat "$STUB_ROOT/$name.wsl.conf" 2>/dev/null || exit 1; exit 0; fi
      exit 1
    fi
    if [ "$cmd" = "bash" ]; then
      cp "$arg" "$STUB_ROOT/$name.bootstrap.sh" 2>/dev/null || true
      if [ "${opts.bootFail ? '1' : '0'}" = "1" ]; then echo "bootstrap boom" >&2; exit 1; fi
      echo "lane_distro:$name"
      echo "lane_distro_owner:wsl2-managed"
      echo "lane_distro_venv:ok"
      exit 0
    fi
    exit 0 ;;
esac
exit 0
`,
  );
  chmodSync(exe, 0o755);
  // 造一份"用户自己的发行版"的 wsl.conf（模拟官方镜像自带 systemd=true）
  writeFileSync(join(root, 'Ubuntu-24.04.wsl.conf'), '[boot]\nsystemd=true\n');
  return { root, record, exe, localAppData, rootfs };
}

function withEnv<T>(env: Env, list: string, fn: () => Promise<T>): Promise<T> {
  const prev = { exe: process.env.HET_WSL_EXE, rec: process.env.STUB_RECORD, list: process.env.STUB_LIST, root: process.env.STUB_ROOT };
  process.env.HET_WSL_EXE = env.exe;
  process.env.STUB_RECORD = env.record;
  process.env.STUB_LIST = list;
  process.env.STUB_ROOT = env.root;
  return fn().finally(() => {
    process.env.HET_WSL_EXE = prev.exe;
    process.env.STUB_RECORD = prev.rec;
    process.env.STUB_LIST = prev.list;
    process.env.STUB_ROOT = prev.root;
  });
}

describe('T17b wslImport（桩 wsl.exe：决定链 + import + bootstrap + 0 侵入）', () => {
  (POSIX ? it : it.skip)('同名冲突：用户已有 het-lane-2404（无标记）→ 换名 -2 导入，且全程不碰用户的 Ubuntu-24.04', async () => {
    const env = sandbox();
    try {
      // 本机已有：用户的官方发行版 + 一个同名但无标记的 het-lane-2404
      const out = await withEnv(env, 'Ubuntu-24.04\nhet-lane-2404', () =>
        importLaneDistro({ localAppData: env.localAppData, extensionVersion: '0.4.0', rootfs: { url: env.rootfs, sha256: STUB_SHA } }),
      );
      assert.strictEqual(out.ok, true, out.reason);
      assert.strictEqual(out.distro, 'het-lane-2404-2', '同名但无标记 → 换名，绝不接管');
      assert.strictEqual(out.imported, true);
      assert.strictEqual(out.ownerVerified, true, '双标记回读必须通过');
      assert.ok(out.evidence?.includes('lane_distro:het-lane-2404-2'), '证据行来自发行版自身');

      const argv = readFileSync(env.record, 'utf8');
      assert.match(argv, /--import het-lane-2404-2 /u, 'import 用的是我们自己的名字');
      assert.doesNotMatch(argv, /set-default/u, 'I2：从不改默认发行版');
      assert.doesNotMatch(argv, /Ubuntu-24\.04/u, 'I2：绝不碰用户的发行版（连读都不读）');
      // Windows 侧标记已落盘（I1 的另一半）
      // 用生产代码自己的路径构造器断言（本测试在 Linux 上跑，而路径按 Windows 语义拼；
      // 真机是 Windows，两者等价 —— 关键是"写到了代码认定该写的位置"）
      assert.ok(existsSync(laneOwnerMarkerPath(env.localAppData, 'het-lane-2404-2')), 'Windows 侧 owner.json 已落盘');
      // bootstrap 脚本已送达发行版：内含合并后的 wsl.conf 与"补镜像缺的包"
      const boot = readFileSync(join(env.root, 'het-lane-2404-2.bootstrap.sh'), 'utf8');
      assert.match(boot, /appendWindowsPath = false/u);
      assert.match(boot, /python3-venv/u);
    } finally {
      rmSync(env.root, { recursive: true, force: true });
    }
  });

  (POSIX ? it : it.skip)('没有 wsl.exe：给 A/C 两条路的环境层结论（不崩、不静默转 MSVC）', async () => {
    const env = sandbox();
    try {
      const prev = process.env.HET_WSL_EXE;
      process.env.HET_WSL_EXE = join(env.root, 'does-not-exist');
      try {
        const out = await importLaneDistro({ localAppData: env.localAppData, extensionVersion: '0.4.0' });
        assert.strictEqual(out.ok, false);
        assert.strictEqual(out.plan.kind, 'win-wsl-required');
        assert.match(out.reason ?? '', /wsl --install -d Ubuntu-24\.04/u, '路线 A');
        assert.match(out.reason ?? '', /toolchain: system/u, '路线 C');
        assert.doesNotMatch(out.reason ?? '', /自动.*MSVC|静默/u);
      } finally {
        process.env.HET_WSL_EXE = prev;
      }
    } finally {
      rmSync(env.root, { recursive: true, force: true });
    }
  });

  (POSIX ? it : it.skip)('import 失败：保留现场（退出码+输出尾）并给出可执行出路', async () => {
    const env = sandbox({ importFail: true });
    try {
      const out = await withEnv(env, 'Ubuntu-24.04', () =>
        importLaneDistro({ localAppData: env.localAppData, extensionVersion: '0.4.0', rootfs: { url: env.rootfs, sha256: STUB_SHA } }),
      );
      assert.strictEqual(out.ok, false);
      assert.match(out.reason ?? '', /wsl --import 失败（exit=1）/u);
      assert.match(out.reason ?? '', /The operation could not be started/u, '保留现场：把真实输出带出来');
      assert.match(out.reason ?? '', /路线 A.*路线 C|常见原因/u);
    } finally {
      rmSync(env.root, { recursive: true, force: true });
    }
  });

  (POSIX ? it : it.skip)('wsl.exe 的消息是 UTF-16LE：给人看之前必须先解码（不能是 NUL 乱码）', async () => {
    const env = sandbox({ importFailUtf16: true });
    try {
      const out = await withEnv(env, 'Ubuntu-24.04', () =>
        importLaneDistro({ localAppData: env.localAppData, extensionVersion: '0.4.0', rootfs: { url: env.rootfs, sha256: STUB_SHA } }),
      );
      assert.strictEqual(out.ok, false);
      // 2026-09-15 windows-wsl-import 首跑实测：真实原因被 NUL 夹碎成
      // `T\u0000h\u0000e\u0000…`，用户看到的是乱码。
      assert.ok(!(out.reason ?? '').includes('\u0000'), '不得把 NUL 乱码交给用户');
      assert.match(out.reason ?? '', /The imported file/u, '必须能看到真实原因');
      assert.match(out.reason ?? '', /wsl --install -d Ubuntu-24\.04/u, '路线 A');
    } finally {
      rmSync(env.root, { recursive: true, force: true });
    }
  });

  (POSIX ? it : it.skip)('bootstrap 失败：同样保留现场（不吞掉）', async () => {
    const env = sandbox({ bootFail: true });
    try {
      const out = await withEnv(env, 'Ubuntu-24.04', () =>
        importLaneDistro({ localAppData: env.localAppData, extensionVersion: '0.4.0', rootfs: { url: env.rootfs, sha256: STUB_SHA } }),
      );
      assert.strictEqual(out.ok, false);
      assert.match(out.reason ?? '', /bootstrap 失败（exit=1）/u);
      assert.match(out.reason ?? '', /bootstrap boom/u);
      // 用户处境与 import 失败相同（车道用不了）→ 同样必须给 A/C，而不是只丢一段尾部输出。
      assert.match(out.reason ?? '', /wsl --install -d Ubuntu-24\.04/u, '路线 A');
      assert.match(out.reason ?? '', /toolchain: system/u, '路线 C');
    } finally {
      rmSync(env.root, { recursive: true, force: true });
    }
  });

  (POSIX ? it : it.skip)('撤销：只注销通过 I1 校验的发行版，并连目录/缓存一起清掉', async () => {
    const env = sandbox();
    try {
      // 先造一个"已存在且是我们的"发行版（双标记一致）
      const importRes = await withEnv(env, 'Ubuntu-24.04', () =>
        importLaneDistro({ localAppData: env.localAppData, extensionVersion: '0.4.0', rootfs: { url: env.rootfs, sha256: STUB_SHA } }),
      );
      assert.strictEqual(importRes.ok, true, importRes.reason);
      const name = importRes.distro!;

      const td = await withEnv(env, `Ubuntu-24.04\n${name}`, () => teardownLaneDistro({ localAppData: env.localAppData }));
      assert.strictEqual(td.ok, true, td.reason);
      assert.deepStrictEqual(td.removed, [name]);
      const argv = readFileSync(env.record, 'utf8');
      assert.match(argv, new RegExp(`--unregister ${name}`, 'u'));
      assert.doesNotMatch(argv, /--unregister Ubuntu-24\.04/u, 'I2：绝不注销用户的发行版');
      assert.ok(!existsSync(join(env.localAppData, 'het-fti', 'wsl', name)), '安装目录已删');
    } finally {
      rmSync(env.root, { recursive: true, force: true });
    }
  });

  (POSIX ? it : it.skip)('I1 拒绝：同名发行版存在但标记是别的 lane → 不认领，走换名/给两条路', async () => {
    const env = sandbox();
    try {
      // 同名 + 存在，但标记是"别人造的"
      mkdirSync(env.root, { recursive: true });
      writeFileSync(join(env.root, 'het-lane-2404.marker.json'), '{"lane":"other-lane","name":"het-lane-2404"}\n');
      const out = await withEnv(env, 'het-lane-2404', () =>
        importLaneDistro({ localAppData: env.localAppData, extensionVersion: '0.4.0', rootfs: { url: env.rootfs, sha256: STUB_SHA } }),
      );
      assert.strictEqual(out.ok, true, out.reason);
      assert.strictEqual(out.distro, 'het-lane-2404-2', '不是我们的 lane → 不认领（换名）');
    } finally {
      rmSync(env.root, { recursive: true, force: true });
    }
  });
});
