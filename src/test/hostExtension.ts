/**
 * Which extension is HeT DevTools in THIS host (the vscode-aware half).
 *
 * The id comes from `package.json` (`declaredExtensionId` in `./extensionId`,
 * which is unit-tested) with a name-scan fallback over `vscode.extensions.all`
 * — both survive a publisher rename. That is exactly what broke the first
 * env-fresh · linux run (34914303247): the harnesses hardcoded the OLD
 * publisher `het-test-publisher` while the extension loaded fine as `het-fti`.
 */
import * as vscode from 'vscode';
import { EXTENSION_NAME, declaredExtensionId } from './extensionId';

export { EXTENSION_NAME, declaredExtensionId };

/** The declared id, or a visible placeholder when package.json is unreadable. */
export const EXTENSION_ID = declaredExtensionId() ?? `${EXTENSION_NAME} (package.json not found)`;

/** The extension as loaded by this host (undefined when absent). */
export function hetExtension(): vscode.Extension<unknown> | undefined {
  const id = declaredExtensionId();
  const byId = id ? vscode.extensions.getExtension(id) : undefined;
  return (
    byId ??
    vscode.extensions.all.find((e) => (e.packageJSON as { name?: string } | undefined)?.name === EXTENSION_NAME)
  );
}

/** Every extension id this host sees — makes a discovery failure self-explaining. */
export function discoveredIds(): string {
  return vscode.extensions.all.map((e) => e.id).join(', ') || '(none)';
}

/** `hetExtension()` with an actionable error (declared id + what was discovered). */
export function requireHetExtension(): vscode.Extension<unknown> {
  const ext = hetExtension();
  if (!ext) {
    throw new Error(
      `het-devtools must be discovered in this host — expected id "${EXTENSION_ID}" ` +
        `(package.json publisher/name); discovered: ${discoveredIds()}`,
    );
  }
  return ext;
}
