#!/usr/bin/env python3
"""
run_bench.py  ─  One-click MCU benchmark: build + flash.

Steps:
  1. Read bench_config.json  (hardware settings)
  2. Read ../metadata.json   (library name)
  3. Auto-generate Conan profile in profiles/<mcu>.profile
  4. Run: conan build . -pr:h profiles/<mcu>.profile --build=missing
  5. Run: download.py to flash benchmark.bin to the target

Usage:
    python3 script/run_bench.py
    python3 script/run_bench.py --no-flash
    python3 script/run_bench.py --config my_board.json
"""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
BENCH_DIR  = SCRIPT_DIR.parent
ROOT_DIR   = BENCH_DIR.parent

_BUILD_CPPSTD = None


def build_cppstd():
    """metadata.json owns the standard; build_type stays Release on purpose, since the board benchmarks optimised code."""
    global _BUILD_CPPSTD
    if _BUILD_CPPSTD is None:
        _BUILD_CPPSTD = json.loads((ROOT_DIR / "metadata.json").read_text(encoding="utf-8"))["build_cppstd"]
    return _BUILD_CPPSTD

# Cortex-M target → Conan arch mapping
CONAN_ARCH_MAP = {
    # ── Cortex-M (baremetal) ──────────────────────────────────────
    "cortex-m0":     "armv6",
    "cortex-m0plus": "armv6",
    "cortex-m1":     "armv6",
    "cortex-m3":     "armv7",
    "cortex-m4":     "armv7",
    "cortex-m4f":    "armv7",
    "cortex-m7":     "armv7",
    "cortex-m7f":    "armv7",
    "cortex-m7d":    "armv7",
    "cortex-m23":    "armv8_32",
    "cortex-m33":    "armv8_32",
    "cortex-m33f":   "armv8_32",
    "cortex-m55":    "armv8_32",
    "cortex-m85":    "armv8_32",
    # ── Cortex-A (Linux) ─────────────────────────────────────────
    "cortex-a5":     "armv7",
    "cortex-a7":     "armv7",
    "cortex-a8":     "armv7",
    "cortex-a9":     "armv7",
    "cortex-a15":    "armv7",
    "cortex-a17":    "armv7",
    "cortex-a35":    "armv8",
    "cortex-a53":    "armv8",
    "cortex-a55":    "armv8",
    "cortex-a72":    "armv8",
    "cortex-a73":    "armv8",
    "cortex-a76":    "armv8",
    "cortex-a78":    "armv8",
}


def load_json(path: Path) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _flags_list(flags: list) -> str:
    return "[" + ",".join(f'"{x}"' for x in flags) + "]"


def generate_profile(cfg: dict, lib_name: str) -> Path:
    """Generate Conan profile for Cortex-M / baremetal target."""
    mcu               = cfg["target_mcu"]
    float_abi         = cfg.get("float_abi", "soft")
    fpu               = cfg.get("fpu", "none")
    flash_origin      = cfg.get("algo_flash_origin", "0x08030000")
    ram_origin        = cfg.get("algo_ram_origin",   "0x20002000")
    compiler_version  = str(cfg.get("compiler_version", "14"))
    toolchain_version = str(cfg.get("toolchain_package_version", "11.3.rel1"))
    extra_cflags      = cfg.get("extra_cflags", [])

    arch     = CONAN_ARCH_MAP.get(mcu, "armv7")
    pkg_name = f"{lib_name}_bench_mcu"

    flags = [f"-mcpu={mcu}", "-mthumb", f"-mfloat-abi={float_abi}"]
    if fpu != "none":
        flags.append(f"-mfpu={fpu}")
    flags.extend(extra_cflags)
    flags_str = _flags_list(flags)

    # baremetal needs -fno-exceptions/-fno-rtti at profile level, else .ARM.exidx breaks the link
    cxx_flags_str = _flags_list(flags + ["-fno-exceptions", "-fno-rtti"])

    profile_content = (
        "[settings]\n"
        "os=baremetal\n"
        f"arch={arch}\n"
        "compiler=gcc\n"
        f"compiler.version={compiler_version}\n"
        f"compiler.cppstd={build_cppstd()}\n"
        "compiler.libcxx=libstdc++11\n"
        "build_type=Release\n"
        "\n"
        "[options]\n"
        f"{pkg_name}/*:target_mcu={mcu}\n"
        f"{pkg_name}/*:float_abi={float_abi}\n"
        f"{pkg_name}/*:fpu={fpu}\n"
        f"{pkg_name}/*:algo_flash_origin={flash_origin}\n"
        f"{pkg_name}/*:algo_ram_origin={ram_origin}\n"
        "\n"
        "[conf]\n"
        "tools.cmake.cmaketoolchain:system_name=Generic\n"
        "tools.cmake.cmaketoolchain:system_processor=arm\n"
        f"tools.build:cflags={flags_str}\n"
        f"tools.build:cxxflags={cxx_flags_str}\n"
        f"tools.build:sharedlinkflags={flags_str}\n"
        f"tools.build:exelinkflags={flags_str}\n"
        "\n"
        "[tool_requires]\n"
        f"arm-toolchain/{toolchain_version}\n"
    )

    profiles_dir = BENCH_DIR / "profiles"
    profiles_dir.mkdir(exist_ok=True)
    profile_path = profiles_dir / f"{mcu}.profile"
    profile_path.write_text(profile_content, encoding="utf-8")
    print(f"[INFO] Profile generated: profiles/{mcu}.profile")
    return profile_path


