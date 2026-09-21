/**
 * Pure half of the extension-id lookup (no `vscode` import → unit-testable).
 *
 * VS Code builds the runtime id from `package.json` (`<publisher>.<name>`), so
 * a harness must never hardcode it: the publisher was renamed
 * `het-test-publisher` → `het-fti` for the Marketplace release and every
 * real-host test died at STEP 1 with `extension must be discovered`
 * (env-fresh · linux run 34914303247).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** `package.json` name of the extension under test. */
export const EXTENSION_NAME = 'het-devtools';

/**
 * `<publisher>.<name>` read from the repo's `package.json`.
 *
 * The bundle always lives at `<root>/out/<dir>/<file>.js`, so walk up looking
 * for the FIRST `package.json` whose `name` is ours — which also skips the
 * `out/verifyRunner/package.json` fixture (name `het-verify-runner`) that sits
 * next to the installed-runner bundle.
 */
export function declaredExtensionId(startDir: string = __dirname): string | undefined {
  let dir = startDir;
  for (let i = 0; i < 5; i += 1) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; publisher?: string };
      if (pkg.name === EXTENSION_NAME && pkg.publisher) {
        return `${pkg.publisher}.${pkg.name}`;
      }
    } catch {
      /* no readable package.json here — keep walking up */
    }
    dir = join(dir, '..');
  }
  return undefined;
}
