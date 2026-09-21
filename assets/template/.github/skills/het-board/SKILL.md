---
name: het-board
description: 'Cross-compilation & on-board verification (Cortex-M baremetal / Cortex-A Linux) for the fcpp template. Use when: board / cross-compile / baremetal / cortex-m / flash / benchmark on target. 上板/交叉编译/裸机：编译到目标板并跑基准验证。'
argument-hint: "Board / target (optional) / 板卡/目标（可选）"
user-invocable: true
---

# S5 · het-board — Cross-Compile & On-Board Verification（交叉编译 / 上板验证）

> Facts: `.github/skills/_shared/metadata-contract.md`、`benchmark/README.md`、`.hetai/build-matrix.yml`。

## Mental Model（心智模型）

> "Two legs: **test_package runs host-side GTest on the desktop (x86_64)**; **benchmark cross-compiles to the target (Cortex-M baremetal / Cortex-A Linux) and verifies on real hardware**. hetai does the cross-build automatically; you only configure board parameters and cases."
> 两条腿：test_package 在电脑上做全量 GTest；benchmark 交叉编译到目标板上做性能验证；你只配置板卡参数和用例。

## Platform Split（平台分工）

| | test_package | benchmark |
|---|---|---|
| Runs on（跑在哪） | Host desktop (x86_64) | Target board |
| Purpose（干什么） | GTest full verification + coverage | On-board performance benchmark |
| Deps（依赖） | GTest always | Target-side deps (etl...), never GTest |

## 3-Step Checklist（三步操作清单）

1. Configure board（配置板卡）: edit `benchmark/bench_config.json` (`target_mcu`, flash/RAM addresses, `flash_tool` = jlink/openocd/pyocd, `jlink_device`).
2. Write cases（写用例）: edit `benchmark/bench_entry.c` (shared by MCU/Linux).
3. Build + flash + collect（构建/烧录/采集）:
   ```bash
   python benchmark/script/run_bench.py             # one-click: profile → build → flash → collect
   python benchmark/script/run_bench.py --no-flash  # build only
   ```

## Output Protocol（输出协议）

```
BENCHMARK_START
RESULT|test_add_n128|80
BENCHMARK_END
```
Results saved to `benchmark/results/<mcu>.json`.

## CI Trigger（CI 触发）

- Commit `ci(:hammer_and_wrench:): ...` → `cross-compile.yml` cross-builds the **library itself through
  Conan** using a generated profile (README's `conan create . -pr:h=<profile> -tf=` flow) for aarch64
  cortex-a53 and cortex-m4 baremetal, then reports the packaged archives' Class/Machine.
  在线冒烟：走 conan profile 真正编译库本身，只验产物架构，不需要板子，不碰 `:fire:`。
- Commit `feat(:fire:): ...` (or `🔥`) → `hetai-package-matrix` cross-builds + transfers to board. 触发交叉编译打包 + 板卡传输。
- Needs a **self-hosted runner** + hetai platform scripts (not GitHub-hosted). 需要自托管 runner + hetai 平台。

## Self-Help When Red（失败自救）

1. Baremetal build fails: check MCU/FPU/float-abi in `bench_config.json`. 检查板卡参数。
2. Deps not found: baremetal only keeps `baremetal_white_list` libs (default etl/ArduinoJson). 裸机只保留白名单依赖。
3. Flash fails: check `flash_tool`, J-Link device name, board connection. 检查烧录配置与连接。
4. Deep troubleshooting → `het-fix-ci` (S6).

