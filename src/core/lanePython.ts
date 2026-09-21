/**
 * The LANE's Python interpreter policy.
 *
 * A managed lane owns a private venv, but it must pick the interpreter from
 * what the HOST has (never install one). That choice is not cosmetic: the docs
 * stack pins `sphinx>=8`, which needs **Python >= 3.10**.
 *
 * env-fresh · macos run 34927513753 died exactly here: the picker preferred the
 * hardcoded `/usr/bin/python3` (macOS ships 3.9.6) over the `python3` on PATH
 * (the runner has 3.14.7) → `pip install "sphinx<9,>=8"` reported
 *   `ERROR: No matching distribution found for sphinx<9,>=8`
 * and the user saw a cryptic pip dump instead of "your Python is too old".
 *
 * Policy implemented here (pure string building → unit-tested):
 *   1. candidates are probed NEWEST-FIRST (`python3.14` … `python3.10`, conda,
 *      `python3`, `python`, and `/usr/bin/python3` only as a last resort);
 *   2. a candidate that satisfies the docs floor wins; if none does, we still
 *      fall back to any venv-capable Python so BUILDING keeps working (docs is
 *      the only consumer that needs 3.10) and say so loudly;
 *   3. an existing venv built with a too-old Python is REBUILT once a newer one
 *      appears — otherwise installing Python 3.12 would silently change nothing
 *      (the venv is cached by `bin/conan` presence);
 *   4. the docs bootstrap refuses early with an actionable message when the
 *      lane's Python is below the floor, instead of dumping pip's resolution log.
 */

/** Minimum Python for the docs stack (`sphinx>=8`). */
export const PYTHON_DOCS_FLOOR = '3.10';

/** Version names the picker probes, newest first (`python3`, `python` come after). */
export const PYTHON_VERSIONED_NAMES = ['python3.14', 'python3.13', 'python3.12', 'python3.11', 'python3.10'] as const;

/** Pure `version >= floor` for `MAJOR.MINOR` strings ('0.0' = unknown → false). */
export function pythonFloorOk(version: string, floor = PYTHON_DOCS_FLOOR): boolean {
  const a = /^(\d+)\.(\d+)$/u.exec((version ?? '').trim());
  const b = /^(\d+)\.(\d+)$/u.exec(floor.trim());
  if (!a || !b) {
    return false;
  }
  const [amaj, amin] = [Number(a[1]), Number(a[2])];
  const [bmaj, bmin] = [Number(b[1]), Number(b[2])];
  return amaj > bmaj || (amaj === bmaj && amin >= bmin);
}

/**
 * POSIX shell block that (selects and) builds the lane venv.
 *
 * `pipPackages` are the lane's own build tooling (conan/cmake/ninja) — the docs
 * stack is installed separately by the docs bootstrap.
 */
