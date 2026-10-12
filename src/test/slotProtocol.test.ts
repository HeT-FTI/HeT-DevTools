/**
 * **Slot 协议与路由**（A 块的核心机制）：片段怎么切、消息怎么回、谁接住。
 *
 * 这一层最容易出的两个错（都在 V1 里真实发生过）：
 *   1. **片段带着 pageShell 的 head 被注入** → `acquireVsCodeApi()` 抛异常，把该
 *      `<script>` 后面的代码整段带走，页面上所有按钮变哑；
 *   2. **驾驶舱自己的消息被误打上 `__slot`** → 卡片动作被路由进某个视图，永远到不了
 *      驾驶舱的动作分支，表现就是"点了没反应"。
 *
 * 所以这里把"切片段"和"哪些消息类型属于驾驶舱"都变成**可单测的纯函数**，并把
 * "浏览器端的保留类型表"与 TS 侧的常量做**同源断言**（写死两份必然漂移）。
 */
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  COCKPIT_RESERVED_TYPES,
  SLOT_CLOSE,
  SLOT_FIELD,
  SLOT_OPEN,
  SLOT_POST,
  fragmentOf,
  isSlotMessage,
  slotFieldOf,
  tagSlotMessage,
  usesReservedType,
} from '../features/slots/protocol';
import {
  openSlotIds,
  registerSlotHandler,
  resetSlots,
  routeSlotMessage,
  slotDiagnostics,
} from '../features/slots/registry';
import { pageShell } from '../features/ui';

describe('§A Slot 协议：片段 / 标记 / 路由', () => {
  it('切片段：只取 body（pageShell 的 head 必须丢掉，否则 API 重复获取把页面脚本带走）', () => {
    const page = pageShell('标题', '<h1>内容</h1>\n<script>send({ type: \'x\' });</script>');
    const frag = fragmentOf(page);
    assert.ok(frag.includes('<h1>内容</h1>'), 'body 内容要在');
    assert.ok(frag.includes("send({ type: 'x' })"), 'body 里的脚本要在（片段自己发消息靠它）');
    assert.ok(!frag.includes('acquireVsCodeApi'), 'head 里的 acquireVsCodeApi 必须被丢掉');
    assert.ok(!frag.includes('<head>') && !frag.includes('<!DOCTYPE'), '不许带整页骨架');
    assert.ok(!frag.includes('<html'), '不许带 <html>');
  });

  it('切片段：没有 body 骨架时原样返回（兼容裸片段），且首尾空白被裁掉', () => {
    assert.strictEqual(fragmentOf('  <div>裸片段</div>  '), '<div>裸片段</div>');
    assert.strictEqual(fragmentOf('<html><body>\n<p>a</p>\n</body></html>'), '<p>a</p>');
  });

  it('标记与识别：带 `__slot` 的才是片段消息，且字段名唯一', () => {
    const tagged = tagSlotMessage({ type: 'render', html: 'x' }, 'deps');
    assert.strictEqual(tagged[SLOT_FIELD], 'deps');
    assert.strictEqual(tagged.type, 'render');
    assert.strictEqual(isSlotMessage(tagged), true);
    assert.strictEqual(slotFieldOf(tagged), 'deps');
    assert.strictEqual(isSlotMessage({ type: 'render' }), false, '驾驶舱自己的消息不该被当成片段消息');
    assert.strictEqual(slotFieldOf({ type: 'render' }), undefined);
    assert.strictEqual(isSlotMessage(null), false);
  });

  it('保留类型表：协议常量与浏览器端注入的是**同一份**（写死两份必然漂移）', () => {
    for (const t of [SLOT_OPEN, SLOT_CLOSE, SLOT_POST, 'action', 'copilot', 'folded', 'section:open']) {
      assert.ok(COCKPIT_RESERVED_TYPES.includes(t), `${t} 必须在保留表里`);
    }
    assert.strictEqual(usesReservedType({ type: 'slot:close' }), true);
    assert.strictEqual(usesReservedType({ type: 'render' }), false);
    const shell = readFileSync('src/features/cockpit/singlepage/shell.ts', 'utf8');
    assert.ok(
      shell.includes('COCKPIT_RESERVED_TYPES'),
      '驾驶舱的脚本必须从 protocol 注入保留类型表，不许自己再写一份字面量数组',
    );
    assert.ok(
      /var COCKPIT_TYPES = \$\{JSON\.stringify\(COCKPIT_RESERVED_TYPES\)\}/u.test(shell),
      '注入方式要能被如实读到（JSON.stringify 同一常量）',
    );
  });

  it('路由：开着的 Slot 接得住，关掉的 Slot 会被记进诊断（不静默丢弃）', () => {
    resetSlots();
    const seen: string[] = [];
    const sub = registerSlotHandler('deps', (m) => seen.push(String(m.type)));
    assert.deepStrictEqual(openSlotIds(), ['deps']);
    assert.strictEqual(routeSlotMessage('deps', { type: 'add' }), true);
    assert.deepStrictEqual(seen, ['add']);
    assert.strictEqual(routeSlotMessage('release', { type: 'go' }), false, '没人接住要如实返回 false');
    const diag = slotDiagnostics();
    assert.strictEqual(diag.droppedCount, 1);
    assert.deepStrictEqual(diag.lastDropped, { id: 'release', type: 'go' }, '诊断要能指出是谁没接住');
    sub.dispose();
    assert.deepStrictEqual(openSlotIds(), [], '撤销后不再是开着的');
    assert.strictEqual(routeSlotMessage('deps', { type: 'add' }), false, '撤销后不该再被路由');
    resetSlots();
  });

  it('一次只登记一个处理器（互斥折叠的结构前提）', () => {
    resetSlots();
    const first: string[] = [];
    const second: string[] = [];
    const a = registerSlotHandler('hud', (m) => first.push(String(m.type)));
    assert.strictEqual(routeSlotMessage('hud', { type: 'close' }), true);
    a.dispose();
    const b = registerSlotHandler('hud', (m) => second.push(String(m.type)));
    assert.strictEqual(routeSlotMessage('hud', { type: 'close' }), true);
    assert.deepStrictEqual(first, ['close']);
    assert.deepStrictEqual(second, ['close'], '旧处理器撤销后不该再收到消息');
    b.dispose();
    resetSlots();
  });
});
