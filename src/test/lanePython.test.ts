import * as assert from 'node:assert';
import { PYTHON_DOCS_FLOOR, PYTHON_VERSIONED_NAMES, lanePythonFloorGuardSteps, laneVenvBootstrapSteps, pythonFloorOk } from '../core/lanePython';

describe('lane Python policy (docs floor + host-first interpreter pick)', () => {
  // env-fresh · macos run 34927513753: the picker preferred the hardcoded
  // /usr/bin/python3 (macOS 3.9.6) over the `python3` on PATH (3.14.7) →
  // `pip install "sphinx<9,>=8"` → "No matching distribution found".
  it('compares MAJOR.MINOR against the docs floor (unknown never passes)', () => {
    assert.ok(pythonFloorOk('3.10'));
    assert.ok(pythonFloorOk('3.14'));
    assert.ok(pythonFloorOk('4.0'));
    assert.ok(!pythonFloorOk('3.9'));
    assert.ok(!pythonFloorOk('3.9.6'), 'three components are not the version format we probe with');
    assert.ok(!pythonFloorOk('0.0'), 'unknown interpreter must not satisfy the floor');
    assert.ok(!pythonFloorOk(''));
    assert.ok(pythonFloorOk('3.11', '3.10'));
  });

  it('emits a host-first, newest-first candidate ladder (system python last)', () => {
    const shell = laneVenvBootstrapSteps('/lane/venv', ['"conan>=2.0,<3"']).join('\n');
    for (const n of PYTHON_VERSIONED_NAMES) {
      assert.ok(shell.includes(n), `probes ${n}`);
    }
    assert.ok(shell.includes('command -v "$n"'), 'resolves candidates from PATH');
    assert.ok(shell.includes('lane_add "$CONDA_PY"'), 'the user conda python stays a candidate');
    let last = -1;
    for (const n of PYTHON_VERSIONED_NAMES) {
      const at = shell.indexOf(n);
      assert.ok(at > last, `${n} must be probed newest-first`);
      last = at;
    }
    const system = shell.indexOf('lane_add /usr/bin/python3');
    assert.ok(last < system, '/usr/bin/python3 is only a last resort (the 3.9 trap)');
    assert.ok(shell.indexOf('lane_add "$CONDA_PY"') < system, 'conda python outranks the system python');
  });

  it('prefers a floor-satisfying interpreter and falls back so BUILDING still works', () => {
    const shell = laneVenvBootstrapSteps('/lane/venv', ['"conan>=2.0,<3"'], PYTHON_DOCS_FLOOR).join('\n');
    assert.ok(shell.includes('if lane_make_venv floor; then FLOOR=ok'));
    assert.ok(shell.includes('elif lane_make_venv any'), 'still creates a venv without a modern python');
    assert.ok(shell.includes('lane_venv:new('), 'reports what it created (evidence); `lane_python_floor:below` says why docs will refuse');
    assert.ok(shell.includes('exit 3'), 'no venv-capable python at all is fatal');
    assert.ok(shell.includes('lane_python_chosen:') && shell.includes('lane_python_floor:'), 'reports the choice + floor status');
    assert.ok(shell.includes('lane_venv:rebuild('), 'a too-old venv is rebuilt once a newer python shows up');
    assert.ok(shell.includes('/lane/venv'), 'targets the lane-private venv');
    assert.ok(shell.includes('"conan>=2.0,<3"'), 'installs the lane build tooling');
    assert.doesNotMatch(shell, /--user/u, 'never installs into the user site-packages');
  });

  it('reuses a ready venv unless its interpreter is below the floor', () => {
    const shell = laneVenvBootstrapSteps('/lane/venv', [], PYTHON_DOCS_FLOOR).join('\n');
    assert.ok(shell.includes('lane_venv:reuse('));
    assert.ok(/if lane_py_ok "\$VENV_V" \|\| \[ -z "\$PY_FLOOR_C" \]/u.test(shell), 'no modern python present → keep the working venv (no churn)');
  });

  it('guards the docs stack with an actionable message instead of pip noise', () => {
    const guard = lanePythonFloorGuardSteps('/lane/venv/bin').join('\n');
    assert.ok(guard.includes('docs_python:below('), 'a machine-readable marker for the log/evidence');
    assert.ok(guard.includes(`>= ${PYTHON_DOCS_FLOOR}`), 'names the floor');
    assert.ok(guard.includes('brew install python@3.12'), 'macOS conventional command');
    assert.ok(guard.includes('apt install python3.12'), 'Linux conventional command');
    assert.ok(guard.includes('conda create -n py312 python=3.12'), 'conda conventional command');
    assert.ok(guard.includes('lane_venv:rebuild'), 'tells the user the lane will rebuild itself afterwards');
    assert.ok(guard.includes('exit 4'), 'fails BEFORE pip resolves (own exit code)');
  });
});
