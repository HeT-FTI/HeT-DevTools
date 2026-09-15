<div align="center">

# HeT DevTools

**把基于 [fcpp](https://github.com/HeT-FTI/fcpp) 的 C/C++ 工程保障变成“按一下就懂”的伴生仪表。**

> 只需写 `include/` 与 `src/`，剩下的构建、测试、依赖、文档、质量、提交、发布、上板交给它。

A plain-language engineering cockpit for fcpp-based C/C++ libraries: build, test, dependencies, docs, quality gates, release & board benchmarks — one click each.

![VS Code >= 1.134](https://img.shields.io/badge/VS%20Code-%3E%3D1.134-blue) ![Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-green) ![CI](https://github.com/CubicZebra/HeT-DevTools/actions/workflows/ci.yml/badge.svg)

</div>

---

## 为什么用

fcpp 模板用 Conan / CMake / CI / Doxygen / semantic-release 把工程保障做成了“基础设施即代码”。但对只想写 C/C++ 的开发者来说，每个术语都是一道门槛。HeT DevTools 把这些术语全部变成**无脑按钮**：

- **构建** = `conan create`（错误自动映射到“问题”面板）
- **加依赖** = 四桶可视化，`conandata.yml` + `metadata.json` 双写（预览→确认→可撤销）
- **出文档** = `docs/build.py` 一键，Doxygen+Sphinx 双语多版本
- **质量门禁** = 本地绿 = CI 绿（clang-format / clang-tidy / schema / commitlint / gitleaks）
- **提交** = `type(:emoji:):` 双通道（type 定版本号、emoji 触发 CI）
- **发版/Preflight** = 与 GitHub Actions 门禁一一对应
- **上板** = Benchmark 面板（无硬件也可用 `--no-flash` + 模拟输出解析）

## 5 分钟快速开始

1. 安装 VS Code ≥ 1.134，并准备 fcpp 开发环境：`python`（≥ 3.10，文档栈 `sphinx>=8` 的最低要求）、`conan`、C/C++ 编译器（conda 或手动均可）。不想自己备？把工程的 `toolchain` 保持 `managed`，扩展会在隔离车道内按需准备（见下文「环境初始化器」）。
2. 打开一个含 `metadata.json` 的 fcpp 项目（模板生成或自建均可）——扩展自动激活。
3. 命令面板（`Ctrl+Shift+P`）→ `HeT DevTools: 打开仪表盘`。
4. 依次点：`构建并测试` → `覆盖率视图` → `文档中心`。
5. 想从零开始？在 Explorer 里右键一个文件夹 →「在此初始化 fcpp 项目」（零弹窗），或命令面板 `HeT DevTools: 从模板初始化新项目`（向导）。

> 所有“写文件”操作都遵循 **预览 → 确认 → 写回（.bak 备份）**，扩展绝不自动改动 `include/` / `src/` / `conanfile.py`。

## 隐身设计（Invisible by Default）

装之前 VS Code 什么样，装之后还是什么样——**没有侧边图标、没有欢迎页、没有常驻提示**。唯一的变化：打开含 fcpp 工程后，**状态栏右下出现一枚 HeT chip**（监控 only；无工程时 chip 完全隐藏）。

- **悬停 chip** → 简约监控概况（健康分 / 最近构建 / 测试 x/y / 构建运行时），纯图标文本、无命令链接——只读监控，绝无“可点项”。
- **点击 chip** → 键盘可达的 QuickPick 概况：打开仪表盘 / 构建并测试 / 仅构建 / 依赖 / 文档 / 质量 / 提交 / 发布 / 测试结果 / 一键体检。
- **没有项目时从零开始**：Explorer 右键任意文件夹 →「在此初始化 fcpp 项目」——**全程零弹窗零通知**，创建即静默完成并自动打开项目；或走命令面板的五步向导。
- 其余全部功能藏于命令面板 / QuickPick / `@het` Chat，按需出现、零打扰。

## 通用工具链发现（多来源 · 可失败 · 可手动指定）

默认 PowerShell 里找不到工具时，扩展自动多来源嗅探：PATH → conda/mamba 环境（含 base、`~/.conda/envs`、ProgramData 等，优先语义化环境名 build/dev/het）→ uv（`~/.local/share/uv`）→ 工作区 venv。找到后自动把对应目录注入子进程 PATH，让 conan 构建、文档（doxygen/graphviz）、质量（clang-format 等）开箱即用；测试依赖（gtest/benchmark）由 conan 托管时显示为“构建时自动获取”，无需主机安装。托管语义（managed）下的真实构建/文档/覆盖率以**车道口径**为准（Windows=WSL2 托管 lane，见下），不以嗅探结果代替。

嗅探**允许失败**：仪表盘概览「环境与工具链」分区逐项显示 ✓/✗ 与来源（conda 推断标注“启发式推断 · 极可能”，可点「手动指定」覆写为确切路径并即时生效，或「清除」恢复自动）；未找到的项绝不阻塞，需要时回退手动指定。一切无需命令行。

## 离线新建项目（内置模板 · 零弹窗）

扩展自带 fcpp 模板快照（约 2 MB，打包进 vsix）。**完全断网也能建工程**：Explorer 右键任意文件夹 →「在此初始化 fcpp 项目」，全程零弹窗零通知，创建即静默完成并自动打开项目。模板源选择链：在线固定哈希（推荐）→ 内置模板 → workspace/fcpp 开发副本 → het.template.localPath → HET_TEMPLATE_LOCAL；在线不可用时自动回退本地，实际来源写入 `.het/template-ref.json`（供模板更新检查）。Windows 上新项目默认关闭代码覆盖率（MSVC 不支持），并自动对测试包做 GBK 兼容补丁。

**没有 git 也能建工程（T04）**：创建本身不依赖 git——只是跳过 `git init` 与基线提交，并在日志里给出安装指引（`winget install --id Git.Git -e`）；装好 Git 后在该目录自行 `git init` 即可。创建成功仍然**不发任何通知**（窗口保持零打扰）。

## 仪表盘（唯一工作台，可不开）

点击状态栏 HeT chip，或在命令面板执行 `HeT DevTools: 打开仪表盘`（严格单例，重复触发复用不重建）：

- **单列 Markdown 流式布局**：概览 / 构建与测试 / 依赖 / 文档 / 质量 / 提交 / 发布 / 上板等分区自上而下排列，每区可折叠；任意窄宽度不崩坏。
- 顶部目录 chip 与 tooltip 链接可**直达任意分区**（锚点滚动）。
- 概览区：健康分 / 最近构建 / 测试结果三枚 chip + 「一键体检」默认折叠；测试分区收录失败用例。
- 构建/测试运行时**底部日志抽屉自动展开**，成功 3 秒收起；失败自动展开「问题」提示并映射到问题面板。
- **依赖分区内可直接增删依赖**；`HeT DevTools: 添加依赖` 走 QuickPick 搜索流（内置 ConanCenter 精选索引，离线可用，可选目标模块，杜绝手误）。
- **五步新建项目向导**：身份 → 构建参数 → 开关 → 确认；模板源三选（固定哈希推荐 / 在线最新 / 本地模板），在线不可用自动回退本地；成功即自动打开项目。
- 最后页面与向导草稿自动持久化；zh/en chrome 切换；深浅主题全适配。

## 命令一览

| 命令 | 用途 |
|------|------|
| `HeT DevTools: 打开仪表盘` | 健康分 / 环境 / 快捷动作 |
| `HeT DevTools: 在此初始化 fcpp 项目` | Explorer 文件夹右键：零弹窗建项目并自动打开 |
| `HeT DevTools: 构建项目` / `构建并测试` | `conan create`，诊断映射问题面板 |
| `HeT DevTools: 依赖管理器` | 四桶依赖增删（conandata + metadata 双写） |
| `HeT DevTools: 新增模块` | 成对文件骨架（导入标记/双语注释/@exporter） |
| `HeT DevTools: 生成测试` | 模式 A 代码驱动 / 模式 B 蓝图先行（测试先行） |
| `HeT DevTools: 覆盖率视图` | `activate_code_coverage` 引导 + 报告定位打开 |
| `HeT DevTools: 打开覆盖率报告` | 打开最近生成的覆盖率报告（默认浏览器） |
| `HeT DevTools: 打开文档产物` | 打开 Sphinx / Doxygen 文档（Doxygen 打开多语言/多版本导航页） |
| `HeT DevTools: 文档中心` | Doxygen+Sphinx 一键（含 graphviz 本机修正） |
| `HeT DevTools: 质量与安全` | format / tidy / schema / commitlint / gitleaks / MegaLinter |
| `HeT DevTools: 提交助手` | 双通道规范提交，commitlint 预检，推送需确认 |
| `HeT DevTools: 发布中心` / `发布前检查` | 📦 发版引导与 Preflight |
| `HeT DevTools: 上板测试` | Benchmark：`--no-flash` 构建 / 模拟输出解析 |
| `HeT DevTools: CI 状态` | GitHub Actions（离线降级为本地工作流清单） |
| `HeT DevTools: 审计报告` | 10 节 Markdown → `workspace/audit-report.md`（可 `@workspace` 引用） |
| `HeT DevTools: 从模板初始化新项目` / `检查模板更新` | G-21 / G-22（只读对比 + 同步计划） |
| `HeT DevTools: 检查开发环境` | 重新采集环境样本并回写 chip / 环境视图 |
| `HeT DevTools: 托管环境状态（JSON）` / `准备托管环境` / `移除托管环境` | 环境生命周期（同意 → 准备 → 就绪/受阻；移除即清，含自建发行版与同意记录） |
| `HeT DevTools: 宿主能力（JSON）` / `构建环境方案（JSON）` / `WSL2 车道状态（JSON）` / `Linux 车道状态（JSON）` / `macOS 车道状态（JSON）` | 环境事实的四/五个只读出口（排障与脚本化都用这一份，不另写口径） |
| `HeT DevTools: 导出环境诊断（脱敏）` | 一份文件带走排障所需全部事实（路径折叠为 `~`） |
| `HeT DevTools: 工程健康明细` | 12 项细粒度体检面板（得分/权重 + 建议） |
| `HeT DevTools: 项目体检` | 强制重算健康并回写 chip |
| `HeT DevTools: 打开构建输出` | 聚焦“HeT DevTools”输出面板 |
| `@het`（Chat） | 意图路由到对应面板 |

## 隐私与遥测（T-5.2）

- 遥测**默认关闭**（`het.telemetry.enabled`）。
- 开启后仅在本机 `workspaceState` 记录激活/功能使用次数；**本版本不发送任何数据、不含代码与个人数据**（无 PII），并可随时关闭。
- GitHub 登录复用 VS Code 内置认证（D-9）：凭证由 VS Code 托管，扩展不落地、不存储任何密钥。

## 环境初始化器（托管车道 · 三平台同构）

- **托管环境**：`het.env.prepare` 在隔离车道内自举 conan/cmake/ninja 与**生成式** conan profile（`Toolchain 即数据`：profile 只生成、不探测，写进去的是**实际选中**的编译器版本）。落点固定且可一条命令撤销：Linux/WSL 在 `~/.het-fti/managed-env`；Windows 自建发行版另加 `%LOCALAPPDATA%\het-fti\wsl\`（rootfs 缓存）。
- **工具链靠阶梯自愈，不是写死**：Linux/WSL 车道按 **gcc-13（CI 基线）→ 14 / 15 / 12 → 发行版默认** 逐级探测；探不到且有免密 root 时按同一阶梯安装。**写进 profile 的版本永远是选中的那个**（Ubuntu 22.04 仓库无 gcc-13 → 走兼容版、PPA 或升级，扩展给出可复制命令）。文档栈需要 **Python ≥ 3.10**（`sphinx>=8`）：车道从宿主已有解释器里挑最合适的一个建 venv，低于下限时**提前失败并给出办法**，而不是把 pip 的报错丢给你。
- **平台决策**：`het.env.status` 按宿主能力返回 Provider（`linux-managed` / `linux-native` / `win-wsl2` / `win-wsl2-pending` / `win-wsl-required` / `macos-native`）；WSL 存在即走 Linux 语义；无可用 WSL2 时明确引导启用（`wsl --install -d Ubuntu-24.04`）或设 `toolchain: system` 走本机 MSVC 兼容（无覆盖率），**绝不静默降级**。
- **Windows 无发行版时自建（T17，对用户环境 0 侵入）**：检测到 WSL2 但没有可用发行版时，`het.env.prepare` 从 Canonical 官方源拉取**钉死 sha256** 的 Ubuntu 24.04 rootfs，导入成我们自己的发行版（`het-lane-2404`，重名自动 `-2`），并先把代价讲清（约 340MB 下载 / 1.5–2.5GB 磁盘）。三条不变式：只碰带我们双标记的发行版；不动你的发行版（不 `--set-default` / 不 `--unregister` / 不在其中写文件）；全部落在 `%LOCALAPPDATA%\het-fti\wsl\`，用「移除托管环境」一键撤销。失败时如实给 A（手动装官方发行版）/ C（改 `toolchain: system`）两条路，**绝不静默转 MSVC**。
- **构建走环境车道（V5-1 / A3）**：`managed` 语义项目在 Windows 上经 **WSL2 托管车道**执行（`wsl.exe` 内 Linux 语义 + gcov/lcov）；Linux 宿主在有 apt + 免密 root 时走**同构**的 `linux-managed` 车道。两者共用同一套车道脚本：私有 venv + 私有 `CONAN_HOME` + 生成式 profile，**不触碰**发行版里的 conda base / FEniCS 等其他环境；诊断路径自动映射回 Windows「问题」面板。只有 `metadata.toolchain: system` 才走本机工具链（显式兼容模式，默认不推荐）。
- **CMake 只下一份**：车道自带 cmake，构建时跳过模板从 ConanCenter 拉的那份；`system` 语义下宿主 cmake 已达模板下限（默认 3.28）同样跳过，未达则**如实告诉你**本次会从 ConanCenter 拉取（三条出路：装新 cmake、`HET_CMAKE_MIN` 自降底线、改回 `managed`）。
- **镜像与代理（内网）**：`het.env.pipIndexUrl` / `het.env.conanRemote` / `het.env.httpProxy` 只作用于车道私有的 venv 与 CONAN_HOME，不改系统配置；自建发行版可用 `het.env.wslRootfsUrl` + `het.env.wslRootfsSha256` 指向内网镜像（覆盖必须同时给出 sha256），`het.env.keepRootfsCache` 控制移除时是否保留缓存。
- **卸载即清**：`het.env.remove` 移除托管环境（含自建发行版与"已同意"记录）；激活时自动 GC 孤儿目录（无 marker 且无工具产物才清理），也可手动跑 `het.envGc`；扩展卸载后 `globalStorage` 由 VS Code 清除。
- 常用命令：`het.envStatus` / `het.envPrepare` / `het.envRemove` / `het.envGc` / `het.envDump`（**脱敏**诊断包，路径折叠为 `~`）/ `het.getHostCapabilities` / `het.getProvisionPlan` / `het.getWslLane` / `het.getLinuxLane` / `het.getMacosLane`；监控 `het.hud.fontSize`（10–20）。

## 平台支持与验证

| 平台 | 架构 | 工具链 | 覆盖率 | 文档 | 人工步骤 |
|------|------|--------|--------|------|----------|
| Ubuntu 24.04 | x64 | **linux-managed 隔离车道**（`~/.het-fti/managed-env`：私有 venv + 私有 CONAN_HOME + 生成式 profile；编译器走阶梯 13 → 14/15/12 → 发行版默认） | ✅ full | ✅ 车道内 apt 自愈 | 无（有免密 root 时全自动） |
| Ubuntu 22.04 | x64 | 同上；仓库里没有 gcc-13 → 用兼容版 gcc-12，或加 PPA，或升级系统 | 🟡 取决于 gcov 版本 | ✅ | 首次可能需你按提示装一次编译器 |
| Windows + WSL2 | x64 | 发行版内的**同构**托管车道（你已有的官方发行版，或我们自建 `het-lane-2404`） | ✅ full | ✅ 车道内 apt 自愈 | 无（自建发行版后全自动；CI 实测：导入 → 启动 → 车道自举出 gcc-13 → 撤销干净） |
| Windows 无 WSL2 | x64 | 先启用 WSL2（需虚拟化），或显式设 `toolchain: system` 走本机 MSVC 兼容 | ⛔ none | 🟡 宿主备齐则可用 | 启用 WSL2，或显式选择 system |
| macOS arm64 | arm64 | macos-native（Xcode CLT + 车道 venv；Apple clang 按**实际版本**写入 profile） | ⛔ none（Apple clang 无 GNU gcov；llvm-cov→gcov 路线见 T20） | 🟡 venv sphinx ✅；doxygen/graphviz 走 brew（我们只报告不代装） | `xcode-select --install` 一次 GUI 确认 |

- **覆盖率语义**：Linux = full（车道）· Windows/WSL2 车道 = full · Windows 本机 MSVC 兼容 = none · macOS = none。**不支持的平台上，卡片里的覆盖率行显示 `—`（平台没有这项能力），而不是 `✗`（那会像是你没装）**，并附技术原因。
- **支持的架构**：Windows x64 · Linux x64 · macOS arm64；macOS x64 与 Linux arm64 不在承诺范围（车道会明确报出并引导改用 `toolchain: system`）。
- **`system` 语义 = 系统有什么用什么**：扩展不替你安装；缺前置时给**你能直接粘贴**的命令（按平台给 winget/choco · brew · apt），或提示改回 `managed`。CI 里 `linux-system`/`windows-system` 的作用是"先把宿主备成工具齐备的用户机，再断言文档必须成功"——即作业断言 ≤ 平台承诺。
- **车道优先（lane-first）**：`managed` 语义一律先走隔离车道（Windows = WSL2 lane、Linux = linux-managed）；只有 `toolchain: system` 才走本机原生——构建/覆盖率/docs 均不 touch 系统或 conda 环境。
- **CI（`CubicZebra/HeT-DevTools`，branch main）**：
  - **自动门禁**：`ci.yml › verify`（ubuntu/macos/windows：tsc / lint / 单测 / `audit:pins` / vsix 打包，push 与 PR 触发）。`audit:pins` 拦的是"把 CI 事实写进产品代码"（绝对路径、基线编译器字面量、被抄写一遍的版本下限）。
  - **手动真机验证（按平台拆三个 workflow，一个平台 = 一个失败面）**：`env-fresh · linux`（`linux-managed` 含覆盖率 + `linux-system` + 金丝雀）/ `env-fresh · windows`（`windows-system`、`windows-blocked`：无车道时拒绝并给一键切换、`windows-wsl-import`：自建私有发行版走完「计划/代价 → 官方 rootfs 真校验 → 导入 → 启动 → 车道自举 → 车道级幂等（删掉生成式 profile 必须自愈）→ 撤销」，并断言 0 侵入；`-f scenario=wsl-import-full` 再在自建发行版里跑完整 DoD（conan create + GTest + 覆盖率 + 文档））/ `env-fresh · macos`（`macos-lane`，覆盖率按平台跳过）。日志按 `SCENARIO → GATE → PREFLIGHT → MAIN → ASSERT → CLEANUP → EVIDENCE` 分区，证据上传为 `out/real-evidence.txt`。
  - **证据里能查版本**：`vscode=` / `vscodeSource=` 记录本次跑的宿主 —— 回归作业一律跑**钉住版**（= 承诺下限 1.134.0），另有金丝雀作业跑最新版做信号；两者在证据里一眼可分。
  - 逐条证据与 run 号汇总在 `workspace/develope/platform-verification-report.md`（开发文档，不入包）。

## 开发

```powershell
conda activate build   # 本机 node/npm 位于 build 环境
npm install
npm run check          # tsc --noEmit
npm run compile        # esbuild → out/extension.js
npm test               # 单元测试（mocha）
npm run test:c1..c7   # 各阶段端到端（C1~C7，离线可用）
npm run test:real     # 真机扩展宿主（macOS/Linux CI 用；Windows 本机不跑）
node scripts/verify-installed.mjs  # 安装态四阶段 verify（Windows 本机）
npm run package       # vsce package → .vsix（本地 dry-run）
```

按 F5 启动 Extension Development Host；打开含 `metadata.json` 的 fcpp 项目即可触发激活。

> 设计与草图：`workspace/develope/development-plan.md`、`gui-sketches.md`；阶段收尾：`phase1~4-closeout.md`（均为开发文档，不入包）。

## License

Apache-2.0
