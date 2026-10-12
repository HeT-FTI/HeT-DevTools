import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CURATED_PACKAGES } from '../data/conanIndex';
import { FORCED_BUCKET, addDependency, type DependencyView } from '../core/dependencyService';
import {
  CUSTOM_VERSION,
  bucketOf,
  groupRows,
  searchCatalog,
  summarizeDeps,
  validateAddInput,
  versionsFor,
} from '../features/deps/model';
import { depsListHtml, depsPageHtml } from '../features/deps/html';

const view = (over: Partial<DependencyView> = {}): DependencyView => ({
  bucket: 'cpp',
  displayKey: 'fmt/11.1.4',
  conanName: 'fmt',
  version: '11.1.4',
  targets: ['fmt::fmt'],
  ...over,
});

const read = (p: string): string => readFileSync(join('src', p), 'utf8');

describe('§F.42 依赖管理器重做（搜索 × 版本联动 × 域 → 双写 + 回显）', () => {
  it('索引检索：按包名或用途都能搜到，空串给全部', () => {
    assert.strictEqual(searchCatalog('').length, CURATED_PACKAGES.length);
    assert.ok(searchCatalog('fmt').some((e) => e.conan === 'fmt'));
    assert.ok(searchCatalog('FMT').some((e) => e.conan === 'fmt'), '大小写不敏感');
    assert.ok(searchCatalog('日志').some((e) => e.conan === 'spdlog'), '按用途中文也能搜');
    assert.deepStrictEqual(searchCatalog('绝不存在这个包xyz'), []);
  });

  it('版本联动：候选来自索引，已装的非索引版本也会出现在最前，末尾固定"自定义"', () => {
    const fmt = versionsFor('fmt');
    assert.deepStrictEqual(
      fmt.slice(0, CURATED_PACKAGES.find((c) => c.conan === 'fmt')!.versions.length),
      CURATED_PACKAGES.find((c) => c.conan === 'fmt')!.versions,
    );
    assert.strictEqual(fmt.at(-1), CUSTOM_VERSION, '末尾固定自定义哨兵');
    const unknown = versionsFor('my-internal-lib', '0.1.0');
    assert.deepStrictEqual(unknown, ['0.1.0', CUSTOM_VERSION], '自定义包也要有当前版本可选');
  });

  it('域归属：索引里有的按索引预选，没有的默认 cpp', () => {
    assert.strictEqual(bucketOf('zlib'), 'c');
    assert.strictEqual(bucketOf('fmt'), 'cpp');
    assert.strictEqual(bucketOf('my-internal-lib'), 'cpp');
  });

  it('规则固定桶是**单一来源**：索引条目必须与写入规则一致（gtest 曾在索引里是 common）', () => {
    for (const [conan, bucket] of Object.entries(FORCED_BUCKET)) {
      assert.strictEqual(
        bucketOf(conan),
        bucket,
        `索引里的 ${conan} 桶（${bucketOf(conan)}）与写入规则（${bucket}）不一致 —— 面板会预选错`,
      );
    }
  });

  it('校验：任何失败都给一句人话（不能静默 return —— 那就是"按钮是死的"）', () => {
    assert.match(validateAddInput({ conanName: '', version: '1.0', bucket: 'cpp' })!, /包名/u);
    assert.match(
      validateAddInput({ conanName: 'fmt', version: CUSTOM_VERSION, bucket: 'cpp' })!,
      /版本/u,
    );
    assert.match(validateAddInput({ conanName: 'fmt', version: '', bucket: 'cpp' })!, /版本/u);
    assert.match(validateAddInput({ conanName: 'fmt', version: '1', bucket: 'nope' })!, /未知的归属桶/u);
    assert.strictEqual(validateAddInput({ conanName: 'fmt', version: '11.1.4', bucket: 'cpp' }), null);
  });

  it('被规则改桶时**如实回执**（不静默覆盖用户选择）', () => {
    const meta = {
      name: 'demo',
      version: '0.1.0',
      dependencies: { common: {}, c: {}, cpp: {}, infra: {} },
      enable_python_bindings: false,
    } as never;
    const res = addDependency(meta, 'requirements:\n', {
      conanName: 'gtest',
      version: '1.15.2',
      bucket: 'common',
    });
    assert.strictEqual(res.ok, true, res.issues.join('；'));
    assert.strictEqual(res.appliedBucket, 'infra', '实际落盘的桶');
    assert.strictEqual(res.coerced, true, '要标记"被规则改桶了"，UI 才能如实说');
    const ok = addDependency(meta, 'requirements:\n', {
      conanName: 'fmt',
      version: '11.1.4',
      bucket: 'cpp',
    });
    assert.strictEqual(ok.coerced, false, '正常包不许被标成改桶');
  });

  it('分桶：固定四桶顺序、空桶也显示（"没有"本身是信息）', () => {
    const groups = groupRows([view(), view({ bucket: 'infra', displayKey: 'gtest/1.15.0' })]);
    assert.deepStrictEqual(groups.map((g) => g.bucket), ['common', 'c', 'cpp', 'infra']);
    assert.strictEqual(groups.find((g) => g.bucket === 'cpp')!.rows.length, 1);
    assert.strictEqual(groups.find((g) => g.bucket === 'common')!.rows.length, 0);
  });

  it('页面：包名走有界选择器、版本/桶用下拉、索引快照可解析', () => {
    const html = depsPageHtml({ views: [view()], issues: [] });
    assert.ok(html.includes('data-picker-id="dep"'), '包名要用有界选择器（可滚动/有计数/键盘可用）');
    assert.ok(html.includes('id="dep-total"'), '候选要有命中计数');
    assert.ok(html.includes('id="dep-list"'), '要有候选列表容器');
    assert.ok(!/<datalist/u.test(html), '原生 datalist 已禁用（规模一大就没滚动条/计数/键盘）');
    assert.ok(html.includes('<select id="ver"'), '版本用下拉');
    assert.ok(html.includes('<select id="bucket"'), '域用下拉');
    assert.ok(html.includes('id="ver-custom"'), '索引过时时要能自定义版本');
    assert.ok(html.includes('het.addDependency'), '面板里要写明键盘路径（同一套写入）');
    const json = /<script type="application\/json" id="dep-catalog">([\s\S]*?)<\/script>/u.exec(html);
    assert.ok(json, '索引快照要嵌进页面（版本联动用）');
    const parsed = JSON.parse(json![1].replace(/\\u003c/gu, '<')) as { conan: string }[];
    assert.ok(parsed.length >= 20, '快照不能退化成空壳');
    assert.ok(parsed.some((p) => p.conan === 'fmt'));
  });

  it('死按钮门禁：不用 onclick=，每个 data-action 都有处理分支', () => {
    const html = depsPageHtml({ views: [view()], issues: [] });
    assert.ok(!/onclick=/u.test(html), '不许再用 inline onclick（F.31 同源错法）');
    const acts = [...html.matchAll(/data-action="([^"]+)"/gu)].map((m) => m[1]);
    assert.ok(acts.length >= 3, `至少要有 添加/刷新/移除：${acts.join(',')}`);
    for (const a of acts) {
      assert.ok(
        new RegExp(`act === '${a}'`, 'u').test(html),
        `data-action="${a}" 没有处理分支 —— 点了就是没反应`,
      );
    }
    // 输入事件也要有分支（版本联动靠它；包名筛选由 picker 接管）
    assert.ok(html.includes("el.id === 'ver'"), '版本下拉的 change 联动要接住');
    assert.ok(html.includes('window.onPickerSelect'), '选择器选中要回调页面做联动');
  });

  it('刷新走局部替换（只首帧整页），并在 #note 回显', () => {
    const html = depsPageHtml({ views: [], issues: [] }, '已刷新 · 10:00:00');
    assert.ok(html.includes('id="list"') && html.includes('id="note"'), '要有可局部替换的锚点');
    assert.ok(html.includes("m.type !== 'render'"), '监听宿主 render 消息');
    assert.ok(html.includes('已刷新 · 10:00:00'), '首帧就能带上一句提示');
    const src = read('features/deps/panel.ts');
    const assigns = src.match(/webview\.html\s*=/gu) ?? [];
    assert.strictEqual(assigns.length, 2, '整页渲染只允许首帧（正常/异常各一）');
    assert.ok(src.includes("type: 'render'"), '刷新走 render 消息');
    assert.ok(src.includes('validateAddInput'), '面板必须做提交前校验并回话');
  });

  it('入口门禁：het.openDeps 打开详情页（不再深链驾驶舱），且与 QuickPick 共用同一 service', () => {
    const ext = read('extension.ts');
    assert.match(
      ext,
      /registerCommand\('het\.openDeps', \(\) => openDepsPanel\(context\)\)/u,
      'openDeps 要打开依赖详情页',
    );
    assert.ok(!/het\.openDeps', \(\) => openDashboard/u.test(ext), '不再深链驾驶舱');
    assert.match(ext, /function openDepsPanel\([\s\S]{0,120}createDepsService\(\)/u, '两条入口共用同一 service');
  });

  it('清单回显：空列表与有依赖时都说清"当前有什么"', () => {
    assert.match(summarizeDeps([]), /尚无依赖/u);
    assert.strictEqual(
      summarizeDeps([view()]),
      '1 个：fmt/11.1.4@11.1.4',
    );
    const html = depsListHtml({ views: [], issues: ['conandata.yml 缺少 requirements 段'] });
    assert.ok(html.includes('⚠ conandata.yml 缺少 requirements 段'), '问题要显示在清单顶部');
    assert.ok(html.includes('（空）'), '空桶要有明确占位');
  });
});
