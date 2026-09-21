import * as assert from 'node:assert';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baseName, normalizeSlashes } from '../utils/paths';
import {
  cleanupStaleInjection,
  hasInjectedMain,
  isInjectedMain,
  isInjectedUcovFile,
  staleInjectionFiles,
} from '../core/injectedFiles';

/** 上游 `_entry_lists()` 生成的 GTest main（原样抄一份，改动即失败）。 */
const INJECTED_MAIN = `#include <gtest/gtest.h>


int main(int argc, char **argv) {
    ::testing::InitGoogleTest(&argc, argv);
    return RUN_ALL_TESTS();
}
`;

/** 用户自己写的 main（不是系统生成的）。 */
const USER_MAIN = `#include <cstdio>

int main() {
    printf("my own harness\\n");
    return 0;
}
`;

const USER_TEST = `#include <gtest/gtest.h>

TEST(MySuite, works) {
    EXPECT_EQ(1, 1);
}
`;

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'het-inject-'));
}

describe('模板注入文件防呆（§F.39 构建/测试前清理）', () => {
  it('识别注入块：名字与内容双条件，用户文件一律不认', () => {
    assert.ok(hasInjectedMain(INJECTED_MAIN));
    assert.ok(isInjectedMain(INJECTED_MAIN));
    assert.ok(!isInjectedMain(USER_MAIN), '没有注入块 → 不是注入文件');
    assert.ok(!hasInjectedMain(USER_MAIN));
    // ucov_ 拷贝 = 用例 + 注入块（有 TEST 仍然算注入文件）
    assert.ok(isInjectedUcovFile('ucov_sample_test.cpp', USER_TEST + INJECTED_MAIN));
    assert.ok(!isInjectedUcovFile('sample_test.cpp', USER_TEST + INJECTED_MAIN), '名字不符不删');
    assert.ok(!isInjectedUcovFile('ucov_sample.cpp', USER_TEST), '内容不符不删（可能是用户自己的）');
  });

  it('列出上一轮残留：test/unit/main.cpp · test/stress/main.cpp · test/unit/ucov_*.cpp', () => {
    const root = tmpProject();
    try {
      mkdirSync(join(root, 'test', 'unit'), { recursive: true });
      mkdirSync(join(root, 'test', 'stress'), { recursive: true });
      writeFileSync(join(root, 'test', 'unit', 'main.cpp'), INJECTED_MAIN);
      writeFileSync(join(root, 'test', 'stress', 'main.cpp'), INJECTED_MAIN);
      writeFileSync(join(root, 'test', 'unit', 'ucov_alpha_test.cpp'), USER_TEST + INJECTED_MAIN);
      writeFileSync(join(root, 'test', 'unit', 'beta_test.cpp'), USER_TEST);
      const stale = staleInjectionFiles(root).map((f) => normalizeSlashes(f).replace(normalizeSlashes(root), ''));
      assert.deepStrictEqual(stale.sort(), [
        '/test/stress/main.cpp',
        '/test/unit/main.cpp',
        '/test/unit/ucov_alpha_test.cpp',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('清理是幂等的：删掉系统生成的、留下用户写的，再跑一次什么也不删', () => {
    const root = tmpProject();
    try {
      mkdirSync(join(root, 'test', 'unit'), { recursive: true });
      mkdirSync(join(root, 'test', 'stress'), { recursive: true });
      writeFileSync(join(root, 'test', 'unit', 'main.cpp'), INJECTED_MAIN);
      writeFileSync(join(root, 'test', 'stress', 'main.cpp'), USER_MAIN); // 用户自己写的
      writeFileSync(join(root, 'test', 'unit', 'ucov_alpha_test.cpp'), USER_TEST + INJECTED_MAIN);
      writeFileSync(join(root, 'test', 'unit', 'beta_test.cpp'), USER_TEST); // 用户用例

      const first = cleanupStaleInjection(root);
      assert.deepStrictEqual(first.removed.map((f) => baseName(f)).sort(), [
        'main.cpp',
        'ucov_alpha_test.cpp',
      ]);
      assert.deepStrictEqual(first.skipped.map((f) => baseName(f)), ['main.cpp'], '同名的用户文件要列出来但不动');
      // 用户文件都还在
      assert.ok(readdirSync(join(root, 'test', 'unit')).includes('beta_test.cpp'));
      assert.strictEqual(readdirSync(join(root, 'test', 'stress')).length, 1, '用户写的 stress/main.cpp 不能删');

      const second = cleanupStaleInjection(root);
      assert.deepStrictEqual(second.removed, [], '第二次应该无可删（幂等）');
      assert.deepStrictEqual(second.skipped.map((f) => baseName(f)), ['main.cpp']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });


  it('接线门禁：构建与测试两条入口都在跑之前清一次（防呆不能只写在注释里）', () => {
    const ext = readFileSync(join('src', 'extension.ts'), 'utf8');
    const build = /async function buildProjectInner\(\)[\s\S]*?cleanupInjectedBeforeRun\(project\.root\)/u.test(ext);
    const test = /async function runTestsInner\(\)[\s\S]*?cleanupInjectedBeforeRun\(project\.root\)/u.test(ext);
    assert.ok(build, '构建入口要先清理注入残留');
    assert.ok(test, '测试入口要先清理注入残留');
    // 清理必须在真正执行之前（顺序错了就等于没做）
    const runIdx = ext.indexOf('const result = await executeTestRun();');
    const cleanIdx = ext.lastIndexOf('cleanupInjectedBeforeRun(project.root)');
    assert.ok(cleanIdx > -1 && cleanIdx < runIdx, '清理要排在 executeTestRun 之前');
  });

  it('目录不存在也不炸（没有测试目录的项目照样能构建）', () => {
    const root = tmpProject();
    try {
      assert.deepStrictEqual(staleInjectionFiles(root), []);
      assert.deepStrictEqual(cleanupStaleInjection(root).removed, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
