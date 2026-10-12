/**
 * V3 · L5 / G4 门禁：**新库合同不许靠人记**。
 *
 * 合同原文 = 模板里 `.github/misc/Codegen-Starter.txt` 的 SECTION 7。本文件盯四件事：
 *   1. **逐条对账**：合同里每一条都在 `NEW_LIB_CHECKS` 里有一条、顺序一致、不多不少
 *      （模板加一条、代码少一条 → 红；这是"删掉一条 → 红"的门禁形式）；
 *   2. **判得了就判，判不了就说为什么**：每条要么有判据、要么有 `why`（`–` 必须说原因）；
 *   3. **夹具实测**：一个"照合同做完"的工程全过；动了手脚的工程那几条必须红；
 *   4. **不编造**：读不到的事实（没有 metadata / 没构建过）必须是 `–`，不许绿也不许红。
 */
import * as assert from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FIX_BY_ID,
  NEW_LIB_CHECKS,
  auditNewLib,
  ciInstalledPackages,
  fixOf,
  newLibAuditFact,
  type LibSnapshot,
} from '../core/newLibAudit';
import { collectLibSnapshot } from '../core/libSnapshot';

const CONTRACT = join('assets', 'template', '.github', 'misc', 'Codegen-Starter.txt');

/** 从合同文件里解析 SECTION 7 的条目（`[ ]` 行 + 续行拼回一条，空白规范化）。 */
function contractItems(text: string): string[] {
  const after = text.slice(text.indexOf('SECTION 7 —'));
  const before = after.slice(0, after.indexOf('END OF PROMPT'));
  const items: string[] = [];
  let cur: string[] | null = null;
  for (const raw of before.split(/\r?\n/u)) {
    const m = /^\s*\[ \]\s*(.*)$/u.exec(raw);
    if (m) {
      if (cur) {
        items.push(cur.join(' ').replace(/\s+/gu, ' ').trim());
      }
      cur = [m[1]];
      continue;
    }
    // 续行（缩进比 `[ ]` 更深、且不是新条目/小标题）
    if (cur && /^\s{4,}\S/u.test(raw) && !/^─/u.test(raw)) {
      cur.push(raw.trim());
    }
  }
  if (cur) {
    items.push(cur.join(' ').replace(/\s+/gu, ' ').trim());
  }
  return items;
}

const items = contractItems(readFileSync(CONTRACT, 'utf8'));

/** 一份"照合同做完"的工程快照（各条判定都应有明确结论）。 */
function goodSnapshot(): LibSnapshot {
  const guard = '// Conan::ImportStart\n// Conan::ImportEnd\n';
  return {
    paths: [
      'include/',
      'include/alpha.h',
      'src/',
      'src/alpha.c',
      'test_package/',
      'test_package/main.cpp',
      'test_package/test/unit/alpha.cpp',
      'test_package/test/stress/alpha_stress.cpp',
      'docs/doxygen/dox/mainpage.dox',
      'docs/doxygen/dox/demos/',
      'docs/doxygen/dox/demos/tutorial.dox',
      'docs/sphinx/locales/zh_CN/LC_MESSAGES/index.po',
      'docs/images/ALL_title_card.png',
      'README.md',
      'LICENSE',
      'NOTICE',
      '.github/misc/.releaserc.json',
      'api/python_bindings.cpp',
    ],
    files: {
      'include/alpha.h': `${guard}/** @exporter */\nint alpha(void);\n`,
      'src/alpha.c': `${guard}\n#include "alpha.h"\nint alpha(void) { return 1; }\n`,
      'test_package/main.cpp': '// BENCHMARK: alpha\nBENCHMARK_ALPHA();\n',
      'test_package/test/unit/alpha.cpp': '#include <alpha.h>\nTEST(Alpha, Works) {}\n',
      'docs/doxygen/dox/mainpage.dox': 'mylib — 一句话说明\n',
      'docs/doxygen/dox/demos/tutorial.dox': '@example\nalpha\n@include alpha.h\n',
      'docs/sphinx/locales/zh_CN/LC_MESSAGES/index.po': 'msgid "x"\nmsgstr "y"\n',
      'README.md': '# mylib\n\n快速开始…\n',
      LICENSE: 'Apache License\n',
      NOTICE: 'HeT-FTI\n',
      '.github/misc/.releaserc.json': '{\n  "branches": ["main"]\n}\n',
      'api/python_bindings.cpp': 'py::class_<Alpha>(m, "Alpha");\n',
    },
    metadata: {
      name: 'mylib',
      version: '0.1.0',
      team: 'HeT-FTI',
      license: 'Apache-2.0',
      build_cppstd: '17',
      build_cstd: '11',
      generate_modules_inplace: false,
      // 依赖是**按桶**存的（与真实 metadata.json 一致）：桶名不是包名
      dependencies: { common: { zlib: ['ZLIB::ZLIB'] } },
      doc_languages: ['en', 'zh_CN'],
      enable_python_bindings: true,
    } as LibSnapshot['metadata'],
    conandata: ['zlib/1.3.1'],
    ciInstalled: ['zlib'],
    templateLicense: 'Apache License\n',
    templateNotice: 'HeT-FTI\n',
    templateName: 'fcpp',
    buildOk: true,
  };
}

