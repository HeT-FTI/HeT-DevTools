/**
 * **D 块门禁：输出收敛**（计划 §6-D / C4）。
 *
 * 用户的诉求只有一句：「你搞那么多分项 output 是刷存在感吗」——
 * 翻译成可机器检查的规矩就是四条：
 *   1. **通道只有一个**（`HeT DevTools`），且**只有一个创建点**（同名两条 = 用户看到"两个通道"）；
 *   2. **每行都带已知域标签**（域的区分回到行首，而不是靠"选频道"）；
 *   3. 页内视图的过滤是**纯函数**（域/级别/关键字），可单测、不依赖 UI；
 *   4. 页内视图不另造输出源：行来自同一个环形缓冲，且页面只有一段脚本（F.29）。
 */
import * as assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  LOG_DOMAINS,
  LOG_LEVELS,
  OUTPUT_CHANNEL_NAME,
  formatLogLine,
  outputChannelNames,
  parseLogLine,
  type LogEntry,
} from '../core/outputChannels';
import { OUTPUT_LOG_CAP, allEntries, appendLog, filterEntries, resetLog, tailEntries } from '../core/outputLog';
import { EMPTY_FILTER, outputViewHtml } from '../features/output/html';
import { outputViewPageHtml } from '../features/output/page';
import { SLOT_TITLES } from '../features/slots/titles';
import { intentFor } from '../core/intents';

const SRC = 'src';
function sourceFiles(): string[] {
  return (readdirSync(SRC, { recursive: true, encoding: 'utf8' }) as string[])
    .filter((f) => f.endsWith('.ts') && !f.includes('test'))
    .map((f) => join(SRC, f));
}

