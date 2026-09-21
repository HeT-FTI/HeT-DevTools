# A Modern C/CPP Library Build System

This project is a C/C++ library built using Conan 2, featuring modern C and C++ standard support and module 
capabilities.

## Badges

![License](https://img.shields.io/github/license/CubicZebra/fcpp?color=blue&label=license)
![CodeFactor Grade](https://img.shields.io/codefactor/grade/github/CubicZebra/fcpp?label=code%20quality&logo=codefactor)
![C++](https://img.shields.io/badge/C%2B%2B-17%2F20%2F23-blue?logo=c%2B%2B&logoColor=white)
![Modules](https://img.shields.io/badge/modules-C%2B%2B23%20experimental-purple?logo=c%2B%2B&logoColor=white)
![CI](https://github.com/CubicZebra/fcpp/actions/workflows/ci-build-test.yml/badge.svg)
![CI](https://github.com/CubicZebra/fcpp/actions/workflows/docs-build.yml/badge.svg)
![CMake](https://img.shields.io/badge/cmake-3.28%2B-orange?logo=cmake)
![Python](https://img.shields.io/badge/python-3.10%2B-blue?logo=python)
![Doxygen](https://img.shields.io/badge/docs-Doxygen-green?logo=doxygen&logoColor=white)
![Sphinx](https://img.shields.io/badge/docs-Sphinx-blue?logo=readthedocs&logoColor=white)

## Project Overview

- **Language**: C/C++
- **Library Build System**: Python with Conan 2.0
- **File Build System**: Doxygen, Graphviz, Sphinx
- **Module Support**: Optionally activated, when C++ standard ≥ 23
- **Metadata-Driven**: `metadata.json` is the single source of truth (build, deps, docs, CI)
- **Skills & Agent**: library-level `het-*` skills + routing agent (`.github/skills/`)
- **Component Structure**:
    - pairwise header and source assumption
    - suffix distinguishment, (.h, .c) for C part, and (.hpp, .cpp) for C++ part
    - documenting system uses .dox for pure docstring, .cxx for examples codes; both are
      documentation-only and live exclusively under `docs/doxygen/dox/`, never in `include/`/`src/`

## Features

- Conan-based modern dependency management
- Supports C++ standards 17, 20, and 23
- Automatic module file generation (`.ixx`/`.cppm`) from headers/sources
- Cross-platform compatibility (Windows, Linux, macOS)
- Dual C and C++ interfaces with separate linkage targets
- Doxygen annotation support for object exporting (`@exporter`, `@attacher`)
- Automation documenting system via Doxygen and Sphinx
- Importation, derivation and call relationship illustration through Graphviz
- `metadata.json` as the single source of truth (build / deps / docs / CI)
- Library-level VS Code skills + routing agent (`.github/skills/`, `/het-*` slash commands)
- Metadata + gitmoji driven CI/CD orchestration (GitHub Actions)
- Cross-compilation & on-board benchmark framework (`benchmark/`)
- Agentic Coding workspace (`/workspace/`, git-ignored)

## Agentic Coding Workspace

The template reserves `/workspace/` (declared in `.gitignore`) for agent-generated work products produced
during Agentic Coding sessions — e.g., implementation plans, test contracts, audit reports, and other
intermediate artifacts. Keep such working files under `/workspace/` so they never pollute the tracked
source tree.

## Skills & Agent (VS Code)

The template ships a library-level skills system under `.github/skills/` — **15 `het-*` skills plus one
routing agent**, all invocable from Copilot Chat by typing `/`:

| Family | Skills | Audience |
|--------|--------|----------|
| IaC usage (S0–S6) | `het-guide`, `het-build`, `het-release`, `het-docs`, `het-quality`, `het-board`, `het-fix-ci` | CI/CD novices |
| Dev automation (N1–N8) | `het-deps`, `het-module`, `het-setup`, `het-testgen`, `het-commit`, `het-audit`, `het-preflight`, `het-patent` | Developers |
| Routing agent (A1) | `het-agent` | Everyone |

Examples: `/het-guide` for onboarding, `/het-testgen` to generate tests, `/het-agent` for natural-language
composite tasks (e.g. *"add a module, test it, and commit"*). See `.github/skills/README.md` and
`PLAN-skills.md` for the full execution plan.

## Build Requirements

- Python 3.10+ (Conan tooling)
- Conan 2.0+
- Compatible C/C++ compiler:
    - GCC
    - Clang
    - MSVC
- CMake (auto-installed by Conan)

## Documenting Requirements

- Doxygen
- Graphviz
- sphinx
- sphinx-intl
- sphinx-rtd-theme

## Test Requirements

- GTest

## CI/CD (metadata-driven)

All GitHub Actions workflows are orchestrated from `metadata.json` (entry: `ci-orchestrator.yml`, decision:
`metadata-controller.yml`). Each pipeline is gated by a `workflow_triggers.*` switch and triggered by a
gitmoji in the commit message. The canonical commit form is `<type>(<emoji>): <description>` — the emoji
sits in the parentheses right after the commit word (e.g. `feat(:fire:): ...`, `chore(:package:): ...`);
as a **soft rule** the emoji also triggers from anywhere in the message:

| Pipeline | gitmoji in commit message | Gate (`metadata.json`) |
|----------|---------------------------|------------------------|
| Build | `:building_construction:` | `workflow_triggers.build` |
| Tests + coverage | `:beer:` | `trigger_tests` / `activate_code_coverage` |
| Release | `(:package:):` | `workflow_triggers.release` + the gitmoji in the pushed commits |
| Docs | `:book:` | `workflow_triggers.docs` |
| Security / lint | `:shield:` | `workflow_triggers.security_scan` (also runs on every PR) |
| Online cross-compile | `:hammer_and_wrench:` | `workflow_triggers.cross_compile` (Conan cross-build from a generated profile; decoupled: the emoji starts only this one) |
| Board cross-build | `:fire:` (or `🔥`) | hetai self-hosted runner |

> **Note**: `workflow_triggers.build` / `.tests` / `.docs` / `.security_scan` / `.cross_compile` are
> enabled by default (commit-lint & schema gates always run on push/PR; build/tests/security
> shift-left on PRs).
> `release` needs both halves: the switch is the standing permission, the gitmoji is this push's
> intent. `build_type` is the project's default build type and gates nothing.

## Crash Course of Build

### 1. Build then test your library

inplace build and test

```bash
conan create . -s build_type=Debug --build=missing
```

cross-build to host device (assume toolchain and profile are ready):

```bash
conan create . -pr:b=default -pr:h=arm_profile -s build_type=Debug --build=missing -tf=""
```

### 2. Build documentations

```bash
python ./docs/build.py
```

### 3. Full local pass

Steps 1-2 end to end, then drop the local package. `build_type` is the one `metadata.json` declares,
and the package name is yours — there is nothing to edit here:

```bash
conan create . -pr:b=default -pr:h=default -s build_type=Debug --build=missing
python ./docs/build.py
python ./test_package/conanfile.py
conan remove "<your-package>/*" --confirm
```

### 4. Add requirements

Add your required libraries in *conandata.yml* where dependency graph is automatically computed from, then 
modify the **dependencies** field in *metadata.json* to config proper package names and associated targets to 
link (no need modification on *CMakeLists.txt*).

Requirements for your project can be the package archived on [Conan Center](https://conan.io/center), or user 
built ones. If the later one, at least you need a locale Conan server for managing your libraries.

### 5. Run MegaLinter locally (blocking SAST)

MegaLinter mirrors the CI `megalinter` job (`.github/workflows/security-linters.yml`): same config
(`.github/misc/.mega-linter.yml`), same full image, and the same version (`v8.8.0`, pinned to match the
CI action). It runs the SAST layer — gitleaks / semgrep / checkov / devskim, plus clang-format
& cppcheck. The **required** gates (clang-format / clang-tidy / gitleaks with pinned tool versions) are the
native `quality-gates` job of the same workflow.

Prerequisites: Docker (or Podman) + Node.js ≥ 20.

```bash
bash .github/misc/run-megalinter.sh             # lint the whole codebase
bash .github/misc/run-megalinter.sh --fix       # auto-apply fixes (e.g. clang-format)
bash .github/misc/run-megalinter.sh src/foo.c   # lint selected files only
CONTAINER_ENGINE=podman bash .github/misc/run-megalinter.sh   # Podman users
```

- The first run pulls the `v8.8.0` image (a few GB — cached on later runs).
- Reports are written to `megalinter-reports/` (git-ignored); per-linter details are in
  `megalinter-reports/linters_logs/ERROR-*.log`.
- The runner (`mega-linter-runner`) is a devDependency — `npm ci` installs it, or it is fetched
  automatically on first use.

## All-in-one Project Structure

```
project-root/
├── conanfile.py              # Conan recipe
├── CMakeLists.txt            # CMake build framework
├── metadata.json             # Project metadata configuration (single source of truth)
├── conandata.yml             # Dependency specifications, Conan plugin support
├── package.json              # Node-side tooling deps (commitlint / semantic-release / ajv)
├── CHANGELOG.md              # Auto-generated by semantic-release (init tag required)
├── build                     # One-liner local build script
├── LICENSE                   # Apache v2 Project license
├── NOTICE                    # Notice file of Apache v2
├── .vscode/                  # Recommended editor config (extensions / settings / tasks)
├── .devcontainer/            # Reproducible dev environment (Dockerfile)
├── .github/                  # CI/CD + library-level skills
│   ├── workflows/            # ci-orchestrator / metadata-controller / build / test / docs / release / security
│   ├── skills/               # 16 het-* skills + het-agent + _shared + manifest.json
│   ├── misc/                 # clang-format(-c/cpp) / clang-tidy / gitleaks / releaserc / commitlint /
│   │                         # metadata.schema / mega-linter / pre-commit / labels / Codegen-Starter.txt
│   ├── CODEOWNERS            # Required reviewers
│   ├── CONTRIBUTING.md       # Contribution & commit conventions
│   ├── dependabot.yml        # Grouped monthly dependency updates
│   └── PULL_REQUEST_TEMPLATE.md
├── api/                      # Interface to advanced programming language
│    └── python_bindings.cpp  # Python bindings interface
├── include/                  # Public headers
│   ├── *.h                   # C interface headers
│   └── *.hpp                 # C++ interface headers
├── src/                      # Implementation files
│   ├── *.c                   # C sources
│   ├── *.cpp                 # C++ sources
│   └── *.ixx/*.cppm          # Auto-generated Module files (in experimental)
├── benchmark/                # Cross-compile & on-board benchmark framework (Cortex-M / Cortex-A)
├── .hetai/                   # hetai package matrix (cross-compile targets)
├── wokspace/                 # Agentic Coding work products (git-ignored)
├── docs/                     # Documentations root
│   ├── doxygen/              # Doxygen system main root
│   │   ├── dox/              # Pure documentations' folder (the only home of .dox/.cxx)
│   │   │   ├── demos/        # Examples catalogue (hand-written, standalone)
│   │   │   │   ├── *.dox     # Documenting docstring
│   │   │   │   └── *.cxx     # Example codes
│   │   │   └── *.dox         # Main pages and etc
│   │   └── ...
│   ├── sphinx/               # Sphinx system main root
│   │   ├── source/           # Source files of sphinx system
│   │   ├── locales/          # Pot files for internalization
│   │   └── ...
│   └── images/               # Static images for doxygen/sphinx system
└── test_package/             # Test project
    ├── export/               # Log for testing results
    ├── resources/            # Test resources for test_package/ programs
    ├── stress/
    │   └── *.cpp             # Scripts for stress testing
    ├── unit/
    │   └── *.cpp             # Scripts for unit testing
    ├── main.cpp              # Validation program for package
    ├── conanfile.py          # Conan recipe for test_package
    └── CMakeLists.txt        # CMake build workflow for test_package
```

> **Suffix rule**: `.dox` and `.cxx` are **documentation-only**. They live exclusively under
> `docs/doxygen/dox/` as hand-written standalone files (`mainpage.dox`, `demos/*.dox`,
> `demos/*.cxx`) and are never written as a docstring inside `include/` or `src/`, which carry
> `.h/.c/.hpp/.cpp` only. A complete doc set is a landing page plus a tutorial; example code is
> optional (0..N `.cxx` per `.dox`, no pairing) and `docs/build.py` fails the build when any of
> those properties breaks.

## Module Generation (experimental)

When `generate_modules_inplace` is enabled in `metadata.json`:

1. Header/source pairs automatically generate module files
2. `#include` directives are converted to `import` statements
3. Doxygen annotations control symbol visibility:
    - `@exporter`: Exports symbols in modules
    - `@attacher`: Attaches symbols to modules

This feature is experimental now, however, the specific syntax can make the existing project a ease 
migration to fit the future C++ standard.

## Compiler Support Matrix

| Feature          | MSVC | Clang | GCC | Apple-Clang |
|------------------|------|-------|-----|-------------|
| C++ Modules      | ✓    | ✓     | ✓   | ✓           |
| C Compatibility  | ✓    | ✓     | ✓   | ✓           |
| Automatic Export | ✓    | ✓     | ✓   | ✓           |

## Platforms Support

- **Desktop**: Windows, Linux, MacOS
- **Mobile**: arm-linux, risc-v

## Downstream Contract (HeT DevTools)

This template is also built by the **HeT DevTools** VS Code extension in a *managed lane*: it creates its
own private venv / `CONAN_HOME` and a **generated** Conan profile instead of probing the user's machine.
The interfaces below are **backward compatible** — by default the behaviour is byte-for-byte the CI one.

| Interface | Value | Default | Meaning |
|---|---|---|---|
| `HET_CMAKE_MIN` | version string (e.g. `3.15`) | unset | Overrides the `cmake_minimum_required` floor (CI baseline is 3.28) |
| `HET_CMAKE_BUILD_REQUIRE` | `none` or a version | unset | Skips / replaces the ConanCenter `cmake/<metadata.cmake_version>` (read by **both** recipes) |
| `metadata.graphviz_bin` | directory path | **absent** | Absent = use `dot` from `PATH`. This is a **machine-specific** field and normally should not be committed |
| `conancenter` remote name | keep the standard name | — | A downstream private `CONAN_HOME` may point it at a corporate mirror — never assume its URL |
| Coverage artifact | `test_package/test/export/coverage/coverage_summary.json` | — | **Parse the JSON, not the HTML.** The `coverage_report/index.html` path stays a stable artifact, but its layout belongs to genhtml and may be restyled at any release. CI publishes the lcov leg as the canonical `Coverage-report` artifact and keeps `Coverage-report-<os>-<ts>` as per-leg evidence |
| `user.het:run_tests` | conan conf (`-c user.het:run_tests=False`) | `True` | Narrows `metadata.trigger_tests` for one run and leaves the library uninstrumented — what the build-only CI legs do. Namespaced to the template, not to the package, so a rename never has to touch it |

(The implementations live in `CMakeLists.txt`, `conanfile.py`, `test_package/conanfile.py` and `docs/build.py`.)

## Benchmark (on-board)

`benchmark/` cross-compiles the library to real hardware and measures performance on-board:

- **Cortex-M (baremetal)**: flash via JLink / OpenOCD / PyOCD, timing via SYSTICK
- **Cortex-A (Linux)**: deploy via ADB / SSH, timing via `clock_gettime`

Edit `benchmark/bench_config.json` (board parameters) and `benchmark/bench_entry.c` (algorithm cases),
then run `python benchmark/script/run_bench.py` (add `--no-flash` to build only). Results follow the
`BENCHMARK_START / RESULT|name|cycles / BENCHMARK_END` protocol. See `benchmark/README.md`.

> Role split: `test_package/` runs **host-side** GTest verification (desktop/x86_64, even when the library
> is cross-compiled to baremetal), while `benchmark/` runs **target-side** on-board verification.

## Commit Convention & Versioning

Commit style uses the [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/)
specification, extended with the template's private **emoji superset** (see the CI/CD table above) so a
single message both bumps the version and triggers the right pipeline.

**Canonical commit form** — the emoji is placed in the parentheses right after the commit word:

```
<type>(<emoji>): <description>
```

Examples: `feat(:fire:): cross-compile support`, `test(:beer:): vector add cases`,
`chore(:package:): prepare release`. As a soft rule, the emoji anywhere in the message also triggers the
pipeline, but the parenthesized placement is the recommended convention.

Versioning is driven by **semantic-release** (`semver-release.yml` + `.github/misc/.releaserc.json`): the commit prefix
decides the jump — `feat` → minor, `fix`/`perf` → patch, `BREAKING CHANGE`/`!` → major. A release
generates `CHANGELOG.md` and rewrites the `version` in `metadata.json`. (The legacy
commit-base-versioning mechanism has been removed.)

## To Do Things

Possible frame design/validation on Apple Clang compiler (raised from dlib requirement).

## License

[Apache-2.0] - See included LICENSE file for details.

