import * as assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * G19 的"文档不许漂"门禁。
 *
 * 为什么值得钉：旧 UI（11 tab）现在还是默认，而新 IA 是 5 段 + 25 卡。
 * 两个模块的头部注释曾经停留在"§3 IA / §4 单页渲染器"（都指向已经不存在的说法），
 * 下一个读代码的人会以为 layout.ts 就是新 IA —— 为了让"谁是新、谁是旧、删的条件是什么"
 * 一眼可见，把这几句话说进注释并用门禁守住。
 *
 * 注意：**不许依赖 `workspace/**`**（计划书/清单是 gitignored，新克隆里不存在），
 * 所以这里只查源码注释。
 */
describe('旧 UI 的标记（G19）', () => {
  const read = (p: string): string => readFileSync(join('src', p), 'utf8');

  it('归档不许进 vsix：`.vscodeignore` 必须排除 `_archive/**`（vsce 不读 .gitignore）', () => {
    const ignore = readFileSync('.vscodeignore', 'utf8');
    const rules = ignore.split('\n').map((l) => l.trim());
    assert.ok(
      rules.includes('_archive/**'),
      '归档目录只在 .gitignore 里是不够的 —— vsce 只认 .vscodeignore，会照样把 _archive/** 打进 vsix',
    );
    // 反过来守住容易被"顺手排掉"的东西：内置模板快照必须进包（没有它就不能离线建工程）
    assert.ok(
      !rules.includes('assets/**'),
      '不能把 assets/** 排掉：内置模板快照要靠它离线建工程',
    );
    assert.ok(rules.includes('out/**') && rules.includes('src/**'), '源码与 out 中间产物不进包');
  });

  it('旧 UI 的模块已经不在 src 里（全部归档到 _archive/，dead scope）', () => {
    for (const rel of ['features/cockpit/layout.ts', 'features/cockpit/webview/render.ts']) {
      assert.ok(!existsSync(join('src', rel)), `${rel} 不该还在 src 里（旧 UI 已归档）`);
    }
    const model = read(join('features', 'cockpit', 'singlepage', 'model.ts'));
    assert.ok(model.includes('LEGACY_TAB_IDS'), '旧 tab id 要留在 model.ts（信息不丢校验用）');
    assert.ok(model.includes('LegacyTabId'), '并标明它是历史记录，不是导航目标');
    const sections = read(join('features', 'cockpit', 'singlepage', 'sections.ts'));
    assert.ok(sections.includes('sectionForTab'), '旧深链要能解析成新段（老链接继续可用）');
  });

  it('新 UI 的入口仍在（旧模块的注释指向的东西必须真的存在）', () => {
    const sections = read(join('features', 'cockpit', 'singlepage', 'sections.ts'));
    const shell = read(join('features', 'cockpit', 'singlepage', 'shell.ts'));
    assert.ok(sections.includes('export const SECTIONS'), 'sections.ts 是 5 段 25 卡的单一数据源');
    assert.ok(shell.includes('export function cockpitSinglePageHtml('), 'shell.ts 要导出整页入口');
    assert.ok(sections.includes('tabsCovered'), '信息不丢校验还在（旧 tab 一个都不能丢）');
  });
});
