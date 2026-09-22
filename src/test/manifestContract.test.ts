import * as assert from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { stripCommentsCode } from './support/htmlFacts';

/**
 * **manifest ↔ 代码 的对账门禁**（§F.47）。
 *
 * 这是"页面发出去没人接"的**同一个错误在清单层的翻版**：
 *   · `package.json` 声明了命令、代码里没 `registerCommand` → 命令面板里点了没反应；
 *   · 代码注册了命令、清单里没声明 → 命令面板搜不到、快捷键也绑不上；
 *   · 标题写成 `%cmd.x%` 但 nls 里没有 → 界面上直接显示 `%cmd.x%`（用户看不懂）；
 *   · keybinding 指向没声明的命令 → 按键静默失效。
 *
 * 四种情况都机器可查，且都能在开发期红 —— 不该等实测反馈来发现。
 */

interface Manifest {
  contributes: {
    commands: { command: string; title: string }[];
    keybindings?: { command: string; key: string; when?: string; title?: string }[];
    menus?: Record<string, { command: string; when?: string }[]>;
  };
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as Manifest;
const declared = new Set(pkg.contributes.commands.map((c) => c.command));

/**
 * 剥注释用**共享的字符串感知**实现（`support/htmlFacts`）。
 * 踩过的坑：产品代码里有 conan 包模式 `fmt/*:*`，旧的非字符串感知实现会把它当块注释开始，
 * 把后面整段代码吃掉 —— 门禁因此漏检过 7 个命令。
 */
const strip = (t: string): string => stripCommentsCode(t);

// 自证：字符串里的 `/*` 不许影响后续扫描
{
  const probe = strip("const pat = 'fmt/<版本>:*';\nregisterCommand('het.probe', () => 1);");
  if (!probe.includes("'het.probe'")) {
    throw new Error('stripComments 把字符串里的 `/*` 当成了注释 → 门禁会漏检');
  }
}

/** src 下的非测试源码（扩展本体）。 */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) {
        walk(p);
      } else if (n.endsWith('.ts') && !p.includes(`${sep}test${sep}`)) {
        out.push(p);
      }
    }
  };
  walk(join('src'));
  return out;
}

const SOURCES = sourceFiles();
const ALL_SOURCE_TEXT = SOURCES.map((f) => strip(readFileSync(f, 'utf8'))).join('\n');

