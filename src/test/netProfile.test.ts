import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CANONICAL_ROOTFS_PREFIX,
  CN_APT_MIRRORS,
  CN_PIP_INDEXES,
  GH_ACCEL_PREFIXES,
  NET_PROFILES,
  NJU_ROOTFS_PREFIX,
  effectiveProfile,
  inCnTimezone,
  netDecisionLine,
  netPlanFor,
  netSourceHelp,
  netSummaryLine,
  njuRootfsUrl,
  rootfsCandidatesFor,
  rootfsFallbackOrder,
  type SourceKind,
} from '../core/netProfile';
import { LANE_ROOTFS } from '../core/wslDistro';

/**
 * G16/G22：网络与源策略的门禁。
 *
 * 两条最容易走偏的地方各有一组断言：
 * 1. **不弹窗**（第二输第 3 条）：决策只能进输出面板 → 模块纯函数的返回里有一行决策文本；
 * 2. **不静默降级**：换了源/兜底到第二候选必须写得出来（逐类明细 + 卡片摘要）。
 */
describe('网络与源策略（G16/G22）', () => {
  it('§F.43 auto 的第二判据：英文系统 + 国内时区也要走 CN 源（实测根因）', () => {
    // 反例（改回去就红）：只看 locale → 英文 Windows 在国内被判成 global
    assert.strictEqual(effectiveProfile('auto', 'en-US', 'Asia/Shanghai'), 'cn');
    assert.strictEqual(effectiveProfile('auto', 'en-US', 'Asia/Chongqing'), 'cn');
    assert.strictEqual(effectiveProfile('auto', 'zh-cn', undefined), 'cn', 'locale 仍是第一判据');
    assert.strictEqual(effectiveProfile('auto', 'en-US', 'Europe/Berlin'), 'global');
    assert.strictEqual(effectiveProfile('auto', undefined, undefined), 'global');
    // 手动档不被覆盖
    assert.strictEqual(effectiveProfile('global', 'zh-cn', 'Asia/Shanghai'), 'global');
    assert.strictEqual(effectiveProfile('cn', 'en-US', 'Europe/Berlin'), 'cn');
    assert.ok(inCnTimezone('asia/shanghai'));
    assert.ok(!inCnTimezone('UTC'));
  });

  it('§F.43 判定依据要写进决策行（可诊断，不用猜"为什么走官方源"）', () => {
    const cn = netPlanFor({ profile: 'auto', locale: 'en-US', timeZone: 'Asia/Shanghai' });
    assert.strictEqual(cn.chains.rootfs[0], njuRootfsUrl(LANE_ROOTFS.url), 'rootfs 主源是 NJU');
    const line = netDecisionLine(cn);
    assert.ok(line.includes('tz=Asia/Shanghai'), `决策行要带时区，实际：${line}`);
    assert.ok(line.includes('locale=en-US'));
    assert.ok(line.includes('启用 CN 源'), '要明说启用了 CN 源');
  });

  it('auto 跟界面语言走：zh* → CN 源；其余 → 官方源', () => {
    assert.strictEqual(effectiveProfile('auto', 'zh-cn'), 'cn');
    assert.strictEqual(effectiveProfile('auto', 'zh-tw'), 'cn');
    assert.strictEqual(effectiveProfile('auto', 'en-us'), 'global');
    assert.strictEqual(effectiveProfile('auto', undefined), 'global', '认不出来就给官方源（= 现状）');
    assert.strictEqual(effectiveProfile('cn', 'en-us'), 'cn', '手动档不受语言影响');
    assert.strictEqual(effectiveProfile('global', 'zh-cn'), 'global');
    assert.deepStrictEqual([...NET_PROFILES], ['auto', 'cn', 'global', 'custom']);
    // 非法值退回默认档（不是抛异常，也不能变成 custom）
    assert.strictEqual(netPlanFor({ profile: 'yes' }).profile, 'auto');
  });

  it('CN 链的顺序就是实测结论：pip/apt/rootfs 都是 NJU 主源，gh-accel 三个备用', () => {
    const plan = netPlanFor({ profile: 'cn' });
    assert.strictEqual(plan.chains.pip[0], 'https://mirror.nju.edu.cn/pypi/web/simple');
    assert.ok(plan.chains.pip[0].endsWith('/pypi/web/simple'), '路径必须是实测 200 的那个（/pypi/simple 是 404）');
    assert.strictEqual(plan.chains.apt[0], 'https://mirror.nju.edu.cn/ubuntu');
    assert.ok(plan.chains.rootfs[0].startsWith(NJU_ROOTFS_PREFIX), 'rootfs 主源 = NJU');
    assert.deepStrictEqual(plan.chains.ghAccel, [...GH_ACCEL_PREFIXES]);
    assert.ok(plan.chains.pip.length >= 2, 'pip 要有兜底');
    assert.ok(plan.chains.apt.length >= 2, 'apt 要有兜底');
    assert.strictEqual(plan.template.builtinSnapshot, true, '模板先看内置快照（离线可用）');
    assert.strictEqual(plan.template.codeload, true);
    assert.deepStrictEqual(plan.template.accel, [...GH_ACCEL_PREFIXES]);
    assert.strictEqual(plan.template.gitClone, true, '最后才 git clone');
  });

  it('官方档 = 现状：不注入任何 pip/apt/gh 镜像，只保留 Canonical rootfs', () => {
    const plan = netPlanFor({ profile: 'global' });
    assert.deepStrictEqual(plan.chains.pip, [], '不改 pip = 用 PyPI 默认');
    assert.deepStrictEqual(plan.chains.apt, [], '不动发行版 sources.list');
    assert.deepStrictEqual(plan.chains.ghAccel, []);
    assert.deepStrictEqual(plan.chains.rootfs, [LANE_ROOTFS.url]);
    assert.deepStrictEqual(plan.template.accel, []);
    assert.ok(plan.decision.includes('使用官方源'));
  });

  it('rootfs：NJU 与 Canonical **同路径**（只有前缀不同），且兜底顺序不退到"跳过校验"', () => {
    const nju = njuRootfsUrl(LANE_ROOTFS.url);
    assert.ok(nju.startsWith(NJU_ROOTFS_PREFIX));
    const tail = LANE_ROOTFS.url.slice(CANONICAL_ROOTFS_PREFIX.length);
    assert.strictEqual(nju.slice(NJU_ROOTFS_PREFIX.length), tail, '只换前缀，路径原样保留');
    assert.ok(LANE_ROOTFS.sha256.length === 64, 'sha256 始终是我们 pin 的那个');

    const cn = netPlanFor({ profile: 'cn' });
    assert.deepStrictEqual(rootfsFallbackOrder(cn), [nju, LANE_ROOTFS.url], 'CN：NJU 失败退到 Canonical');
    const global = netPlanFor({ profile: 'global' });
    assert.deepStrictEqual(rootfsFallbackOrder(global), [LANE_ROOTFS.url], '官方档只有一条');
    const override = netPlanFor({ profile: 'cn', wslRootfsUrl: 'https://mirror.corp/rootfs.tar.gz' });
    assert.deepStrictEqual(
      rootfsFallbackOrder(override),
      ['https://mirror.corp/rootfs.tar.gz'],
      '用户显式给了就用它，不掺链（我们不知道它的 sha，由既有校验把关）',
    );
  });

  it('显式覆盖优先于链，而且必须在决策行里点名（可追溯）', () => {
    const plan = netPlanFor({
      profile: 'cn',
      pipIndexUrl: 'https://mirror.corp/simple',
      wslRootfsUrl: 'https://mirror.corp/rootfs.tar.gz',
    });
    assert.deepStrictEqual(plan.chains.pip, [], '覆盖了就不再往车道里塞我们的候选');
    assert.strictEqual(plan.overrides.pip, 'https://mirror.corp/simple');
    assert.strictEqual(plan.overrides.rootfs, 'https://mirror.corp/rootfs.tar.gz');
    assert.ok(plan.decision.includes('pip=自定义'), `决策行要点名覆盖，实际：${plan.decision}`);
    assert.ok(plan.decision.includes('rootfs=自定义'));
    assert.ok(plan.summary.includes('含自定义覆盖'), `摘要也要看得出来，实际：${plan.summary}`);
  });

  it('决策行：一行、[net] 开头、逐类明细齐全；摘要给卡片用', () => {
    const cn = netPlanFor({ profile: 'auto', locale: 'zh-cn' });
    const line = netDecisionLine(cn);
    // §F.43：决策行带上两个判据（locale + tz），出问题时能直接看出为什么选了这个源。
    assert.ok(line.startsWith('[net] profile=auto（locale=zh-cn · tz=未知）'), `实际：${line}`);
    assert.ok(!line.includes('\n'), '决策记录必须是一行（输出面板一眼能看）');
    for (const frag of ['启用 CN 源', 'pip=NJU', 'apt=NJU', 'rootfs=NJU', 'gh-accel=3 个备用', 'docker=关闭']) {
      assert.ok(line.includes(frag), `决策行缺「${frag}」：${line}`);
    }
    assert.strictEqual(netSummaryLine(cn), '当前生效：国内源 · 自动');
    const global = netPlanFor({ profile: 'global' });
    assert.strictEqual(netSummaryLine(global), '当前生效：官方源');
    assert.ok(global.decision.includes('pip=PyPI 默认'), global.decision);
    assert.ok(global.decision.includes('apt=发行版自带'), '不说清就等于静默');
  });

  it('Docker 镜像默认关闭（CN 公网镜像实测已死），只有企业自填才开', () => {
    assert.strictEqual(netPlanFor({ profile: 'cn' }).dockerMirror, '');
    const on = netPlanFor({ profile: 'cn', dockerMirror: 'https://registry.corp' });
    assert.strictEqual(on.dockerMirror, 'https://registry.corp');
    assert.ok(on.decision.includes('docker=自定义镜像'));
    assert.ok(on.summary.includes('Docker 镜像已启用'));
  });

  it('custom 档：het.net.mirrors 按类别生效，没给的类别仍走 CN 兜底', () => {
    const plan = netPlanFor({
      profile: 'custom',
      custom: { pip: ['https://mirror.corp/pypi'], apt: 'https://mirror.corp/ubuntu', ghAccel: [] },
    });
    assert.deepStrictEqual(plan.chains.pip, ['https://mirror.corp/pypi'], '自定义顺序要原样保留');
    assert.deepStrictEqual(plan.chains.apt, ['https://mirror.corp/ubuntu'], '字符串也算合法形状');
    assert.deepStrictEqual(plan.chains.ghAccel, [], '显式给空数组 = 不要加速前缀');
    assert.ok(plan.chains.rootfs[0].startsWith(NJU_ROOTFS_PREFIX), '没给的类别仍走 CN 兜底（不是空手）');
    assert.ok(plan.decision.includes('pip=自定义'));
    const garbage = netPlanFor({ profile: 'custom', custom: 42 });
    assert.ok(garbage.chains.pip.length > 0, 'custom 值不可解析时不许变成"什么都不配"');
  });

  it('每类源的失败都给"下一步"（含可复制的设置名）', () => {
    for (const kind of ['pip', 'apt', 'rootfs', 'ghAccel', 'docker'] as SourceKind[]) {
      const help = netSourceHelp(kind);
      assert.ok(help.length > 10, `${kind} 的下一步太短`);
      assert.ok(/`het\.|设置/.test(help), `${kind} 的下一步要说清改哪个设置：${help}`);
    }
  });

  it('不弹窗：策略模块是纯函数，且决策只在输出面板里出现', () => {
    const mod = readFileSync(join('src', 'core', 'netProfile.ts'), 'utf8');
    assert.ok(!/from 'vscode'|require\('vscode'\)/.test(mod), 'netProfile 必须是纯模块（否则无法单测）');
    for (const forbidden of ['showInformationMessage', 'showWarningMessage', 'showQuickPick', 'showErrorMessage']) {
      assert.ok(!mod.includes(forbidden), `不弹窗（§10）：不许出现 ${forbidden}`);
    }
    const ext = readFileSync(join('src', 'extension.ts'), 'utf8');
    const start = ext.indexOf('function currentNetPlan');
    // 只扫"源策略"这一段（到下一个函数为止）：模板获取那段允许用通知（它要报进度/结果）
    const body = ext.slice(start, ext.indexOf('async function fetchTemplateReference', start));
    assert.ok(body.includes('function logNetDecision'), '要有决策记录入口');
    for (const forbidden of ['showInformationMessage', 'showWarningMessage', 'showQuickPick']) {
      assert.ok(!body.includes(forbidden), `源策略不许弹窗：${forbidden}`);
    }
    assert.ok(ext.includes('logNetDecision();'), '激活时要真的写一行');
    assert.ok(ext.includes('onDidChangeConfiguration'), '改设置要即时重新记录');
  });

  it('真的用上了：没填 pipIndexUrl 时车道镜像取链的第一个候选', () => {
    const ext = readFileSync(join('src', 'extension.ts'), 'utf8');
    assert.ok(
      ext.includes("pipIndexUrl: cfg.get<string>('pipIndexUrl', '') || plan.chains.pip[0] || ''"),
      'CN 档必须真的进 PIP_INDEX_URL（否则"国内源"只是说法）',
    );
  });

  it('rootfs 候选给导入层用：CN 档 NJU 主源 + Canonical 兑底；显式覆盖不掺链', () => {
    const cn = netPlanFor({ profile: 'cn' });
    const c = rootfsCandidatesFor(cn);
    assert.ok(c.primary?.url.startsWith(NJU_ROOTFS_PREFIX), 'CN 档主源 = NJU');
    assert.strictEqual(c.primary?.sha256, LANE_ROOTFS.sha256, '主源与兑底用同一个 pin');
    assert.deepStrictEqual(c.fallback.map((f) => f.url), [LANE_ROOTFS.url], '官方源做兑底');
    assert.strictEqual(c.fallback[0].sha256, LANE_ROOTFS.sha256);

    const global = rootfsCandidatesFor(netPlanFor({ profile: 'global' }));
    assert.strictEqual(global.primary?.url, LANE_ROOTFS.url);
    assert.deepStrictEqual(global.fallback, [], '官方档无需兑底');

    const explicit = rootfsCandidatesFor(
      netPlanFor({ profile: 'cn', wslRootfsUrl: 'https://mirror.corp/rootfs.tar.gz' }),
    );
    assert.strictEqual(explicit.primary, undefined, '显式覆盖时不由我们决定主源（sha 也在设置里）');
    assert.deepStrictEqual(explicit.fallback, [], '也不掺兑底');
  });

  it('接线：导入层真的会换源，且换源要说出来（不静默降级）', () => {
    const ext = readFileSync(join('src', 'extension.ts'), 'utf8');
    assert.ok(ext.includes('rootfsCandidatesFor(currentNetPlan())'), '导入前要取候选链');
    assert.ok(ext.includes('rootfsFallback: rootfsPlan.fallback'), '兑底要传下去');
    assert.ok(
      ext.includes("if ((explicit.url ?? '').trim()) {\n    return { rootfs: explicit, fallback: [] };"),
      '显式设置要优先且不掺链',
    );
    const imp = readFileSync(join('src', 'features', 'env', 'wslImport.ts'), 'utf8');
    assert.ok(imp.includes('async function acquireRootfs('), '要有候选走位');
    assert.ok(imp.includes('主源不可用'), '换源要打日志（可复盘）');
    assert.ok(
      imp.includes('const chain = [opts.primary, ...opts.fallback].filter'),
      '链的顺序：主源在前',
    );
    assert.ok(imp.includes('sha256: c.sha256'), '每个候选都过校验（候选没有“免检”的）');
    assert.ok(!/sha256:\s*['"]['"]/.test(imp), '不许把校验值写成空字符串');
  });

  it('设置项三个都声明了，且中英文案齐全（枚举档位也有说明）', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      contributes: { configuration: { properties: Record<string, { default?: unknown; enum?: string[] }> } };
    };
    const props = pkg.contributes.configuration.properties;
    assert.deepStrictEqual(props['het.net.profile']?.enum, ['auto', 'cn', 'global', 'custom']);
    assert.strictEqual(props['het.net.profile']?.default, 'auto');
    assert.strictEqual(props['het.net.mirrors']?.default && typeof props['het.net.mirrors'].default === 'object', true);
    assert.strictEqual(props['het.net.dockerMirror']?.default, '', 'Docker 镜像默认关闭');
    for (const nls of ['package.nls.json', 'package.nls.zh-cn.json']) {
      const dict = JSON.parse(readFileSync(nls, 'utf8')) as Record<string, string>;
      for (const key of [
        'config.netProfile',
        'config.netProfile.auto',
        'config.netProfile.cn',
        'config.netProfile.global',
        'config.netProfile.custom',
        'config.netMirrors',
        'config.netDockerMirror',
      ]) {
        assert.ok(dict[key], `${nls} 缺 ${key}`);
      }
      assert.ok(dict['config.netProfile'].includes('弹窗') || dict['config.netProfile'].includes('dialog'),
        '文案要说清"不会弹窗"');
    }
    assert.ok(CN_PIP_INDEXES.length >= 3 && CN_APT_MIRRORS.length >= 3);
  });
});
