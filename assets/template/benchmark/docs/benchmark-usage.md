# Benchmark 模块使用教程

## 1. 适用对象

本文面向两类开发者：

- 嵌入式工程师：编写或维护 benchmark 用例，关注 C/C++ 入口、板端运行和结果解释。
- CI / DevOps 工程师：构建 benchmark ELF、传输产物、触发上板测试和生成报告。

## 2. 本机准备

进入仓库：

```bash
cd /path/to/<repo>
git status -sb
```

进入 benchmark 模块：

```bash
cd benchmark
```

基础工具：

```bash
python3 --version
conan --version
cmake --version
ninja --version
```

板端调试服务器还应具备：

```bash
picocom -b 115200 /dev/ttyACM0
ssh -V
scp -V
rsync --version
tar --version
```

## 3. Benchmark 配置

Linux armv7 RK3506 推荐配置：

```json
{
  "target_os": "Linux",
  "target_cpu": "cortex-a7",
  "float_abi": "hard",
  "fpu": "neon-vfpv4",
  "extra_cflags": [],
  "compiler_version": "11",
  "toolchain_package_version": "11.3.rel1",
  "deploy_tool": "ssh",
  "remote_path": "/tmp/<pkg>_benchmark/benchmark",
  "ssh_host": "root@<board-ip>",
  "timeout": 30
}
```

不要覆盖模板 `platform/bench_config_linux.json`。本机调试可新增：

```text
platform/bench_config_rk3506.json
```

CI 临时配置可由 CI 脚本生成，不要求提交到仓库。

## 4. 本机构建验证

只构建，不部署：

```bash
cd /path/to/<repo>/benchmark
python3 script/run_bench.py --config platform/bench_config_linux.json --no-flash
```

成功后应出现：

```text
build/Release/benchmark
```

注意：

- `--no-flash` 不应要求串口设备。
- `pyserial` 只在裸机串口采集阶段需要。
- 如果报 `<pkg>/<version>` 找不到，说明本机 Conan cache/remote 尚未准备好目标包。

## 5. CI 构建产物检查

CI 产物目录：

```bash
RUN_ID=<run_id>
RUN_DIR=/path/to/<repo>_board_ci/$RUN_ID/build/<org>/<repo>/linux-armv7-11.3.rel1
```

检查文件：

```bash
find "$RUN_DIR" -maxdepth 2 -type f | sort
jq . "$RUN_DIR/result.json"
jq . "$RUN_DIR/artifacts/benchmark-info.json"
```

检查 ELF：

```bash
file "$RUN_DIR/artifacts/benchmark-linux-armv7-11.3.rel1"
readelf -h "$RUN_DIR/artifacts/benchmark-linux-armv7-11.3.rel1" | sed -n '1,80p'
readelf -l "$RUN_DIR/artifacts/benchmark-linux-armv7-11.3.rel1" | sed -n '/Requesting program interpreter/p'
sha256sum "$RUN_DIR/artifacts/benchmark-linux-armv7-11.3.rel1"
```

预期：

```text
ELF 32-bit LSB executable, ARM, EABI5
hard-float ABI
interpreter /lib/ld-linux-armhf.so.3
```

## 6. 板端预检

串口进入板端：

```bash
sudo picocom -b 115200 /dev/ttyACM0
```

板端执行：

```bash
uname -a
uname -m
test -e /lib/ld-linux-armhf.so.3 && echo interp_present=yes || echo interp_present=no
command -v base64 || true
command -v sha256sum || true
command -v ldd || true
```

预期：

```text
armv7l
interp_present=yes
```

如果 `ldd` 不存在，可以用：

```bash
/lib/ld-linux-armhf.so.3 --list /tmp/<pkg>_benchmark/benchmark
```

## 7. SSH 部署运行

板端网络可达时：

```bash
ssh root@<board-ip> 'mkdir -p /tmp/<pkg>_benchmark'
scp "$RUN_DIR/artifacts/benchmark-linux-armv7-11.3.rel1" root@<board-ip>:/tmp/<pkg>_benchmark/benchmark
ssh root@<board-ip> 'chmod +x /tmp/<pkg>_benchmark/benchmark && /tmp/<pkg>_benchmark/benchmark'
```

如果板端地址不可达，尝试：

```bash
ssh root@<board-ip> 'uname -a'
```

## 8. 串口部署运行

板端网络不可达时，可以使用串口 base64 传输。

本机生成 base64：

```bash
base64 "$RUN_DIR/artifacts/benchmark-linux-armv7-11.3.rel1" > /tmp/<pkg>-benchmark.b64
```

板端执行：

```bash
mkdir -p /tmp/<pkg>_benchmark
cat > /tmp/<pkg>_benchmark/benchmark.b64 <<'EOF'
# 粘贴 /tmp/<pkg>-benchmark.b64 内容
EOF
base64 -d /tmp/<pkg>_benchmark/benchmark.b64 > /tmp/<pkg>_benchmark/benchmark
chmod +x /tmp/<pkg>_benchmark/benchmark
sha256sum /tmp/<pkg>_benchmark/benchmark
/lib/ld-linux-armhf.so.3 --list /tmp/<pkg>_benchmark/benchmark
/tmp/<pkg>_benchmark/benchmark
echo $?
```

为避免与 `oven_CXX` 等其他项目冲突，本项目统一使用：

```text
/tmp/<pkg>_benchmark
```

## 9. 结果判断

通过条件：

- ELF 架构是 ARM 32-bit hard-float。
- 板端存在 `/lib/ld-linux-armhf.so.3`。
- 动态依赖可解析。
- benchmark 退出码为 `0`。
- 输出包含 `BENCHMARK_START` 和 `BENCHMARK_END`。
- 每个 case 都有 `RESULT|...` 行。

失败阶段分类：

| 阶段 | 判定 |
| --- | --- |
| 产物未收到 | run 目录或 benchmark ELF 不存在 |
| ELF 架构不符 | `file/readelf` 不是 ARM hard-float |
| 无法传到板端 | SSH 不通且串口不可用 |
| 板端权限问题 | 无法 chmod 或执行 |
| 解释器/动态库问题 | 缺 `/lib/ld-linux-armhf.so.3`、`libc.so.6`、`libm.so.6` |
| benchmark 运行失败 | 退出码非 0 或输出协议不完整 |

## 10. 生成报告

每个需要 benchmark 的 run 根目录应生成：

```text
/path/to/<repo>_board_ci/<run_id>/benchmark-report.md
```

报告内容按照 `benchmark-report-spec.md` 执行。

最小必填信息：

- run_id
- repo
- target_key
- toolchain_version
- benchmark-info.json 摘要
- ELF 静态检查
- 板端环境
- 部署路径
- 运行命令
- stdout/stderr
- 退出码
- 结论
