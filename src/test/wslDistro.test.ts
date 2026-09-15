import * as assert from 'node:assert';
import {
  LANE_DISTRO_LANE_ID,
  LANE_ROOTFS,
  adoptionVerdict,
  isOurDistroName,
  laneBootstrapScript,
  laneDistroBaseName,
  laneRootfsSource,
  laneTeardownPlan,
  laneWslInstallDir,
  mergeWslConf,
  parseOwnerRecord,
  pickLaneDistroName,
  planWslDistro,
  wslImportArgs,
} from '../core/wslDistro';

const SHA = '8251e27ffff381a4af5f41dcb94d867de3e0d9774a9241908ab34555d99315ea';
const ownerJson = (name: string, sha = SHA): string =>
  JSON.stringify({ lane: LANE_DISTRO_LANE_ID, name, rootfsSha256: sha, extensionVersion: '0.4.0', createdAt: '' });

describe('T17a wslDistro (managed 自托管发行版：命名/0 侵入不变式/状态机)', () => {
  it('命名所有权：只有 het-lane-<4位年份>(-N) 形状才可能是我们的', () => {
    assert.strictEqual(laneDistroBaseName(), 'het-lane-2404');
    for (const ok of ['het-lane-2404', 'het-lane-2404-2', 'het-lane-2604']) {
      assert.ok(isOurDistroName(ok), `${ok} 应被认作我们的命名形状`);
    }
    // 用户自己的发行版名（Store 官方名、用户随手起的、以及"看起来像但多了后缀字符串"的）
    for (const bad of ['Ubuntu-24.04', 'ubuntu24.04', 'Ubuntu', 'Debian', 'het-lane', 'het-lane-2404-x', 'het-lanex-2404', '']) {
      assert.ok(!isOurDistroName(bad), `${bad} 不应被认作我们的`);
    }
  });

  it('同名冲突：基名被**外来**发行版占用 → 换名，绝不接管', () => {
    // 情况 1：本机干净
    assert.deepStrictEqual(pickLaneDistroName([], []).outcome, 'none');
    assert.strictEqual(pickLaneDistroName([], []).name, 'het-lane-2404');

    // 情况 2：用户有一个名字极像的发行版（这就是"为了避免重复"那个场景）
    const userHas = pickLaneDistroName(['Ubuntu-24.04', 'ubuntu24.04'], []);
    assert.strictEqual(userHas.name, 'het-lane-2404', '用户同名（但不是我们的形状）不影响我们的命名');

    // 情况 3：基名被**同名但无标记**的发行版占用 → 换 -2
    const clash = pickLaneDistroName(['het-lane-2404'], []);
    assert.strictEqual(clash.outcome, 'renamed');
    assert.strictEqual(clash.name, 'het-lane-2404-2');
    assert.strictEqual(clash.blockedBy, 'het-lane-2404');
    assert.match(clash.note, /不是我们的|绝不接管/u);

    // 情况 4：基名是我们的双标记发行版 → 复用（不重建）
    const reuse = pickLaneDistroName(['het-lane-2404'], ['het-lane-2404']);
    assert.strictEqual(reuse.outcome, 'reuse');
    assert.strictEqual(reuse.name, 'het-lane-2404');

    // 情况 5：基名 + -2/-3/-4 全被外来占用 → 放弃自建（给 A/C）
    const exhausted = pickLaneDistroName(['het-lane-2404', 'het-lane-2404-2', 'het-lane-2404-3', 'het-lane-2404-4'], []);
    assert.strictEqual(exhausted.outcome, 'exhausted');
    assert.strictEqual(exhausted.name, undefined);
  });

  it('接管判据 I1：必须名字形状 + 双标记 + 三者一致（缺一不可）', () => {
    const base = { name: 'het-lane-2404', ownerInDistro: ownerJson('het-lane-2404'), ownerOnWindows: ownerJson('het-lane-2404'), isListed: true };
    assert.strictEqual(adoptionVerdict(base).adopt, true);

    assert.strictEqual(adoptionVerdict({ ...base, name: 'Ubuntu-24.04' }).adopt, false, '形状不对 → 不接管');
    assert.strictEqual(adoptionVerdict({ ...base, isListed: false }).adopt, false, '不在 wsl -l -q → 不接管');
    assert.strictEqual(adoptionVerdict({ ...base, ownerInDistro: undefined }).adopt, false, '缺发行版内标记 → 不接管');
    assert.strictEqual(adoptionVerdict({ ...base, ownerOnWindows: undefined }).adopt, false, '缺 Windows 侧标记 → 不接管');
    assert.strictEqual(adoptionVerdict({ ...base, ownerOnWindows: ownerJson('het-lane-2404', 'a'.repeat(64)) }).adopt, false, '两侧 sha 不一致 → 不接管');
    assert.strictEqual(adoptionVerdict({ ...base, ownerInDistro: ownerJson('het-lane-2404-9') }).adopt, false, '标记里的名字不符 → 不接管');
    assert.strictEqual(adoptionVerdict({ ...base, ownerInDistro: '{"lane":"other","name":"het-lane-2404","rootfsSha256":"' + SHA + '"}' }).adopt, false, '别的 lane 造的 → 不认领');
  });

  it('owner 标记是不可信输入：坏 JSON/坏 lane/坏 sha 一律拒绝', () => {
    assert.strictEqual(parseOwnerRecord('not json').ok, false);
    assert.strictEqual(parseOwnerRecord('{}').ok, false);
    assert.strictEqual(parseOwnerRecord(JSON.stringify({ lane: LANE_DISTRO_LANE_ID, name: 'Ubuntu', rootfsSha256: SHA })).ok, false);
    assert.strictEqual(parseOwnerRecord(JSON.stringify({ lane: LANE_DISTRO_LANE_ID, name: 'het-lane-2404', rootfsSha256: 'short' })).ok, false);
    const good = parseOwnerRecord(ownerJson('het-lane-2404'));
    assert.strictEqual(good.ok, true);
    assert.strictEqual(good.record?.rootfsSha256, SHA);
  });

  it('权威源：默认 = Canonical 的 wsl 变体 + 钉死 sha256；覆盖必须显式给 sha', () => {
    const def = laneRootfsSource();
    assert.strictEqual(def.url, LANE_ROOTFS.url);
    assert.strictEqual(def.sha256, LANE_ROOTFS.sha256);
    assert.match(def.url!, /^https:\/\/cloud-images\.ubuntu\.com\/wsl\/releases\/24\.04\/current\//u);
    assert.strictEqual(def.bytes, LANE_ROOTFS.bytes);

    // 内网覆盖：给了 URL 但没给 sha → 拒绝（没有"跳过校验"的开关）
    const noSha = laneRootfsSource({ url: 'https://mirror.internal/ubuntu-noble-wsl-amd64-wsl.rootfs.tar.gz' });
    assert.strictEqual(noSha.ok, false);
    assert.match(noSha.reason!, /同时给出 het\.env\.wslRootfsSha256/u);

    // 形状不对的 URL 也拒绝
    assert.strictEqual(laneRootfsSource({ url: 'not-a-url', sha256: SHA }).ok, false);
    // 但本地路径/UNC 必须放行（口径要与 core/wslRootfs.localSourcePath 一致；
    // T17b 桩测试抓到过：POSIX 绝对路径曾被误拒 → 内网离线场景直接不可用）
    for (const local of ['/tmp/a.tar.gz', 'C:\\repo\\a.tar.gz', '\\\\fileserver\\share\\a.tar.gz', 'file:///tmp/a.tar.gz']) {
      assert.strictEqual(laneRootfsSource({ url: local, sha256: SHA }).ok, true, `${local} 应被接受`);
    }
    assert.strictEqual(laneRootfsSource({ url: 'https://mirror.internal/x.tar.gz', sha256: 'zzz' }).ok, false);
    // 合法覆盖
    const okOverride = laneRootfsSource({ url: 'https://mirror.internal/x.tar.gz', sha256: SHA });
    assert.strictEqual(okOverride.ok, true);
    assert.strictEqual(okOverride.sha256, SHA);
  });

  it('状态机：无 wsl / 无虚拟化 / 内核过旧 / 可自建 / 复用，且失败一律给 A+C 两条路', () => {
    const noWsl = planWslDistro({ wslExe: false });
    assert.strictEqual(noWsl.kind, 'win-wsl-required');
    assert.strictEqual(noWsl.routes.length, 2);

    assert.strictEqual(planWslDistro({ wslExe: true, virtualization: false }).kind, 'win-wsl-no-virtualization');
    assert.strictEqual(planWslDistro({ wslExe: true, kernelOk: false }).kind, 'win-wsl-kernel-outdated');
    assert.match(planWslDistro({ wslExe: true, kernelOk: false }).message, /wsl --update/u);

    const imp = planWslDistro({ wslExe: true, distros: ['Ubuntu-24.04'] });
    assert.strictEqual(imp.kind, 'win-wsl-import');
    assert.strictEqual((imp as { distroName: string }).distroName, 'het-lane-2404');
    // 代价文案必须说清规模，且明确"不动你已有的发行版"
    assert.match(imp.message, /约 340MB|约 340 MB/u);
    assert.match(imp.message, /不会改动你已有的任何发行版/u);

    const reuse = planWslDistro({ wslExe: true, distros: ['het-lane-2404'], ourDistros: ['het-lane-2404'] });
    assert.strictEqual(reuse.kind, 'win-wsl2-ready');
    assert.strictEqual((reuse as { reuse: boolean }).reuse, true);

    // 换名场景：外来同名 → 仍然去 import，但名字是 -2
    const renamed = planWslDistro({ wslExe: true, distros: ['het-lane-2404'] });
    assert.strictEqual((renamed as { distroName: string }).distroName, 'het-lane-2404-2');

    // 换名用尽 / rootfs 覆盖不合法 → 都退回"给两条路"，绝不硬来
    const used = planWslDistro({ wslExe: true, distros: ['het-lane-2404', 'het-lane-2404-2', 'het-lane-2404-3', 'het-lane-2404-4'] });
    assert.strictEqual(used.kind, 'win-wsl-required');
    const badSrc = planWslDistro({ wslExe: true, rootfs: { url: 'https://mirror/x.tar.gz' } });
    assert.strictEqual(badSrc.kind, 'win-wsl-required');
  });

  it('I2/I3：import/撤销只碰我们自己的名字，且都落在 LOCALAPPDATA 下', () => {
    assert.deepStrictEqual(wslImportArgs('het-lane-2404', 'C:\\Users\\u\\AppData\\Local\\het-fti\\wsl\\het-lane-2404', 'C:\\cache\\x.tar.gz'), [
      '--import',
      'het-lane-2404',
      'C:\\Users\\u\\AppData\\Local\\het-fti\\wsl\\het-lane-2404',
      'C:\\cache\\x.tar.gz',
      '--version',
      '2',
    ]);
    const dir = laneWslInstallDir('C:\\Users\\u\\AppData\\Local', 'het-lane-2404');
    assert.match(dir, /het-fti\\wsl\\het-lane-2404$/u);

    const plan = laneTeardownPlan('het-lane-2404', 'C:\\Users\\u\\AppData\\Local', false).join('\n');
    assert.match(plan, /wsl --terminate het-lane-2404/u);
    assert.match(plan, /wsl --unregister het-lane-2404/u);
    assert.match(plan, /cache/u);

    // 传入非我们的名字 → 抛错（防调用方误伤用户发行版）
    assert.throws(() => laneTeardownPlan('Ubuntu-24.04', 'C:\\X', false), /not ours/u);
    assert.throws(() => laneBootstrapScript({ name: 'Ubuntu-24.04', sha256: SHA, extensionVersion: '0.4.0' }), /not ours/u);
  });

  it('bootstrap：合并 wsl.conf（保留厂商设置）+ 装镜像缺的包 + owner 标记 + 证据行', () => {
    // 官方 wsl 镜像自带的 wsl.conf（实测原文）
    const vendor = '[boot]\nsystemd=true\n';
    const merged = mergeWslConf(vendor);
    const script = laneBootstrapScript({ name: 'het-lane-2404', sha256: SHA, extensionVersion: '0.4.0', wslConf: merged });
    assert.match(script, /appendWindowsPath = false/u, 'Windows PATH 混入会让探针看到"存在但跑不了"的 exe');
    assert.match(script, /options = "metadata"/u);
    assert.match(script, /\[boot\]/u);
    assert.match(script, /systemd=true/u, '厂商的 [boot] systemd=true 必须原样保留');
    assert.match(script, /apt-get install -y -qq --no-install-recommends python3-venv/u, '镜像缺 ensurepip → 我们自己的发行版直接装好');
    assert.match(script, /locale-gen/u);
    assert.match(script, /LANG=C\.UTF-8/u);
    assert.match(script, /\/etc\/het-lane\.json/u);
    assert.match(script, /lane_distro:het-lane-2404/u);
    assert.match(script, /lane_distro_owner:wsl2-managed/u);
    assert.match(script, /lane_distro_venv:/u, '把"venv 可用吗"写进证据');
    // 绝不出现"改默认发行版"这种事
    assert.doesNotMatch(script, /--set-default/u);
  });

  it('mergeWslConf：保留厂商设置与注释、只动我们的键、且幂等', () => {
    const vendor = '# 厂商注释\n[boot]\nsystemd=true\n\n[interop]\nenabled = true\n';
    const once = mergeWslConf(vendor);
    assert.match(once, /# 厂商注释/u, '注释保留');
    assert.match(once, /\[boot\]\nsystemd=true/u, '[boot] 原样');
    assert.match(once, /\[interop\]\nenabled = true\nappendWindowsPath = false/u, '已有的 interop 只补键');
    assert.match(once, /\[automount\]/u, '缺的 section 追加');
    assert.strictEqual(mergeWslConf(once), once, '合并两次结果必须一致（幂等）');
    assert.strictEqual(mergeWslConf(''), mergeWslConf(mergeWslConf('')));

    // 已知键值被手改 → 改回我们要求的值（appendWindowsPath 是硬要求）
    const tampered = '[interop]\nappendWindowsPath = true\n';
    assert.match(mergeWslConf(tampered), /appendWindowsPath = false/u);
    // 大小写/空格宽松匹配
    assert.match(mergeWslConf('[Interop]\nAPPENDWINDOWSPATH=true\n'), /appendWindowsPath = false/u);
  });
});