def build(profile_path: Path) -> None:
    # wipe the build dir between targets: CMake caches are not portable across toolchains
    build_dir = BENCH_DIR / "build"
    if build_dir.exists():
        import shutil
        shutil.rmtree(build_dir)
        print(f"[INFO] Cleaned build directory: {build_dir}")

    rel_profile = profile_path.relative_to(BENCH_DIR)
    cmd = ["conan", "build", ".", f"-pr:h={rel_profile}", "--build=missing"]
    print(f">> {' '.join(cmd)}")
    subprocess.run(cmd, check=True, cwd=str(BENCH_DIR))


def generate_profile_linux(cfg: dict, lib_name: str) -> Path:
    """Generate Conan profile for Cortex-A / Linux target."""
    cpu               = cfg.get("target_cpu", cfg.get("target_mcu", "cortex-a7"))
    float_abi         = cfg.get("float_abi", "hard")
    fpu               = cfg.get("fpu", "neon-vfpv4")
    compiler_version  = str(cfg.get("compiler_version", "11"))
    toolchain_version = str(cfg.get("toolchain_package_version", "11.3.rel1"))
    extra_cflags      = cfg.get("extra_cflags", [])

    arch = CONAN_ARCH_MAP.get(cpu, "armv7")

    flags = [f"-mcpu={cpu}"]
    if fpu not in ("none", ""):
        flags += [f"-mfloat-abi={float_abi}", f"-mfpu={fpu}"]
    elif float_abi:
        flags.append(f"-mfloat-abi={float_abi}")
    flags.extend(extra_cflags)
    flags_str = _flags_list(flags)

    profile_content = (
        "# AUTO-GENERATED by script/run_bench.py — do not edit manually.\n"
        "[settings]\n"
        "os=Linux\n"
        f"arch={arch}\n"
        "compiler=gcc\n"
        f"compiler.version={compiler_version}\n"
        f"compiler.cppstd={build_cppstd()}\n"
        "compiler.libcxx=libstdc++11\n"
        "build_type=Release\n"
        "\n"
        "[conf]\n"
        f"tools.cmake.cmaketoolchain:extra_variables={{\"TARGET_MCU\": \"{cpu}\"}}\n"
        f"tools.build:cflags={flags_str}\n"
        f"tools.build:cxxflags={flags_str}\n"
        f"tools.build:exelinkflags={flags_str}\n"
        f"tools.build:sharedlinkflags={flags_str}\n"
        "\n"
        "[tool_requires]\n"
        f"arm-toolchain/{toolchain_version}\n"
    )

    profiles_dir = BENCH_DIR / "profiles"
    profiles_dir.mkdir(exist_ok=True)
    profile_path = profiles_dir / f"{cpu}.profile"
    profile_path.write_text(profile_content, encoding="utf-8")
    print(f"[INFO] Profile generated: profiles/{cpu}.profile")
    return profile_path


