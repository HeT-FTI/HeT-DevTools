import { join } from 'node:path';
import { FcppMetadata, FcppProject, ToolStatus } from '../types';
import { pathExists } from '../utils/fs';

/**
 * Health-check rule engine (development-plan T-1.9 / G-03).
 * Pure logic with injectable tool/state facts; filesystem probes only via
 * project.root. Fully unit-testable without the VS Code host.
 */

export type CheckKind = 'ok' | 'warn' | 'fail';

export interface HealthCheckItem {
  id: string;
  title: string;
  kind: CheckKind;
  detail: string;
  suggestion?: string;
  /** Contribution to the 100-point score when ok (warn = half, fail = 0). */
  weight: number;
  /** V5-6: fine-grained 0..1 grade (coverage/tests/build are graded). */
  grade?: number;
}

export interface HealthInput {
  project?: FcppProject;
  tools?: Record<string, ToolStatus>;
  state?: {
    lastBuildOk?: boolean;
    lastTestsOk?: boolean;
    /** V5-6: actual last test counts (for graded 测试/构建 scoring). */
    testsRun?: { passed: number; failed: number; skipped: number };
  };
  /** V5-6: actual coverage report fact (for graded 覆盖率 scoring). */
  coverage?: { found: boolean; line: number | null } | null;
  /** V5-2B: managed/WSL lane facts override raw which-sniffing where provided. */
  env?: {
    /** true = lane conan ready · false = lane missing conan · absent = system sniff. */
    conan?: boolean;
  };
  /** T19: capability flags so unsupported features never count as failures. */
  capabilities?: {
    /** false on macOS (no GNU gcov) → the coverage row reports 平台不支持 at full grade. */
    coverage?: boolean;
  };
}

export interface HealthReport {
  score: number;
  verdict: 'PASS' | 'WARN' | 'FAIL';
  checks: HealthCheckItem[];
}

/** V5-2: plain-language verdict for the hover "工程健康" row. */
export function verdictZh(verdict: HealthReport['verdict']): string {
  return verdict === 'PASS' ? '良好' : verdict === 'WARN' ? '需改进' : '不达标';
}

const GAP_LABELS: Record<string, string> = {
  'env.conan': 'conan 未就绪',
  'env.git': 'git 缺失',
  'meta.parsed': 'metadata 解析失败',
  'meta.core': '核心字段缺失',
  'deps.buckets': '依赖桶不完整',
  'switches.ci': 'CI 开关全关',
  'tests.present': '测试未配置',
  'coverage.enabled': '覆盖率未达标',
  'docs.enabled': '文档未配置',
  'quality.config': '质量门禁缺失',
  'state.build': '构建未验证',
  'state.tests': '测试未跑',
};

/**
 * V5-2: the ≤3 "可提升" short labels for the hover row — non-ok checks sorted
 * fail-first (then warn), weight descending, then mapped to plain wording.
 */
export function healthGapLabels(report: Pick<HealthReport, 'checks'>): string[] {
  const rank = (k: HealthCheckItem['kind']): number => (k === 'fail' ? 0 : k === 'warn' ? 1 : 2);
  const nonOk = report.checks
    .filter((c) => c.kind !== 'ok')
    .sort((a, b) => rank(a.kind) - rank(b.kind) || b.weight - a.weight);
  return nonOk.slice(0, 3).map((c) => GAP_LABELS[c.id] ?? c.title);
}

interface RuleResult {
  ok: boolean;
  required?: boolean;
  detail: string;
  suggestion?: string;
  /** V5-6: 0..1 fine grade — when set it drives kind + score (finer grading). */
  grade?: number;
}

type RuleFn = (ctx: {
  meta?: FcppMetadata;
  root?: string;
  tools?: Record<string, ToolStatus>;
  state?: HealthInput['state'];
  env?: HealthInput['env'];
  coverage?: HealthInput['coverage'];
}) => Promise<RuleResult>;

