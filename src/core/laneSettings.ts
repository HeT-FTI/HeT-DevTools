/**
 * conan `settings.yml` adapter for the LANE's own CONAN_HOME.
 *
 * `settings.yml` is conan's closed vocabulary: every `compiler.version` in a
 * profile must be listed there. conan ships it in the wheel and lags the
 * toolchains (Apple ships a new clang yearly), so a brand-new compiler makes
 * EVERY build fail deep inside conan with
 *   `Invalid setting '21.0.0' is not a valid 'settings.compiler.version' value`
 * (env-fresh · macos run 34926785628 — there the version was also mis-formatted,
 * see `normalizeAppleClangVersion`; this module covers the residual case).
 *
 * We only ever touch the lane's PRIVATE copy (`~/.het-fti/managed-env/.conan2/
 * settings.yml`), never the user's, and every change is logged as
 * `lane_settings:added(...)` so it is never silent.
 *
 * Pure string building (no fs/vscode) → unit-tested.
 */

/**
 * Apple clang reports three components (`Apple clang version 21.0.0`), conan
 * lists at most two (`"21"` / `"21.0"`). Passing the raw string is invalid.
 */
export function normalizeAppleClangVersion(raw: string): string {
  const m = /^(\d+)(?:\.(\d+))?/u.exec((raw ?? '').trim());
  if (!m) {
    return (raw ?? '').trim();
  }
  return m[2] === undefined ? m[1] : `${m[1]}.${m[2]}`;
}

/** Compiler name in conan's settings.yml vocabulary (apple-clang / gcc / …). */
export function settingsCompilerKey(ccName: string, os: 'Linux' | 'Macos'): string {
  const n = (ccName ?? '').toLowerCase();
  if (n.includes('clang') && os === 'Macos') {
    return 'apple-clang';
  }
  if (n.includes('gcc')) {
    return 'gcc';
  }
  return n;
}

/**
 * Shell steps that make the lane's `settings.yml` know `version` for `name`.
 *
 * Runs AFTER the profile is written; never fatal (prints `lane_settings:skip(…)`
 * and exits 0 so `set -e` cannot kill the ensure script).
 *
 * `conanHome` is passed explicitly because the ensure script never exports
 * `CONAN_HOME`, and `conan --version` is run first: conan only materialises
 * `settings.yml` on its FIRST invocation, so patching before that would be a
 * silent no-op (`lane_settings:skip(no settings.yml)`).
 */
export function laneSettingsEnsureSteps(name: string, version: string, venvBin: string, conanHome: string): string[] {
  if (!name || !version) {
    return [];
  }
  const py = `${venvBin}/python`;
  const program = [
    'import os, sys, yaml',
    `name, ver = ${JSON.stringify(name)}, ${JSON.stringify(version)}`,
    'path = os.path.join(os.environ.get("CONAN_HOME", ""), "settings.yml")',
    'try:',
    '    if not os.path.exists(path):',
    '        print("lane_settings:skip(no settings.yml)"); sys.exit(0)',
    '    with open(path, encoding="utf-8") as fh:',
    '        data = yaml.safe_load(fh)',
    '    node = (data.get("compiler") or {}).get(name)',
    '    if not isinstance(node, dict):',
    '        print("lane_settings:skip(no compiler.%s in settings.yml)" % name); sys.exit(0)',
    '    versions = [str(v) for v in (node.get("version") or [])]',
    '    if ver in versions:',
    '        print("lane_settings:ok(%s %s)" % (name, ver)); sys.exit(0)',
    '    versions.append(ver)',
    '    node["version"] = versions',
    '    tmp = path + ".het-tmp"',
    '    with open(tmp, "w", encoding="utf-8") as fh:',
    '        yaml.safe_dump(data, fh, sort_keys=False, allow_unicode=True)',
    '    os.replace(tmp, path)',
    '    print("lane_settings:added(%s %s — conan 尚不认识该版本，已写入车道私有 settings.yml)" % (name, ver))',
    'except Exception as exc:',
    '    print("lane_settings:skip(%s)" % exc)',
    'sys.exit(0)',
  ].join('\n');
  return [
    '# Lane settings.yml: conan must KNOW the profile\'s compiler version (it lags new toolchains).',
    // 1) bootstrap the lane cache (creates settings.yml on first run)
    `CONAN_HOME="${conanHome}" "${venvBin}/conan" --version >/dev/null 2>&1 || true`,
    // 2) teach it the version (idempotent, never fatal)
    `CONAN_HOME="${conanHome}" "${py}" - <<'HET_SETTINGS'`,
    program,
    'HET_SETTINGS',
  ];
}

/** The `compiler.version` conan will read from this generated profile ('' when absent). */
export function profileCompilerVersion(profileText: string): string {
  const m = /^compiler\.version\s*=\s*(\S+)/mu.exec(profileText ?? '');
  return m ? m[1].trim() : '';
}