/**
 * 扫描前先剥注释：**注释里会提到旧通道名/旧写法**（说明“以前是什么、为什么改”），
 * 那不是违规。源码级扫描自伤是这套门禁的老坑（见 `support/htmlFacts.ts` 的同款处理）。
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');
}

describe('D-1 只允许一个 Output 通道', () => {
  it('通道名唯一，且来自同一个常量', () => {
    assert.deepStrictEqual(outputChannelNames(), [OUTPUT_CHANNEL_NAME]);
    assert.strictEqual(OUTPUT_CHANNEL_NAME, 'HeT DevTools');
  });

  it('创建点唯一（同名两条通道 = 用户看到"两个 HeT DevTools"）', () => {
    const owners = sourceFiles().filter((f) => readFileSync(f, 'utf8').includes('createOutputChannel('));
    assert.deepStrictEqual(
      owners.map((f) => relative('.', f)),
      [join('src', 'constants.ts')],
      '`createOutputChannel` 只允许出现在 constants.ts（懒建单例）',
    );
  });

  it('写通道只有三个入口（`log` / `logBlock` / `logStream`）—— 裸写 `channel.append*` 一律禁止', () => {
    // 为什么：D 块只扫了 `log(` 调用点，于是 `extension.ts` 里留下了 35 处直接
    // `channel?.appendLine(...)` —— 它们**绕过结构化行、也绕过环形缓冲**，
    // 后果是页内「输出」视图少一段、按域过滤看不到。裸写多了就是"两套写法"，
    // 这正是 D 块想根治的事。
    // 两个例外，各有硬理由：
    //   · `constants.ts` 是唯一的写入口本身；
    //   · `core/busy.ts` 拿的是**注入的** BusyHost 通道（纯逻辑层不许 import vscode），
    //     它用 `formatLogLine` 写行 + 同时进环形缓冲 —— 断言这一点，免得例外变成后门。
    const allowed = [join('src', 'constants.ts'), join('src', 'core', 'busy.ts')];
    const bad: string[] = [];
    for (const f of sourceFiles()) {
      if (allowed.some((a) => f.endsWith(a))) {
        continue;
      }
      const text = stripComments(readFileSync(f, 'utf8'));
      for (const m of text.matchAll(/\bchannel\??\.append(Line)?\(/gu)) {
        bad.push(`${relative('.', f)}: ${m[0]}`);
      }
    }
    assert.deepStrictEqual(
      bad,
      [],
      `这些地方绕过了唯一写入口（请改用 log(domain,…) / logBlock(…, 标签, 文本) / logStream(原始流)）：\n${bad.join('\n')}`,
    );
    // 入口本身必须真的存在（否则是把检查架空）
    const constants = readFileSync(join('src', 'constants.ts'), 'utf8');
    for (const fn of ['export function log(', 'export function logBlock(', 'export function logStream(']) {
      assert.ok(constants.includes(fn), `constants.ts 必须提供 ${fn}）`);
    }
    // 例外也要继续成立：busy.ts 必须用**共享的**行格式写注入通道
    const busy = readFileSync(join('src', 'core', 'busy.ts'), 'utf8');
    assert.ok(
      busy.includes('formatLogLine(entry)') && busy.includes('outputLog.append(entry)'),
      'core/busy.ts 的例外理由变了（它必须既用共享格式器、又进环形缓冲）—— 要么恢复这两件事，要么把它从白名单里删掉',
    );
  });

  it('不再有逐域通道名（`HeT DevTools · 构建` 这类写法）', () => {
    const bad: string[] = [];
    for (const f of sourceFiles()) {
      const text = stripComments(readFileSync(f, 'utf8'));
      for (const m of text.matchAll(/['"`]HeT DevTools · [^'"`]+['"`]/gu)) {
        bad.push(`${relative('.', f)}: ${m[0]}`);
      }
    }
    assert.deepStrictEqual(bad, [], `这些地方还在按域分通道（D 块已收敛成一个）：\n${bad.join('\n')}`);
  });
});

describe('D-2 每行都带已知域标签', () => {
  it('format ↔ parse 往返一致（行格式只有一个来源）', () => {
    for (const domain of LOG_DOMAINS) {
      for (const level of LOG_LEVELS) {
        const entry: LogEntry = { at: new Date('2026-09-22T10:31:02').getTime(), domain, level, text: '示例文本' };
        const line = formatLogLine(entry);
        const back = parseLogLine(line);
        assert.ok(back, `解析失败：${line}`);
        assert.strictEqual(back!.domain, domain);
        assert.strictEqual(back!.level, level);
        assert.strictEqual(back!.text, '示例文本');
      }
    }
  });

  it('没有域标签的老式行解析为 null（门禁才能发现"裸行"）', () => {
    assert.strictEqual(parseLogLine('[10:31:02] 构建并测试'), null);
    assert.strictEqual(parseLogLine('构建并测试'), null);
    assert.strictEqual(parseLogLine('[10:31:02] [nope] · x'), null, '未知域要判无效（否则"写错域"没人发现）');
  });

  it('所有 `log(` 调用都给了已知域（源码级扫描）', () => {
    const bad: string[] = [];
    for (const f of sourceFiles()) {
      const text = stripComments(readFileSync(f, 'utf8'));
      // 跳过**声明**（`function log(domain: LogDomain, …)`），只查调用点
      const withoutDecl = text.replace(/function log\([^)]*\)[^{]*\{/gsu, 'function log() {');
      for (const m of withoutDecl.matchAll(/(?<![\w.])log\(([^)\n]*)/gu)) {
        const arg = m[1].trim();
        if (arg.startsWith(')') || arg === '') {
          continue;
        }
        const domain = arg.replace(/^['"]/, '').split(/['"]/u)[0];
        if (!(LOG_DOMAINS as readonly string[]).includes(domain)) {
          bad.push(`${relative('.', f)}: log('${domain}', …) —— 未登记的域`);
        }
      }
    }
    assert.deepStrictEqual(bad, [], `这些日志行没有（或用了未知的）域标签：\n${bad.join('\n')}`);
  });
});

describe('D-3 页内过滤是纯函数', () => {
  const sample: LogEntry[] = [
    { at: 1, domain: 'build', level: 'step', text: '编译打包' },
    { at: 2, domain: 'build', level: 'fail', text: 'conan create 失败：缺 gtest' },
    { at: 3, domain: 'docs', level: 'ok', text: '编译文档完成' },
    { at: 4, domain: 'env', level: 'info', text: '缓存 12.4 GB' },
  ];

  it('按域 / 级别 / 关键字（大小写不敏感）过滤', () => {
    assert.deepStrictEqual(filterEntries(sample, { domains: ['build'] }).map((e) => e.at), [1, 2]);
    assert.deepStrictEqual(filterEntries(sample, { levels: ['fail'] }).map((e) => e.at), [2]);
    assert.deepStrictEqual(filterEntries(sample, { keyword: 'GTEST' }).map((e) => e.at), [2], '关键字大小写不敏感');
    assert.deepStrictEqual(
      filterEntries(sample, { domains: ['build'], levels: ['fail'], keyword: 'conan' }).map((e) => e.at),
      [2],
      '三个条件是**与**关系',
    );
    assert.strictEqual(filterEntries(sample, {}).length, 4, '空条件 = 全部');
    assert.strictEqual(filterEntries(sample, { keyword: '   ' }).length, 4, '空白关键字等于不过滤');
  });

  it('环形缓冲有界（长构建不会把内存吃穿），且只留尾部', () => {
    resetLog();
    for (let i = 0; i < OUTPUT_LOG_CAP + 40; i += 1) {
      appendLog({ at: i, domain: 'build', level: 'info', text: `L${i}` });
    }
    assert.strictEqual(allEntries().length, OUTPUT_LOG_CAP);
    assert.strictEqual(allEntries()[0].text, 'L40', '砍掉的是最老的');
    assert.deepStrictEqual(tailEntries({}, 3).map((e) => e.text), ['L537', 'L538', 'L539']);
    resetLog();
  });
});

describe('D-4 页内「输出」视图：同一份数据 + 一段脚本', () => {
  const rows: LogEntry[] = [
    { at: Date.now(), domain: 'build', level: 'fail', text: 'conan create 失败' },
    { at: Date.now(), domain: 'docs', level: 'ok', text: '文档完成' },
  ];

  it('视图渲染出三个过滤控件 + 计数 + 行（无行时给明确文案）', () => {
    const html = outputViewHtml(rows, EMPTY_FILTER);
    assert.ok(html.includes('data-out="domain"'), '域过滤');
    assert.ok(html.includes('data-out="level"'), '级别过滤');
    assert.ok(html.includes('data-out="keyword"'), '关键字过滤');
    assert.ok(html.includes('data-out-count'), '要有计数（用户得知道筛掉了多少）');
    assert.ok(html.includes('conan create 失败'), '行文本要在');
    assert.ok(html.includes('构建验证'), '域用 §5.1 的定稿名显示，不是裸英文');
    const empty = outputViewHtml([], EMPTY_FILTER);
    assert.ok(empty.includes('没有匹配的行'), '空结果要给明确文案（不是白屏）');
  });

  it('页面只有一段脚本（F.29：一个文档只能取一次 API）', () => {
    const page = outputViewPageHtml(rows, EMPTY_FILTER);
    // 数 `</script>`（pageShell 的脚本注释里提到了 `<script>`，数开始标签会自伤）
    assert.strictEqual((page.match(/<\/script>/gu) ?? []).length, 2, 'pageShell 一段 + 页面体一段');
    // pageShell 自己取一次（唯一允许的一次）；我的页面体**不许**再取。
    // 注意先剥 `//` 注释行：pageShell 的注释里也提到过 acquireVsCodeApi()（自伤老坑）。
    const stripped = page.replace(/^\s*\/\/.*$/gmu, '');
    assert.strictEqual(
      (stripped.match(/acquireVsCodeApi\(\)/gu) ?? []).length,
      1,
      '只能有一次 API 获取（pageShell）',
    );
    assert.ok(page.includes('send(currentFilter())'), '控件变化要上报');
    assert.ok(page.includes("send({ type: 'output:reveal' })"), '“在输出面板里打开”要走消息');
  });

  it('Slot 标题与入口命令都登记好了（否则视图打不开）', () => {
    assert.strictEqual(SLOT_TITLES.output, `输出：${OUTPUT_CHANNEL_NAME}`);
    const it = intentFor('openOutput');
    assert.ok(it, 'openOutput 必须是登记过的 Intent');
    assert.strictEqual(it!.slot, 'output');
    assert.strictEqual(it!.command, 'het.openOutput');
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      contributes: { commands: { command: string }[] };
    };
    assert.ok(
      pkg.contributes.commands.some((c) => c.command === 'het.openOutput'),
      '命令要在 package.json 里声明',
    );
  });
});
