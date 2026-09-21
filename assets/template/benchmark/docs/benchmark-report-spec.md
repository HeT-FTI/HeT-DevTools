# Benchmark Report 规范与解读

## 1. 文件位置

每个需要上板测试的 run_id 根目录必须保存一份 Markdown 报告：

```text
/path/to/<repo>_board_ci/<run_id>/benchmark-report.md
```

报告是离线审计文件，用于回答三个问题：

1. CI 是否产出了正确的 benchmark ELF。
2. ELF 是否适合目标板运行。
3. 板端实际运行结果是否通过。

## 2. 文件命名

固定命名：

```text
benchmark-report.md
```

不要把报告写入 `artifacts/`，避免和 CI 原始产物混在一起。

## 3. 报告章节

报告建议包含以下章节：

```text
# Benchmark 运行报告
1. 报告元信息
2. 产物接收状态
3. Benchmark 构建配置
4. ELF 静态检查
5. 板端环境
6. 部署与运行
7. 结果汇总
8. 结论
9. 失败阶段或后续建议
```

## 4. 报告元信息

必填字段：

| 字段 | 说明 | 示例 |
| --- | --- | --- |
| report_version | 报告格式版本 | v0.1 |
| generated_at | 报告生成时间 | 2026-06-16 20:30:00 +0800 CST |
| run_id | GitHub Actions run id | 27321189218 |
| repo | 仓库 | <org>/<repo> |
| package_ref | Conan 包引用 | <pkg>/<version> |
| build_kind | 构建类型 | linux |
| target_key | 目标 key | linux-armv7 |
| toolchain_version | 工具链版本 | 11.3.rel1 |
| source_branch | 源码分支 | fcpp-dev |
| report_path | 报告绝对路径 | /path/to/<repo>_board_ci/<run_id>/benchmark-report.md |

## 5. 产物接收状态

必须记录：

| 检查项 | 说明 |
| --- | --- |
| run 根目录 | `<root>/<run_id>` 是否存在 |
| build 子目录 | 是否存在 |
| 目标产物目录 | 完整路径 |
| result.json | 是否存在，`status` 值 |
| board-transfer.json | 是否存在 |
| benchmark-info.json | 是否存在，`status` 值 |
| benchmark ELF | 相对路径 |
| benchmark build log | 相对路径 |

如果缺任何关键文件，报告结论应标记为失败，失败阶段为 `产物未收到`。

## 6. Benchmark 构建配置

从 `artifacts/benchmark-info.json` 和 `artifacts/benchmark-config.json` 提取：

| 字段 | 示例 |
| --- | --- |
| target_os | Linux |
| target_cpu | cortex-a7 |
| float_abi | hard |
| fpu | neon-vfpv4 |
| executable_relpath | artifacts/benchmark-linux-armv7-11.3.rel1 |
| build_log_relpath | artifacts/benchmark-build.log |
| built_at | 2026-06-11T11:11:07+08:00 |

这些字段用于确认当前产物是否匹配 RK3506 armv7 hard-float 目标。

## 7. ELF 静态检查

必须运行：

```bash
file artifacts/benchmark-linux-armv7-11.3.rel1
readelf -h artifacts/benchmark-linux-armv7-11.3.rel1 | sed -n '1,80p'
readelf -l artifacts/benchmark-linux-armv7-11.3.rel1 | sed -n '/Requesting program interpreter/p'
sha256sum artifacts/benchmark-linux-armv7-11.3.rel1
```

必须记录：

| 字段 | 通过条件 |
| --- | --- |
| 文件类型 | ELF 32-bit LSB executable, ARM |
| ABI | EABI5 hard-float |
| 动态解释器 | /lib/ld-linux-armhf.so.3 |
| 文件大小 | 非 0 |
| SHA256 | 本地和板端一致 |

如果不满足，失败阶段为 `ELF 架构不符`。

## 8. 板端环境

必须记录：

```bash
uname -a
uname -m
test -e /lib/ld-linux-armhf.so.3 && echo interp_present=yes || echo interp_present=no
```

建议记录：

```bash
command -v base64 || true
command -v sha256sum || true
command -v ldd || true
```

通过条件：

```text
uname -m = armv7l 或等价 armv7
interp_present=yes
```

## 9. 动态依赖解读

优先使用：

```bash
ldd /tmp/<pkg>_benchmark/benchmark
```

如果板端没有 `ldd`，使用：

```bash
/lib/ld-linux-armhf.so.3 --list /tmp/<pkg>_benchmark/benchmark
```

通过条件：

```text
libm.so.6 => /lib/libm.so.6
libc.so.6 => /lib/libc.so.6
/lib/ld-linux-armhf.so.3
```

如果缺动态库，不要直接安装系统包，应先记录缺失项并回报。

## 10. 运行输出解读

必须捕获：

- stdout
- stderr
- 退出码

协议字段：

| 行 | 含义 |
| --- | --- |
| BENCHMARK_START | benchmark 开始 |
| MODULE\|name\|cases=n | 模块名和用例数量 |
| RESULT\|case\|value | 单个用例结果 |
| BENCHMARK_END | benchmark 结束 |

通过条件：

- `BENCHMARK_START` 出现一次。
- `BENCHMARK_END` 出现一次。
- `MODULE` 出现一次。
- `RESULT` 数量与 `MODULE` 中 `cases` 一致。
- 退出码为 `0`。

## 11. 结果汇总表

报告应将结果整理成表格：

| module | case | value | unit |
| --- | --- | ---: | --- |
| LibBench | test_add_n128 | 80 | benchmark 输出原始值 |
| LibBench | test_sub_n128 | 76 | benchmark 输出原始值 |

当前 `RESULT` 第三列是 benchmark 输出原始值。Linux A 核端口使用 `clock_gettime(CLOCK_MONOTONIC)`，通常可按微秒级耗时理解，但报告中应保留“原始值”字样，避免后续 MCU cycles 与 Linux us 混淆。

## 12. 结论字段

结论必须明确：

| 条件 | 状态 |
| --- | --- |
| CI 产物含 benchmark ELF | 满足 / 不满足 |
| benchmark-info.json status=success | 满足 / 不满足 |
| ELF 为 ARM 32-bit hard-float | 满足 / 不满足 |
| 板端解释器存在 | 满足 / 不满足 |
| 动态依赖可解析 | 满足 / 不满足 |
| benchmark 退出码为 0 | 满足 / 不满足 |
| benchmark 协议输出完整 | 满足 / 不满足 |
| watcher 可自动消费 | 满足 / 暂不满足 |

## 13. 失败阶段分类

固定分类：

```text
产物未收到
ELF 架构不符
无法传到板端
板端权限问题
解释器/动态库问题
benchmark 运行失败
report 生成失败
```

同一报告只应选择最靠前的失败阶段作为主失败原因，其余问题写入后续建议。

## 14. v0.1 示例结论

`run_id=27321189218` 的结论为：

```text
验证通过。benchmark ELF 可在 RK3506 armv7 板端运行，退出码为 0，输出协议完整。当前 SSH 不通时可使用串口自动化；SSH 恢复后 watcher 可切换到 scp + ssh。
```
