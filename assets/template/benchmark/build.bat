#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
#  One-click MCU benchmark: build + flash.
#
#  SETUP (once per board):
#    Edit bench_config.json to set target_mcu, flash/RAM addresses,
#    flash_tool, and jlink_device / openocd_target / pyocd_target.
#
#  USAGE:
#    ./build.bat              — build + flash
#    ./build.bat --no-flash   — build only (no hardware required)
#    ./build.bat --config other_board.json
# ─────────────────────────────────────────────────────────────────
python3 script/run_bench.py "$@"