def deploy_linux(cfg: dict) -> None:
    """Deploy and run benchmark ELF on A-core Linux target via ADB or SSH."""
    elf_path    = BENCH_DIR / "build" / "Release" / "benchmark"
    deploy_tool = cfg.get("deploy_tool", cfg.get("flash_tool", "adb"))
    remote_path = cfg.get("remote_path", "/data/local/tmp/benchmark")

    if not elf_path.exists():
        print(f"[ERROR] Binary not found: {elf_path}")
        sys.exit(1)

    cmd = [
        sys.executable,
        str(SCRIPT_DIR / "download.py"),
        "--binary", str(elf_path),
        "--mode",   deploy_tool,
        "--remote", remote_path,
        "--run",
    ]

    if deploy_tool == "ssh":
        ssh_host = cfg.get("ssh_host", "")
        if not ssh_host:
            print("[WARN] ssh_host not configured in bench_config — skipping deploy.")
            return
        cmd += ["--host", ssh_host]

    elif deploy_tool == "adb":
        pass  # adb uses default device; no extra args needed

    print(f">> {' '.join(cmd)}")
    subprocess.run(cmd, check=True)


def flash(cfg: dict) -> None:
    bin_path   = BENCH_DIR / "build" / "Release" / "benchmark.bin"
    flash_tool = cfg.get("flash_tool", "jlink")
    flash_addr = cfg.get("algo_flash_origin", "0x08030000")

    if not bin_path.exists():
        print(f"[ERROR] Binary not found: {bin_path}")
        sys.exit(1)

    cmd = [
        sys.executable,
        str(SCRIPT_DIR / "download.py"),
        "--binary", str(bin_path),
        "--mode",   flash_tool,
        "--addr",   flash_addr,
    ]

    if flash_tool == "jlink":
        device = cfg.get("jlink_device", "")
        if not device or device == "CHANGE_ME":
            print("[WARN] jlink_device is not configured in bench_config.json — skipping flash.")
            return
        cmd += ["--device", device]
        cmd += ["--speed", str(cfg.get("jlink_speed", "4000"))]

    elif flash_tool == "openocd":
        target_cfg = cfg.get("openocd_target", "")
        if not target_cfg:
            print("[WARN] openocd_target not configured — skipping flash.")
            return
        cmd += ["--interface", cfg.get("openocd_interface", "interface/stlink.cfg")]
        cmd += ["--target", target_cfg]
        if cfg.get("openocd_cmsis_vid_pid"):
            cmd += ["--cmsis-vid-pid", cfg["openocd_cmsis_vid_pid"]]

    elif flash_tool == "pyocd":
        target = cfg.get("pyocd_target", "")
        if not target:
            print("[WARN] pyocd_target not configured — skipping flash.")
            return
        cmd += ["--target", target]
        if cfg.get("pyocd_probe"):
            cmd += ["--probe", cfg["pyocd_probe"]]

    print(f">> {' '.join(cmd)}")
    subprocess.run(cmd, check=True)


def main():
    parser = argparse.ArgumentParser(
        description="One-click MCU benchmark: build + flash."
    )
    parser.add_argument(
        "--config", default="platform/bench_config.json",
        help="Path to hardware config file (default: platform/bench_config.json)"
    )
    parser.add_argument(
        "--no-flash", action="store_true",
        help="Build only, skip the flash step"
    )
    args = parser.parse_args()

    cfg_path = BENCH_DIR / args.config
    if not cfg_path.exists():
        print(f"[ERROR] Config not found: {cfg_path}")
        print("  Copy platform/bench_config.json and edit it for your board.")
        sys.exit(1)

    cfg      = load_json(cfg_path)
    meta     = load_json(ROOT_DIR / "metadata.json")
    lib_name = meta.get("name", "lib")

    target_os    = cfg.get("target_os", "baremetal")
    is_linux     = target_os == "Linux"

    profile_path = (generate_profile_linux(cfg, lib_name)
                    if is_linux
                    else generate_profile(cfg, lib_name))
    build(profile_path)

    if not args.no_flash:
        if is_linux:
            deploy_linux(cfg)
        else:
            flash(cfg)
    else:
        print("[INFO] --no-flash specified, skipping download step.")


if __name__ == "__main__":
    main()
