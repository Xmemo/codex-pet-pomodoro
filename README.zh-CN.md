# Pet Pomodoro

[![GitHub License](https://img.shields.io/github/license/Xmemo/codex-pet-pomodoro)](LICENSE)
[![GitHub Releases](https://img.shields.io/github/v/release/Xmemo/codex-pet-pomodoro)](https://github.com/Xmemo/codex-pet-pomodoro/releases)

[English](README.md) | 简体中文

**超昼夜节律 × 番茄钟 × 干眼预防提醒，与 Codex 电子宠物一起**

一款受 Huberman Lab 超昼夜节律讨论启发的 macOS 番茄钟。专注时，它贴着 Codex 电子宠物安静计时；该休息时，同一只宠物放大，以平静的待机姿态给工作一个明显的“暂停”信号。干眼预防提醒用于提示屏幕休息，不代表已被临床证实能够预防或治疗干眼。

## 产品体验

下列产品图为 AI 生成或合成的展示插图，不是未经修改的实机录屏，也不证明某个运行状态。

<p align="center">
  <img src="docs/images/pet-pomodoro-companion-panel.png" alt="番茄钟与 Codex 电子宠物组合在同一个紧凑面板中" width="100%">
  <br><em>让计时器与电子宠物保持在一起，成为一个专注伙伴。</em>
</p>

<p align="center">
  <img src="docs/images/pet-pomodoro-rest-takeover.png" alt="Codex 电子宠物旁的面板清晰展示 25、50、90 分钟选项和播放控制" width="100%">
  <br><em>在宠物旁选择 25、50 或 90 分钟节奏，并控制计时。</em>
</p>

<p align="center">
  <img src="docs/images/pet-pomodoro-focus-controls.png" alt="进入休息时，Codex 电子宠物放大占据屏幕，紧凑计时器仍显示在旁边" width="100%">
  <br><em>到达恢复节点，宠物放大陪伴休息。</em>
</p>

> [!WARNING]
> **非官方免责声明**：本项目是独立的社区工具，与 OpenAI 无关联，也未获得其认可。本项目不捆绑 OpenAI 徽标或官方宠物资产。

---

## 工作流程

伴侣程序不申请也不使用「录屏」或「辅助功能」权限。Codex 暴露独立宠物窗口时，计时器按窗口边界跟随；语音模式下则根据宿主窗口几何位置估算宠物在右下方的位置。Codex 调整布局后，估算位置可能偏移。若没有可识别的宠物/宿主窗口，表盘会隐藏，而不会固定在无关的屏幕位置。运行 `codex-pet-companion doctor --json` 查看诊断。

1. 选择 `25/5`、`50/10` 或 `90/20`。
2. 让紧凑番茄表盘与 Codex 小宠物陪伴专注。
3. 休息开始时，宠物放大为全屏、低动态的待机状态。
4. 让明显的视觉转换打断继续工作，建立真正的恢复边界。
5. 保留本地周期历史，供后续复盘或 AI 辅助分析工作模式。

---

## Huberman Lab、超昼夜节律与 90 分钟

Huberman Lab 的 *Focus Toolkit* 建议把专注段控制在约 90 分钟以内，并在之后进行主动卸载或有意识地放松。这个有影响力的科学传播框架，是 `90/20` 选项的产品灵感。

相关研究也支持产品采用的机制：

- 真实学习场景研究发现，预先安排休息相较自行决定休息，与更少的疲劳和分心、更高的专注与动机相关。
- Meta 分析支持短暂休息对提升活力、降低疲劳的整体作用。
- 汇总 158 项研究的 Meta 分析显示，时间管理与表现和幸福感存在中等程度关联。
- 系统综述显示，电脑提示能够显著改变休息或活动行为。

`90/20` 仍是可选实验起点，不是生理处方。研究没有证明某个精确间隔适合所有人和任务，本软件本身也没有经过临床效果试验。完整证据、功能映射和声明范围见[科学依据与声明边界](docs/research/scientific-basis.zh-CN.md)。

### 屏幕休息与干眼风险意识

Pet Pomodoro 还内置了 `20-20-10` 屏幕休息提示：专注计时每累计 20 分钟，宠物放大 20 秒，提示用户看向约 6 米（20 英尺）外，并缓慢、轻柔、完整地眨眼 10 次。暂停时间不计入间隔，专注倒计时继续；睡眠或重新连接期间错过的提示不会补播。25/50/90 分钟专注段分别会出现 1、2、4 次提示。它不监测其他屏幕使用，不会确认用户是否真的远眺或眨眼，也不会拦截输入；目前没有用户可见的开关或间隔设置。

这项设计是**屏幕休息与干眼风险意识提醒**，不是已证实的干眼预防方法。数字屏幕使用可能伴随眨眼变化，但提醒类干预的现有证据有限且不一致；针对已确诊干眼人群的小样本高频眨眼训练研究，并不能验证本产品低得多的提醒频率。“20 分钟 / 20 秒 / 眨眼 10 次”这一组合没有经过临床测试，Pet Pomodoro 不承诺预防或治疗干眼、数字视疲劳或其他疾病。详细证据与限制见[科学依据与声明边界](docs/research/scientific-basis.zh-CN.md)。（[TFOS Lifestyle 报告](https://doi.org/10.1016/j.jtos.2023.04.004)；[Xu 等，2025](https://doi.org/10.1038/s41746-025-02053-8)；[Johnson 与 Rosenfield，2023](https://doi.org/10.1097/OPX.0000000000001971)）

## 它与普通番茄钟有什么不同

普通番茄钟通常提供工作倒计时和休息倒计时。Pet Pomodoro 保留熟悉的 `25/5`，增加受 Huberman Lab 超昼夜节律框架启发的 `50/10` 与 `90/20` 可选节奏，并把计时器融入 Codex 电子宠物体验。这些节奏是供个人尝试的起点，不表示每个人的大脑都严格遵循同一个周期。

专注时，小番茄表盘伴随原有宠物。不同于只切换倒计时的普通计时器，Pet Pomodoro 还用宠物呈现 `20-20-10` 眼部休息提示和较长的恢复时段。眼部提示用于培养屏幕休息与干眼风险意识，不是已证实的干眼预防或治疗方法，应用也不会监测眼部行为；到这些提示节点时，同一只宠物会放大，以平静、低动态的方式让暂停更醒目，但不会锁屏或拦截鼠标。目标、计时事件和完成状态保存在本地，可由用户导出供 AI 分析；运行时不依赖云端，也没有遥测或托管看板。

## 隐私

目标和计时历史仅保存在本机 `~/.codex/ultradian-rhythm`。应用不上传会话数据、不运行遥测，也不会调用 AI 模型。宠物定位只使用可见窗口元数据和几何位置；伴侣程序不会申请「录屏」或「辅助功能」权限，不捕获窗口像素，也不保存截屏。

分享历史前请检查导出文件，目标文字和时间可能暴露工作内容。详见[本地数据与 AI 分析](docs/data-and-ai-analysis.md)。

---

## 范围与限制

- **无已签名二进制文件**：源码在安装过程中使用 Xcode Command Line Tools 在本地编译。我们不分发预编译、已进行代码签名的二进制文件。
- **显示环境差异**：显示器排列、刘海屏设置和 macOS 空间可能影响布局。
- **无跨平台支持**：使用 Swift、AppKit 和 LaunchAgents 专为 macOS 原生构建。不支持 Windows、Linux 和移动操作系统。
- **无内置 AI、Review 界面或云端看板**：计时器会保存本地周期记录并提供 CLI 历史导出，但 v0.1.0 的精简面板不采集 Review。它不会上传数据、自动调用模型、评价生产力或提供托管分析面板。
- **非医疗建议**：本项目是专注计时器，不是医疗器械，也不用于治疗注意力、睡眠或其他健康问题。
- **无官方关联**：与 OpenAI 或任何官方项目无关。
- **屏幕访问**：宠物定位只使用可见窗口元数据和几何位置，不申请「录屏」或「辅助功能」权限，也不捕获窗口像素；具体边界见[隐私说明](docs/data-and-ai-analysis.md)。

---

## 前置条件

- **macOS**。
- **Node.js 20、22 或 24**，并由 Node.js Foundation 官方签名。
- **Python 3.11 或更高版本**，来源为 uv、python.org 或 Homebrew。
- **Xcode Command Line Tools**（需提供 `xcrun swiftc`），只在安装时用于编译本地 Swift 组件。
- **GitHub CLI (`gh`)**（安装前用于验证发布来源证明）。

---

## 宠物兼容性

兼容的 Codex 宠物包无需附加素材即可与陪伴引擎协同工作。引擎读取配置的宠物 ID，并使用标准图集（atlas）：

- 进入状态：使用中性首帧完成几何放大
- 休息状态：保持平静待机；Rocky 约每三秒执行一次受限眨眼序列，未配置专属档案的宠物保持稳定待机帧
- 退出状态：保持当前帧完成几何收缩

自定义宠物从 `~/.codex/pets` 读取。对于兼容的内置宠物，Provider 只读访问已安装应用 ASAR 中匹配的单个图集条目，并在本地缓存该条目；不会修改应用，也不会重新分发图集。

增强型宠物包可以在 `pet.json` 旁附带 `companion.json`，以提供专用的 `enter`、`rest` 和 `exit` 动画片段（支持 schemaVersion 1 帧文件或 schemaVersion 2 的 atlasFrames/restHeightRatio）。详见：

- [companion-json-schema.md](docs/contracts/companion-json-schema.md)
- [examples/example-pet/](examples/example-pet/)

验证宠物包：

```bash
node bin/codex-pet-companion.js validate-pet examples/example-pet
```

预览已安装的宠物包：

```bash
codex-pet-companion preview --pet example-pet --state rest
```

预览会从标准的 Codex 宠物目录中加载宠物。内置的 `examples/example-pet` 包是一个用于验证和测试的几何示例。

> [!IMPORTANT]
> **无专有资产**：此开源仓库**不**打包或捆绑任何来自官方平台的专有宠物资产或图形。仓库中仅包含最简的几何演示包。

---

## 使用 Codex 安装

如需通过 Codex 安装，请将以下单行指令复制并粘贴到您的 Codex 代理（Agent）中：

> 根据 https://github.com/Xmemo/codex-pet-pomodoro 仓库中的 [INSTALL_WITH_CODEX.md](INSTALL_WITH_CODEX.md) 契约安装 Pet Pomodoro。使用晚于 v0.1.0 且带有 attestation 的 Release；执行安装器前，使用 gh attestation verify 校验仓库 Xmemo/codex-pet-pomodoro、工作流 .github/workflows/release.yml 和准确的版本 tag，并校验 SHA256SUMS。不得修改 ChatGPT.app 或 Codex.app，并汇报 ultradian 与 codex-pet-companion 状态。

*注意：在安装过程中，Codex 可能会向您请求网络和文件系统的访问权限审批。*

安装器要求压缩包具有绑定到本仓库、指定发布工作流和版本 tag 的 Sigstore/GitHub artifact attestation。SHA256 用于发现文件不匹配；attestation 证明工作流来源，不代表代码绝对安全。v0.1.0 发布早于该验证机制，不能通过此校验；必须使用由新发布工作流生成的后续版本。此机制仍信任仓库维护者和 GitHub Actions 配置。

### 从 Codex CLI 安装

在终端运行以下命令，会以安装请求启动交互式 Codex 会话：

```bash
codex '阅读 https://github.com/Xmemo/codex-pet-pomodoro/blob/main/INSTALL_WITH_CODEX.md 并严格按安装契约执行。仅可安装 v0.1.0 之后、且压缩包同时通过 SHA256 与本仓库、发布工作流、精确 tag 的 GitHub attestation 验证的版本。若不存在符合条件的版本就停止。保留正常审批，不使用 sudo，也不绕过审批。'
```

Codex 会对需要审批的操作正常请求确认。`v0.1.1` 已发布并带有可验证的 attestation；`v0.1.0` 早于发布来源证明机制，不应通过这条验证安装流程安装。

---

## 手动安装

在仓库根目录下运行：

```bash
./scripts/install.sh
```

安装程序会将项目和固定版本的 Node/Python 运行时复制到内置盘用户目录 `~/.local/share/codex-ultradian-rhythm`，安装时编译 Swift 组件，在 `~/.local/bin` 下安装 CLI 包装器，并注册一个用户级 LaunchAgent：

- `~/Library/LaunchAgents/io.github.codex-pet-companion.plist`

LaunchAgent 会在 Codex 重启期间持续运行计时服务，并且只在受支持的 Codex/ChatGPT 应用运行时启动宠物界面。表盘跟随宠物移动，宠物隐藏时同步隐藏；计时依据本地持久化截止时间恢复。不会安装 root Helper，也不会修改 Codex/ChatGPT 应用。若 macOS 阻止后台项目，请在**系统设置 → 通用 → 登录项与扩展**中允许；安装器不会改写 macOS 权限数据库。安装会事务式切换托管文件，并在新 supervisor 通过健康检查前，将旧程序与服务配置保留在 `~/.codex/ultradian-rhythm/migration-backups`。

---

## 命令行接口 (CLI)

### 计时器命令

```bash
ultradian status
ultradian status --json
ultradian start start --goal "起草发布说明"
ultradian start flow --goal "完成安装器测试"
ultradian start deep --goal "撰写架构章节"
ultradian start deep --goal "替换当前周期" --replace
ultradian pause
ultradian resume
ultradian stop
ultradian repeat
ultradian history --limit 50 --json
ultradian notify-test
```

### 陪伴端命令

```bash
codex-pet-companion validate-pet <path>
codex-pet-companion preview --pet <id> --state enter
codex-pet-companion preview --pet <id> --state rest
codex-pet-companion preview --pet <id> --state exit
codex-pet-companion start
codex-pet-companion stop
codex-pet-companion status
codex-pet-companion doctor --json
codex-pet-companion repair
codex-pet-companion config set pet auto
codex-pet-companion config set pet <id>
```

命令行契约详见 [cli-commands.md](docs/contracts/cli-commands.md) 与 [visual-event-protocol.md](docs/contracts/visual-event-protocol.md)。历史字段、导出流程和可复用 AI 分析提示词见[本地数据与 AI 分析](docs/data-and-ai-analysis.md)。

---

## 隐私与安全

- **完全本地化操作**：无遥测、无远程分析或远程日志。除非您主动导出并分享，否则周期记录不会离开本机。
- **无后台网络活动**：应用程序不会监听任何公开端口，也不会连接到外部服务器。
- **干净的执行环境**：完全运行在用户空间目录上下文中（`~/.local/` 和标准的 macOS 路径）。
- **记录可检查**：历史周期保存在 `~/.codex/ultradian-rhythm/sessions.sqlite`。可使用 `ultradian history --limit 50 --json` 只读导出。

---

## 疑难解答

- **Swift 渲染器编译失败**：请确保已通过 `xcode-select --install` 安装了 Xcode 命令行工具。
- **找不到 CLI 命令**：请确保已将 `~/.local/bin` 添加到终端环境的 `PATH` 变量中。
- **后台服务没有运行**：执行 `codex-pet-companion doctor --json`。若 macOS 将项目标记为禁止，请前往“系统设置 → 通用 → 登录项与扩展”允许，然后运行 `codex-pet-companion repair`。
- **宠物界面消失**：计时服务仍会独立运行。查看 `codex-pet-companion doctor --json` 和 `~/.codex/ultradian-rhythm/supervisor.log`；宠物无法识别时会隐藏界面，而不会固定到屏幕其他位置。
- **运行时或渲染器异常**：运行 `codex-pet-companion repair`。渲染器在安装时编译，日常运行不依赖 Xcode 或保持外接硬盘连接。

---

## 卸载

默认卸载将移除 LaunchAgents 和已安装的二进制文件，同时保留计时器状态：

```bash
./scripts/uninstall.sh
```

如需同时清除本地计时器状态，请运行：

```bash
./scripts/uninstall.sh --purge-state
```

---

## 路线图

- [ ] 支持自定义悬浮窗口坐标与刘海屏规避。
- [ ] 优化半透明悬浮面板渲染选项。
- [ ] 扩展自定义帧率的 schema 定义。
- [ ] 基于现有历史导出增加可选的本地报告。

---

## 参与贡献

欢迎大家提交贡献！请查阅 [CONTRIBUTING.md](CONTRIBUTING.md) 以了解如何提交 Issue 和 Pull Request。

---

## 开源许可证

本项目基于 [MIT 许可证](LICENSE) 开源。
