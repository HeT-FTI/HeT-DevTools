# Benchmark 上板测试架构设计

## 1. 目标

本文记录本项目 `benchmark/` 模块在 RK3506 Linux armv7 板端上的上板测试架构。当前目标不是替代业务测试，而是提供一条稳定、可追溯、可被 CI 和本机 watcher 消费的性能基准验证链路。

核心目标：

- GitHub Actions / HETAI CI 负责编译本项目 package 和 benchmark ELF。
- 内网调试服务器负责接收 CI 产物并执行上板验证。
- RK3506 Ubuntu / Buildroot armv7 板端负责运行 benchmark ELF。
- 每个需要上板验证的 `run_id` 目录保存统一格式的 benchmark report。

## 2. 角色与边界

| 角色 | 职责 | 不负责 |
| --- | --- | --- |
| 本仓库 | 保存 benchmark 源码、配置模板、技术文档、CI workflow 入口 | 保存板端密码或私钥 |
| HETAI CI self-runner | 构建 `linux-armv7-11.3.rel1` package 和 benchmark ELF | 直接操作 RK3506 串口 |
| 内网调试服务器 | 接收 CI 产物、运行板端测试、生成 report | 修改内网验收服务器 |
| RK3506 板端 | 执行 benchmark ELF 并输出协议行 | 安装未确认的系统包或改系统服务 |

## 3. 数据流

```text
GitHub push / workflow_dispatch
        |
        v
HETAI CI self-runner
        |
        | 1. conan create <pkg>/<version>
        | 2. benchmark no-flash build
        | 3. package artifacts
        v
/path/to/<repo>_board_ci/<run_id>/build/<org>/<repo>/linux-armv7-11.3.rel1
        |
        | board test server consumes artifacts
        v
RK3506 board /tmp/<pkg>_benchmark/benchmark
        |
        | stdout benchmark protocol
        v
<run_id>/benchmark-report.md
```

## 4. 目录约定

CI 传输到本机后的目标目录：

```text
/path/to/<repo>_board_ci/<run_id>/build/<org>/<repo>/linux-armv7-11.3.rel1
```

目标目录内关键文件：

```text
result.json
package_refs.json
summary.md
console.log
board-transfer.json
artifacts/package-folder.tar.gz
artifacts/package-info.txt
artifacts/benchmark-linux-armv7-11.3.rel1
artifacts/benchmark-info.json
artifacts/benchmark-build.log
```

每个需要上板测试的 run 根目录应保存：

```text
/path/to/<repo>_board_ci/<run_id>/benchmark-report.md
```

后续 watcher 还可以新增：

```text
.board-test-status.json
board-test.log
board-test-result.json
```

这些文件属于本机板端测试结果，不应覆盖 CI 原始 artifacts。

## 5. Benchmark 构建模型

`benchmark/script/run_bench.py` 读取平台配置并生成 Conan profile：

- Linux A 核配置使用 `target_os: Linux`。
- RK3506 使用 `target_cpu: cortex-a7`。
- armv7 hard-float 使用 `float_abi: hard` 和 `fpu: neon-vfpv4`。
- `--no-flash` 只构建，不部署板端。

CI benchmark 构建要求：

```bash
cd benchmark
python3 script/run_bench.py --config platform/bench_config_ci_rk3506.json --no-flash
```

产物要求：

```text
benchmark/build/Release/benchmark
```

CI 收集后命名为：

```text
artifacts/benchmark-linux-armv7-11.3.rel1
```

## 6. 板端运行模型

首选部署方式是 SSH：

```bash
scp artifacts/benchmark-linux-armv7-11.3.rel1 root@<board-ip>:/tmp/<pkg>_benchmark/benchmark
ssh root@<board-ip> '/tmp/<pkg>_benchmark/benchmark'
```

当前 RK3506 网络在本机环境下不稳定时，使用串口 `/dev/ttyACM0`：

```bash
picocom -b 115200 /dev/ttyACM0
```

自动化初版可以通过串口 base64 传输：

```text
local ELF -> base64 -> serial heredoc -> board base64 -d -> chmod +x -> run
```

为避免与其他项目冲突，本项目默认板端临时目录建议使用：

```text
/tmp/<pkg>_benchmark
```

## 7. 输出协议

benchmark ELF 标准输出必须包含：

```text
BENCHMARK_START
MODULE|<module>|cases=<n>
RESULT|<case>|<value>
...
BENCHMARK_END
```

示例：

```text
BENCHMARK_START
MODULE|LibBench|cases=2
RESULT|test_add_n128|80
RESULT|test_sub_n128|76
BENCHMARK_END
```

watcher 和 report 生成器只依赖这些协议行，不依赖额外日志格式。

## 8. Watcher 初版职责

本机 watcher 后续应实现：

- 扫描最新或指定 `run_id`。
- 检查 `result.json` 和 `artifacts/benchmark-info.json`。
- 校验 benchmark ELF 架构和解释器。
- 使用 SSH 或串口部署到板端。
- 捕获 stdout/stderr、退出码、板端 `uname -a`、动态库解析结果。
- 写入 `benchmark-report.md`、`board-test.log`、`board-test-result.json`。
- 使用 lock 文件防并发。
- 支持 `--dry-run`。

## 9. 当前结论

`run_id=27321189218` 已验证通过：

- benchmark ELF 为 ARM 32-bit hard-float。
- 动态解释器为 `/lib/ld-linux-armhf.so.3`。
- 板端架构为 `armv7l`。
- 板端运行退出码为 `0`。
- 输出协议完整。

这证明当前 benchmark 模块已经具备作为 RK3506 armv7 上板验证基线的条件。
