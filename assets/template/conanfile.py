from conan import ConanFile
from conan.errors import ConanInvalidConfiguration
from conan.tools.cmake import CMakeToolchain, CMake, CMakeDeps, cmake_layout
from conan.tools.build import cross_building
from conan.tools.scm import Version
from typing import Literal
from pathlib import Path
import yaml
import json
import os
import shutil
import subprocess
import tempfile
sep = os.path.sep
_get_root_path_list = (lambda : (Path(__file__).__str__()).split(sep)[:-1])


white_list = {f'<{_}>' for _ in ['algorithm', 'array', 'chrono', 'cmath', 'functional', 'memory', 'optional',
                                 'string', 'string_view', 'utility', 'vector', 'deque', 'forward_list', 'list',
                                 'map', 'queue', 'set', 'stack', 'unordered_map', 'unordered_set', 'atomic',
                                 'thread', 'mutex', 'future', 'iostream', 'fstream', 'sstream', 'format', 'ranges',
                                 'mdspan', 'flat_map', 'flat_set']}
_is_valid_import = (lambda x, c: x.startswith('#include ') and x[9:].strip() in c)
conan_targets = {
    'Eigen3::Eigen': 'eigen::eigen',
    'ZLIB::ZLIB': 'zlib::zlib',
    'Catch2::Catch2': 'catch2::catch2'
}

# CMake below 4.2 cannot name the newest Visual Studio generator, so an MSVC host dies at configure.
CMAKE_MSVC_FLOOR = '4.2'

# Module annotation / include-guard literals (extracted to avoid drift).
METADATA_FILENAME = 'metadata.json'
TAG_EXPORTER = '@exporter'
TAG_ATTACHER = '@attacher'
GUARD_IFDEF = '#ifdef __cplusplus\n'
GUARD_ENDIF = '#endif\n'


def _get_root_path() -> str:
    return sep.join(_get_root_path_list())


def _inherit_root_metadata():
    with open(_get_root_path() + sep + METADATA_FILENAME, 'r', encoding='utf-8') as f:
        _meta = json.load(f)
    return _meta


_metadata = _inherit_root_metadata()


def _get_export_objects(x: list[str], tag: Literal['@exporter', '@attacher'] = TAG_EXPORTER) -> list[str]:
    # Global objects are separated by two blank lines (repo convention)
    _cache = (''.join(x)).split('\n\n')
    _export_objs = [_ for _ in _cache if tag in _]

    container = []
    for _obj in _export_objs:
        _obj = [_ for _ in _obj.split('\n') if _ != '']
        _res, _ptr = list(_obj), False
        for i, (_v1, _v2) in enumerate(zip(_obj, _res)):
            if _v1.startswith(f' * {tag}'):
                _ptr = True
            if _v1.startswith(' */') and _ptr:
                _res[i] = _v2 + '\nexport '
                _ptr = False
        _res = '\n'.join([_ for _ in _res if not _.startswith(f' * {tag}')])
        if tag == TAG_EXPORTER:
            _res = _res.replace('export \n','export ')
        else:  # @attacher
            _res = _res.replace('export \n', '')
        container.append(_res)

    return container


def _source_file_loader(txt: str) -> list[str]:
    with open(txt, 'r', encoding='utf-8') as f:
        _tmp = f.readlines()
    return _tmp


def _load_file(x: str) -> str:
    with open(x, 'r', encoding='utf-8') as f:
        res = f.readlines()
    return ''.join(res)


def _pragma_in_import(x: list[str]) -> tuple[bool, int]:
    # return the pragma once line in conan import wrapper, as its index if exists (-1 if not)
    _has_pragma, _idx = False, -1
    for i, _l in enumerate(x):
        if _l.startswith('#pragma once'):
            _has_pragma = True
            _idx = i
        if _l.strip() == '// Conan::ImportEnd':
            break
    return _has_pragma, _idx


