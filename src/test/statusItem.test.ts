/**
 * StatusItem 模型门禁（C 块）：三档同源 + 预算 + 投影合并。
 *
 * 为什么单独测这个纯模型：三档（芯片 / 悬停 / 页内）只要有一档自己拼文案，就会出现
 * "chip 说成功、卡片说失败"这类没法解释的观感 —— 所以把"同源"变成可断言的事实，
 * 而不是一条纪律。
 */
import * as assert from 'node:assert';
import {
  DOMAIN_LABEL,
  HOVER_DOMAIN_ORDER,
  HOVER_LIMITS,
  StatusItemError,
  chipBusyItem,
  chipTextOf,
  hoverMarkdown,
  hoverProjection,
  linkify,
  stateIcon,
  type StatusItem,
} from '../core/statusItem';

const item = (over: Partial<StatusItem> = {}): StatusItem => ({
  id: 'build',
  domain: 'build',
  state: 'ok',
  text: '✅ 成功',
  ...over,
});

describe('C. StatusItem（三档同源 / 预算 / 投影）', () => {
  it('三档同源：芯片文字里的"做什么"来自 core/status.ts 的进行时口径', () => {
    const busy = chipTextOf([item({ id: 'build', state: 'running' })], 87);
    assert.strictEqual(busy, '$(sync~spin) HeT 构建中');
    const idle = chipTextOf([item()], 87);
    assert.strictEqual(idle, '$(pulse) HeT 87');
    assert.strictEqual(chipTextOf([item()], null), '$(pulse) HeT ·', '没有健康分也不许瞎编');
  });

  it('抢芯片的只有"非 env"的进行中项（env 检查是秒级动作）', () => {
    const envBusy = [item({ id: 'envCheck', domain: 'env', state: 'running' })];
    assert.strictEqual(chipBusyItem(envBusy), undefined);
    assert.strictEqual(chipTextOf(envBusy, 87), '$(pulse) HeT 87');
    const both = [...envBusy, item({ id: 'test', domain: 'test', state: 'running' })];
    assert.strictEqual(chipBusyItem(both)?.id, 'test');
  });

  it('投影：同域合并成一行（6 个状态项 → 5 行），行名按 rail 顺序', () => {
    const items: StatusItem[] = [
      item({ id: 'envCheck', domain: 'env', text: 'WSL2 · conan 2.32' }),
      item({ id: 'build', domain: 'build', text: '✅ 成功' }),
      item({ id: 'test', domain: 'test', text: '✅ 通过 7' }),
      item({ id: 'docsBuild', domain: 'docs', text: '未构建' }),
      item({ id: 'coverage', domain: 'quality', text: '未生成' }),
      item({ id: 'release', domain: 'release', text: '与参考一致' }),
    ];
    const p = hoverProjection(items, { actions: [], nav: [] });
    assert.deepStrictEqual(
      p.rows.map(([k]) => k),
      ['环境车道', '构建验证', '模块文档', '质量安全', '交付发布'],
    );
    const build = p.rows.find(([k]) => k === '构建验证')?.[1] ?? '';
    assert.ok(build.includes('✅ 成功') && build.includes('✅ 通过 7'), '同域两项合并在一个单元格里');
  });

  it('预算越界直接抛错（而不是渲染出来才发现挤成一片）', () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      item({ id: `x${i}`, domain: (['env', 'build', 'docs', 'quality', 'release'] as const)[i % 5], text: `t${i}` }),
    );
    // 6 个域不同 → 最多 5 行：这里构造 6 个不同行是不可能的（只有 5 个域），所以改用动作超限
    const mk = (n: number): { id: string; label: string; command: string; kind: 'primary' }[] =>
      Array.from({ length: n }, (_, i) => ({ id: `a${i}`, label: `a${i}`, command: `het.a${i}`, kind: 'primary' }));
    assert.doesNotThrow(() => hoverProjection(many, { actions: mk(HOVER_LIMITS.primaryActions), nav: [] }));
    assert.throws(() => hoverProjection(many, { actions: mk(HOVER_LIMITS.primaryActions + 1), nav: [] }), StatusItemError);
    assert.throws(
      () =>
        hoverProjection(many, {
          actions: [],
          nav: Array.from({ length: HOVER_LIMITS.nav + 1 }, (_, i) => ({
            id: `n${i}`,
            label: `n${i}`,
            command: `het.n${i}`,
            kind: 'nav' as const,
          })),
        }),
      StatusItemError,
    );
  });

  it('主动作与产物入口指向同一条命令 → 抛错（重复入口会被误读成两个功能）', () => {
    const dup = item({
      action: { id: 'a', label: 'A', command: 'het.same' },
      artifact: { id: 'b', label: 'B', command: 'het.same' },
    });
    assert.throws(() => hoverProjection([dup], { actions: [], nav: [] }), StatusItemError);
  });

  it('图标与链接：状态有图标，命令链接可点（带参数时 URL 编码）', () => {
    assert.strictEqual(stateIcon('running'), '$(sync~spin)');
    assert.strictEqual(stateIcon('fail'), '$(error)');
    assert.strictEqual(stateIcon('timedOut'), '$(clock)');
    assert.strictEqual(linkify('详情', 'het.docs'), '[详情](command:het.docs)');
    assert.strictEqual(
      linkify('Doxygen', 'het.openDocsArtifact', 'doxygen'),
      '[Doxygen](command:het.openDocsArtifact?%22doxygen%22)',
    );
  });

  it('悬停 Markdown：表头固定、动作分区在表格之后', () => {
    const md = hoverMarkdown('demo', hoverProjection([item()], {
      actions: [{ id: 'x', label: 'X', command: 'het.x', kind: 'primary' }],
      nav: [{ id: 'n', label: 'N', command: 'het.n', kind: 'nav' }],
    }));
    assert.ok(md.includes('| 项目 | 状态 |'));
    assert.ok(md.indexOf('━━━ 快捷操作') > md.indexOf('| 项目 | 状态 |'));
    assert.ok(md.indexOf('━━━ 打开') > md.indexOf('━━━ 快捷操作'));
    // §5.3：悬停里只写项目名（品牌名只允许在唯一页签标题与通道名上）
    assert.ok(md.includes('**$(package) demo**'));
    assert.ok(!md.includes('HeT DevTools'), '悬停不署品牌名 —— 它只该在唯一页签标题上');
  });

  it('超时/取消是不同的出口（图标不同，语义不能混）', () => {
    assert.notStrictEqual(stateIcon('timedOut'), stateIcon('fail'));
    assert.notStrictEqual(stateIcon('cancelled'), stateIcon('fail'));
  });
});

describe('C. StatusItem 的"不静默丢"纪律', () => {
  it('域不在 rail 名单里 → 抛错（静默丢掉意味着某个状态项永远不显示，比报错难查）', () => {
    const rogue = {
      id: 'rogue',
      domain: 'unknown-domain' as never,
      state: 'ok' as const,
      text: 'x',
    };
    assert.throws(() => hoverProjection([rogue], { actions: [], nav: [] }), StatusItemError);
  });

  it('rail 名单就是 §5.1 的五个域（改这个名单必须同步改 rail 与文档）', () => {
    assert.deepStrictEqual(HOVER_DOMAIN_ORDER, ['环境车道', '构建验证', '模块文档', '质量安全', '交付发布']);
    const labels = new Set(Object.values(DOMAIN_LABEL));
    for (const label of labels) {
      assert.ok(HOVER_DOMAIN_ORDER.includes(label), `${label} 不在悬停行名单里`);
    }
  });
});
