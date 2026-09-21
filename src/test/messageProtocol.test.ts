import * as assert from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

/**
 * **跨层消息协议门禁**（§F.46）：页面"发出去的"与宿主"接住的"必须一一对上。
 *
 * 为什么要这么一条：
 *   我们以前的低级错误全都是同一类 —— **两边的名字/形状不匹配**，而每一侧的单测都绿：
 *   · 页面 `send({ type: 'render' })`，宿主只在 `message.type === 'refresh'` 里处理 → 点了没反应；
 *   · 宿主回 `postMessage({ type: 'update', html })`，页面监听 `m.type !== 'health'` → 界面永不刷新；
 *   · 宿主算好 `{ listHtml }`，页面取 `m.html` → 局部刷新永远是空的。
 *
 * 所以这条门禁不看"某个函数对不对"，而是把**两侧的字符串**抓出来对账：
 *   ① 页面发出的每个 `type` 必须出现在宿主的分支里；
 *   ② 宿主回发的每个 `type` 必须被页面监听；
 *   ③ 宿主回发的**字段名**必须真的被页面读（`m.x` / `m["x"]`）。
 *
 * 覆盖范围自动发现：任何带 `onDidReceiveMessage(` 的宿主文件 + 同目录/一层子目录里的
 * 页面文件（`shell.ts` / `*Html.ts` / `html.ts` / `hudModel.ts` …）。新面板一落地就自动纳入。
 */

const SRC = join('src');
const read = (p: string): string => readFileSync(p, 'utf8');
const strip = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');

/** 递归收集 src 下的 `.ts`（含测试 —— 测试里也会写协议字面量）。 */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walk(p, out);
    } else if (name.endsWith('.ts')) {
      out.push(p);
    }
  }
  return out;
}

const ALL = walk(SRC);

/** 宿主文件：自己接消息的（panel / 控制器 / host）。 */
function hostFiles(): string[] {
  return ALL.filter((f) => strip(read(f)).includes('onDidReceiveMessage('));
}

/** 页面文件：和宿主同目录，或宿主目录的**一层子目录**（驾驶舱：controller.ts ↔ singlepage/*）。 */
function pageFiles(host: string): string[] {
  const dir = host.slice(0, host.lastIndexOf(sep));
  const nested = readdirSync(dir)
    .map((n) => join(dir, n))
    .filter((p) => statSync(p).isDirectory())
    .flatMap((d) => walk(d));
  // **含宿主自己**：preflight / deps / testgen / health 把页面脚本内嵌在 panel.ts 里，
  // 排除宿主就会把它们的 emit / listen / 字段读取全看漏（这门禁第一次跑就是这样误报的）。
  return [
    host,
    ...ALL.filter((f) => f.startsWith(dir + sep) && !nested.includes(f)),
    ...nested,
  ].filter((f) => !f.includes(`${sep}test${sep}`));
}