class PackageRecipe(ConanFile):

    package_type = "library"

    # Binary configuration
    settings = "os", "compiler", "build_type", "arch"
    options = {"shared": [True, False], "fPIC": [True, False]}
    default_options = {"shared": _metadata.get('is_shared'), "fPIC": True}  # inherit from config

    # Sources are located in the same place as this recipe, copy them to the recipe
    exports_sources = ["CMakeLists.txt", "src/*", "include/*", METADATA_FILENAME, "LICENSE"]
    exports = ["conandata.yml", METADATA_FILENAME, "LICENSE"]

    generators = "VirtualBuildEnv", "VirtualRunEnv"
    conandata, meta, headers, sources, license_full_text , importable_modules = [None for _ in range(6)]

    def init(self):
        """
        ps1: Get-Content "build" | Invoke-Expression
        bash: bash ./build
        """
        conandata_path = Path(self.recipe_folder) / "conandata.yml"
        metadata_path = Path(self.recipe_folder) / METADATA_FILENAME
        license_path = Path(self.recipe_folder) / "LICENSE"

        self.conandata = yaml.safe_load(conandata_path.read_text())
        self.meta = yaml.safe_load(metadata_path.read_text())

        # Required attributes
        self.name, self.version = self.meta.get('name'), self.meta.get('version')

        # Optional attributes
        self.license_full_text = _load_file(license_path.__str__())
        self.topics = tuple(self.meta.get('topics'))
        for k in ['license', 'url', 'homepage', 'description', 'authors', 'maintainers']:
            self.__setattr__(k, self.meta.get(k))

        # Modules processing
        self.headers, self.sources, self.importable_modules = None, None, self._determine_importable_modules()
        self._modules_preprocessing()

    def _file_detector(self, folder: str, obj: list[str], retarget: Path = None) -> list[tuple[str, str]]:
        entry = Path(self.recipe_folder) / folder if retarget is None else retarget / folder
        res = []
        for _obj in obj:
            res.extend(list(entry.rglob(f"*.{_obj}")))
        _tmp = [(os.path.dirname(str(file)), os.path.basename(str(file))) for file in res]
        return _tmp

    def _modules_preprocessing(self):

        # clear generated modules
        _m_files = self._file_detector("src", ["ixx", "cppm", ])
        for (k, v) in _m_files:
            _rm_file = k + sep + v
            if os.path.exists(_rm_file):
                os.remove(_rm_file)

        # regenerated module files
        if self.meta.get("generate_modules_inplace"):

            self.headers = self._file_detector("include", ["hpp", ])
            self.sources = self._file_detector("src", ["cpp", ])
            _suffix = 'ixx' if os.name == 'nt' else 'cppm'

            for (k, v) in self.sources:
                _src = v.split('.')
                _mod_name = _src[0]

                _hpp_content = _source_file_loader(k.replace('src', 'include') + sep + _mod_name + '.hpp')
                _hpp_intro, _hpp_inc, _hpp_split, _hpp_extra, _hpp_obj = self._module_elements(_hpp_content,
                                                                                               _mod_name)

                _cpp_content = _source_file_loader(k + sep + v)
                _cpp_intro, _cpp_inc, _cpp_split, _cpp_extra, _cpp_obj = self._module_elements(_cpp_content,
                                                                                               _mod_name)

                # merge export items in hpp or cpp
                _m_intro, _m_split = _hpp_intro, _hpp_split  # follow the hpp nomenclature
                _m_inc = [_ for _ in set(_hpp_inc).union(set(_cpp_inc)) if not _.startswith('// Conan::Escape')]
                _m_inc = [_ for _ in _m_inc if not _.startswith('#pragma once')]
                _m_inc = [_ for _ in _m_inc if f'{_mod_name}.hpp' not in _]  # escape self include
                _m_extra = list(set(_hpp_extra).union(set(_cpp_extra)))
                _m_obj = ['\n'] + '@@'.join(_hpp_obj + _cpp_obj).replace('@@', '\n\n\n').split('\n')

                _m_full = _m_intro + _m_inc + _m_split + _m_extra + _m_obj
                with open(k + sep + _mod_name + f'.{_suffix}', 'w', encoding='utf-8') as f:
                    f.write('\n'.join(_m_full))

    def _determine_importable_modules(self):
        _tmp = [f'<{_}>' for _ in self.meta.get('std_modules') if f'<{_}>' in white_list]
        return _tmp + ['"' + _ + '.hpp";' for _ in self.meta.get("user_modules")]

    def build_requirements(self):
        # escape: HET_CMAKE_BUILD_REQUIRE=none keeps the cmake on PATH, a version pins another
        _override = (os.environ.get('HET_CMAKE_BUILD_REQUIRE') or '').strip()
        if _override.lower() == 'none':
            return
        _cmake = _override or self.meta.get('cmake_version')
        # fail here with the fix, rather than inside CMake with a generator name it never heard of
        if str(self.settings.get_safe('compiler')) == 'msvc' and Version(_cmake) < Version(CMAKE_MSVC_FLOOR):
            raise ConanInvalidConfiguration(
                f"cmake/{_cmake} cannot name the Visual Studio generator Conan picks for "
                f"msvc/{self.settings.get_safe('compiler.version')}: CMake {CMAKE_MSVC_FLOOR}+ is required. "
                f"Raise metadata.json 'cmake_version', or set HET_CMAKE_BUILD_REQUIRE to a newer version.")
        self.build_requires(f"cmake/{_cmake}")

    def config_options(self):
        if self.settings.os == "Windows":
            self.options.rm_safe("fPIC")

    def configure(self):
        if self.options.shared:
            self.options.rm_safe("fPIC")

        supported_compilers = {"gcc", "msvc", "clang", "apple-clang", }  # no support for 'Visual Studio' in Conan1.0
        if self.settings.compiler.__str__() in supported_compilers:
            _build_std = self.meta.get("build_cppstd")
            _build_std = "17" if _build_std not in {"17", "20", "23"} else _build_std  # fallback to C++17
            self.settings.compiler.cppstd = _build_std

        self._make_c_compatible()

    def _make_c_compatible(self):
        _c_hs = self._file_detector('include', ['h', ], retarget=Path(self.recipe_folder).parent / 'es')
        for (k, v) in _c_hs:
            _f = k + sep + v
            with open(_f, 'r', encoding='utf-8') as f:
                _org_text = f.readlines()
            _has_pragma, _idx = _pragma_in_import(_org_text)
            if _has_pragma:
                _start = ['#pragma once\n', GUARD_IFDEF, 'extern "C" {\n', GUARD_ENDIF]
            else:
                _start = [GUARD_IFDEF, 'extern "C" {\n', GUARD_ENDIF]
            _inner_text = ['    ' + l for i, l in enumerate(_org_text) if i != _idx]
            _end = [GUARD_IFDEF, '}\n', GUARD_ENDIF]
            _new_text = _start + _inner_text + _end

            with open(_f, 'w', encoding='utf-8') as f:
                f.write(''.join(_new_text))

    def _coverage_enabled(self):
        """Whether this run instruments the library; `-c user.het:run_tests=False` narrows metadata for one run."""
        if not self.conf.get('user.het:run_tests', default=True, check_type=bool):
            return False
        return bool(self.meta.get("activate_code_coverage"))

    def _test_dependencies_enabled(self):
        return bool(self.meta.get("trigger_tests"))

    def _python_bindings_enabled(self):
        return bool(self.meta.get("enable_python_bindings"))

    def requirements(self):
        for req in self.conandata.get('requirements'):
            _pkg = req.split('/')[0]
            if cross_building(self) and self.settings.os == "baremetal":
                if _pkg not in self.meta.get('baremetal_white_list'):
                    continue
            if _pkg == 'gtest':
                continue
            if _pkg == 'pybind11' and not self._python_bindings_enabled():
                continue
            self.requires(req)

    def layout(self):
        cmake_layout(self)

    def generate(self):
        tc = CMakeToolchain(self)
        tc.variables['C_DEPS'], tc.variables['CPP_DEPS'] = self._preparing_deps_links()
        tc.variables['ENABLE_COVERAGE'] = self._coverage_enabled()

        if cross_building(self) and self.settings.os == "baremetal":  # cross build to MCU
            tc.variables["CMAKE_TRY_COMPILE_TARGET_TYPE"] = "STATIC_LIBRARY"
        
        tc.generate()
        deps = CMakeDeps(self)
        deps.generate()

    def _preparing_deps_links(self):
        _common, _c, _cpp, _infra = [self.meta.get('dependencies').get(_) for _ in ['common', 'c', 'cpp', 'infra']]
        _c = {k: v if k not in _common.keys() else list(set(v).union(set(_common.get(k)))) for k, v in _c.items()}
        _cpp = {k: v if k not in _common.keys() else list(set(v).union(set(_common.get(k)))) for k, v in _cpp.items()}

        if cross_building(self) and self.settings.os == 'baremetal':
            _c, _cpp, _common, _infra = [{k: v for k, v in z.items() if k in self.meta.get("baremetal_white_list")} 
                                         for z in [_c, _cpp, _common, _infra]]
        else:
            _infra.pop("GTest", None)
            if not self._python_bindings_enabled():
                _infra.pop("pybind11", None)

        _infra_deps = [f"{k}@{' '.join(v)}" for k, v in _infra.items()]
        _c_deps = [f"{k}@{' '.join(v)}" for k, v in {**_common, **_c}.items()]
        _cpp_deps = [f"{k}@{' '.join(v)}" for k, v in {**_common, **_cpp}.items()]
        return _c_deps, list(set(_cpp_deps).union(set(_infra_deps)))

    def package_id(self):
        # Fold tools.build:cflags/cxxflags into package_id so each MCU ABI gets its own binary
        for key in ("tools.build:cflags", "tools.build:cxxflags"):
            value = self.conf.get(key, default=None)
            if value:
                self.info.conf.define(key, str(value))


    def build(self):
        cmake = CMake(self)
        cmake.configure()
        cmake.build()
        self._validate_built_archives()

    def _validate_built_archives(self):
        # escape Linux/baremetal, two cross-compilation cases (Mach-O/PE have neither readelf nor ELF attributes)
        _non_elf_os = {"Macos", "iOS", "watchOS", "tvOS", "Windows"}
        if str(self.settings.os) in _non_elf_os:
            self.output.info(
                f"[compat:SKIP] os={self.settings.os}: ELF attribute validation "
                "is not applicable (Mach-O/PE target)"
            )
            return

        archive_names = [f"lib{self.name}_c.a", f"lib{self.name}_cpp.a"]
        build_dir = Path(self.build_folder)

        readelf_path = self._find_binutil("readelf")
        ar_path = self._find_binutil("ar")

        reports = []
        failures = []

        for archive_name in archive_names:
            archive_path = build_dir / archive_name
            if not archive_path.exists():
                continue

            report = self._inspect_archive(archive_path, ar_path, readelf_path)
            reports.append(report)

            verdict = self._evaluate_archive_compatibility(report)
            report["verdict"] = verdict
            if not verdict["ok"]:
                failures.append((archive_path, verdict))

        report_path = build_dir / "compatibility_report.json"
        report_path.write_text(json.dumps(reports, indent=2, ensure_ascii=False), encoding="utf-8")
        self.output.info(f"Compatibility report written: {report_path}")

        for report in reports:
            verdict = report["verdict"]
            status = "PASS" if verdict["ok"] else "FAIL"
            self.output.info(
                f"[compat:{status}] {report['archive']} target={verdict['target']} sample={report['sample_object']}"
            )
            self.output.info(f"  attrs: {report['attributes']}")
            self.output.info(f"  summary: {verdict['summary']}")

        if failures:
            details = [f"{path.name}: {verdict['summary']}" for path, verdict in failures]
            raise RuntimeError("Archive compatibility validation failed: " + " | ".join(details))

    def _find_binutil(self, name: str) -> str:
        compiler_conf = self.conf.get("tools.build:compiler_executables", default={}, check_type=dict)
        compiler_path = compiler_conf.get("c") if compiler_conf else None

        candidates = []
        if compiler_path:
            compiler_bin = Path(compiler_path)
            bin_dir = compiler_bin.parent
            prefix = compiler_bin.name
            if prefix.endswith("gcc"):
                prefix = prefix[:-3]
            candidates.append(str(bin_dir / f"{prefix}{name}"))

        resolved = next((candidate for candidate in candidates if Path(candidate).exists()), None)
        if resolved:
            return resolved

        path_tool = shutil.which(name)
        if path_tool:
            return path_tool

        prefixed = shutil.which(f"arm-none-eabi-{name}")
        if prefixed:
            return prefixed

        raise RuntimeError(f"Unable to locate binutil: {name}")

    def _inspect_archive(self, archive_path: Path, ar_path: str, readelf_path: str) -> dict:
        with tempfile.TemporaryDirectory(prefix="smt-compat-") as temp_dir:
            subprocess.run([ar_path, "x", str(archive_path)], cwd=temp_dir, check=True, capture_output=True, text=True)
            members = sorted(Path(temp_dir).glob("*.obj"))
            if not members:
                members = sorted(Path(temp_dir).iterdir())
            if not members:
                raise RuntimeError(f"Archive has no members: {archive_path}")

            sample = self._select_representative_member(members)
            attrs = self._read_elf_attributes(sample, readelf_path)

        return {
            "archive": archive_path.name,
            "sample_object": sample.name,
            "attributes": attrs,
        }

    def _select_representative_member(self, members: list[Path]) -> Path:
        for member in members:
            if "CompilerId" not in member.name:
                return member
        return members[0]

    def _read_elf_attributes(self, obj_path: Path, readelf_path: str) -> dict:
        result = subprocess.run(
            [readelf_path, "-A", str(obj_path)],
            check=True,
            capture_output=True,
            text=True,
        )
        attrs = {}
        for line in result.stdout.splitlines():
            line = line.strip()
            if not line.startswith("Tag_"):
                continue
            if ":" not in line:
                continue
            key, value = line.split(":", 1)
            attrs[key.strip()] = value.strip().strip('"')
        return attrs

    def _evaluate_archive_compatibility(self, report: dict) -> dict:
        target_os = str(self.settings.os)
        target_arch = str(self.settings.arch)
        attrs = report["attributes"]

        target = f"{target_os}/{target_arch}"
        if target_os != "baremetal":
            return {
                "ok": True,
                "target": target,
                "summary": "Non-baremetal target: attributes recorded, no MCU ISA restriction enforced.",
            }

        cpu_arch = attrs.get("Tag_CPU_arch", "unknown")
        thumb_isa = attrs.get("Tag_THUMB_ISA_use", "")
        arm_isa = attrs.get("Tag_ARM_ISA_use", "No")
        cpu_arch_profile = attrs.get("Tag_CPU_arch_profile", "")

        expected = {
            "armv6": {"v6-M", "v6S-M"},
            "armv7": {"v7-M", "v7E-M"},
            "armv8_32": {"v8-M.baseline", "v8-M.mainline"},
        }.get(target_arch, set())

        # GCC 11+ may drop the -M suffix from Tag_CPU_arch; both spellings are valid
        expected_bases = {tag.split("-M")[0].split(".")[0] for tag in expected}
        arch_ok = (not expected) or (cpu_arch in expected) or (
            cpu_arch in expected_bases and cpu_arch_profile == "Microcontroller"
        )

        problems = []
        if not arch_ok:
            problems.append(f"Tag_CPU_arch={cpu_arch} not in expected {sorted(expected)}")

        if arm_isa.lower() in {"yes", "1", "true"}:
            problems.append("ARM ISA is enabled, but baremetal Cortex-M targets require Thumb code")

        # v6/v7 report "Thumb-1"/"Thumb-2"; v8-M (Cortex-M23/M33) reports a boolean "Yes"
        if thumb_isa.lower() not in {"yes", "1", "true"} and "Thumb" not in thumb_isa:
            problems.append("Thumb ISA attribute is missing")

        ok = not problems
        if ok:
            summary = f"Archive is compatible with {target}; CPU arch={cpu_arch}, Thumb={thumb_isa}."
        else:
            summary = "; ".join(problems)

        return {
            "ok": ok,
            "target": target,
            "summary": summary,
        }

    def _remove_customized_doc_command(self, tags: list[str] = None):  # maybe no use anymore

        if tags is None:
            tags = [TAG_EXPORTER, TAG_ATTACHER]

        _cpp = self._file_detector('src', ['cpp', ], retarget=Path(self.recipe_folder).parent / 'es')
        _hpp = self._file_detector('include', ['hpp', ], retarget=Path(self.recipe_folder).parent / 'es')

        for (k, v) in (_cpp + _hpp):
            _f = k + sep + v
            with open(_f, 'r', encoding='utf-8') as f:
                _file = f.readlines()
            with open(_f, 'w', encoding='utf-8') as w:
                w.write(''.join(_ for _ in _file if not any(_.startswith(f' * {tag}') for tag in tags)))


    def _module_elements(self, x: list[str], m_name: str):
        # transforms: <lib> -> import <lib>; "lib.hpp" -> import "lib.hpp"

        _flag, _is_import_lines, _splitter = 1, [], 0
        for i, _l in enumerate(x):
            _is_import_lines.append(_flag)
            if _l.strip() == '// Conan::ImportEnd':
                _flag = 0
                _splitter = i + 1

        _import_context = [l for i, l in zip(_is_import_lines, x) if i]
        _other_context = [l for i, l in zip(_is_import_lines, x) if not i]

        _tmp = ['// Conan::Escape ' + _ if _is_valid_import(_, self.importable_modules) else _ for _
                in _import_context[1:-1]]
        _extra = ['import ' + _.split('#include ')[-1].strip() + ';\n' for _ in _tmp if
                  _.startswith('// Conan::Escape ')]
        _intro, _split = ['module;\n', ], [f'export module {m_name};\n', ]

        # drop '\n' in import lines
        _intro, _tmp, _split, _extra = ([_.strip() for _ in _intro], [_.strip() for _ in _tmp],
                                        [_.strip() for _ in _split], [_.strip() for _ in _extra])

        return (_intro, _tmp, _split, _extra, _get_export_objects(_other_context, TAG_EXPORTER) +
                _get_export_objects(_other_context, TAG_ATTACHER))

    def package(self):
        cmake = CMake(self)
        cmake.install()

        report_path = Path(self.build_folder) / "compatibility_report.json"
        if report_path.exists():
            dst = Path(self.package_folder) / "share" / self.name
            dst.mkdir(parents=True, exist_ok=True)
            shutil.copy2(report_path, dst / report_path.name)

    def package_info(self):
        self.cpp_info.libs = [self.name]
        _c, _cpp = self._preparing_deps_links()

        self.cpp_info.components[f"{self.name}_c"].libs = [f"{self.name}_c"]
        self.cpp_info.components[f"{self.name}_c"].requires = [[_t := _.split('@')[1],
                                                                conan_targets[_t] if _t in conan_targets
                                                                else _t][-1] for _ in _c]
        self.cpp_info.components[f"{self.name}_cpp"].libs = [f"{self.name}_cpp"]
        self.cpp_info.components[f"{self.name}_cpp"].requires = [[_t := _.split('@')[1],
                                                                  conan_targets[_t] if _t in conan_targets
                                                                  else _t][-1] for _ in _cpp]

    @staticmethod
    def _call_syntax_suggestion():
        _content = """
        ============================= Syntax Guide =============================
        1.force 2 blank lines to distinguish global objects;
        2.Use // Conan::ImportStart and // Conan::ImportEnd in beginning,
          wrapping #include lines;
        3.generate_modules_inplace is true in metadata.json can automatically,
          generate modules (ixx, cppm) files;
        4.std_modules and user_modules in metadata.json affect import lines,
        5.std_modules make #include <stdlib> to import <stdlib>; in the right
          order, when 3. is satisfied;
        6.user_modules make #include <usrlib.hpp> to import <usrlib.hpp> in
          the right order, when 3. is satisfied;
        7.multi-lined doxygen /** ... */ with @exporter inside, will export
          associated global object (see 1.) into generated modules;
        8.multi-lined doxygen /** ... */ with @attacher inside, will attach
          associated global object (see 1.) into generated modules;
        9.suffix .h and .c for C; then .hpp and .cpp for C++;
        ============================= Guide Over =============================', 
        """
        print(*_content, sep='\n')
