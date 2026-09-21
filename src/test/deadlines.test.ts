/**
 * **有界超时门禁**（G2 / G17，§3.5 阈值表）。
 *
 * 背景（实测反馈）：编译文档用的是 `timeoutMs: 0`，脚本一挂住就是"转两小时不回来"，
 * 用户没有任何办法判断是"还在干活"还是"已经死了"。这次把它收成**一张表 + 一种翻译**：
 *   · 阈值只在 `core/deadlines.ts` 定义，设置 `het.task.deadlines` 可覆盖；
 *   · 产品代码里**不许再出现 `timeoutMs: 0`**（本文件扫代码强制，注释不算）；
 *   · 超时必须翻成人话（主体 + 实际阈值 + 下一步），不许把毫秒原文丢给用户；
 *   · 设置只能**调大**，写 0 / 负数 / NaN 一律退回默认 —— 不存在"把超时关掉"这条路。
 */
import * as assert from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEADLINES_MS,
  DEADLINE_KINDS,
  DEADLINE_SETTING,
  deadlineFor,
  deadlineLabel,
  isTimeoutError,
  timeoutError,
  withDeadline,
} from '../core/deadlines';
import { ExecError } from '../utils/exec';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walk(p, out);
    } else if (p.endsWith('.ts')) {
      out.push(p);
    }
  }
  return out;
}

const PRODUCT_FILES = walk('src').filter((p) => !p.startsWith(join('src', 'test')));
const UNBOUNDED = /timeoutMs\s*:\s*0\b/u;

/** 剥注释：门禁管代码，不管"解释为什么不能这么写"的那句话。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
}

describe('G2/G17 有界超时（单一来源 / 人话 / 不能关掉）', () => {
  it('阈值表与 §3.5 定稿一致（改动必须同步计划）', () => {
    const minutes = (k: keyof typeof DEADLINES_MS): number => DEADLINES_MS[k] / 60_000;
    assert.strictEqual(minutes('build'), 15);
    assert.strictEqual(minutes('test'), 15);
    assert.strictEqual(minutes('docs'), 30, '文档：首次装图 + 大库文档，慢是常态但必须有上界');
    assert.strictEqual(minutes('quality'), 15);
    assert.strictEqual(minutes('envPrepare'), 45, '环境准备：拉 rootfs/镜像量级最大');
    assert.strictEqual(minutes('cross'), 30);
    assert.strictEqual(minutes('board'), 30);
    assert.strictEqual(minutes('misc'), 10, '兜底');
    assert.ok(DEADLINE_KINDS.length >= 10, '阈值类别不该被掏空');
  });

  it('产品代码里不许出现 `timeoutMs: 0`（剥注释扫 + 自证探测器能失败）', () => {
    assert.strictEqual(UNBOUNDED.test('run(x, { timeoutMs: 0 })'), true, '探测器对注入样本无感 → 门禁是假的');
    assert.strictEqual(UNBOUNDED.test('run(x, { timeoutMs: 1000 })'), false);
    assert.strictEqual(
      UNBOUNDED.test(stripComments('// 以前这里是 timeoutMs: 0\nrun(x);')),
      false,
      '注释里的反例不该被算作违规',
    );
    assert.ok(PRODUCT_FILES.length >= 50, `扫到的产品文件太少（${PRODUCT_FILES.length}）`);
    const bad = PRODUCT_FILES.filter((p) => UNBOUNDED.test(stripComments(readFileSync(p, 'utf8'))));
    assert.deepStrictEqual(
      bad.map((p) => p.split(/[\\/]/u).join('/')),
      [],
      '这些文件还在无限等：改用 core/deadlines.ts 的阈值（超时要能回答"下一步"）',
    );
  });

  it('设置只能调大：0 / 负数 / NaN 一律退回默认（不存在"把超时关掉"）', () => {
    assert.strictEqual(deadlineFor('docs'), DEADLINES_MS.docs);
    assert.strictEqual(deadlineFor('docs', { docs: 0 }), DEADLINES_MS.docs, '写 0 不能等于无限');
    assert.strictEqual(deadlineFor('docs', { docs: -1 }), DEADLINES_MS.docs);
    assert.strictEqual(deadlineFor('docs', { docs: Number.NaN }), DEADLINES_MS.docs);
    assert.strictEqual(deadlineFor('docs', { docs: 5 * 60_000 }), 5 * 60_000, '调大/调小都允许');
    assert.strictEqual(deadlineFor('docs', { docs: 6000 }), 6000);
    assert.strictEqual(deadlineFor('misc', { misc: 1 }), 1000, '再小也留 1 秒（不许退化成 0）');
  });

  it('超时翻成人话：主体 + 实际阈值 + 下一步（而不是 `timed out after Nms`）', () => {
    const err = timeoutError('编译文档', 'docs');
    assert.ok(err.message.includes('编译文档'), '要说是**哪个**动作超时');
    assert.ok(err.message.includes('30 分钟'), '要写实际阈值（用户据此决定要不要调）');
    assert.ok(err.message.includes(`${DEADLINE_SETTING}.docs`), '要给出可调的位置');
    assert.ok(!/timed out after/u.test(err.message), '不许把毫秒原文丢给用户');
    assert.strictEqual(isTimeoutError(new ExecError('command timed out after 100ms')), true);
    assert.strictEqual(isTimeoutError(new Error('boom')), false);
    assert.strictEqual(deadlineLabel(120_000), '2 分钟');
    assert.strictEqual(deadlineLabel(1_500), '2 秒');
  });

  it('withDeadline：把表里的阈值传给 exec，只翻译超时、其余错误原样上抛', async () => {
    let seen = 0;
    const value = await withDeadline('编译文档', 'docs', async (timeoutMs) => {
      seen = timeoutMs;
      return 'ok';
    });
    assert.strictEqual(value, 'ok');
    assert.strictEqual(seen, DEADLINES_MS.docs, 'exec 拿到的必须是表里的阈值');

    await assert.rejects(
      async () => withDeadline('编译文档', 'docs', async () => Promise.reject(new ExecError('command timed out after 5ms'))),
      /⏱ 编译文档 超过 30 分钟/u,
    );
    await assert.rejects(
      async () => withDeadline('编译文档', 'docs', async () => Promise.reject(new Error('boom'))),
      /^Error: boom$/u,
      '非超时的错误必须原样上抛（不许被翻译掩盖）',
    );
  });

  it('提示里引用的设置名必须在 package.json 里真实存在（否则是假指引）', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      contributes: { configuration: { properties: Record<string, unknown> } };
    };
    const prop = pkg.contributes.configuration.properties[DEADLINE_SETTING];
    assert.ok(prop, `package.json 里缺少 ${DEADLINE_SETTING} 设置项`);
  });
});
