# Changelog

All notable changes follow [Conventional Commits](https://www.conventionalcommits.org/) + fcpp emoji superset.

## [Unreleased]

### Changed

- **VS Code 下限从 `1.95.0` 抬到 `1.134.0`（`engines.vscode`）**：1.95 是 2024-10 的宿主，为它养 macOS 兼容分支不划算。实证：macOS 的 app 主程序名逐版本不同 —— `microsoft/vscode#291948`（2026-02，里程碑 1.110）把它从写死的 `Electron` 改成 `product.nameShort`（`Code`），`#326502`（2026-07，1.131）删掉了 `Electron` 兼容软链；我直接读了官方 `darwin-arm64` 包的中央目录确认：1.109.5 只有 `Electron`、1.110.0 两者都有、1.131.0 起只有 `Code`。**1.134.0 是"环境里不存在 Electron + 三条线（`engines.vscode` / `@types/vscode` / CI 钉住版）零错位"的唯一点**（`@types/vscode` 只发布离散版本：…1.125.0 → 1.134.0 → 1.136.0，**没有 1.131.0**）。
- `@types/vscode` 由 `^1.95.0`（锁文件实际解析到 1.134.0）改为 `~1.134.0`：让**编译期** API 面与对用户的承诺一致 —— 之前承诺 1.95、却按 1.134 的类型写代码，属于"声明 ≠ 实际"（本次修正后 `tsc` 仍干净，说明我们本来就没用到更新的 API）。

## [0.4.0] - 2026-09-08

### Added

- **Linux 隔离 managed lane（A3，派生优先）**：Linux 宿主检测到 `apt` + 免密 root（uid0 或 `sudo -n`）时 Provider 为 `linux-managed`——在 `~/.het-fti/managed-env` 自举与 WSL2 车道**同构**的隔离车道（私有 venv conan/cmake/ninja + 私有 CONAN_HOME + 生成式 gcc-13 profile + root apt 自愈 python3-venv/gcc-13/lcov/gcov 符号链），不 touch 系统环境；驾驶舱新增「Linux 派生 managed lane · ~/.het-fti/managed-env」块、chip 摘要、HUD 车道双口径、`het.getLinuxLane` 命令；本地 WSL DoD 绿（ensure + `conan create` Release coverage → 76.9%/66.7%，与 CI 同源）。无 apt/免密 root 的宿主保持 `linux-native` 并给出诚实引导文案。
- **命令可发现性（P1-B-2）**：`package.json > contributes.commands` 补齐 `het.envCheck / het.openDocsArtifact / het.openBuildOutput / het.openCoverageReport / het.healthReport` 等 5 条（共 35 条命令入命令面板），`package.nls.*` 中英文案全量同步。
- **离线模板回退演练（C7）**：`HET_FORCE_TEMPLATE_OFFLINE=1` 强制走本地内置模板回退的端到端宿主检查。

### Changed

- **移除 win-mingw 静默降级（A1/A2）**：`ProviderId` 去掉 `win-mingw`；Windows 无可用 WSL2 时返回 `win-wsl-required`（coverage none）并明确引导 `wsl --install -d Ubuntu-24.04`，或显式设 `metadata.toolchain: system` 走本机 MSVC 兼容（无覆盖率）——**绝不自动选 MSVC**；`win-wsl2-pending`/`wslProbe` 提示改为可复制命令引导；移除 `toolchainDiscovery` 的 WSL 信息性快照（车道口径为准）。verify 矩阵扩为 5 行（新增 `linux-managed`）。
- **chip 死字段清理（D1）**：移除 `ChipModel` 遗留的 `conanEnv`/`runtimeDetail`/`coverage`（渲染已被 `envSummary` 与 coverage 报告同源取代）。

### Fixed

- **环境耦合单测注入化（D3）**：`toolchainDiscovery` 支持 `rootCandidates` 注入，测试不再触碰真实目录。

### 平台真机收敛（P2 · platform-real，2026-09-08）

- **真机验证 job**：`.github/workflows/ci.yml` 新增 `platform-real`（ubuntu-latest + macos-latest），在**真实扩展宿主**里驱动 `conan create + GTest + docs`（fixture = 打包内置模板 `assets/template`；Linux lane 保留 coverage，macOS 关闭）；`verify` job 扩为 ubuntu/macos/windows。收敛后触发改为 **workflow_dispatch-only**（省额度）。
- **六项平台决策落地**：① macOS 覆盖率 = none（Apple clang 无 GNU gcov/lcov，llvm-cov 列入后续，reason/note/label 明示）；② Linux build+docs 先走 managed lane（linux-managed），原生仅当 lane 不可用 / `toolchain: system`；③ 真机 docs 双平台闭环（macOS 原生 + Linux lane）；④ 原生缺 conan 默认 profile 时自动 `conan profile detect`（仅缺失、绝不覆盖已有）；⑤ 支持架构 = Windows x64 / Linux x64 / macOS arm64（macOS x64、Linux arm64 不支持）。
- **headless 文档构建**：`het.docs` 仅打开面板（构建需 webview 消息）→ 新增 `het.docsRun`（复用同一 runner，含 WSL2/Linux lane + 原生分派）与 `het.getLastDocsOutput`，供真机宿主与自动化直接驱动。
- **真机结果**（run `34196799144` 全绿）：ubuntu-latest = linux-managed lane 构建 + GTest 3/3 + lane 内 lcov/genhtml `coverage_report`（lines 76.9%）+ lane docs（doxygen/sphinx 产物）；macos-latest = apple-clang 原生构建 + GTest + 原生 docs（conan venv python：numpy/sphinx）。verify 三平台均绿（unit 322）。
- **关键修复**：`rootAptLinux` 不再把 `sudo -n` 当 `apt-get` 参数（apt 报 `option 'n' is not understood`）→ `sudo` 作为命令执行；`linkGcov13` 改走 `sudo -n bash -c`；macOS 原生 docs 的 python 首选 = 解析到的 conan 同目录解释器（PATH 在 macOS 扩展宿主被重继承，`which` 会命中无 numpy 的 system python）并加 `import numpy` 探针；realBuild 覆盖率断言改目录感知（`coverage_report` 是目录不是文件）。本地 WSL lane 复现覆盖率 76.9% 与 CI 同源。

## [0.3.3] - 2026-09-08

### Fixed

- **Doxygen 主入口指向导航页（docs.html）**：`het.openDocsArtifact`、chip 文档行探测、文档中心产物列表统一优先 `docs/doxygen/build/docs.html`（多语言/多版本导航中枢），不再指向某个具体语言/版本的页面；Sphinx 仍为 `html/index.html`。探测兼容旧产物（无 `docs.html` 时回退递归查找 `index.html`）。

## [0.3.2] - 2026-09-07

### Fixed

- **conan 就绪始终为 ✗ 的根因（issue-3）**：`laneConanPresent` 之前用 `wsl.exe … bash "<字符串>"`（无 `-lc`）→ bash 把命令当**文件名**，恒 exit 127 = false，导致已成功构建却显示「托管环境 conan 未就绪」。同时 `getWslLaneStatus` 的内联 `-lc` 探测（`$lane` 双引号）经 wsl.exe 传递后失效 → HUD 的 CMake/Ninja 恒 ✗。**统一改为文件传输通道**（`runWslScript`），新增 `probeLaneDocsTools`；实测 lane conan 2.32 / cmake 4.4.3 / python 3.12 / sphinx 8.2 / doxygen 1.9.8 / dot / make 全部正确识别。
- **体检粒度化打分（issue-3）**：覆盖率/测试/构建改为 0–1 分级（服务「稳定、可靠、有保障、经得起推敲」）：
  - 覆盖率（5 分制）：未开启=0 · 已开启无报告=0.4（2/5）· ≥60%=0.6 · ≥80%=0.8 · ≥90%=1.0（5/5）；
  - 单元/压力测试：失败=0.2 · 全绿但跳过/用例偏少=0.7 · 全绿=1.0；
  - 构建：从未=0.2 · 失败=0.4 · 成功未跑测试=0.75 · 构建+测试全绿=1.0。
  明细面板按 `得分/权重` 显示（如 2/5），gap 文案「覆盖率未达标」不再误报「未开」。
- **文档中心改车道口径（issue-1）**：托管车道下工具表显示**车道**的 Python/Doxygen/Graphviz/Sphinx/make（含来源注记），不再报「Python ✗」「Graphviz 路径不匹配」（车道自动 reconcile `/usr/bin`）；native 回退原嗅探。
- **文档构建进度可视化（issue-1）**：与 `conan create` 同款——chip 转圈 + 「构建文档」运行中提示、驾驶舱日志抽屉实时打印、文档面板内 Busy 提示。
- **悬停卡快捷操作排版（issue-2）**：改为逐行 bullet（每个动作一行），不再挤成一行被截断。
- **监控卡 HUD（issue-4）**：宽度自适应（`min(780px, calc(100vw-32px))` 居中，统计/动作网格 `auto-fit`）；环境条目**双行显示**（主行值 + 副行真实路径，如 `WSL2 车道 · ~/.het-fti/managed-env/venv/bin/conan`），一眼分辨车道托管 vs 本机工具。
- **webview 设计语言统一（issue-5）**：覆盖率面板、工程健康明细改用共享 `pageShell/BASE_CSS`（卡片/行/chip/按钮/详情样式层级一致）。

## [0.3.1] - 2026-09-07

### Fixed

- **覆盖率本地与 CI 语义对齐（V5-6，issue-2）**：车道 `CONAN_HOME` 由 `…/managed-env/conan2` 改为 `…/managed-env/.conan2`（旧缓存自动一次性迁移），使模板覆盖率步骤硬编码的 `…/.conan2/p/b/…` 过滤 glob 与 GitHub Action（`~/.conan2`）完全一致——此前车道本地覆盖率在 `lcov --extract` 处匹配不到任何记录而失败，在线 Action 却通过（本地 76.9% / 66.7% 与 CI 同源）。车道缺 `lcov/genhtml/gcov` 时免密 root 自愈安装（镜像 CI 的 `apt install lcov`）。
- **覆盖率报告定位打通（issue-2）**：新增共享定位/解析模块（`coverage/report`）：先查 `test_package/test/export/coverage/coverage_report`（conan create 现场路径，车道与原生一致），再查项目 `coverage_report` 与 `build` 树、机器 `.conan2/p`；解析 genhtml 行/函数百分比。覆盖面板、chip「代码覆盖」行与新增 `het.openCoverageReport` 命令三处同源。
- **环境/Conan 状态反映“实际使用的工具链”（issue-1）**：`getWslLaneStatus` 的 conan/cmake 改为报告**车道 venv**（构建真正使用的那份），不再报告发行版 base 里装了但扩展不用的 conan——此前 base 未装 conan 也能构建成功，显示却一直“缺 conan”；HUD 环境行同样按车道口径显示（不再因 Windows 侧无 conan 而显示红叉）。
- **健康状态过期不再误导（issue-1）**：构建/测试/覆盖率/环境检查完成后强制重算体检（`ensureHealthCached(true)`），此前激活时的旧“conan 未就绪”会一直残留到手动重跑。
- **webview 与 chip 完全同步（issue-3）**：新增 live 状态枢纽（`features/live`），chip 刷新即广播；体检明细面板改**单例 + 事件驱动**（去掉固定 700 ms 延时，重跑后即时刷新），覆盖率面板订阅同源刷新。
- **悬停卡版式（issue-4）**：「状态」列只显示运行结果 + 打开结果/明细的**入口**（输出/测试结果/Doxygen/Sphinx/报告/明细）；所有执行动作归入「快捷操作」区（检查环境 / 构建并测试 / 构建文档 / 生成覆盖率 / 重新体检 / 完整监控卡）。

## [0.3.0] - 2026-09-07

### Added

- **悬停小卡片控制台（V5-2）**：chip 悬停升级为可交互「项目/状态」七行闭环（开发环境 / 构建结果 / 测试中心 / 技术文档 / 代码覆盖 / 模板同步 / 工程健康——四字标签、总括置后）；每行带 `command:` 链接（Copilot 同款，悬停常驻、点击即执行、移出即消失）；技术文档行成功后刷出 `[Doxygen] [Sphinx]` 产物入口、失败可跳文档中心；工程健康行极简显示（分数/判定/项数 + `[体检]`/`[明细]`），可提升标签以独立 hint 行呈现避免撑破表格。
- **健康维度细化（电脑管家式体检）**：体检缓存扩为完整 report；新增判定词与 ≤3 可提升标签（fail→warn→权重排序）；`het.healthReport` 体检明细面板（12 项得分/颜色/建议 + 重新体检）。
- **环境展示对齐新设计语言（V5-2B）**：总览页移除旧 generic 嗅探明细/运行时行/工具 chips，只展示 Provider 决策 → 托管环境 → WSL/macOS 车道 → 手动覆盖（仅非空 `het.tools`）；新增单一环境样本（`envSample`），体检 conan 判据接车道事实。
- **metadata 人类可读 + 无 .bak（V5-3）**：`metadata.json` 写回全部手术式（只动被改字段、保留 fcpp 原排版，新项目即模板原样 + 手术改写）；fcpp 风格序列化器兜底；全链路不再产生 `.bak`。
- **文档环境闭环（V5-4）**：Windows + managed 文档构建全程走 WSL2 车道（venv `numpy/sphinx/sphinx-intl/sphinx-rtd-theme` + 免密 root apt 自愈 `doxygen/graphviz/make`，不碰发行版 conda 环境）；车道就绪自动手术式覆写 `graphviz_bin=/usr/bin`。
- **文档产物入口（V5-5）**：文档面板 Doxygen/Sphinx 分开按钮（无产物灰、成功点亮，默认浏览器打开）；构建成功 toast 带「打开 Sphinx/Doxygen 文档」动作；悬停卡文档行同源。

## [0.2.0] - 2026-09-07

### Added

- **构建执行接入环境车道（V5-1，治本 all-in-one）**：`managed` 语义项目在 Windows 上自动经 **WSL2 托管车道**构建——Linux 同语义（gcc-13 + gcov/lcov）、与发行版内的 conda base / FEniCS 等环境完全隔离。
  - 车道自举（幂等）：`~/.het-fti/managed-env` 下私有 venv（conan/cmake/ninja）+ 私有 `CONAN_HOME` + **生成式**（绝不探测）Conan 2 profile（gcc 13 / libstdc++11 / cppstd 17 + `tools.build:compiler_executables` 钉死 gcc-13/g++-13）。
  - 自愈：发行版缺 `python3-venv` 时经 WSL 免密 root 一次性 `apt-get install python3-venv` 后重试；缺 gcc-13/lcov 时给出可执行指引。
  - 脚本一律以文件方式执行（`wsl.exe … -- bash <file>`），绕开 wsl.exe 对多行 argv 脚本的破坏；诊断路径 `/mnt/<drive>/…` 自动映射回 Windows 供“问题”面板跳转。
  - 修复潜伏缺陷：`wsl -l -q` 的 **UTF-16LE 输出解码**（此前发行版名是 NUL 垃圾）；`managedProfile` 由 Conan 1 的 `[env]` 改为 Conan 2 的 `[conf] tools.build:compiler_executables` 并补 `compiler.cppstd`。
  - 无 WSL 发行版时给出明确指引（不再静默回落到不可用的 MSVC 默认 profile）；`toolchain: system` 保持原样（本机工具链兼容模式）。

## [0.1.1] - 2026-09-07

### Added

- **环境初始化器（V4）**：宿主能力探测（Linux/macOS/WSL2/MinGW/MSVC）、托管环境 managed-env（Python venv + conan/cmake/ninja + CONAN_HOME + 标记文件）、WSL2 车道（含托管发行版引导）、macOS 车道（CLT + llvm-cov）、环境页（准备/移除按钮）。
- **监控卡（V4-6）**：HUD 总览（状态卡 + 10 快捷动作 + 1-9 键盘）、状态栏芯片两栏表格 tooltip + gitmoji 徽标条、Snooze / 隐藏 HUD。
- **零人工验收矩阵（V4-7）**：`verify-installed` 四阶段（empty/proj/matrix/scrub）+ 心跳看门狗 + 零通知宿主。
- **卸载语义（V4-8）**：激活时托管环境 GC、项目工具链 `managed|system` 标记、新项目默认 managed、`het.envGc` / `het.envRemove` 命令。

### Fixed

- 版本号 0.1.0 → 0.1.1：修复同版本覆盖安装不生效（VS Code 不更新同版本扩展）导致旧版 UI/环境页残留的问题。

## [0.1.0] - 2026-09-03

### Added

- **工程脚手架（Phase 0）**：TypeScript strict + esbuild 单文件打包、ESLint、Mocha、`@vscode/test-electron` 集成宿主、`.vsix` 本地打包、Marketplace 元数据、GitHub 身份服务（三层降级）、模板来源服务（TEMPLATE_REF 锁定）。
- **核心闭环（Phase 1）**：fcpp 项目三级探测、工具链检测、欢迎页、状态栏、构建（`conan create` + 诊断映射）、GTest/CTest 输出解析、测试结果视图、驾驶舱（健康评分）、真实 fcpp 端到端 C1（构建+5 测试通过）。
- **开发者自动化（Phase 2）**：metadataService（校验/diff/.bak 写回）、元数据设置编辑器 G-17、依赖管理器 G-07（conandata+metadata 双写、四桶约束）、新增模块向导 G-08、测试生成模式 A G-09、TestController 测试浏览器、覆盖率视图 G-06、C2 端到端。
- **蓝图驱动测试生成（T-2.8）**：模式 B——从 PRD/PlantUML 提取契约 → GTest 契约 + 实现计划（落 `/workspace/`）。
- **文档 / 质量 / 提交 / 发布（Phase 3）**：文档中心 G-10（含 D-10 graphviz 本机修正）、质量门禁 G-11（format/tidy/schema/commitlint/gitleaks + MegaLinter 降级）、提交助手 G-16（双通道）、发布中心 G-12、Preflight G-13、C3 端到端。
- **Benchmark / CI / 审计 / 初始化（Phase 4）**：上板面板 G-14（`--no-flash` + 协议解析）、CI 状态 G-19（离线降级）、审计报告 G-03 完整版（`workspace/audit-report.md`）、专利向导 G-20、`@het` Chat 桥接、模板初始化 G-21、模板更新检查（只读 + 同步计划）、C4 端到端（离线全链路）。
- **打磨（Phase 5）**：`package.nls` 双语（命令/配置/市场文案）、运行时状态栏双语、本地可选遥测（默认关、无外发）、激活计时与 metadata/conandata 节流监听、OS×VS Code CI 矩阵、市场页 README。

### Fixed

- MSVC/GBK 下生成文件的代码字符串保持纯 ASCII（D-11）。
- pybind11 位于 infra 桶时不要求 `enable_python_bindings`（仅主包桶受限）。
- 异步命令注册不再被 `void` 包装吞掉返回值（`executeCommand` 可 await）。

### Security

- 无凭证落地：GitHub 认证复用 VS Code 内置会话 / gh CLI / 匿名降级。
- 遥测默认关闭且本版本不外发任何数据。
