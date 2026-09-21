/**
 * Prepend a directory to a child-process PATH **without breaking Windows**.
 *
 * Windows spells the variable `Path` (mixed case), not `PATH`. Building a child
 * env as `{ ...process.env, PATH: dir + ';' + process.env.PATH }` therefore
 * creates a SECOND, conflicting key; the child then received a PATH without
 * `System32`, and the Windows system build died with
 * `'chcp' is not recognized` / `'cmake' is not recognized`
 * (env-fresh · windows-system, run 34920652428). Always mutate the key the
 * environment actually has.
 *
 * Pure (no vscode) → unit-tested.
 */
export function prependPath(env: NodeJS.ProcessEnv, dir: string, delimiter: string): NodeJS.ProcessEnv {
  if (!dir) {
    return env;
  }
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const current = env[key] ?? '';
  if (current.split(delimiter).includes(dir)) {
    return env;
  }
  return { ...env, [key]: current.length > 0 ? `${dir}${delimiter}${current}` : dir };
}

/** The PATH-ish key of this environment ('Path' on Windows, 'PATH' elsewhere). */
export function pathKeyOf(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
}