describe('L5 · 新库自检（G4：合同逐条可执行）', () => {
  it('**逐条对账**：模板 SECTION 7 的每一条都有对应检查，顺序一致、不多不少', () => {
    assert.ok(items.length >= 20, `合同条目解析看起来不对（${items.length} 条）`);
    assert.deepStrictEqual(
      NEW_LIB_CHECKS.map((c) => c.source),
      items,
      '合同的每一条都必须在 NEW_LIB_CHECKS 里、且顺序一致（模板改了合同 → 这里必须跟着改）',
    );
    const ids = NEW_LIB_CHECKS.map((c) => c.id);
    assert.strictEqual(new Set(ids).size, ids.length, '检查 id 不能重复');
  });

  it('**弄红自证**：删掉一条检查 / 合同多加一条 → 门禁红', () => {
    const dropped = NEW_LIB_CHECKS.slice(0, -1).map((c) => c.source);
    assert.notDeepStrictEqual(dropped, items, '少一条就该对不上');
    const extra = [...items, 'Something new the template added.'];
    assert.notDeepStrictEqual(
      NEW_LIB_CHECKS.map((c) => c.source),
      extra,
      '合同多一条而代码没跟上 → 必须红',
    );
  });

  it('判得了就判、判不了就说清为什么（`–` 不许含糊）', () => {
    for (const c of NEW_LIB_CHECKS) {
      if (c.evaluate) {
        assert.strictEqual(c.why, undefined, `${c.id}: 有判据就不该同时写 why`);
      } else {
        assert.ok((c.why ?? '').trim().length > 5, `${c.id}: 判不了必须写清为什么（"为什么判不了"）`);
      }
    }
    const manual = NEW_LIB_CHECKS.filter((c) => !c.evaluate).map((c) => c.id);
    assert.ok(manual.length <= 4, `要人判的条款不该变多（现在 ${manual.length} 条：${manual.join('、')}）`);
  });

  it('每条机器可判的红项都有"怎么补"（§19.2：红项必须有下一步）', () => {
    for (const c of NEW_LIB_CHECKS.filter((x) => x.evaluate)) {
      assert.ok((FIX_BY_ID[c.id] ?? '').length > 5, `${c.id}: 红项缺"怎么补"`);
    }
    for (const id of Object.keys(FIX_BY_ID)) {
      assert.ok(NEW_LIB_CHECKS.some((c) => c.id === id), `${id}: 补法指向了不存在的条款`);
    }
    assert.strictEqual(fixOf('不存在的条款', '兜底'), '兜底', '找不到补法也不许留空');
  });

  it('**夹具实测**：照合同做完的工程 → 机器可判的全过；动了手脚 → 那几条红', () => {
    const ok = auditNewLib(goodSnapshot());
    const bad = ok.filter((r) => r.ok === false);
    assert.deepStrictEqual(bad.map((r) => r.id), [], `不该有红项：${bad.map((r) => `${r.id}(${r.detail})`).join(' / ')}`);
    assert.strictEqual(newLibAuditFact(ok).state, 'warn', '还剩"要人判"的几条 → warn（不是假绿）');

    // 去掉头文件守卫 + 删掉同名单测 + LICENSE 被改 + 旧名残留 → 那四条红（README 仍写着本项目名）
    const mutated: LibSnapshot = {
      ...goodSnapshot(),
      files: {
        ...goodSnapshot().files,
        'include/alpha.h': '/** @exporter */\nint alpha(void);\n',
        LICENSE: 'Apache License（被我改过）\n',
        'README.md': '# mylib（改自 fcpp 模板）\n',
      },
    };
    // 删掉单测（paths 里去掉）
    mutated.paths = mutated.paths.filter((p) => p !== 'test_package/test/unit/alpha.cpp');
    const reds = auditNewLib(mutated)
      .filter((r) => r.ok === false)
      .map((r) => r.id)
      .sort();
    assert.deepStrictEqual(reds, ['include-guard', 'license-notice', 'no-old-name', 'unit-per-header']);

    const fact = newLibAuditFact(auditNewLib(mutated));
    assert.strictEqual(fact.state, 'fail');
    assert.match(fact.fact, /✗ 4/u);
    assert.match(fact.next ?? '', /^需要你执行：/u, '红项后面必须给下一步');
  });

  it('**不编造**：读不到的必须 `–`（说清读不到什么），既不许绿也不许红', () => {
    const empty = auditNewLib({ files: {}, paths: [] });
    for (const r of empty) {
      assert.notStrictEqual(r.ok, true, `${r.id}: 什么都没读到却给了绿`);
      assert.strictEqual(r.ok, undefined, `${r.id}: 没有事实时应为 –`);
    }
    assert.strictEqual(newLibAuditFact(empty).fact, `✓ 0 · – ${empty.length}`);

    // 没构建过 ≠ 构建失败
    const noBuild = auditNewLib({ ...goodSnapshot(), buildOk: undefined });
    const build = noBuild.find((r) => r.id === 'builds');
    assert.strictEqual(build?.ok, undefined);
    assert.match(build?.detail ?? '', /还没构建过/u);

    // 没开 pybind11 = 本项不适用（不是失败）
    const noPy = auditNewLib({
      ...goodSnapshot(),
      metadata: { ...goodSnapshot().metadata, enable_python_bindings: false } as LibSnapshot['metadata'],
    });
    const py = noPy.find((r) => r.id === 'pybind-bindings');
    assert.strictEqual(py?.ok, undefined);
    assert.match(py?.detail ?? '', /不适用/u);
  });

  it('CI 系统头映射（G6 的事实来源）：从 workflow 里读出装了哪些包', () => {
    const wf = readFileSync(join('assets', 'template', '.github', 'workflows', 'security-linters.yml'), 'utf8');
    const pkgs = ciInstalledPackages(wf);
    assert.ok(pkgs.includes('zlib') && pkgs.includes('pcre2') && pkgs.includes('eigen'), pkgs.join(','));
    assert.ok(pkgs.includes('etl'), 'header-only 的包由专门步骤装（startswith("etl/")）');
  });

  it('**采集器实测**（临时工程）：无扩展名的 LICENSE/NOTICE 也必须读进来', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'het-libsnap-'));
    try {
      writeFileSync(join(dir, 'metadata.json'), '{"name":"mylib"}\n');
      // 这两个文件**没有扩展名** —— 判定第 19 条要逐字比对它们
      writeFileSync(join(dir, 'LICENSE'), 'Apache License\n');
      writeFileSync(join(dir, 'NOTICE'), 'HeT-FTI\n');
      writeFileSync(join(dir, 'conandata.yml'), 'requirements:\n  - "zlib/1.3.1"\n');
      mkdirSync(join(dir, 'include'));
      writeFileSync(join(dir, 'include', 'alpha.h'), '// Conan::ImportStart\n// Conan::ImportEnd\n');

      const snap = await collectLibSnapshot(dir, {
        metadata: { name: 'mylib', team: 'HeT-FTI', license: 'Apache-2.0', build_cppstd: '17', build_cstd: '11' } as LibSnapshot['metadata'],
        templateLicense: 'Apache License\n',
        templateNotice: 'HeT-FTI\n',
        templateName: 'fcpp',
      });
      assert.notStrictEqual(snap.files['LICENSE'], undefined, 'LICENSE 没读进来 → 第 19 条会永远误报"被改过"');
      assert.notStrictEqual(snap.files['NOTICE'], undefined, 'NOTICE 同上（无扩展名）');
      assert.deepStrictEqual(snap.conandata, ['zlib/1.3.1']);
      assert.ok(snap.paths.includes('include/') && snap.paths.includes('include/alpha.h'), '目录要以 `/` 结尾');

      // 逐字比对真的会通过（不是"读不到 → 判被改过"）
      const lic = auditNewLib(snap).find((r) => r.id === 'license-notice');
      assert.strictEqual(lic?.ok, true, lic?.detail);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
