// HeT DevTools — esbuild build script.
//  - bundles src/extension.ts -> out/extension.js (single file, external: vscode)
//  - --tests : bundles every src/test/**/*.test.ts -> out/test/** (kept relative)
//  - --watch : rebuild on change
import * as esbuild from 'esbuild';
import { readdirSync, statSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)));
const srcDir = join(root, 'src');
const outDir = join(root, 'out');

const args = process.argv.slice(2);
const watch = args.includes('--watch');
const tests = args.includes('--tests');
const integration = args.includes('--integration');
const c1 = args.includes('--c1');
const c2 = args.includes('--c2');
const c3 = args.includes('--c3');
const c4 = args.includes('--c4');
const c5 = args.includes('--c5');
const c6 = args.includes('--c6');
const c7 = args.includes('--c7');
const c8 = args.includes('--c8');
const real = args.includes('--real');

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: true,
  sourcesContent: false,
  logLevel: 'info',
  external: ['vscode'],
};

function collectTsFiles(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectTsFiles(full, acc);
    } else if (entry.endsWith('.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

function buildOptions() {
  const options = [];
  const wantMain = !tests && !integration;

  // 1) main extension bundle (skipped in tests/integration-only modes)
  if (wantMain) {
    options.push({
      ...common,
      entryPoints: [join(srcDir, 'extension.ts')],
      outfile: join(outDir, 'extension.js'),
    });
  }

  // 2) unit tests (when requested)
  if (tests) {
    // 先清掉上一次的产物：**被删掉的测试源不许在 out/ 里以"幽灵用例"继续跑**。
    // （E 块删 HUD 测试时踩过：源码没了，out/test/hud*.test.js 还在，于是 CI 里绿、
    //   本地红/绿不一致，而且断言的是已经不存在的文件。）
    rmSync(join(outDir, 'test'), { recursive: true, force: true });
    const testRoot = join(srcDir, 'test');
    if (exists(testRoot)) {
      for (const file of collectTsFiles(testRoot)) {
        if (!file.endsWith('.test.ts')) {
          continue;
        }
        const rel = relative(srcDir, file).replace(/\.ts$/, '.js');
        const outfile = join(outDir, rel);
        mkdirSync(dirname(outfile), { recursive: true });
        options.push({ ...common, entryPoints: [file], outfile });
      }
    }
  }

  // 3) extension-host integration smoke test (when requested)
  if (integration) {
    options.push({
      ...common,
      entryPoints: [join(srcDir, 'test', 'integration', 'index.ts')],
      outfile: join(outDir, 'test-integration', 'index.js'),
    });
  }

  // 4) C1 end-to-end check (real fcpp build through the host)
  if (c1) {
    options.push({
      ...common,
      entryPoints: [join(srcDir, 'test', 'integration', 'c1.ts')],
      outfile: join(outDir, 'test-integration', 'c1.js'),
    });
  }

  // 5) C2 end-to-end check (Phase-2 journey: module + testgen + full cycle)
  if (c2) {
    options.push({
      ...common,
      entryPoints: [join(srcDir, 'test', 'integration', 'c2.ts')],
      outfile: join(outDir, 'test-integration', 'c2.js'),
    });
  }

  // 6) C3 end-to-end check (Phase-3 journey: docs/quality/commit/release/preflight)
  if (c3) {
    options.push({
      ...common,
      entryPoints: [join(srcDir, 'test', 'integration', 'c3.ts')],
      outfile: join(outDir, 'test-integration', 'c3.js'),
    });
  }

  // 7) C4 end-to-end check (Phase-4 journey: template init → update → audit)
  if (c4) {
    options.push({
      ...common,
      entryPoints: [join(srcDir, 'test', 'integration', 'c4.ts')],
      outfile: join(outDir, 'test-integration', 'c4.js'),
    });
  }

  // 8) C5 cockpit check (P-G5: empty workspace → wizard auto-open; project → clean state)
  if (c5) {
    options.push({
      ...common,
      entryPoints: [join(srcDir, 'test', 'integration', 'c5.ts')],
      outfile: join(outDir, 'test-integration', 'c5.js'),
    });
  }

  // 9) C6 v2 check (status-bar chip + dashboard section focus + deps commands)
  if (c6) {
    options.push({
      ...common,
      entryPoints: [join(srcDir, 'test', 'integration', 'c6.ts')],
      outfile: join(outDir, 'test-integration', 'c6.js'),
    });
  }

  // 10) C7 template-acquisition path check (E2: forced-offline online pin →
  //     deterministic local fallback + marker + fallback note)
  if (c7) {
    options.push({
      ...common,
      entryPoints: [join(srcDir, 'test', 'integration', 'c7.ts')],
      outfile: join(outDir, 'test-integration', 'c7.js'),
    });
  }

  // 10b) C8 one-tab / slot check (§6-A: 页签恒为 1 + 页内 Slot 互斥，0 人工)
  if (c8) {
    options.push({
      ...common,
      entryPoints: [join(srcDir, 'test', 'integration', 'c8.ts')],
      outfile: join(outDir, 'test-integration', 'c8.js'),
    });
  }

  // 11) P2 real host — cross-platform REAL conan build through the extension
  //     (macOS native / Linux; fixture = committed assets/template, coverage
  //     disabled so macOS needs no lcov/gcov; run via npm run test:real)
  if (real) {
    options.push({
      ...common,
      entryPoints: [join(srcDir, 'test', 'integration', 'realBuild.ts')],
      outfile: join(outDir, 'test-integration', 'realBuild.js'),
    });
  }
  return options;
}

async function runAll(builds) {
  if (watch) {
    const contexts = [];
    for (const o of builds) {
      const ctx = await esbuild.context(o);
      await ctx.watch();
      contexts.push(ctx);
    }
    return contexts;
  }
  await Promise.all(builds.map((o) => esbuild.build(o)));
}

function exists(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

runAll(buildOptions()).catch((e) => {
  console.error(e);
  process.exit(1);
});
