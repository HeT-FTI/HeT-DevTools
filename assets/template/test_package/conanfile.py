from conan import ConanFile
from conan.tools.cmake import CMake, cmake_layout, CMakeToolchain
from conan.tools.build import can_run, cross_building
from conan.tools.files import copy
from conan.tools.env import VirtualRunEnv, VirtualBuildEnv
from pathlib import Path
import subprocess
import shutil
import json
import yaml
import re
import sys
import os
sep = os.path.sep
MAIN_CPP = 'main.cpp'
_get_file_name = (lambda x: x.split(sep)[-1])


def _clear_test_build():
    _build = sep.join(__file__.split(sep)[:-1] + ['build'])
    _presets = sep.join(__file__.split(sep)[:-1] + ['CMakeUserPresets.json'])
    if os.path.exists(_build):
        shutil.rmtree(_build)
    if os.path.exists(_presets):
        os.remove(_presets)


def _recursive_find(root: str, obj_files: list[str]):
    for f in os.listdir(root):
        _f = root + sep + f
        if not os.path.isdir(_f):
            if f in obj_files:
                yield _f
        else:
            yield from _recursive_find(_f, obj_files)


def _entry_lists() -> list[str]:
    return ['#include <gtest/gtest.h>\n',
            '\n',
            '\n',
            'int main(int argc, char **argv) {\n',
            '    ::testing::InitGoogleTest(&argc, argv);\n',
            '    return RUN_ALL_TESTS();\n',
            '}\n']


def _source_relpath(tracefile_path: str) -> str:
    """Trim a tracefile's absolute path to the project-relative part, so two platforms can compare file sets."""
    _normalised = tracefile_path.replace('\\', '/')
    for _root in ('/src/', '/include/', '/api/'):
        _at = _normalised.rfind(_root)
        if _at != -1:
            return _normalised[_at + 1:]
    return _normalised.rsplit('/', 1)[-1]


