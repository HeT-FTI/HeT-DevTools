/**
 * V3 · L5b / G6 门禁：**依赖演进**（系统头映射 · 上游最新 · 两份清单）。
 *
 * 这块最容易写成"看着有理"的假门禁，所以三条判据都用**真实文件**当输入：
 *   1. 模板的 `security-linters.yml` / `conandata.yml` / `src/*.c(pp)` 是现成的真样本；
 *   2. "上游最新"用 conan 真会吐出来的 JSON 形状（含非数字版本段）；
 *   3. **不编造**：没查到版本的包不许出现在"有新版"里；没有 `declared` 时卡片只说 `—`。
 */
import * as assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ciSystemHeaders,
  conandataRequirements,
  depEvolution,
  includedHeaders,
  latestVersionFromSearch,
  packageForHeader,
} from '../core/depEvolution';
import { listDependencies } from '../core/dependencyService';
import { EMPTY_FACTS, singlePageModelFrom } from '../features/cockpit/singlepage/modelFrom';
import { initialCockpitState } from '../features/cockpit/state';
import type { FcppMetadata } from '../types';

const TPL = join('assets', 'template');
const conandataText = readFileSync(join(TPL, 'conandata.yml'), 'utf8');
const workflowText = readFileSync(join(TPL, '.github', 'workflows', 'security-linters.yml'), 'utf8');
const templateMeta = JSON.parse(readFileSync(join(TPL, 'metadata.json'), 'utf8')) as FcppMetadata;
const tplSrc: Record<string, string> = {};
for (const f of readdirSync(join(TPL, 'src'))) {
  if (/\.(c|cc|cpp|cxx)$/u.test(f)) {
    tplSrc[`src/${f}`] = readFileSync(join(TPL, 'src', f), 'utf8');
  }
}

/** 模板的依赖（`listDependencies` = 依赖管理器与卡片共用那一份）。 */
const declared = listDependencies(templateMeta, conandataText).map((v) => ({
  name: v.displayKey,
  conan: v.conanName,
  ...(v.version !== undefined ? { version: v.version } : {}),
}));

