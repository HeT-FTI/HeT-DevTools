from conan import ConanFile
from conan.tools.cmake import CMake, cmake_layout, CMakeToolchain
from conan.tools.build import can_run, cross_building
from conan.tools.files import copy
from conan.tools.env import VirtualRunEnv, VirtualBuildEnv
from pathlib import Path
import subprocess
import shutil
import yaml
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
        self.build_requires(f"cmake/{self.metadata.get('cmake_version')}")

    def requirements(self):
        self.requires(self.tested_reference_str)
        for req in self.conandata.get("requirements", []):
            self.requires(req)

    def generate(self):
        self._add_entries()
        build_env, run_env = VirtualBuildEnv(self), VirtualRunEnv(self)
        build_env.generate()
        run_env.generate(scope="run")

        tc = CMakeToolchain(self)
        lib_name = self.tested_reference_str.split("/")[0]
        tc.variables["LIB_NAME"] = lib_name
        tc.variables["CXX_DEPS"] = self._get_targets()
        tc.variables["TRIGGER_TESTS"] = self.metadata.get('trigger_tests')
        tc.variables['ENABLE_COVERAGE'] = self.metadata.get('activate_code_coverage')
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

        # scripting in test_package/main.cpp
        if can_run(self):
            cmd = os.path.join(self.cpp.build.bindirs[0], "main")
            self.run(cmd, env="conanrun")

        # test cases in test_pacakge/test/*.cpp
        if self.metadata.get('trigger_tests'):
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

    def _code_coverage_auto(self):
        compiler = getattr(self.settings, 'compiler').__str__()
        if compiler == 'gcc':
            self._code_coverage_gcc()
        elif compiler == 'clang':
            self._code_coverage_clang()
        else:
            raise NotImplementedError(f'Compiler {compiler} is not supported.')

    def _code_coverage_clang(self):
        raise NotImplementedError('Clang is under implementation')

    def _code_coverage_gcc(self):

        # get conan build folder
        _name, _ver = [self.metadata.get(_) for _ in ['name', 'version']]
        _tmp = subprocess.run(["conan", "list", f"{_name}/{_ver}:*"], capture_output=True, text=True)
        _tmp_ref = [str(_).strip() for _ in _tmp.stdout.split('\n')]
        _pkg_uid = _tmp_ref[[i for i, _ in enumerate(_tmp_ref) if _ == 'packages'][0] + 1]
        _tmp = subprocess.run(["conan", "cache", "path", f"{_name}/{_ver}:{_pkg_uid}"],
                              capture_output=True, text=True)
        # `conan cache path <ref>` prints the PACKAGE folder of the cache entry:
        #   <CONAN_HOME>/p/b/<pkgname-prefix><hash>/p
        # Its parent is the entry root that holds THIS package's b/ (build +
        # copied sources) and p/ trees — the only reliable scope for our code.
        _pkg_folder = _tmp.stdout.strip()
        _pkg_root = sep.join(_pkg_folder.split(sep)[:-1])
        if not _pkg_root:
            raise RuntimeError(f'conan cache path {_name}/{_ver}:{_pkg_uid} returned "{_pkg_folder}"')
        _main_pkg_build_fd = _pkg_root + sep + 'b' + sep + 'build'

        # collect code coverage files to export/coverage/
        _gcda = [str(_) for _ in Path(_main_pkg_build_fd).rglob('*.gcda')]
        _gcno = [_[:-4] + 'gcno' for _ in _gcda]

        target_folder = self.recipe_folder + sep + 'test' + sep + 'export'
        coverage_folder = target_folder + sep + 'coverage'
        if not os.path.exists(target_folder):
            os.mkdir(target_folder)
        else:
            if os.path.exists(coverage_folder):
                shutil.rmtree(coverage_folder)
        os.mkdir(coverage_folder)

        for v1, v2 in zip(_gcda, _gcno):
            shutil.copy2(v1, coverage_folder + sep + _get_file_name(v1))
            shutil.copy2(v2, coverage_folder + sep + _get_file_name(v2))

        # auto html report generation
        cmd1 = ['lcov', '--directory', coverage_folder, '--capture', '--output-file',
                os.path.join(coverage_folder, 'coverage_test.info'), '--rc', 'geninfo_auto_base=1']
        subprocess.run(cmd1, check=True)
        # Downstream contract (HeT DevTools): scope the report to OUR package by
        # the DERIVED cache entry root.
        # The cache folder is named `<pkgname-prefix><hash>` (e.g. fcpp2501d113050e3),
        # so neither the old literal `*/.conan2/p/b/<name[:3]>*` (breaks as soon as
        # CONAN_HOME is renamed) nor a package-id based pattern (matches nothing at
        # all) is the folder name. A non-matching filter makes lcov 2.x abort with
        # `ERROR: no valid records found in tracefile …` → the whole `conan create`
        # fails and no coverage report is produced.
        cmd2 = ['lcov', '--extract', os.path.join(coverage_folder, 'coverage_test.info'),
                _pkg_root.replace(sep, '/') + '/*', '--output-file',
                os.path.join(coverage_folder, 'coverage_test.filtered.info')]
        subprocess.run(cmd2, check=True)
        cmd3 = ['genhtml', os.path.join(coverage_folder, 'coverage_test.filtered.info'),
                '--output-directory', os.path.join(coverage_folder, 'coverage_report')]
        subprocess.run(cmd3, check=True)

        # remove intermediate files
        for _f in os.listdir(coverage_folder):
            _full_name = coverage_folder + sep + _f
            if not os.path.isdir(_full_name):
                os.remove(_full_name)

    def _add_entries(self):
        if self.metadata.get('trigger_tests'):

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
        if not self.metadata.get('trigger_tests'):
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
