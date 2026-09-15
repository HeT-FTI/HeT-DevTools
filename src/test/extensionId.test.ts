/**
 * Guards the bug class that broke the FIRST env-fresh · linux run
 * (run 34914303247): every real-host harness hardcoded
 * `het-test-publisher.het-devtools`, the publisher was renamed to `het-fti`
 * for the Marketplace release, and the whole job died at STEP 1 with
 * `AssertionError: extension must be discovered` — even though the extension
 * loaded perfectly.
 *
 * VS Code builds the runtime id from `package.json` (`<publisher>.<name>`), so
 * the id must be DERIVED (package.json / `vscode.extensions`) and never written
 * as a literal. This test fails the moment someone writes one again.
 */
import * as assert from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { declaredExtensionId } from './extensionId';

// __dirname = out/test → repo root is two levels up (see projectDetector.test).
const repoRoot = join(__dirname, '..', '..');
const scannedDirs = [join(repoRoot, 'src'), join(repoRoot, 'scripts')];

interface Manifest {
  name?: string;
  publisher?: string;
  version?: string;
}

function manifest(): Manifest {
  return JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as Manifest;
}

function collect(dir: string, acc: string[] = []): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e === 'node_modules' || e.startsWith('.')) {
      continue;
    }
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      collect(p, acc);
    } else if (/\.(ts|mjs)$/u.test(e)) {
      acc.push(p);
    }
  }
  return acc;
}

/**
 * Blank out comments before scanning: the guard must catch *code* literals, not
 * prose (this file's own header cites the old id on purpose). The `(^|[^:])`
 * guard keeps `https://…` inside strings intact; a false negative is harmless
 * here, a false positive would make the guard unusable.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
}

describe('extension id (rename-proof)', () => {
  it('derives the runtime id from package.json', () => {
    const pkg = manifest();
    assert.ok(pkg.publisher, 'package.json must declare a publisher — VS Code builds the id from it');
    assert.ok(pkg.name, 'package.json must declare a name');
    const id = `${pkg.publisher}.${pkg.name}`;
    assert.match(id, /^[a-z0-9-]+\.[a-z0-9-]+$/u, 'unexpected extension id shape: ' + id);
    // The Marketplace/CI identity is the publisher+name pair; the NAME must
    // stay `het-devtools` (commands/keys/docs all assume it).
    assert.strictEqual(pkg.name, 'het-devtools');
  });

  it('never hardcodes a `<publisher>.het-devtools` literal in src/ or scripts/', () => {
    const offenders: string[] = [];
    for (const dir of scannedDirs) {
      for (const file of collect(dir)) {
        const text = stripComments(readFileSync(file, 'utf8'));
        const m = /['"`]([a-z0-9-]+\.het-devtools)['"`]/u.exec(text);
        if (m) {
          offenders.push(`${file.slice(repoRoot.length + 1)} → "${m[1]}"`);
        }
      }
    }
    assert.deepStrictEqual(
      offenders,
      [],
      'extension ids must come from package.json (src/test/hostExtension.ts) — hardcoded: ' + offenders.join(' | '),
    );
  });

  it('the installed-vsix folder name is derived from package.json', () => {
    const src = readFileSync(join(repoRoot, 'scripts', 'verify-installed.mjs'), 'utf8');
    assert.ok(
      /\$\{pkg\.publisher\}\.\$\{pkg\.name\}/u.test(src),
      'verify-installed.mjs must build the installed folder name from package.json',
    );
  });

  // The lookup runs from `<root>/out/<dir>/<file>.js` in the real hosts, so the
  // walk (not just package.json reading) is what the CI depends on.
  it('walks up from a bundle dir (out/test-integration) to the root package.json', () => {
    const expected = `${manifest().publisher}.${manifest().name}`;
    assert.strictEqual(declaredExtensionId(join(repoRoot, 'out', 'test-integration')), expected);
    assert.strictEqual(declaredExtensionId(join(repoRoot, 'out', 'verifyRunner')), expected);
  });

  it('skips the het-verify-runner fixture package.json on the way up', () => {
    const fixture = JSON.parse(
      readFileSync(join(repoRoot, 'src', 'test', 'installedRunner', 'package.json'), 'utf8'),
    ) as Manifest;
    assert.notStrictEqual(fixture.name, 'het-devtools', 'fixture must not claim our name');
    // Starting INSIDE the fixture dir must still resolve OUR id from the root.
    assert.strictEqual(
      declaredExtensionId(join(repoRoot, 'src', 'test', 'installedRunner')),
      `${manifest().publisher}.${manifest().name}`,
    );
  });
});
