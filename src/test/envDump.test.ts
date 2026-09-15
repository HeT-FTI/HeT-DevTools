import * as assert from 'node:assert';
import { ENV_DUMP_SCHEMA, buildEnvDump, dumpFileName, redact, redactDeep, redactRoots } from '../core/envDump';

describe('T05 envDump (redacted remote-diagnosis export)', () => {
  it('collapses home roots (both separators) to ~', () => {
    const roots = ['C:\\Users\\zhang', '/home/zhang'];
    assert.strictEqual(redact('C:\\Users\\zhang\\.het-fti\\managed-env', roots), '~\\.het-fti\\managed-env');
    assert.strictEqual(redact('/home/zhang/.conan2/p/b/x', roots), '~/.conan2/p/b/x');
    assert.strictEqual(redact('no paths here', roots), 'no paths here');
  });

  it('redacts nested structures without touching keys', () => {
    const out = redactDeep(
      { lane: { root: '/home/zhang/.het-fti/managed-env' }, rows: ['/home/zhang/x', 3, true] },
      ['/home/zhang'],
    ) as { lane: { root: string }; rows: unknown[] };
    assert.strictEqual(out.lane.root, '~/.het-fti/managed-env');
    assert.deepStrictEqual(out.rows, ['~/x', 3, true]);
  });

  it('redactRoots skips short/empty env values', () => {
    const roots = redactRoots('/home/zhang', ['', 'C:', undefined]);
    assert.ok(roots.includes('/home/zhang'));
    assert.ok(!roots.includes(''));
    assert.ok(!roots.includes('C:'), 'a bare drive letter is too short to redact safely');
  });

  it('buildEnvDump stamps schema+ts and redacts the whole document', () => {
    const doc = buildEnvDump(
      {
        extension: { version: '0.4.0', vscode: '1.95.0' },
        host: { platform: 'linux' },
        provider: { id: 'linux-managed' },
        lane: { root: '/home/zhang/.het-fti/managed-env' },
        managed: null,
        tools: [{ key: 'conan', source: 'path', exe: '/home/zhang/.local/bin/conan' }],
        versions: { conan: 'Conan version 2.32.0' },
        mirrors: { pip: 'default' },
        lastBuildTail: ['/home/zhang/proj/src/a.cpp:1: error: boom'],
      },
      ['/home/zhang'],
      new Date('2026-09-14T10:00:00.000Z'),
    );
    assert.strictEqual(doc.schema, ENV_DUMP_SCHEMA);
    assert.strictEqual(doc.ts, '2026-09-14T10:00:00.000Z');
    assert.strictEqual(doc.lane?.root, '~/.het-fti/managed-env');
    assert.strictEqual(doc.tools[0].exe, '~/.local/bin/conan');
    assert.strictEqual(doc.lastBuildTail[0], '~/proj/src/a.cpp:1: error: boom');
  });

  it('file name is filesystem safe', () => {
    const name = dumpFileName(new Date('2026-09-14T10:00:00.000Z'));
    assert.ok(/^het-env-dump-[0-9TZ-]+\.json$/.test(name), name);
    assert.ok(!name.includes(':'));
  });
});
