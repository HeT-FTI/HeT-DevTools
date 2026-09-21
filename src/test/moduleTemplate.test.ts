import * as assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hasPair, planModuleFiles, stubForDeclaration } from '../core/moduleTemplate';

describe('moduleTemplate.planModuleFiles', () => {
  it('generates a valid C++ header/source pair', () => {
    const plan = planModuleFiles({ moduleName: 'mymod', description: '向量运算', language: 'cpp', since: '1.0' });
    assert.strictEqual(plan.ok, true);
    assert.deepStrictEqual(
      plan.files.map((f) => f.relPath),
      ['include/mymod.hpp', 'src/mymod.cpp'],
    );
    const header = plan.files[0].content;
    const source = plan.files[1].content;
    assert.ok(header.includes('// Conan::ImportStart'));
    assert.ok(header.includes('// Conan::ImportEnd'));
    assert.ok(header.includes('#pragma once'));
    assert.ok(header.includes('@brief [en] 向量运算'));
    assert.ok(header.includes('@brief [zh] 向量运算'));
    assert.ok(header.includes('@since 1.0'));
    assert.ok(header.includes('@exporter'));
    assert.ok(header.includes('void mymod_init(void);'));
    assert.ok(source.includes('#include <mymod.hpp>'));
    assert.ok(source.includes('// TODO: implement'));
  });

  it('uses .h/.c for the C language', () => {
    const plan = planModuleFiles({ moduleName: 'cmod', description: 'C API', language: 'c', since: '1.0' });
    assert.strictEqual(plan.ok, true);
    assert.deepStrictEqual(
      plan.files.map((f) => f.relPath),
      ['include/cmod.h', 'src/cmod.c'],
    );
    assert.ok(!plan.files[0].content.includes('stdint'));
  });

  it('keeps extra declarations in the header after the init block', () => {
    const plan = planModuleFiles({
      moduleName: 'mymod',
      description: 'demo',
      language: 'cpp',
      since: '1.0',
      extraDeclarations: ['int mymod_sum(const int* a, int n);', '#include <evil> // ignored'],
    });
    assert.strictEqual(plan.ok, true);
    const header = plan.files[0].content;
    assert.ok(header.includes('int mymod_sum(const int* a, int n);'));
    assert.ok(!header.includes('evil'));
    assert.ok(header.includes('额外公开接口'), '额外声明要有明确的分隔说明');
  });

  it('§F.44 额外声明的**函数原型**要在源文件里有实现桩（bug-v2：声明有了、cpp 里没有）', () => {
    const plan = planModuleFiles({
      moduleName: 'mymod',
      description: 'demo',
      language: 'cpp',
      since: '1.0',
      extraDeclarations: [
        'int mymod_sum(const int* a, int n);',
        'void mymod_reset(void);',
        'bool mymod_ok(void);',
        'struct Point;',
        '#include <evil> // ignored',
      ],
    });
    const source = plan.files[1].content;
    // 头文件里有的每一处函数原型，源文件里都要有对应定义（签名一致）
    assert.ok(source.includes('int mymod_sum(const int* a, int n) {'), '要有 mymod_sum 的实现桩');
    assert.ok(source.includes('void mymod_reset(void) {'), 'void 也要有实现');
    assert.ok(source.includes('bool mymod_ok(void) {'), 'bool 也要有实现');
    assert.ok(source.includes('return 0;'), '非 bool 标量给 0 占位');
    assert.ok(source.includes('return false;'), 'bool 给 false 占位');
    assert.ok(source.includes('TODO'), '桩里要写 TODO（别让人以为已经实现）');
    assert.ok(!source.includes('Point'), '非函数声明不需要实现桩');
    assert.ok(!source.includes('evil'), '预处理行照样要过滤');
    // doxygen 一致性：头文件里不该出现第二个文件级 doc 块（以前会重复插一遍）
    assert.strictEqual((plan.files[0].content.match(/@since/gu) ?? []).length, 1, '文件级 doc 只允许一份');
  });

  it('§F.44 桩的返回值按语言/类型给（C 用复合字面量，C++ 用 {}）', () => {
    assert.strictEqual(stubForDeclaration('void f(void);', 'cpp'), 'void f(void) {\n    // TODO: 实现（当前返回值仅为占位，编译得过但语义未定）\n}');
    assert.ok(stubForDeclaration('int* f(void);', 'cpp')!.includes('return nullptr;'));
    assert.ok(stubForDeclaration('int* f(void);', 'c')!.includes('return 0;'));
    assert.ok(stubForDeclaration('Point make(void);', 'cpp')!.includes('return {};'));
    assert.ok(stubForDeclaration('Point make(void);', 'c')!.includes('return (Point){0};'));
    assert.strictEqual(stubForDeclaration('extern int g_counter;', 'cpp'), null, '变量声明不是函数原型');
    assert.strictEqual(stubForDeclaration('typedef int myint;', 'c'), null);
  });

  it('rejects invalid names and empty descriptions', () => {
    assert.strictEqual(planModuleFiles({ moduleName: 'MyMod', description: 'x', language: 'cpp', since: '' }).ok, false);
    assert.strictEqual(planModuleFiles({ moduleName: '9mod', description: 'x', language: 'cpp', since: '' }).ok, false);
    assert.strictEqual(planModuleFiles({ moduleName: 'okmod', description: '  ', language: 'cpp', since: '' }).ok, false);
  });

  it('hasPair detects existing files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'het-mod-'));
    try {
      assert.strictEqual(await hasPair(root, 'mymod'), false);
      writeFileSync(join(root, 'include-marker'), 'x');
      // simulate via real path creation
      const { mkdirSync } = await import('node:fs');
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'mymod.cpp'), '');
      assert.strictEqual(await hasPair(root, 'mymod'), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