/** 页面 → 宿主：`send({ type: 'x' })` / `postMessage({ type: 'x' })` / `post({…})`。 */
function emittedTypes(pageSrc: string): string[] {
  const text = strip(pageSrc);
  const out = new Set<string>();
  // 只认**页面侧**的发送：`send(...)` / `post(...)` / `vscode.postMessage(...)`；
  // `panel.webview.postMessage(...)` 是宿主→页面，不能算页面发出（否则会互相冤枉）。
  for (const m of text.matchAll(/(?<!webview\.)\b(?:send|post|vscode\.postMessage)\(\s*\{\s*type:\s*'([\w:-]+)'/gu)) {
    out.add(m[1]);
  }
  return [...out];
}

/** 宿主接住：`message.type === 'x'` / `m.type === 'x'` / `ev.data.type === 'x'`。 */
function acceptedTypes(hostSrc: string): string[] {
  const text = strip(hostSrc);
  const out = new Set<string>();
  for (const m of text.matchAll(/\.type\s*===\s*'([\w:-]+)'/gu)) {
    out.add(m[1]);
  }
  return [...out];
}

/** 宿主 → 页面：`postMessage({ type: 'x', … })`。 */
function postedTypes(hostSrc: string): string[] {
  const text = strip(hostSrc);
  const out = new Set<string>();
  for (const m of text.matchAll(/\.postMessage\(\s*\{\s*type:\s*'([\w:-]+)'/gu)) {
    out.add(m[1]);
  }
  return [...out];
}

/** 页面监听：`m.type !== 'x'` / `m.type === 'x'` / `ev.data.type === 'x'`。 */
function listenedTypes(pageSrc: string): string[] {
  const text = strip(pageSrc);
  const out = new Set<string>();
  for (const m of text.matchAll(/\.type\s*[!=]==\s*'([\w:-]+)'/gu)) {
    out.add(m[1]);
  }
  return [...out];
}

/** 宿主回发时带的字段名（只取 `{ type: 'x', a, b: … }` 这一层的字面量字段）。 */
function postedFields(hostSrc: string): string[] {
  const text = strip(hostSrc);
  const out = new Set<string>();
  for (const m of text.matchAll(/\.postMessage\(\s*\{([^}]*)\}/gu)) {
    for (const f of m[1].matchAll(/(?:^|,)\s*([A-Za-z_]\w*)\s*[:,]/gu)) {
      if (f[1] !== 'type') {
        out.add(f[1]);
      }
    }
  }
  return [...out];
}

/** 页面读消息字段：`m.a` / `m['a']` / `m["a"]`。 */
function readFields(pageSrc: string): string[] {
  const text = strip(pageSrc);
  const out = new Set<string>();
  for (const m of text.matchAll(/\bm\.([A-Za-z_]\w*)/gu)) {
    out.add(m[1]);
  }
  for (const m of text.matchAll(/\bm\[['"]([A-Za-z_]\w*)['"]\]/gu)) {
    out.add(m[1]);
  }
  return [...out];
}

/** 页面里"动态发出去"的地方（`send({ type: btn.getAttribute(…) })`）—— 由 F.31 门禁兜。 */
function hasDynamicEmit(pageSrc: string): boolean {
  // 注意：`type:` 后面允许有空格，所以"非引号"要写成"第一个非空白字符是标识符/表达式"，
  // 否则 `send({ type: 'commit' })` 里的那个空格会被当成动态取值（第一次跑就是这样误报的）。
  return /(?<!webview\.)\b(?:send|post)\(\s*\{\s*type:\s*[A-Za-z_$]/u.test(strip(pageSrc));
}

describe('§F.46 跨层消息协议：页面发出去的 = 宿主接住的（自动发现全部面板）', () => {
  const hosts = hostFiles();

  it('发现得到宿主文件（数量不许退化 —— 否则这条门禁会"绿得没意义"）', () => {
    assert.ok(hosts.length >= 15, `宿主文件太少（${hosts.length}）：发现逻辑坏了？`);
    assert.ok(hosts.some((f) => f.includes(join('cockpit', 'controller.ts'))), '驾驶舱控制器要在里面');
    assert.ok(hosts.some((f) => f.includes(join('deps', 'panel.ts'))), '依赖面板要在里面');
  });

  it('① 每个面板：页面发出的 type 都有宿主分支（缺一个就是"点了没反应"）', () => {
    const bad: string[] = [];
    for (const host of hosts) {
      const pages = pageFiles(host);
      const accepted = new Set(acceptedTypes(read(host)));
      for (const page of pages) {
        for (const t of emittedTypes(read(page))) {
          if (!accepted.has(t)) {
            bad.push(`${host} 没处理来自 ${page} 的「${t}」`);
          }
        }
      }
    }
    assert.deepStrictEqual(bad, [], `这些消息发出去没人接：\n${bad.join('\n')}`);
  });

  /**
   * 已知豁免：**逐个写清理由**，且名单必须自我清理（页面补上监听之后这里就得删）。
   * 注意不能用"字符串在页面出现过"当兜底 —— 宿主自己也可能是页面（内嵌脚本），
   * 那样这条检查会被自己的回发字符串骗过去（第一次写就是这么假的）。
   */
  const LISTEN_EXEMPT: Readonly<Record<string, string>> = {};

  it('② 每个面板：宿主回发的 type 都有页面监听（缺一个就是"刷新不生效"）', () => {
    const bad: string[] = [];
    const used: string[] = [];
    for (const host of hosts) {
      const pages = pageFiles(host);
      const listened = new Set(pages.flatMap((p) => listenedTypes(read(p))));
      for (const t of postedTypes(read(host))) {
        const exempt = LISTEN_EXEMPT[`${host}#${t}`];
        if (exempt) {
          used.push(`${host}#${t}`);
          continue;
        }
        if (!listened.has(t)) {
          bad.push(`${host} 回发「${t}」，但页面里没有 \`m.type === '${t}'\` 这样的监听`);
        }
      }
    }
    assert.deepStrictEqual(bad, [], `这些回发没人听：\n${bad.join('\n')}`);
    // 名单自清理：页面已经监听了的，就不许继续挂在豁免里
    assert.deepStrictEqual(
      Object.keys(LISTEN_EXEMPT).filter((k) => !used.includes(k)),
      [],
      '豁免名单里有"其实已经接住了"的条目 —— 请删掉',
    );
  });

  it('③ 宿主回发的字段名必须真的被页面读（否则局部刷新永远是空的）', () => {
    const bad: string[] = [];
    for (const host of hosts) {
      const pages = pageFiles(host);
      const readSet = new Set(pages.flatMap((p) => readFields(read(p))));
      for (const f of postedFields(read(host))) {
        // 只校验"回发给页面的那层"字段：调用方自己记账的字段（如 type/command）不在其中
        if (!readSet.has(f) && !pages.some((p) => strip(read(p)).includes(`.${f}`))) {
          bad.push(`${host} 回发字段「${f}」，页面从不读它`);
        }
      }
    }
    assert.deepStrictEqual(bad, [], `这些回发字段没人读（字段名写错，或页面根本没接）：\n${bad.join('\n')}`);
  });

  it('提取本身要有覆盖率（否则这条门禁会"绿得没意义"）', () => {
    const emits = new Set<string>();
    const accepts = new Set<string>();
    const posts = new Set<string>();
    const listens = new Set<string>();
    const fields = new Set<string>();
    for (const host of hosts) {
      const pages = pageFiles(host);
      const hostSrc = read(host);
      acceptedTypes(hostSrc).forEach((t) => accepts.add(t));
      postedTypes(hostSrc).forEach((t) => posts.add(t));
      postedFields(hostSrc).forEach((f) => fields.add(f));
      for (const p of pages) {
        const src = read(p);
        emittedTypes(src).forEach((t) => emits.add(t));
        listenedTypes(src).forEach((t) => listens.add(t));
      }
    }
    // 四个方向都要提取得出来，否则"全都匹配"是假的（正则一失效就会静默变绿）
    assert.ok(emits.size >= 15, `页面发出（emit）提取太少（${emits.size}）`);
    assert.ok(accepts.size >= 15, `宿主接住（accept）提取太少（${accepts.size}）`);
    assert.ok(posts.size >= 4, `宿主回发（post）提取太少（${posts.size}）`);
    assert.ok(listens.size >= 6, `页面监听（listen）提取太少（${listens.size}）`);
    assert.ok(fields.size >= 4, `回发字段提取太少（${fields.size}）`);
    for (const t of ['refresh', 'action', 'copilot', 'remove', 'add']) {
      assert.ok(emits.has(t), `页面发出的消息里应当有「${t}」（提取漏了？）`);
      assert.ok(accepts.has(t), `宿主分支里应当有「${t}」`);
    }
    for (const t of ['l1', 'section', 'busy', 'render']) {
      assert.ok(posts.has(t), `宿主回发的消息里应当有「${t}」`);
      assert.ok(listens.has(t), `页面监听的类型里应当有「${t}」`);
    }
  });

  it('动态 emit 必须被 F.31 可达性门禁覆盖（这里只确认它存在且没被漏掉）', () => {
    const dynamic = ALL.filter((f) => !f.includes(`${sep}test${sep}`) && hasDynamicEmit(read(f)));
    assert.ok(dynamic.length >= 1, '至少驾驶舱是动态 emit（否则这条检查没意义）');
    for (const f of dynamic) {
      // 动态 emit 的取值必须来自页面上的 `data-*` 属性（由 F.31 可达性门禁负责覆盖率）
      const src = strip(read(f));
      const origin = /data-(action|act|cmd|section|field)/u.exec(src)?.[0];
      assert.ok(origin, `${f} 用动态 type 发消息，但页面里没有任何 data-* 取值来源 —— 无从校验`);
    }
  });
});