export function laneVenvBootstrapSteps(venvPath: string, pipPackages: string[], floor = PYTHON_DOCS_FLOOR): string[] {
  return [
    '# ---- lane venv: pick the best Python the HOST has (docs stack needs sphinx>=8 → Python >= ' + floor + ') ----',
    `VENV="${venvPath}"`,
    'lane_py_ver() { "$1" -c \'import sys; print("%d.%d" % sys.version_info[:2])\' 2>/dev/null || echo 0.0; }',
    `lane_py_ok() { awk -v v="$1" -v m="${floor}" 'BEGIN { split(v, a, "."); split(m, b, "."); exit !(a[1] > b[1] || (a[1] == b[1] && a[2] >= b[2])) }'; }`,
    'CAND=""',
    'lane_add() { if [ -n "$1" ] && [ -x "$1" ]; then case " $CAND " in *" $1 "*) ;; *) CAND="$CAND $1" ;; esac; fi; return 0; }',
    `for n in ${PYTHON_VERSIONED_NAMES.join(' ')} python3 python; do lane_add "$(command -v "$n" 2>/dev/null || true)"; done`,
    'CONDA_PY=""',
    'if command -v conda >/dev/null 2>&1; then CONDA_PY="$(dirname "$(command -v conda 2>/dev/null)")/python"; fi',
    'lane_add "$CONDA_PY"',
    'lane_add /usr/bin/python3',
    'echo "lane_python_candidates:$CAND"',
    'PY_FLOOR_C=""; PY_FLOOR_V=""',
    'for c in $CAND; do v="$(lane_py_ver "$c")"; if lane_py_ok "$v"; then PY_FLOOR_C="$c"; PY_FLOOR_V="$v"; break; fi; done',
    '# Creating the venv is the REAL capability test (a `-m venv --help` probe lies on Debian/Ubuntu',
    '# without python3-venv), so the selection and the creation happen in one pass.',
    'lane_make_venv() {',
    '  for c in $CAND; do',
    '    v="$(lane_py_ver "$c")"',
    '    if [ "$1" = "floor" ] && ! lane_py_ok "$v"; then continue; fi',
    '    if "$c" -m venv "$VENV" >/dev/null 2>&1; then PY="$c"; PYVER="$v"; return 0; fi',
    '    rm -rf "$VENV"',
    '  done',
    '  return 1',
    '}',
    'NEW=1; PY=""; PYVER=""; FLOOR=below',
    'if [ -x "$VENV/bin/conan" ]; then',
    '  VENV_V="$(lane_py_ver "$VENV/bin/python")"',
    '  if lane_py_ok "$VENV_V" || [ -z "$PY_FLOOR_C" ]; then',
    '    NEW=0; PY="$VENV/bin/python"; PYVER="$VENV_V"',
    '    echo "lane_venv:reuse($PYVER)"',
    '  else',
    '    echo "lane_venv:rebuild(venv $VENV_V → $PY_FLOOR_V：docs 栈需要 Python >= ' + floor + ')"',
    '  fi',
    'fi',
    'if [ "$NEW" = 1 ]; then',
    '  rm -rf "$VENV"',
    '  if lane_make_venv floor; then FLOOR=ok',
    '  elif lane_make_venv any; then FLOOR=below',
    '  else echo "FATAL: 找不到能创建 venv 的 python3（macOS: brew install python@3.12 ｜ Debian/Ubuntu: sudo apt install python3-venv ｜ conda: conda create -n py312 python=3.12）"; exit 3',
    '  fi',
    '  echo "lane_venv:new($PYVER)"',
    '  [ -x "$VENV/bin/pip" ] || "$VENV/bin/python" -m ensurepip --upgrade >/dev/null 2>&1 || true',
    `  "$VENV/bin/pip" install --disable-pip-version-check -q ${pipPackages.join(' ')}`,
    'fi',
    'echo "lane_python_chosen:$PY $PYVER"',
    `echo "lane_python_floor:$FLOOR(need >= ${floor} for the docs stack)"`,
  ];
}

/**
 * Docs-side guard: fail EARLY and actionably when the lane's Python is below the
 * floor (instead of letting pip print "No matching distribution found for
 * sphinx<9,>=8", which tells the user nothing).
 */
export function lanePythonFloorGuardSteps(venvBin: string, floor = PYTHON_DOCS_FLOOR): string[] {
  return [
    '# ---- docs stack needs a modern Python: check it BEFORE pip, and explain why ----',
    `PY="${venvBin}/python"`,
    `PYV="$("$PY" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || echo 0.0)"`,
    `if ! awk -v v="$PYV" -v m="${floor}" 'BEGIN { split(v, a, "."); split(m, b, "."); exit (a[1] > b[1] || (a[1] == b[1] && a[2] >= b[2])) ? 0 : 1 }'; then`,
    '  echo "docs_python:below($PYV)"',
    `  echo "托管车道文档栈需要 Python >= ${floor}（sphinx>=8 的最低要求），而车道当前解释器是 $PYV。"`,
    '  echo "  修复：macOS → brew install python@3.12 ｜ Linux/WSL → sudo apt install python3.12 python3.12-venv ｜ conda → conda create -n py312 python=3.12"',
    '  echo "  装好后重跑文档（车道会打印 lane_venv:rebuild 并自动改用新解释器）。构建与测试不受影响。"',
    '  exit 4',
    'fi',
  ];
}
