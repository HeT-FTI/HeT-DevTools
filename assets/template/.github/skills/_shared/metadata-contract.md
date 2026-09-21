# metadata.json Contract（契约：单一驱动源）

> fcpp drives everything from `metadata.json`: CMake, main recipe, test_package and CI controller all read it. Before changing any field, confirm all consumers stay consistent. 修改任何字段前必须确认所有消费方行为一致。

## Fields & Consumers（字段与消费方）

### Basics（基础信息）
| Field（字段） | Consumers（消费方） | Note（说明） |
|------|------|------|
| `name` | all | package name → target prefix, package ref |
| `version` | all | rewritten by semantic-release |
| `target` | CMake/package | `auto` = `${name}::${name}` |
| `build_cppstd` | CMake + recipe + profile generators | Injected by **two** routes: `conanfile.py` sets `settings.compiler.cppstd` (so it joins `package_id` and dependency compatibility) **and** CMake sets `CXX_STANDARD` per target. Both recipes silently fall back to 17 for anything outside 17/20/23, so `metadata.schema.json` restricts the field to that enum — an unsupported value must fail the Metadata Schema job, not quietly become C++17 |
| `build_cstd` | CMake only | `C_STANDARD` + `C_STANDARD_REQUIRED ON` per C target. Conan has **no** `compiler.cstd` setting, so it cannot reach `package_id` — enforced, but by one route only |
| `cmake_version` | both recipes (`build_requirements()`) | Pins `cmake/<version>`, overridable by `HET_CMAKE_BUILD_REQUIRE`. **Floor 4.2**: below it CMake cannot name the `Visual Studio 18 2026` generator Conan derives for msvc 195, so the recipe refuses that pair up front instead of letting CMake fail on an unknown generator name |
| `build_type` | The **one** build type every CI leg builds: the orchestrator hands it to both chains. **Does NOT gate any pipeline** — a switch is permission, a state must not be a predicate. To exercise Release, change this value and push a `:beer:` commit; the build chain then compiles Release on all three platforms |
| `is_shared` / `is_header` | CMake | shared forced to static on Windows |
| `generate_modules_inplace` | recipe | auto-generate .ixx/.cppm modules |
| `std_modules` / `user_modules` | recipe | import conversion |

### Dependency Contract（依赖契约，最关键）
```json
"dependencies": {
  "common": {"<pkg>": ["<CMake target>"]},   // shared by C/C++ targets（双目标共享）
  "c":      {"<pkg>": ["<CMake target>"]},   // C target only
  "cpp":    {"<pkg>": ["<CMake target>"]},   // C++ target only
  "infra":  {"<pkg>": ["<CMake target>"]}    // host-side infra (GTest / pybind11)
}
```

**Semantic rules（不可违背）**
1. **One package in one bucket only**; `common` = shared by both targets. 一个包只放一个桶。
2. **GTest belongs to test_package only** (host-side desktop verification), never in the main package's component requires. GTest 只归 test_package。
3. **pybind11 enters the main package only when `enable_python_bindings=true`** (gated in both main recipe and test_package). pybind11 跟随开关。
4. Keys differ in case from conandata package names (`Eigen3` vs `eigen`) — always compare lowercase. 键名与 conandata 包名大小写不同，统一小写归一。

### Switches（开关）
| Field（字段） | Purpose（作用） |
|------|------|
| `trigger_tests` | run GTest (CI + test_package) |
| `activate_code_coverage` | coverage (lcov + genhtml) |
| `saving_tests_log` | save test log |
| `enable_python_bindings` | build pybind11 module |
| `workflow_triggers.*` | CI master switches (build/tests/release/docs/security_scan/cross_compile); **all false = gitmoji triggers nothing**; on by default: build/tests/docs/security_scan/cross_compile (only `release` is off); `cross_compile` is not part of PR shift-left |
| `baremetal_white_list` | baremetal cross-compile whitelist (default `["etl","ArduinoJson"]`); applied in both deps & requirements |

### Run-time Knobs（运行期旋钮，不进 metadata）
| Knob（旋钮） | Form（形式） | Purpose（作用） |
|------|------|------|
| `user.het:run_tests` | conan conf: `-c user.het:run_tests=False` | Narrows `trigger_tests` for **one run** and leaves the library uninstrumented. This is how the build-only CI leg reuses the same recipes — an `--coverage` library cannot be linked by a plain consumer, so the two sides must never disagree. The namespace is the **template's**, not the package's: a derived project renames itself, and nothing about this knob should have to follow |
| `HET_CMAKE_BUILD_REQUIRE` | env var: `none` or a version | Escape hatch for `cmake_version` (read by both recipes) |

### Docs（文档）
| Field | Purpose |
|------|------|
| `doc_languages` / `doc_versions` | docs/build.py multi-language/version |
| `doc_doxygen_folders` / `doc_doxygen_suffix` | Doxygen scan scope; the suffix list applies to every folder, so it does **not** enforce that `.dox`/`.cxx` stay under `docs/doxygen/dox/` (see `code-conventions.md`) |

## Common Mistakes（易错点）

1. Adding GTest to `dependencies.cpp` → pollutes downstream (benchmark). 污染下游。
2. Reading a metadata key from `self.conandata` (wrong source) → `None` crash; use `self.meta`. 读错数据源会崩。
3. `workflow_triggers.*` all false but expecting CI → turn on first. 开关全关却期望触发。
4. Whitelist case mismatch (`Eigen3` vs `eigen`) → normalize lowercase. 大小写统一小写。
5. Building a coverage library and linking a plain `main` → `undefined reference to __gcov_init`. Coverage is one decision for the whole build, injected by the recipe; never let the two sides disagree. 插桩库不能链接未插桩消费者。

