# Benchmark 模块版本更新记录

## v0.4.0 - 2026-06-16

### 变更

- 新增 `benchmark/docs/` 技术文档目录。
- 新增 benchmark 上板测试架构设计文档。
- 新增 benchmark 使用教程。
- 新增 benchmark report 规范与解读。
- 新增 benchmark 模块版本更新记录。
- `benchmark/conanfile.py` 已将 `pyserial` 改为串口采集阶段懒加载。
- `benchmark/conanfile.py` 已将入口源码导出从固定 `bench_entry.c` 放宽为 `bench_entry.*`，兼容 C 和 C++ 两种入口文件命名。

### 结论

当前 benchmark 模块可以支持两种工程模式：

- C 入口模式：适合家电控制板、裸机或 C ABI 稳定接口。
- C++ 入口模式：适合直接调用 C++ 库、模板库或 ETL 相关接口。

## v0.3.0 - 2026-06-11

### 变更

- HETAI CI 已能为 `linux-armv7-11.3.rel1` 生成 benchmark ELF。
- CI 传输目录中新增：
  - `artifacts/benchmark-linux-armv7-11.3.rel1`
  - `artifacts/benchmark-info.json`
  - `artifacts/benchmark-build.log`
  - `artifacts/benchmark-config.json`
  - `artifacts/benchmark-host.profile`
- `summary.md` 中新增 Benchmark Build 小节。

### 验证

`run_id=27321189218` 已在 RK3506 板端验证通过：

```text
BENCHMARK_START
MODULE|LibBench|cases=2
RESULT|test_add_n128|80
RESULT|test_sub_n128|76
BENCHMARK_END
```

退出码：

```text
0
```

### 结论

CI 产物已经从“只有 <pkg> package”推进到“包含可直接上板运行的 benchmark ELF”。

## v0.2.0 - 2026-06-10

### 变更

- 明确内网调试服务器作为本项目 board benchmark 的部署目标。
- 明确 CI 传输目录结构：

```text
/path/to/<repo>_board_ci/<run_id>/build/<org>/<repo>/linux-armv7-11.3.rel1
```

- 明确每个 run 目录内应包含：
  - `result.json`
  - `package_refs.json`
  - `summary.md`
  - `console.log`
  - `board-transfer.json`
  - `artifacts/package-folder.tar.gz`
  - `artifacts/package-info.txt`

### 发现

早期 CI package 只包含：

```text
lib/lib<pkg>_cpp.a
lib/lib<pkg>_c.a
include/
lib/cmake/
```

没有 benchmark ELF，不能直接上板运行。

### 结论

需要 CI 增加 benchmark build job，或者由本机基于源码和包重新构建 benchmark。

## v0.1.0 - 2026-05

### 变更

- 引入 benchmark 基础框架。
- 支持 Cortex-M 裸机和 Cortex-A Linux 两类目标。
- 建立统一输出协议：

```text
BENCHMARK_START
MODULE|<module>|cases=<n>
RESULT|<case>|<value>
BENCHMARK_END
```

- Linux A 核端口通过 `clock_gettime(CLOCK_MONOTONIC)` 计时。
- 部署后端支持 `adb`、`ssh`、`openocd`、`pyocd`、`jlink`。

### 结论

benchmark 框架具备基础扩展能力，但尚未完成 RK3506 上板验证闭环。

## 后续计划

- 实现本机 watcher：
  - 扫描最新 run_id。
  - 检查 `result.json` 和 `benchmark-info.json`。
  - 自动部署 benchmark ELF 到 RK3506。
  - 捕获 stdout/stderr 和退出码。
  - 自动生成 `benchmark-report.md`。
- 支持 dry-run 和 lock 防并发。
- SSH 可达时优先使用 `scp + ssh`。
- SSH 不可达时使用串口 base64 传输和执行。
- 避免与其他项目临时目录冲突，本项目默认使用 `/tmp/<pkg>_benchmark`。
