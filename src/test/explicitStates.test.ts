import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { summarizePreflight } from '../core/preflightSummary';
import { TOOL_MATRIX } from '../core/toolMatrix';

/** 门禁要扫**代码**，不扫注释：解释性注释里会出现 `timeoutMs: 0` 这种反例字面量。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
}

const ext = (): string => stripComments(readFileSync(join('src', 'extension.ts'), 'utf8'));
const read = (p: string): string => readFileSync(join('src', p), 'utf8');

describe('§F.41 明确终态与判决单一来源', () => {
  it('发布就绪判决只有一处实现：扩展直接复用 summarizePreflight', () => {
    const src = ext();
    // 反例（改回去就红）：`items.filter(...required...).every(...)` 这种内联判断只能出现在纯函数里
    const inline = src.match(/\.filter\(\(i\) => i\.required\)\.every\(/gu) ?? [];
    assert.deepStrictEqual(inline, [], 'allowRelease 不许在扩展里另算一遍（口径会漂移）');
    assert.match(
      src.replace(/\s+/gu, ' '),
      /allowRelease: summarizePreflight\(items\)\.allowRelease/u,
      '扩展必须复用 core/preflightSummary 的判决',
    );
    // 发布中心也要拿到同一份判决（否则"预检说不能发、发布中心说能发"）
    assert.ok(
      read('features/release/panel.ts').includes('verdict'),
      '发布中心要显示并与预检同源的判决',
    );
  });

  it('判决口径自洽：required 全绿才算就绪，红项优先给下一步', () => {
    const items = [
      { label: '构建通过', ok: true, required: true },
      { label: '测试通过', ok: false, detail: '跑 het 重建', required: true },
      { label: 'docs', ok: undefined, detail: '未判定', required: false },
    ];
    const v = summarizePreflight(items);
    assert.strictEqual(v.allowRelease, false);
    assert.ok(v.fact.includes('✗ 1'));
    assert.ok(v.next?.startsWith('需要你执行：'), '红项必须先说怎么修');
    assert.strictEqual(v.firstFail, '测试通过');
    assert.strictEqual(summarizePreflight([{ label: 'a', ok: true, required: true }]).allowRelease, true);
  });

  it('质量面板的三态徽标明确（– 要说清"本机不可用"，不是含糊的"不可用"）', () => {
    const html = read('features/quality/qualityHtml.ts');
    assert.ok(html.includes('– 本机不可用'), 'na 徽标要写清是本机不可用');
    assert.ok(html.includes('· 未运行'), 'idle 徽标要说清还没跑');
  });

  it('最重的两项门禁有**有界超时**，超时也回明确终态（按钮不许永远转圈）', () => {
    const src = ext();
    // 反例：这两项以前是 timeoutMs: 0（无限等）
    /** 取某个门禁分支的代码块：从 `rowId === 'x'` 到下一个结束标记之前。 */
    const blockOf = (id: string, endToken: string): string => {
      const from = src.indexOf(`rowId === '${id}'`);
      const to = src.indexOf(endToken, from + 1);
      assert.ok(from > -1 && to > from, `找不到 ${id} 分支`);
      return src.slice(from, to);
    };
    const mega = blockOf('megalinter', "return err('未知检查项'");
    const git = blockOf('gitleaks', "rowId === 'megalinter'");
    assert.ok(!/timeoutMs: 0/u.test(mega), 'MegaLinter 不许无限等');
    assert.ok(!/timeoutMs: 0/u.test(git), 'gitleaks 不许无限等');
    assert.match(mega, /timeoutMs: 900_000/u, 'MegaLinter 15 分钟上限');
    assert.match(git, /timeoutMs: 300_000/u, 'gitleaks 5 分钟上限');
    assert.ok(/MegaLinter 未跑完（超时）/u.test(src), '超时要有专门的终态文案');
    assert.ok(/建议走在线 CI|走在线 CI/u.test(src), '超时要给出"下一步"（走在线 CI）');
  });

  it('矩阵把"要装什么、多大、不装怎么办"说全（不再只是一句 装 Docker）', () => {
    const mega = TOOL_MATRIX.find((t) => t.id === 'megalinter')!;
    assert.ok(/Docker/u.test(mega.install), '说清依赖 Docker');
    assert.ok(/GB/u.test(mega.install), '给出体积量级（用户要知道成本）');
    assert.ok(/CI/u.test(mega.install), '给出"不装怎么办"（走在线 CI）');
  });

  it('Preflight 面板：刷新走局部替换，不再整页重载（F.29 家族）', () => {
    const src = read('features/preflight/panel.ts');
    const assigns = src.match(/webview\.html\s*=/gu) ?? [];
    assert.strictEqual(assigns.length, 2, '整页渲染只允许首帧那两处（正常/异常各一）');
    assert.ok(src.includes("type: 'render'"), '刷新走 render 消息局部替换');
    assert.ok(src.includes('已重新检查 · '), '刷新要有可见反馈（时间戳）');
  });
});
