from conan import ConanFile
from conan.tools.cmake import CMake, CMakeToolchain, CMakeDeps, cmake_layout
from conan.tools.files import copy
from pathlib import Path
import json
import os
import subprocess
import time

sep = os.path.sep
BENCH_CONFIG_FILENAME = "bench_config.json"


def _inherit_root_metadata():
    """Inherit metadata.json from the repo root"""
    root = Path(__file__).parent.parent
    with open(root / "metadata.json", "r", encoding="utf-8") as f:
        return json.load(f)


def _load_bench_config():
    """Load the bench config"""
    bench_cfg = Path(__file__).parent / BENCH_CONFIG_FILENAME
    if bench_cfg.exists():
        with open(bench_cfg, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


_metadata = _inherit_root_metadata()
_bench_cfg = _load_bench_config()


class BenchMcuConan(ConanFile):
    name = f"{_metadata.get('name', 'lib')}_bench_mcu"
    version = _metadata.get("version", "1.0.0")
    description = f"MCU Benchmark module for {_metadata.get('name', 'lib')} library"
    license = _metadata.get("license", "Apache-2.0")

    settings = "os", "compiler", "build_type", "arch"
    # no shared/fPIC: the MCU benchmark is always static baremetal
    options = {
        "target_mcu": ["cortex-m0", "cortex-m3", "cortex-m4", "cortex-m7",
                        "cortex-m23", "cortex-m33", "cortex-m55", "ANY"],
        "float_abi": ["soft", "softfp", "hard"],
        "fpu": ["none", "fpv4-sp-d16", "fpv5-sp-d16", "fpv5-d16", "auto"],
        "algo_flash_origin": ["ANY"],
        "algo_ram_origin": ["ANY"],
    }
    default_options = {
        "target_mcu": "cortex-m4",
        "float_abi": "hard",
        "fpu": "auto",
        "algo_flash_origin": "0x08020000",
        "algo_ram_origin": "0x20010000",
    }

    exports_sources = [
        "CMakeLists.txt",
        "bench_entry.*",
        "algo_module.ld.in",
        BENCH_CONFIG_FILENAME,
        "core/*",
        "port/*",
    ]

    _metadata = None
    _bench_cfg = None

    def init(self):
        root = Path(self.recipe_folder).parent
        metadata_path = root / "metadata.json"
        with open(metadata_path, "r", encoding="utf-8") as f:
            self._metadata = json.load(f)

        bench_cfg_path = Path(self.recipe_folder) / BENCH_CONFIG_FILENAME
        if bench_cfg_path.exists():
            with open(bench_cfg_path, "r", encoding="utf-8") as f:
                self._bench_cfg = json.load(f)
        else:
            self._bench_cfg = {}

    def requirements(self):
        """Depend on the library under test"""
        lib_name = self._metadata.get("name", "lib")
        lib_ver  = self._metadata.get("version", "1.0.0")
        self.requires(f"{lib_name}/{lib_ver}")

    def build_requirements(self):
        cmake_ver = self._metadata.get("cmake_version", "3.28")
        self.build_requires(f"cmake/{cmake_ver}")

    def _resolve_fpu(self):
        """Infer the FPU type from the MCU"""
        if str(self.options.fpu) != "auto":
            return str(self.options.fpu)

        fpu_map = {
            "cortex-m0": "none",
            "cortex-m3": "none",
            "cortex-m4": "fpv4-sp-d16",
            "cortex-m7": "fpv5-d16",
            "cortex-m23": "none",
            "cortex-m33": "fpv5-sp-d16",
            "cortex-m55": "fpv5-d16",
        }
        return fpu_map.get(str(self.options.target_mcu), "none")

    def _get_cpu_flags(self):
        """Build the MCU-specific compile options"""
        mcu = str(self.options.target_mcu)
        float_abi = str(self.options.float_abi)
        fpu = self._resolve_fpu()

        flags = [f"-mcpu={mcu}", "-mthumb"]

        if fpu != "none":
            flags.extend([f"-mfloat-abi={float_abi}", f"-mfpu={fpu}"])
        else:
            flags.append("-mfloat-abi=soft")

        return flags

    def layout(self):
        cmake_layout(self)

    def generate(self):
        tc = CMakeToolchain(self)

        # baremetal cross-compile: skip the CMake link test
        if self.settings.os == "baremetal":
            tc.variables["CMAKE_TRY_COMPILE_TARGET_TYPE"] = "STATIC_LIBRARY"

        # pass the MCU compile options to CMake
        cpu_flags = self._get_cpu_flags()
        tc.variables["MCU_C_FLAGS"] = ";".join(cpu_flags)
        tc.variables["ALGO_FLASH_ORIGIN"] = str(self.options.algo_flash_origin)
        tc.variables["ALGO_RAM_ORIGIN"] = str(self.options.algo_ram_origin)
        tc.variables["TARGET_MCU"] = str(self.options.target_mcu)

        # library name
        lib_name = self._metadata.get("name", "lib")
        tc.variables["LIB_NAME"] = lib_name

        tc.generate()

        deps = CMakeDeps(self)
        deps.generate()

    def build(self):
        cmake = CMake(self)
        cmake.configure()
        cmake.build()

    def package(self):
        """Copy the generated bin/elf/map into the package"""
        copy(self, "*.bin", src=self.build_folder, dst=os.path.join(self.package_folder, "bin"))
        copy(self, "*.elf", src=self.build_folder, dst=os.path.join(self.package_folder, "bin"))
        copy(self, "*.map", src=self.build_folder, dst=os.path.join(self.package_folder, "bin"))

    def package_info(self):
        self.cpp_info.bindirs = ["bin"]

    # ----------------------------- flash and run -----------------------------

    def _get_flash_tool_cmd(self, bin_path, flash_addr):
        """Build the flash command from the config"""
        tool = self._bench_cfg.get("flash_tool", "openocd")

        if tool == "openocd":
            interface = self._bench_cfg.get("openocd_interface", "interface/stlink.cfg")
            target_cfg = self._bench_cfg.get("openocd_target", "target/stm32f4x.cfg")
            return [
                "openocd",
                "-f", interface,
                "-f", target_cfg,
                "-c", f"program {bin_path} {flash_addr} verify reset exit"
            ]
        elif tool == "pyocd":
            target_type = self._bench_cfg.get("pyocd_target", "stm32f407vg")
            return [
                "pyocd", "flash",
                "--target", target_type,
                "--base-address", flash_addr,
                bin_path
            ]
        elif tool == "jlink":
            return [
                "JFlash",
                "-openprj", self._bench_cfg.get("jlink_project", ""),
                "-open", bin_path, flash_addr,
                "-auto", "-exit"
            ]

        return []

    def test(self):
        """Flash, run and collect the results"""
        bin_path = os.path.join(self.build_folder, "benchmark.bin")
        flash_addr = str(self.options.algo_flash_origin)

        if not os.path.exists(bin_path):
            self.output.error(f"Binary not found: {bin_path}")
            return

        # Step 1: flash
        flash_cmd = self._get_flash_tool_cmd(bin_path, flash_addr)
        if flash_cmd:
            self.output.info(f"Flashing: {' '.join(flash_cmd)}")
            result = subprocess.run(flash_cmd, capture_output=True, text=True)
            if result.returncode != 0:
                self.output.error(f"Flash failed: {result.stderr}")
                return
            self.output.info("Flash OK")

        # Step 2: collect over serial
        serial_port = self._bench_cfg.get("serial_port", "/dev/ttyUSB0")
        baud = self._bench_cfg.get("serial_baud", 115200)
        timeout = self._bench_cfg.get("timeout", 30)

        self.output.info(f"Collecting from {serial_port} @ {baud}")
        results = self._collect_serial_results(serial_port, baud, timeout)

        # Step 3: print the report
        self._print_report(results)

        # Step 4: save the results
        mcu = str(self.options.target_mcu)
        export_dir = os.path.join(self.recipe_folder, "results")
        os.makedirs(export_dir, exist_ok=True)
        result_file = os.path.join(export_dir, f"{mcu}.json")
        with open(result_file, "w") as f:
            json.dump(results, f, indent=2)
        self.output.info(f"Results saved to {result_file}")

    def _collect_serial_results(self, port, baud, timeout):
        """Collect benchmark results over serial"""
        results = []
        try:
            import serial
        except ImportError:
            self.output.warning(
                "pyserial is not installed; skipping serial collection. "
                "Install it only on hosts that need UART result capture."
            )
            return results

        try:
            ser = serial.Serial(port, baud, timeout=1)
            time.sleep(0.5)

            # send the RUN command
            ser.write(b"RUN\r\n")
            ser.flush()

            start_time = time.time()
            started = False

            while (time.time() - start_time) < timeout:
                line = ser.readline().decode("utf-8", errors="ignore").strip()
                if not line:
                    continue

                self.output.info(f"[UART] {line}")

                if line.startswith(("BENCHMARK_START", "BENCH_START")):
                    started = True
                elif line.startswith(("BENCHMARK_END", "BENCH_END")):
                    break
                elif line.startswith("RESULT|") and started:
                    parts = line.split("|")
                    if len(parts) >= 3:
                        results.append({
                            "name": parts[1],
                            "cycles": int(parts[2]),
                            "mcu": str(self.options.target_mcu),
                        })

            ser.close()
        except Exception as e:
            self.output.warning(f"Serial error: {e}")
            self.output.info("Skipping serial collection (no hardware connected?)")

        return results

    def _print_report(self, results):
        """Print the performance report"""
        mcu = str(self.options.target_mcu)
        self.output.info("")
        self.output.info(f"{'=' * 50}")
        self.output.info(f"  LIB Benchmark Report - {mcu}")
        self.output.info(f"{'=' * 50}")
        self.output.info(f"  {'Algorithm':<25} {'Cycles':>10}")
        self.output.info(f"  {'-' * 25} {'-' * 10}")
        for r in results:
            self.output.info(f"  {r['name']:<25} {r['cycles']:>10}")
        self.output.info(f"{'=' * 50}")
        self.output.info("")