const VERDICT_PASS = 80;
const VERDICT_WARN = 50;

export async function runHealthCheck(input: HealthInput): Promise<HealthReport> {
  const meta = input.project?.metadata;
  const root = input.project?.root;

  const rules: Array<{ id: string; title: string; weight: number; run: RuleFn }> = [
    {
      id: 'env.conan',
      title: 'Conan 可用',
      weight: 10,
      run: () => {
        // V5-2B: managed/lane fact wins over which() sniffing under managed semantics.
        if (input.env?.conan === true) {
          return Promise.resolve({ ok: true, detail: '托管车道 conan 已就绪' });
        }
        if (input.env?.conan === false) {
          return Promise.resolve({
            ok: false,
            required: true,
            detail: '托管环境 conan 未就绪',
            suggestion: '在“环境”页一键准备（het.env.prepare），或检查 WSL 车道',
          });
        }
        return Promise.resolve(
          toolResult('conan', input.tools, '构建依赖 Conan 2；缺失将无法构建。', '安装 conan（pip install conan）并 conan profile detect --force'),
        );
      },
    },
    {
      id: 'env.git',
      title: 'Git 可用',
      weight: 5,
      run: () =>
        Promise.resolve(
          toolResult('git', input.tools, '规范提交与 CI 需要 git。', '安装 git'),
        ),
    },
    {
      id: 'meta.parsed',
      title: 'metadata.json 可解析',
      weight: 15,
      run: async () => {
        if (input.project?.metadataError) {
          return { ok: false, required: true, detail: input.project.metadataError, suggestion: '修复 metadata.json 的 JSON 语法' };
        }
        if (!meta) {
          return { ok: false, required: true, detail: '未读取到 metadata.json', suggestion: '创建 fcpp 项目应包含 metadata.json' };
        }
        return { ok: true, detail: `name=${meta.name}, version=${meta.version ?? '?'}` };
      },
    },
    {
      id: 'meta.core',
      title: '核心字段完整',
      weight: 10,
      run: async () => {
        const missing: string[] = [];
        if (!meta) return { ok: false, required: true, detail: '缺少元数据', suggestion: '先修复解析' };
        if (!meta.name) missing.push('name');
        if (!meta.version) missing.push('version');
        if (!meta.build_type) missing.push('build_type');
        return missing.length === 0
          ? { ok: true, detail: `name/version/build_type = ${meta.name}/${meta.version}/${meta.build_type}` }
          : { ok: false, required: true, detail: `缺少字段: ${missing.join(', ')}`, suggestion: '在“项目设置”中补全' };
      },
    },
    {
      id: 'deps.buckets',
      title: '依赖四桶结构',
      weight: 10,
      run: async () => {
        const deps = meta?.dependencies;
        const buckets = deps ? ['common', 'c', 'cpp', 'infra'].filter((b) => !(b in deps)) : null;
        if (deps && buckets!.length === 0) {
          return { ok: true, detail: 'common / c / cpp / infra 均存在' };
        }
        if (deps && buckets!.length > 0) {
          return { ok: true, detail: `缺少可选桶: ${buckets!.join(', ')}（可接受）` };
        }
        return { ok: false, required: true, detail: '缺少 dependencies 字段', suggestion: '在“项目设置 → 依赖”中添加' };
      },
    },
    {
      id: 'switches.ci',
      title: 'CI 开关配置',
      weight: 10,
      run: async () => {
        const t = meta?.workflow_triggers;
        if (!t) {
          return { ok: false, required: true, detail: '缺少 workflow_triggers', suggestion: '在“项目设置 → CI 开关”中配置' };
        }
        const anyOn = Object.values(t).some(Boolean);
        return anyOn
          ? { ok: true, detail: `已开启 ${Object.entries(t).filter(([, v]) => v).map(([k]) => k).join(', ')}` }
          : { ok: false, required: true, detail: '全部开关为 false（提交 emoji 不会触发任何 CI）', suggestion: '至少开启 build/tests' };
      },
    },
    {
      id: 'tests.present',
      title: '测试可用',
      weight: 10,
      run: async () => {
        const dir = root ? await pathExists(join(root, 'test_package')) : false;
        const enabled = meta?.trigger_tests === true;
        if (enabled || dir) {
          // V5-6 graded: configured & present = 0.8 (full 1.0 needs green runs).
          return { ok: true, grade: 0.8, detail: `${enabled ? 'trigger_tests 开启' : ''}${enabled && dir ? ' · ' : ''}${dir ? 'test_package 存在' : ''}` };
        }
        return { ok: false, required: false, grade: 0.2, detail: 'test_package 缺失且 trigger_tests 关闭', suggestion: '生成测试或开启 trigger_tests' };
      },
    },
    {
      id: 'coverage.enabled',
      title: '覆盖率实测',
      weight: 5,
      run: async () => {
        // T19: a platform without the capability (macOS: Apple clang has no GNU
        // gcov data) is NOT a failure — report unsupported at full grade so the
        // score never punishes the user for the platform's limits.
        if (input.capabilities?.coverage === false) {
          return { ok: true, grade: 1, detail: '平台不支持覆盖率（macOS 有限支持：Apple clang 无 GNU gcov）' };
        }
        // V5-6 graded (user-specified 5分制): 开启无报告=0.4 · ≥60%=0.6 ·
        // ≥80%=0.8 · ≥90%=1.0；未开启=0（并非“开了就满分”）。
        const cov = input.coverage;
        if (meta?.activate_code_coverage) {
          if (cov?.found && cov.line !== null && cov.line !== undefined) {
            const line = cov.line;
            const grade = line >= 90 ? 1 : line >= 80 ? 0.8 : line >= 60 ? 0.6 : 0.4;
            return {
              ok: grade >= 0.8,
              grade,
              detail: `行覆盖 ${line}%（≥90% 满分 · ≥80% 良好 · ≥60% 合格）`,
              suggestion: grade < 0.8 ? '补齐核心路径用例以提升覆盖率' : undefined,
            };
          }
          return {
            ok: false,
            required: false,
            grade: 0.4,
            detail: '已开启但尚无覆盖率报告（构建并测覆盖率后生成）',
            suggestion: '点击“生成覆盖率”',
          };
        }
        return { ok: false, required: false, grade: 0, detail: '覆盖率未开启（Debug 构建可生成报告）', suggestion: '在“项目设置 → 测试与覆盖”开启' };
      },
    },
    {
      id: 'docs.enabled',
      title: '文档配置',
      weight: 5,
      run: async () => {
        const langs = meta?.doc_languages;
        if (langs && langs.length > 0) return { ok: true, detail: `doc_languages = ${langs.join(', ')}` };
        return { ok: false, required: false, detail: '未配置 doc_languages', suggestion: '在“项目设置 → 文档”中配置' };
      },
    },
    {
      id: 'quality.config',
      title: '质量门禁配置',
      weight: 5,
      run: async () => {
        const hasConfig = root ? await pathExists(join(root, '.github', 'misc', '.clang-format-cpp')) : false;
        if (hasConfig) return { ok: true, detail: '.github/misc 配置齐全' };
        return { ok: false, required: false, detail: '缺少 .clang-format-cpp 等门禁配置', suggestion: '从 fcpp 模板同步 .github/misc' };
      },
    },
    {
      id: 'state.build',
      title: '最近构建',
      weight: 10,
      run: async () => {
        // V5-6 graded: 从未=0.2 · 失败=0.4 · 成功未跑测试=0.75 · 构建+测试全绿=1.0
        const s = input.state?.lastBuildOk;
        const t = input.state?.testsRun;
        const green = t ? t.failed === 0 : input.state?.lastTestsOk === true;
        if (s === true) {
          if (green) return { ok: true, grade: 1, detail: '最近构建成功且测试全绿' };
          return { ok: true, required: false, grade: 0.75, detail: '最近构建成功但尚未跑测试', suggestion: '运行“构建并测试”以闭环' };
        }
        if (s === false) return { ok: false, required: true, grade: 0.4, detail: '最近一次构建失败', suggestion: '打开“构建”查看错误并修复' };
        return { ok: false, required: true, grade: 0.2, detail: '尚未构建过', suggestion: '点击“构建项目”' };
      },
    },
    {
      id: 'state.tests',
      title: '最近测试',
      weight: 5,
      run: async () => {
        // V5-6 graded (单元/压力测试同源): 失败=0.2 · 全绿但跳过/用例少=0.7 · 全绿=1.0
        const t = input.state?.testsRun;
        if (t) {
          if (t.failed > 0) {
            return { ok: false, required: false, grade: 0.2, detail: `最近测试存在失败（通过 ${t.passed} · 失败 ${t.failed}）`, suggestion: '在测试浏览器中查看' };
          }
          if (t.skipped > 0) {
            return { ok: true, required: false, grade: 0.7, detail: `全绿但跳过 ${t.skipped} 个用例（可减少跳过以获满分）` };
          }
          if (t.passed < 3) {
            return { ok: true, required: false, grade: 0.7, detail: `全绿但用例偏少（${t.passed} 个通过）`, suggestion: '补充单元/压力用例' };
          }
          return { ok: true, grade: 1, detail: `单元/压力测试全绿（通过 ${t.passed}）` };
        }
        const s = input.state?.lastTestsOk;
        if (s === true) return { ok: true, grade: 1, detail: '最近一次测试全绿' };
        if (s === false) return { ok: false, required: false, grade: 0.2, detail: '最近一次测试存在失败', suggestion: '在测试浏览器中查看' };
        return { ok: false, required: false, grade: 0.2, detail: '尚未运行测试', suggestion: '构建并测试' };
      },
    },
  ];

  const checks: HealthCheckItem[] = [];
  for (const rule of rules) {
    const result = await rule.run({ meta, root, tools: input.tools, state: input.state, env: input.env, coverage: input.coverage });
    // V5-6 graded rules: kind derived from the fine grade (≥0.8 ok · ≥0.5 warn
    // · optional low → warn · required low → fail).
    const kind: CheckKind =
      result.grade !== undefined
        ? result.grade >= 0.8
          ? 'ok'
          : result.grade >= 0.5
            ? 'warn'
            : result.required
              ? 'fail'
              : 'warn'
        : result.ok
          ? 'ok'
          : result.required
            ? 'fail'
            : 'warn';
    checks.push({
      id: rule.id,
      title: rule.title,
      kind,
      detail: result.detail,
      suggestion: result.suggestion,
      weight: rule.weight,
      grade: result.grade,
    });
  }

  let raw = 0;
  for (const c of checks) {
    raw += c.grade !== undefined ? c.weight * c.grade : c.kind === 'ok' ? c.weight : c.kind === 'warn' ? c.weight * 0.5 : 0;
  }
  const score = Math.round(raw);
  const verdict = score >= VERDICT_PASS ? 'PASS' : score >= VERDICT_WARN ? 'WARN' : 'FAIL';

  return { score, verdict, checks };
}

function toolResult(
  name: string,
  tools: Record<string, ToolStatus> | undefined,
  detailMissing: string,
  suggestion: string,
): RuleResult {
  const tool = tools?.[name];
  if (tool?.state === 'ok') {
    return { ok: true, detail: `${tool.version ?? name} @ ${tool.foundPath}` };
  }
  if (tool?.state === 'versionMismatch') {
    return { ok: false, required: true, detail: `${name} 版本 ${tool.version ?? '?'} 低于要求 ${tool.required ?? '?'}`, suggestion };
  }
  return { ok: false, required: true, detail: detailMissing, suggestion };
}
