/**
 * L1 产物能力事实门禁（V3 计划 §5.2 / §7.1）。
 *
 * 铁律：**只从真实字段推**、**未知 ≠ 没有**、**每条能力必须能推出一个动作**。
 */
import * as assert from 'assert';
import {
  CAPABILITY_LABELS,
  CAPABILITY_ORDER,
  capabilitySummary,
  deriveCapabilities,
  type CapabilityId,
} from '../core/capability';
import type { FcppMetadata } from '../types';

function meta(patch: Partial<FcppMetadata>): FcppMetadata {
  return { name: 'mylib', ...patch };
}

function ids(input: Parameters<typeof deriveCapabilities>[0]): CapabilityId[] {
  return (deriveCapabilities(input) ?? []).map((c) => c.id);
}

describe('L1 · 产物能力事实（capability）', () => {
  it('没有 metadata = **未知**（undefined），不是"没有能力"', () => {
    assert.strictEqual(deriveCapabilities({}), undefined, '读不到 metadata 必须返回 undefined');
    assert.strictEqual(capabilitySummary(undefined), '', '未知时不显示能力行');
    // 对照：给了 metadata（哪怕是空对象）= 已知，返回数组
    assert.deepStrictEqual(deriveCapabilities({ metadata: meta({}) }), []);
  });

  it('只从真实字段推导（每个字段单独可证）', () => {
    assert.deepStrictEqual(ids({ metadata: meta({ is_shared: true }) }), ['shared-abi']);
    assert.deepStrictEqual(ids({ metadata: meta({ is_header: true }) }), ['header-only']);
    assert.deepStrictEqual(ids({ metadata: meta({ enable_python_bindings: true }) }), ['python-bindings']);
    assert.deepStrictEqual(ids({ metadata: meta({ activate_code_coverage: true }) }), ['coverage']);
    assert.deepStrictEqual(ids({ metadata: meta({ baremetal_white_list: ['etl', 'ArduinoJson'] }) }), ['baremetal']);
    assert.deepStrictEqual(ids({ metadata: meta({}), hasCHeader: true }), ['c-abi']);
    // V3 · L6e（真机截图抓到的）：**仅头文件产物不出「C 接口」** —— 那条能力推出的动作是
    // "符号/ABI 回归"，而纯头文件库没有产物可读（给它的只会是一张点了就失败的卡）。
    assert.deepStrictEqual(
      ids({ metadata: meta({ is_header: true }), hasCHeader: true }),
      ['header-only'],
      '仅头文件 + include/*.h → 只有 header-only（反向隐藏 ABI 类检查）',
    );
    assert.deepStrictEqual(ids({ metadata: meta({}), hasBenchmark: true }), ['perf-baseline']);
    // L3：多目标来自产物事实 `.hetai/build-matrix.yml`（不是"我们猜你要交叉编译"）
    assert.deepStrictEqual(ids({ metadata: meta({}), hasBuildMatrix: true }), ['cross-target']);
    assert.deepStrictEqual(ids({ metadata: meta({}), hasBuildMatrix: false }), []);
  });

  it('四类库的画像不同（同一份代码、四种产物事实）', () => {
    const shared = ids({ metadata: meta({ is_shared: true, activate_code_coverage: true }) });
    const pybind = ids({ metadata: meta({ enable_python_bindings: true }) });
    const bare = ids({ metadata: meta({ baremetal_white_list: ['etl'] }), hasBuildMatrix: true });
    const headerOnly = ids({ metadata: meta({ is_header: true }) });
    assert.deepStrictEqual(shared, ['shared-abi', 'coverage']);
    assert.deepStrictEqual(pybind, ['python-bindings']);
    assert.deepStrictEqual(bare, ['baremetal', 'cross-target']);
    assert.deepStrictEqual(headerOnly, ['header-only']);
    const sets = [shared, pybind, bare, headerOnly].map((x) => x.join(','));
    assert.strictEqual(new Set(sets).size, 4, '四类库不能推出同一串能力（否则显隐就是摆设）');
  });

  it('字段为假/空不算能力（不把"关了的开关"当成能力）', () => {
    const off: FcppMetadata = meta({
      is_shared: false,
      is_header: false,
      enable_python_bindings: false,
      activate_code_coverage: false,
      baremetal_white_list: [],
      // 内部约定字段尤其不能变成"能力"：它是给模板/CI 看的，不是给用户看的
      generate_modules_inplace: false,
    });
    assert.deepStrictEqual(deriveCapabilities({ metadata: off }), [], '关掉的开关不产生任何能力');
  });

  it('顺序稳定：同一份输入两次推导结果一致（且按 CAPABILITY_ORDER 排）', () => {
    const input = {
      metadata: meta({
        is_shared: true,
        is_header: true,
        enable_python_bindings: true,
        activate_code_coverage: true,
        baremetal_white_list: ['etl'],
      }),
      hasCHeader: true,
      hasBenchmark: true,
    };
    const first = deriveCapabilities(input);
    const second = deriveCapabilities(input);
    assert.deepStrictEqual(first, second, '两次推导必须完全相同');
    assert.deepStrictEqual(
      (first ?? []).map((c) => c.id),
      CAPABILITY_ORDER.filter((id) => (first ?? []).some((c) => c.id === id)),
      '输出顺序必须按 CAPABILITY_ORDER 排（快照/对账要稳定）',
    );
  });

  it('每条能力都必须**能推出一个动作**，且带可追溯证据（P7 的准入条件）', () => {
    // 注意：**不能**同时 is_shared + is_header（一个有产物、一个没产物，是自相矛盾的元数据）。
    // V3 · L6e 起仅头文件产物还会**反向隐藏** C 接口（它没有产物可做符号回归）——
    // 所以这里用一份真能同时成立的组合，逐条查"有动作、有证据"。
    const input = {
      metadata: meta({
        is_shared: true,
        enable_python_bindings: true,
        activate_code_coverage: true,
        baremetal_white_list: ['etl', 'ArduinoJson', 'Catch2'],
      }),
      hasCHeader: true,
      hasBenchmark: true,
      hasBuildMatrix: true,
    };
    const caps = deriveCapabilities(input) ?? [];
    assert.strictEqual(
      caps.length,
      7,
      '七个字段/产物都应推出能力（shared / pybind / coverage / baremetal / 多目标 / C 接口 / 性能基线）',
    );
    for (const c of caps) {
      assert.strictEqual(c.label, CAPABILITY_LABELS[c.id], 'label 必须取自单一词表');
      // 能力行是**横排**的一行字：理想 ≤ 8 字，硬顶 10（"Python 绑定"这类固有术语就要 9 字，
      // 再长就说明该换一个更短的说法 —— 而不是把行挤爆）
      assert.ok(c.label.length <= 10, `${c.id}: label「${c.label}」超过 10 字（横排会挤）`);
      assert.ok(c.implies.trim().length > 0, `${c.id}: 推不出动作的能力**不许进界面**（P7）`);
      assert.ok(c.evidence.trim().length > 0, `${c.id}: 必须有可追溯证据（从哪个字段读出来的）`);
    }
    // 证据里必须写着真实字段名，不许是"我们自己编的描述"
    const evidence = caps.map((c) => c.evidence).join(' | ');
    for (const key of ['is_shared', 'enable_python_bindings', 'activate_code_coverage', 'baremetal_white_list']) {
      assert.ok(evidence.includes(key), `证据里必须出现字段名 ${key}`);
    }
    // 仅头文件的反向隐藏：单独验一条（它挤不进上面的"全字段"组合）
    const headerOnly = deriveCapabilities({ metadata: meta({ is_header: true }), hasCHeader: true }) ?? [];
    assert.deepStrictEqual(headerOnly.map((c) => c.id), ['header-only']);
    assert.ok(headerOnly[0].evidence.includes('is_header'), '证据里必须出现字段名 is_header');
    // 产物事实的出处必须是**真的那个入口**：C 头在 include/，bench 在 benchmark/（L6a 更正：
    // 以前这里写的是 `test_package/main.cpp` —— 那是 demo 的 main，不是 bench 入口）。
    assert.ok(evidence.includes('include/*.h'), 'C 接口的证据要写清是 include/*.h');
    assert.ok(evidence.includes('benchmark/'), `性能基线的证据要写清是 bench 入口（实际：${evidence}）`);
  });

  it('能力行摘要：空数组不显示，未知也不显示', () => {
    assert.strictEqual(capabilitySummary([]), '');
    assert.strictEqual(capabilitySummary(undefined), '');
    assert.strictEqual(capabilitySummary(deriveCapabilities({ metadata: meta({ is_shared: true }) })), '共享库 ABI');
  });
});