/** 代码里字面量注册的命令。 */
function literalRegistrations(): Set<string> {
  return new Set(
    [...ALL_SOURCE_TEXT.matchAll(/registerCommand\(\s*'([^']+)'/gu)].map((m) => m[1]),
  );
}

/**
 * **表驱动注册**：命令 id 由数据生成。
 *
 * 这类注册没法用字面量正则找出来，所以在这里显式登记"生成器"，并断言生成出来的
 * 每一条命令都在清单里声明（等于把这个特例纳回门禁，而不是放它一马）。
 *
 * E 块把 HUD 页签并入悬停档后，唯一一个生成器（HUD 的 1–9/Esc）随之删除 ——
 * 现在没有生成器了，但**机制留着**：下次再有表驱动注册，必须回到这里登记。
 */
const GENERATED_REGISTRATIONS: Array<{ why: string; commands: () => string[] }> = [];

/**
 * **内部命令**：注册了但**有意不声明**（自动化 / 集成测试入口，不该出现在命令面板）。
 * 每条都要写清"谁在用"，且名单自我清理：一旦它被声明，就必须从这里删掉。
 */
const INTERNAL_COMMANDS: Readonly<Record<string, string>> = {
  'het.getActivationLine': '集成测试读激活耗时（src/test/integration）',
  'het.getCurrentProject': '集成测试读当前项目根',
  'het.hasProject': '集成测试判断是否已识别项目',
  'het.getCockpitState': '集成测试/安装后校验读驾驶舱状态',
  'het.getCockpitView': 'c6/安装后校验读单页视图状态（深链定位到哪一段、该段可见吗）',
  'het.getChipState': '集成测试读 chip 状态',
  'het.getSlotState': 'c8 集成测试读"当前页内 Slot + 页签数"（页签恒为 1 的运行时证据）',
  'het.getTasks': 'B 块集成测试/现场排查读任务状态（在跑什么、最近成不成、能否取消）',
  'het.getUiSnapshot': 'H 块一致性会话（c9）一次取齐"任务 × 输出 × 前端"三面（也便于现场排查）',
  'het.getOutputLines': 'H 块一致性会话读唯一通道的尾部若干行（与 Output 面板逐字一致）',
  'het.testRunTask': 'H 块一致性会话的长动作注入体（只在测试宿主 + HET_TASK_INJECT=1 时生效）',
  'het.getTaskCenter': 'J 块读任务中心的**模型**（面板渲染的就是它；会话据此断言面板与事实一致）',
  'het.getCacheReport': 'K.1 集成测试/现场排查读缓存报表（分区与按架构体积）',
  'het.getBuildMatrix': 'K.1 集成测试读目标矩阵（证明目标只来自 .hetai/build-matrix.yml）',
  'het.getConanRuntime': '安装后校验读 conan 运行时',
  'het.getEnvRows': '集成测试读环境行',
  'het.envGc': '托管环境 GC（README/CHANGELOG 里说明的内部动作）',
  'het.getLastDocsOutput': '集成测试读最近一次文档输出',
  'het.newProjectDirect': '集成脚本 c4/c7 的"直接建项目"通道（跳过表单）',
  'het.getBuildOk': '集成测试读构建结论',
  'het.getLastBuildError': '集成测试读构建错误',
  'het.getTestSummary': '集成测试读测试汇总',
  'het.getLastConanOutput': '集成测试读 conan 输出尾部',
};

describe('§F.47 manifest ↔ 代码 对账（命令 / 快捷键 / nls）', () => {
  it('声明了的命令，必须真的注册（否则"点了没反应"，且只有用户能发现）', () => {
    const registered = new Set([...literalRegistrations(), ...GENERATED_REGISTRATIONS.flatMap((g) => g.commands())]);
    const missing = [...declared].filter((c) => !registered.has(c));
    assert.deepStrictEqual(missing, [], `这些命令在 package.json 里声明了但代码里没注册：\n${missing.join('\n')}`);
    // 生成器不能退化成空壳（否则等于把上面的检查架空）
    for (const g of GENERATED_REGISTRATIONS) {
      assert.ok(g.commands().length > 0, `生成器没产出命令：${g.why}`);
      assert.ok(g.why.length > 5, '生成器要写清为什么不能用字面量找');
    }
  });

  it('注册了的命令，要么声明、要么在内部名单里写清理由（名单自我清理）', () => {
    const registered = literalRegistrations();
    const undeclared = [...registered].filter((c) => !declared.has(c));
    const unexplained = undeclared.filter((c) => INTERNAL_COMMANDS[c] === undefined);
    assert.deepStrictEqual(
      unexplained,
      [],
      `这些命令注册了但没声明、也没在内部名单里说明：\n${unexplained.join('\n')}`,
    );
    assert.deepStrictEqual(
      Object.keys(INTERNAL_COMMANDS).filter((c) => declared.has(c)),
      [],
      '内部名单里的命令已经声明了 → 请把它从名单删掉（名单必须与事实一致）',
    );
    // 内部命令必须看着就像内部（统一前缀），别和用户可见命令混成一个样子。
    // `testRun` 是 H 块加的注入入口：它**不能**叫 `het.test*`（会和用户可见的
    // `het.testgen` 看着像一家），也不能叫 `get*`（它确实会起一个任务）。
    // 而且未声明的命令根本不会出现在命令面板里 —— 用户永远搜不到它。
    const INTERNAL_PREFIXES = ['get', 'has', 'env', 'new', 'testRun'] as const;
    for (const c of Object.keys(INTERNAL_COMMANDS)) {
      assert.ok(
        INTERNAL_PREFIXES.some((p) => c.startsWith(`het.${p}`)),
        `${c} 命名看不出是内部命令（内部命令要用 ${INTERNAL_PREFIXES.join('/')} 这类前缀，避免和用户命令混淆）`,
      );
    }
  });

  it('菜单与快捷键指向的命令必须已声明（否则入口静默失效）', () => {
    const fromMenus = Object.entries(pkg.contributes.menus ?? {}).flatMap(([where, items]) =>
      items.filter((m) => !declared.has(m.command)).map((m) => `${where} → ${m.command}`),
    );
    assert.deepStrictEqual(fromMenus, [], `菜单挂到了没声明的命令上：\n${fromMenus.join('\n')}`);
    const fromKeys = (pkg.contributes.keybindings ?? [])
      .filter((k) => !k.command.startsWith('workbench.') && !declared.has(k.command))
      .map((k) => `${k.key} → ${k.command}`);
    assert.deepStrictEqual(fromKeys, [], `快捷键绑到了没声明的命令上：\n${fromKeys.join('\n')}`);
  });

  it('`%nls.key%` 两个语言都齐（缺了界面上就显示原始 `%key%`）', () => {
    const en = JSON.parse(readFileSync('package.nls.json', 'utf8')) as Record<string, string>;
    const zh = JSON.parse(readFileSync('package.nls.zh-cn.json', 'utf8')) as Record<string, string>;
    const raw = readFileSync('package.json', 'utf8');
    const keys = new Set([...raw.matchAll(/"%([\w.]+)%"/gu)].map((m) => m[1]));
    assert.ok(keys.size >= 40, `nls key 太少（${keys.size}）—— 提取失效？`);
    assert.deepStrictEqual([...keys].filter((k) => !(k in en)), [], '英文 nls 缺 key');
    assert.deepStrictEqual([...keys].filter((k) => !(k in zh)), [], '中文 nls 缺 key');
    // 反过来：nls 里的死条目也算漂移（改文案时漏删）
    assert.deepStrictEqual(
      Object.keys(en).filter((k) => !keys.has(k)),
      [],
      'package.nls.json 里有没人用的条目（请删掉或接上）',
    );
    assert.deepStrictEqual(
      Object.keys(zh).filter((k) => !(k in en)),
      [],
      '中文 nls 里有英文没有的 key（两份要对齐）',
    );
  });

  it('命令标题要么国际化、要么是可直接显示的中文（不许留裸 key）', () => {
    for (const c of pkg.contributes.commands) {
      const t = c.title;
      assert.ok(
        /^%[\w.]+%$/u.test(t) || /[\u4e00-\u9fa5]/u.test(t),
        `${c.command} 的标题既不是 %nls.key% 也不是可读中文：${t}`,
      );
    }
  });
});