describe('L5b · 依赖演进（G6）', () => {
  it('解析真实文件：conandata 的 requirements 与 CI 的系统头映射', () => {
    const reqs = conandataRequirements(conandataText);
    assert.ok(reqs.length >= 5, `requirements 解析看起来不对：${reqs.length}`);
    assert.deepStrictEqual(reqs.find((r) => r.pkg === 'pcre2'), { pkg: 'pcre2', version: '10.44' });

    const map = ciSystemHeaders(workflowText);
    assert.strictEqual(map.zlib, 'zlib1g-dev', 'apt 包名要一起取出来（用户要抄进终端的就是它）');
    assert.strictEqual(map.pcre2, 'libpcre2-dev');
    assert.strictEqual(map.eigen, 'libeigen3-dev');
    assert.ok('etl' in map, 'header-only 的包由专门步骤装（startswith("etl/")）');
    // 反向：CI 里没映射的包不该凭空出现
    assert.ok(!('gtest' in map) && !('pybind11' in map));
  });

  it('头文件 → 包名只认能明确对上的（不靠猜：对不上就说对不上）', () => {
    assert.strictEqual(packageForHeader('zlib.h', ['zlib', 'pcre2']), 'zlib');
    assert.strictEqual(packageForHeader('etl/transform.h', ['zlib', 'etl']), 'etl');
    assert.strictEqual(packageForHeader('Eigen/Dense', ['eigen']), 'eigen');
    assert.strictEqual(packageForHeader('gtest/gtest.h', ['zlib', 'pcre2']), undefined, '对不上就不猜');

    const headers = includedHeaders({ 'src/a.c': '#include <zlib.h>\n#include "local.h"\n' });
    assert.deepStrictEqual(headers, ['zlib.h', 'local.h']);
  });

  it('**模板本体实测**：src 用到的依赖，CI 里都有系统头 → 不报缺口', () => {
    const ev = depEvolution({ declared, conandataText, ciWorkflowText: workflowText, srcFiles: tplSrc });
    assert.deepStrictEqual(ev.sysHeaderGaps, [], '模板自己必须过自己这条约定');
    assert.deepStrictEqual(ev.mismatched, [], '两份清单一致');
    assert.strictEqual(ev.state, 'ok');
    assert.match(ev.fact, /^直接 \d+$/u, `没有上游数据时只报取得到的数：${ev.fact}`);
  });

  it('**缺系统头**：src 里 include 了、CI 映射里没有 → warn + 给出怎么补', () => {
    const src = { 'src/a.c': '#include <pcre2.h>\n#include <libxml/parser.h>\n' };
    // 把 CI 里的 pcre2 映射删掉（模拟"新加了依赖忘了改 CI"）
    const stripped = workflowText.replace("'pcre2': 'libpcre2-dev'", "'pcre2x': 'libpcre2-dev'");
    const ev = depEvolution({ declared, conandataText, ciWorkflowText: stripped, srcFiles: src });
    assert.deepStrictEqual(ev.sysHeaderGaps, ['pcre2']);
    assert.strictEqual(ev.state, 'warn');
    assert.match(ev.fact, /CI 缺系统头：pcre2（src 里用到）· 直接 \d+/u);
    assert.match(ev.next ?? '', /security-linters\.yml 的 mapping/u, '要给出改哪个文件');
    // 认不出的头（libxml）不进缺口 —— 宁可漏报，也不要让人白改 CI
    assert.ok(!ev.sysHeaderGaps.includes('libxml'));
  });

  it('**两份清单不一致** → fail（构建时真的会找不到依赖）', () => {
    const ev = depEvolution({
      declared: [...declared, { name: 'nlohmann_json' }],
      conandataText,
      ciWorkflowText: workflowText,
      srcFiles: tplSrc,
    });
    assert.deepStrictEqual(ev.mismatched, ['nlohmann_json']);
    assert.strictEqual(ev.state, 'fail');
    assert.match(ev.fact, /两份清单不一致：nlohmann_json/u);
    assert.match(ev.next ?? '', /再漂/u);
  });

  it('**上游最新**：只认真查到的（没查到的包不许出现在"有新版"里）', () => {
    // conan search 的真实输出形状
    const json = JSON.stringify({
      results: [{ items: [{ ref: 'pcre2/10.42' }, { ref: 'pcre2/10.44' }, { ref: 'pcre2/10.45' }] }],
    });
    assert.strictEqual(latestVersionFromSearch(json), '10.45');
    assert.strictEqual(latestVersionFromSearch(JSON.stringify({ results: [{ items: ['zlib/1.3.1', 'zlib/1.2.13.1'] }] })), '1.3.1');
    assert.strictEqual(latestVersionFromSearch('not json'), undefined);
    assert.strictEqual(latestVersionFromSearch(JSON.stringify({ results: [] })), undefined);

    // 只查到 pcre2 → 只有 pcre2 进"有新版"；没查到的（zlib）不许进
    const ev = depEvolution({
      declared,
      conandataText,
      ciWorkflowText: workflowText,
      srcFiles: tplSrc,
      latest: { pcre2: '10.45' },
      latestAt: '3 分钟前',
    });
    assert.deepStrictEqual(ev.outdated, [{ name: 'PCRE2', local: '10.44', latest: '10.45' }]);
    assert.strictEqual(ev.state, 'ok');
    assert.match(ev.fact, /上游有新版 1（PCRE2 10.45 · 3 分钟前）/u);

    // 全部都是最新（且真查过）→ 才敢说"上游已是最新"
    const same = depEvolution({
      declared,
      conandataText,
      ciWorkflowText: workflowText,
      srcFiles: tplSrc,
      latest: Object.fromEntries(reqsOf(conandataText)),
      latestAt: '刚刚',
    });
    assert.deepStrictEqual(same.outdated, []);
    assert.match(same.fact, /上游已是最新（刚刚）/u);
  });

  it('**不编造**：没取到 declared 时卡片只说 `—`（`间接依赖数`没有事实来源，已不再显示）', () => {
    const none = depEvolution({});
    assert.strictEqual(none.fact, '—');
    assert.strictEqual(none.state, 'idle');

    const card = singlePageModelFrom(initialCockpitState(), EMPTY_FACTS).cards.find((c) => c.id === 'deps');
    assert.strictEqual(card?.fact, '—', '没有事实时不许显示任何数字');
    assert.ok(!/间接/u.test(card?.fact ?? ''));
  });

  it('卡片映射：三态与下一步真的上卡（warn 有怎么补、fail 有下一步）', () => {
    const model = singlePageModelFrom(initialCockpitState(), {
      deps: {
        declared,
        conandataText,
        ciWorkflowText: workflowText.replace("'pcre2': 'libpcre2-dev'", ''),
        srcFiles: tplSrc,
      },
    });
    const card = model.cards.find((c) => c.id === 'deps');
    assert.strictEqual(card?.state, 'warn');
    assert.match(card?.fact ?? '', /CI 缺系统头/u);
    assert.match(card?.next ?? '', /^需要你执行：/u);
  });

  it('**接线门禁**：扩展里真的把依赖事实喂进来了（否则卡片永远是 `—`）', () => {
    // L3 的教训：判据写好了、没人喂输入 → 界面上"机制在、一次没生效"。
    const ext = readFileSync(join('src', 'extension.ts'), 'utf8');
    assert.ok(ext.includes('facts.deps = {'), '依赖事实必须真的喂进单页模型');
    assert.ok(ext.includes('currentDependencyViews('), '直接依赖要来自 listDependencies（与依赖管理器同一份）');
    assert.ok(ext.includes('het.deps.latest'), '上游最新只读缓存（那次网络查询是显式动作）');
    // 上游查询必须只在**显式命令**里发生，不许挂在刷新路径上
    const refresh = ext.slice(ext.indexOf('async function feedExtraSinglePageFacts'));
    assert.ok(
      !refresh.slice(0, 4000).includes("'search', pkg"),
      '刷新路径里不许直接跑 conan search（那是点「查上游最新」才干的事）',
    );
  });
});

function reqsOf(text: string): [string, string][] {
  return conandataRequirements(text).map((r) => [r.pkg, r.version]);
}