class PackageTestConan(ConanFile):
    settings = "os", "compiler", "build_type", "arch"
    export_sources = "resources/*"
    generators = "CMakeDeps"

    conandata, metadata = None, None

    def init(self):
        conandata_path = Path(self.recipe_folder).parent / "conandata.yml"
        self.conandata = yaml.safe_load(conandata_path.read_text())
        metadata_path = Path(self.recipe_folder).parent / "metadata.json"
        self.metadata = yaml.safe_load(metadata_path.read_text())

    def build_requirements(self):
        # escape: HET_CMAKE_BUILD_REQUIRE=none also skips the test package's 45 MB cmake
        _override = (os.environ.get('HET_CMAKE_BUILD_REQUIRE') or '').strip()
        if _override.lower() == 'none':
            return
        self.build_requires(f"cmake/{_override or self.metadata.get('cmake_version')}")

    def requirements(self):
        self.requires(self.tested_reference_str)
        for req in self.conandata.get("requirements", []):
            self.requires(req)

    def _tests_enabled(self):
        """Whether this run builds and runs the suite; `-c user.het:run_tests=False` is the build-only leg."""
        return bool(self.metadata.get('trigger_tests')) and \
            self.conf.get('user.het:run_tests', default=True, check_type=bool)

    def generate(self):
        self._add_entries()
        build_env, run_env = VirtualBuildEnv(self), VirtualRunEnv(self)
        build_env.generate()
        run_env.generate(scope="run")

        tc = CMakeToolchain(self)
        lib_name = self.tested_reference_str.split("/")[0]
        tc.variables["LIB_NAME"] = lib_name
        tc.variables["CXX_DEPS"] = self._get_targets()
        tc.variables["TRIGGER_TESTS"] = self._tests_enabled()
        # coverage reads the gcda files the instrumented tests leave behind, so it rides the same switch
        tc.variables['ENABLE_COVERAGE'] = self._tests_enabled() and self.metadata.get('activate_code_coverage')
        tc.variables["MAIN_LIB_TARGET"] = [_a := self.metadata.get('target'),
                                           f'{lib_name}::{lib_name}' if _a == 'auto' else _a][-1]
        tc.variables["RESOURCES_PATH"] = os.path.join(self.build_folder, "resources").replace("\\", "/")
        tc.generate()

        src_folder = os.path.join(self.recipe_folder, "resources").replace("\\", "/")
        dst_folder = os.path.join(self.build_folder, "resources").replace("\\", "/")
        os.makedirs(dst_folder, exist_ok=True)
        copy(self, "*", src=src_folder, dst=dst_folder, keep_path=True)

    def _preparing_deps_links(self):
        _common, _c, _cpp, _infra = [self.metadata.get('dependencies').get(_) for _ in ['common', 'c', 'cpp', 'infra']]
        _c = {k: v if k not in _common.keys() else list(set(v).union(set(_common.get(k)))) for k, v in _c.items()}
        _cpp = {k: v if k not in _common.keys() else list(set(v).union(set(_common.get(k)))) for k, v in _cpp.items()}

        if not self.metadata.get('enable_python_bindings'):
            _infra.pop("pybind11", None)
        
        _infra_deps = [f"{k}@{' '.join(v)}" for k, v in _infra.items()]
        _c_deps = [f"{k}@{' '.join(v)}" for k, v in {**_common, **_c}.items()]
        _cpp_deps = [f"{k}@{' '.join(v)}" for k, v in {**_common, **_cpp}.items()]
        return list(set(_c_deps).union(set(_cpp_deps)).union(set(_infra_deps)))

    def _get_targets(self):
        _targets, _name = self.metadata.get('target'), self.metadata.get('name')
        if _targets is None or _targets == 'auto':
            _targets = [f'{_name}@{_name}::{_name}']
        else:
            _targets = [f'{_name}@{_targets}']
        _targets.extend(self._preparing_deps_links())
        return _targets

    def build(self):
        cmake = CMake(self)
        cmake.configure()
        cmake.build()

    def layout(self):
        cmake_layout(self)

    def configure(self):
        supported_compilers = {"gcc", "msvc", "clang", "apple-clang", }  # no support for 'Visual Studio' in Conan1.0
        compiler = getattr(self.settings, 'compiler')
        if compiler.__str__() in supported_compilers:
            _build_std = self.metadata.get("build_cppstd")
            _build_std = "17" if _build_std not in {"17", "20", "23"} else _build_std  # fallback
            compiler.cppstd = _build_std

    def test(self):

        # defensive logic for cross_building
        if cross_building(self):
            self.output.info("Cross-compilation detect. Skipping test execution.")
            return

        # set LLVM_PROFILE_FILE before main/ctest: the runtime picks its path at process start
        if self._is_llvm_coverage():
            self._prepare_llvm_profile_env()

        # scripting in test_package/main.cpp
        if can_run(self):
            cmd = os.path.join(self.cpp.build.bindirs[0], "main")
            self.run(cmd, env="conanrun")

        # test cases in test_pacakge/test/*.cpp
        if self._tests_enabled():
            self._run_ctest_suite()

            if self.metadata.get('activate_code_coverage'):
                self._code_coverage_auto()

    def _run_ctest_suite(self):
        try:
            if can_run(self):
                cmake = CMake(self)
                cmake.test()
        except (Exception, ) as err:
            print('CTest Crashed:', err)
        finally:
            target_folder = self.recipe_folder + sep + 'test' + sep + 'export'

            if self.metadata.get('saving_tests_log'):
                obj_folder = self.recipe_folder + sep + 'build'
                report = next(iter(_recursive_find(obj_folder, ['LastTest.log'])))
                with open(report, 'r', encoding='utf-8') as f:
                    _content = f.readlines()
                if not os.path.exists(target_folder):
                    os.mkdir(target_folder)
                with open(target_folder + sep + 'TestResult.log', 'w', encoding='utf-8') as f:
                    f.write(''.join(_content))
            elif os.path.exists(_f := target_folder + sep + 'TestResult.log'):
                os.remove(_f)

            self._remove_entries()

    def _compiler_name(self):
        return getattr(self.settings, 'compiler').__str__()

    def _is_llvm_coverage(self):
        """True when coverage is on and the toolchain writes LLVM raw profiles."""
        return bool(self.metadata.get('activate_code_coverage')) and \
            self._compiler_name() in ('clang', 'apple-clang')

    def _profraw_folder(self):
        return self.recipe_folder + sep + 'build' + sep + 'profraw'

    def _prepare_llvm_profile_env(self):
        """Send every LLVM raw profile to one folder, one file per process.

        The runtime only writes where it is told at process start, and two
        processes sharing a name would clobber each other, hence `%p`. Setting
        it in os.environ is enough: conan runs the binaries through
        ``Popen(..., shell=True)`` without an explicit ``env``, so children
        inherit the environment we set here.
        """
        _folder = self._profraw_folder()
        if os.path.exists(_folder):
            shutil.rmtree(_folder)
        os.makedirs(_folder)
        os.environ['LLVM_PROFILE_FILE'] = _folder + sep + 'het-%p.profraw'
        self.output.info(f"[coverage:llvm] LLVM_PROFILE_FILE={os.environ['LLVM_PROFILE_FILE']}")

    def _coverage_folder(self):
        """`<recipe>/test/export/coverage`, recreated empty.

        Its `coverage_report/` subfolder is the artifact downstream parses, so
        the layout is a contract (C3) -- both coverage paths must use this.
        """
        target_folder = self.recipe_folder + sep + 'test' + sep + 'export'
        coverage_folder = target_folder + sep + 'coverage'
        if not os.path.exists(target_folder):
            os.mkdir(target_folder)
        else:
            if os.path.exists(coverage_folder):
                shutil.rmtree(coverage_folder)
        os.mkdir(coverage_folder)
        return coverage_folder

    def _package_root(self):
        """Root of THIS package's entry inside the conan cache.

        `conan cache path <ref>` prints the PACKAGE folder of the cache entry:
          <CONAN_HOME>/p/b/<pkgname-prefix><hash>/p
        Its parent is the entry root that holds this package's b/ (build +
        copied sources) and p/ trees -- the only reliable scope for our code.
        """
        _name, _ver = [self.metadata.get(_) for _ in ['name', 'version']]
        _tmp = subprocess.run(["conan", "list", f"{_name}/{_ver}:*"], capture_output=True, text=True)
        _tmp_ref = [str(_).strip() for _ in _tmp.stdout.split('\n')]
        _marked = [i for i, _ in enumerate(_tmp_ref) if _ == 'packages']
        if not _marked:
            raise RuntimeError(f'conan list {_name}/{_ver}:* listed no package; '
                               f'cannot scope the coverage report')
        _pkg_uid = _tmp_ref[_marked[0] + 1]
        _tmp = subprocess.run(["conan", "cache", "path", f"{_name}/{_ver}:{_pkg_uid}"],
                              capture_output=True, text=True)
        _pkg_folder = _tmp.stdout.strip()
        _pkg_root = sep.join(_pkg_folder.split(sep)[:-1])
        if not _pkg_root:
            raise RuntimeError(f'conan cache path {_name}/{_ver}:{_pkg_uid} returned "{_pkg_folder}"')
        return _pkg_root

    def _instrumented_binaries(self, build_folder):
        """The instrumented executables of this test package.

        `llvm-cov export` consumes binaries (the gcc path can consume
        .gcda/.gcno instead), and which executables exist is only known after
        the test package is configured, so derive them from ctest's own
        metadata rather than hard-coding names.

        Two sources are needed, and taking only the first is a trap:
          * every target gtest discovery ran, i.e. each `<target>[<n>]_*.cmake`
            -- this is the only way to reach `main`, which defines no TEST()
            and therefore never shows up in an `add_test` command, yet is the
            executable that links the library and so carries the coverage we
            actually want;
          * the `add_test` commands, which give the executables ctest runs.
        """
        _add_test = (r'add_test\s*\(\s*(?:\[=\[.*?\]=\]|"[^"]*"|\S+)\s+'
                     r'(?:\[=\[.*?\]=\]|"([^"]+)"|(\S+))')
        _discovered = r'([^/\\"]+)\[\d+\]_(?:tests|include)\.cmake'

        _paths, _names = [], set()
        for _cmake_file in sorted(Path(build_folder).rglob('CTestTestfile.cmake')) + \
                sorted(Path(build_folder).rglob('*_tests.cmake')):
            for _m in re.finditer(_discovered, _cmake_file.name):
                _names.add(_m.group(1))
            _text = _cmake_file.read_text(encoding='utf-8', errors='replace')
            for _m in re.finditer(_discovered, _text):
                _names.add(_m.group(1))
            for _m in re.finditer(_add_test, _text):
                _bin = _m.group(1) or _m.group(2)
                if _bin and os.path.isfile(_bin):
                    _paths.append(_bin)

        for _name in sorted(_names):
            _direct = os.path.join(build_folder, _name)   # single-config layout
            if os.path.isfile(_direct):
                _paths.append(_direct)
                continue
            _hits = [str(_) for _ in Path(build_folder).rglob(_name) if _.is_file()]
            _paths.extend(sorted(_hits))

        _found, _seen = [], set()
        for _p in _paths:
            _key = os.path.realpath(_p)      # add_test paths and the joined
            if _key not in _seen:            # ones may be different spellings
                _seen.add(_key)              # of the same executable
                _found.append(_p)
        return _found

    def _clang_coverage_tools(self):
        """Resolve llvm-profdata / llvm-cov plus the lcov renderer.

        Apple ships the LLVM tools with the Xcode command line tools but usually
        keeps them off PATH, so `xcrun -f` is the supported way to find them.
        Missing tools are reported loudly with the command that fixes it (C2).
        """
        _tools = {}
        for _name in ('llvm-profdata', 'llvm-cov'):
            _path = shutil.which(_name)
            if _path is None and sys.platform == 'darwin':
                _probe = subprocess.run(['xcrun', '-f', _name], capture_output=True, text=True)
                _path = _probe.stdout.strip() if _probe.returncode == 0 else None
            if not _path or not os.path.isfile(_path):
                raise RuntimeError(f'Code coverage: cannot locate `{_name}`, which is '
                                   f'required to turn LLVM raw profiles into a report. '
                                   f'On macOS install the Xcode command line tools '
                                   f'(`xcode-select --install`); elsewhere install an '
                                   f'LLVM toolchain that ships it.')
            _tools[_name] = _path
        for _name in ('lcov', 'genhtml'):
            if shutil.which(_name) is None:
                raise RuntimeError(f'Code coverage: cannot locate `{_name}`. '
                                   f'On macOS install it with `brew install lcov`.')
        return _tools['llvm-profdata'], _tools['llvm-cov']

    def _coverage_totals(self, info_file):
        """Sum the tracefile's own LF/LH/FNF/FNH/BRF/BRH records; each file record carries its totals, so a plain sum is the report's."""
        _sums, _files = {}, set()
        with open(info_file, 'r', encoding='utf-8') as f:
            for _line in f:
                if _line.startswith('SF:'):
                    _files.add(_source_relpath(_line[3:].strip()))
                    continue
                _key, _, _value = _line.strip().partition(':')
                if _key in ('LF', 'LH', 'FNF', 'FNH', 'BRF', 'BRH') and _value.isdigit():
                    _sums[_key] = _sums.get(_key, 0) + int(_value)
        _rate = lambda hit, found: round(100.0 * hit / found, 2) if found else 0.0
        _totals = {_what: {'hit': _sums.get(_h, 0), 'found': _sums.get(_f, 0),
                           'percent': _rate(_sums.get(_h, 0), _sums.get(_f, 0))}
                   for _what, _h, _f in [('lines', 'LH', 'LF'),
                                         ('functions', 'FNH', 'FNF'),
                                         ('branches', 'BRH', 'BRF')]}
        # the file set is what two platforms can compare; the rates cannot match (see _code_coverage_clang)
        _totals['files'] = sorted(_files)
        return _totals

    def _render_html_report(self, coverage_folder, info_file, pkg_root):
        """Filter the tracefile down to OUR entry, render the HTML, clean up.

        Shared verbatim by the gcc and clang paths so the two cannot drift: the
        artifact path produced here is what downstream parses.
        """
        # scope the report to this package's derived cache root; a non-matching filter makes lcov 2.x abort
        cmd2 = ['lcov', '--extract', info_file,
                pkg_root.replace(sep, '/') + '/*', '--output-file',
                os.path.join(coverage_folder, 'coverage_test.filtered.info')]
        subprocess.run(cmd2, check=True)
        cmd3 = ['genhtml', os.path.join(coverage_folder, 'coverage_test.filtered.info'),
                '--output-directory', os.path.join(coverage_folder, 'coverage_report')]
        subprocess.run(cmd3, check=True)

        _totals = self._coverage_totals(os.path.join(coverage_folder, 'coverage_test.filtered.info'))

        # remove intermediate files
        for _f in os.listdir(coverage_folder):
            _full_name = coverage_folder + sep + _f
            if not os.path.isdir(_full_name):
                os.remove(_full_name)

        # the CI gate reads this, not genhtml's HTML: the tracefile is upstream, the HTML is a template
        with open(os.path.join(coverage_folder, 'coverage_summary.json'), 'w', encoding='utf-8') as f:
            json.dump(_totals, f, indent=2, sort_keys=True)
            f.write('\n')

    def _code_coverage_auto(self):
        compiler = self._compiler_name()
        if compiler == 'gcc':
            self._code_coverage_gcc()
        elif compiler in ('clang', 'apple-clang'):
            self._code_coverage_clang()
        else:
            raise NotImplementedError(f'Compiler {compiler} is not supported.')

    def _code_coverage_clang(self):
        """Apple/LLVM clang coverage: profraw -> profdata -> lcov -> html.

        GNU lcov/gcov cannot read LLVM's raw profiles, so the front of this
        pipeline necessarily differs from the gcc one. The tail -- filter to our
        cache entry, render, clean up -- is shared verbatim so the two can never
        drift, which is what keeps the artifact path a stable contract.

        Difference in the numbers is expected and is not a bug: llvm-cov counts
        lines and functions its own way, and it also reports inline code from
        headers that gcc/gcov attributes to the caller.
        """
        _profdata_bin, _cov_bin = self._clang_coverage_tools()
        coverage_folder = self._coverage_folder()

        _profraw = sorted(str(_) for _ in Path(self._profraw_folder()).glob('*.profraw'))
        if not _profraw:
            raise RuntimeError(f'Code coverage: no LLVM raw profile (*.profraw) found in '
                               f'{self._profraw_folder()}. The instrumented binaries did '
                               f'not run, or they did not inherit LLVM_PROFILE_FILE.')
        self.output.info(f'[coverage:llvm] merging {len(_profraw)} raw profile(s)')

        _profdata = coverage_folder + sep + 'coverage_test.profdata'
        cmd1 = [_profdata_bin, 'merge', '-sparse', *_profraw, '-o', _profdata]
        subprocess.run(cmd1, check=True)

        _bins = self._instrumented_binaries(self.build_folder)
        if not _bins:
            raise RuntimeError(f'Code coverage: ctest registered no runnable executable '
                               f'under {self.build_folder}. `llvm-cov export` needs the '
                               f'instrumented binaries themselves, not their object files.')
        self.output.info(f'[coverage:llvm] exporting {len(_bins)} instrumented binary(ies)')

        # llvm-cov export reports only the FIRST object, so export per binary and concatenate
        _info = os.path.join(coverage_folder, 'coverage_test.info')
        with open(_info, 'w', encoding='utf-8') as _handle:
            for _bin in _bins:
                cmd2 = [_cov_bin, 'export', f'-instr-profile={_profdata}',
                        '-format=lcov', _bin]
                subprocess.run(cmd2, check=True, stdout=_handle)

        self._render_html_report(coverage_folder, _info, self._package_root())

    def _code_coverage_gcc(self):

        # get conan build folder
        _pkg_root = self._package_root()
        _main_pkg_build_fd = _pkg_root + sep + 'b' + sep + 'build'

        # collect code coverage files to export/coverage/
        _gcda = [str(_) for _ in Path(_main_pkg_build_fd).rglob('*.gcda')]
        _gcno = [_[:-4] + 'gcno' for _ in _gcda]

        coverage_folder = self._coverage_folder()

        for v1, v2 in zip(_gcda, _gcno):
            shutil.copy2(v1, coverage_folder + sep + _get_file_name(v1))
            shutil.copy2(v2, coverage_folder + sep + _get_file_name(v2))

        # auto html report generation
        cmd1 = ['lcov', '--directory', coverage_folder, '--capture', '--output-file',
                os.path.join(coverage_folder, 'coverage_test.info'), '--rc', 'geninfo_auto_base=1']
        subprocess.run(cmd1, check=True)

        self._render_html_report(coverage_folder,
                                 os.path.join(coverage_folder, 'coverage_test.info'),
                                 _pkg_root)

    def _add_entries(self):
        if self._tests_enabled():

            _f_stress = self.recipe_folder + sep + 'test' + sep + 'stress'
            if not os.path.exists(_m := _f_stress + sep + MAIN_CPP):
                with open(_m, 'w', encoding='utf-8') as f:
                    f.write(''.join(_entry_lists()))

            _f_unit = self.recipe_folder + sep + 'test' + sep + 'unit'
            if self.metadata.get('activate_code_coverage'):
                _files = [str(_) for _ in Path(_f_unit).rglob('*.cpp')]
                _cache = [[_a := _.split(sep), (sep.join(_a[:-1]), _a[-1])][-1] for _ in _files]
                for _test_src, _test_ucov in zip(_files, _cache):
                    with open(_test_src, 'r') as f:
                        _tmp = f.readlines()
                    _tmp.extend(_entry_lists()[1:])
                    with open(_test_ucov[0] + sep + 'ucov_' + _test_ucov[1], 'w', encoding='utf-8') as f:
                        f.write(''.join(_tmp))
            else:
                if not os.path.exists(_m := _f_unit + sep + MAIN_CPP):
                    with open(_m, 'w', encoding='utf-8') as f:
                        f.write(''.join(_entry_lists()))

    def _remove_entries(self):
        if not self._tests_enabled():
            return

        stress_main = self.recipe_folder + sep + 'test' + sep + 'stress' + sep + MAIN_CPP
        if os.path.exists(stress_main):
            os.remove(stress_main)

        _f_unit = self.recipe_folder + sep + 'test' + sep + 'unit'
        if self.metadata.get('activate_code_coverage'):
            self._remove_ucov_files(_f_unit)
        elif os.path.exists(_f3 := _f_unit + sep + MAIN_CPP):
            os.remove(_f3)

    def _remove_ucov_files(self, _f_unit):
        for _m in Path(_f_unit).rglob('*.cpp'):
            if str(_m).split(sep)[-1].startswith('ucov_'):
                os.remove(str(_m))


if __name__ == '__main__':
    _clear_test_build()
