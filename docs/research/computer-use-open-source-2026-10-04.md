# Computer Use 开源仓库调研

调研日期：2026-10-04（Asia/Shanghai）。目标：为 Ayana 的 Windows 桌面操作选择可复用组件，重点评估定位、执行、结果验证和部署成本。

本次检查了 13 个项目的上游仓库、README、GitHub 元数据，并深入读取 Cua Driver、Windows-MCP、UI-TARS GUI SDK、UFO 操作接口的部分源码或接口文档。未安装运行这些项目，结论是候选筛选，尚不是本机稳定性排名。原始公开材料与 API 响应缓存在 `.runtime/research/computer-use/`，未读取或上传 Ayana 密钥及聊天记录。

## 选型结论

建议先对 **Cua Driver、UFO²、Windows-MCP** 做同一组 Windows 操作任务的对比；视觉路线再选择 **UI-TARS GUI SDK 或 Midscene Computer**。Agent S 可作为完整任务规划的实验对照。

这是基于接口与工程证据的判断：Cua Driver 更值得先评估执行层；UFO 更值得先评估 Windows 完整任务框架。两者承担不同职责，不能把单步执行测试与完整任务成功率混为一谈。

选型暂不要求迁移 Ayana 的角色、语音或桌面壳。可先通过独立进程适配候选后端，得到实际结果之后再决定替换多少现有代码。

## 项目对比

| 项目与上游 | 类型及主要能力 | Windows / 接入方式 | 对 Ayana 的用途与局限 |
| --- | --- | --- | --- |
| [Microsoft UFO](https://github.com/microsoft/UFO) | 完整 Agent 框架；截图、UIA、Win32、COM 与 GUI/API 混合操作 | UFO² 为单机 Windows 路线；Python，带 HostAgent/AppAgent 和 MCP 操作接口 | 优先评估完整任务执行；框架较大，接入其整个协调系统的成本高于接入单一驱动 |
| [Cua / Cua Driver](https://github.com/trycua/cua) | 原生执行驱动、SDK、MCP，以及独立的沙箱/评测组件 | 原生 Windows；Rust 驱动，Python/TypeScript SDK、CLI、MCP | 优先评估执行后端；有快照关联 token 和明确的后台/前台边界。不同子项目、发布通道不能混用 |
| [Windows-MCP](https://github.com/CursorTouch/Windows-MCP) | Windows 工具服务；控件树、截图、输入、窗口管理、等待条件 | Windows；stdio 或 HTTP MCP；当前源码 Python >=3.14 | 轻量对照，控件树可供文本模型使用；一些 label 最终转换为屏幕坐标，不代表纯语义执行 |
| [Windows-Use](https://github.com/Jeomon/Windows-Use) | 基于 Windows UIA 的任务 Agent，采用 Windows-MCP 生态 | Windows；Python SDK/CLI | 可参考如何用文本控件信息组织任务循环；应与 Windows-MCP 区分，不能当作另一套独立底层 |
| [UI-TARS Desktop](https://github.com/bytedance/UI-TARS-desktop) | 桌面应用、视觉 Agent SDK、动作解析器、桌面/浏览器 Operator | Windows；Electron/TypeScript；可用 GUI SDK 与 NutJS Operator | 与现有 Electron 技术栈契合。视觉定位仍依赖模型，且主分支 SDK 与发布版桌面程序需分别验证 |
| [UI-TARS 模型](https://github.com/bytedance/UI-TARS) | GUI 专用视觉模型与部署/使用资料 | 可通过模型服务供 Windows 客户端调用 | 为自绘控件提供视觉定位；它不是桌面执行驱动，模型权重和推理资源需另行选择 |
| [Agent S](https://github.com/simular-ai/Agent-S) | 完整任务规划/反思框架，Agent S3 使用独立 grounding 模型定位 | 官方声明 Windows/macOS/Linux；Python SDK | 可作任务规划对照；模型服务和生成动作执行链增加集成成本，仓库中的 hosted Sai 成绩不能当作开源 S3 成绩 |
| [Midscene](https://github.com/web-infra-dev/midscene) | 视觉 GUI Agent 和测试工具；aiAct、aiWaitFor、aiAssert、报告 | 原生 Windows/macOS/Linux；`@midscene/computer`，另有 Web/移动端接口 | 可比较视觉操作、结果断言和可回放报告；Windows 本地输入仍受焦点与权限级别影响 |
| [Browser Use](https://github.com/browser-use/browser-use) | 浏览器任务 Agent；可连接本地或远程浏览器 | 在 Windows 上用于浏览器；Python 库/CLI | 适合作为网页任务后端，不能覆盖任意原生 Windows 应用 |
| [OmniParser](https://github.com/microsoft/OmniParser) | 截图元素检测、图标描述与结构化解析 | 可供桌面视觉流程调用；Python、模型权重 | 可补充控件树缺失的视觉信息；单独使用不提供规划、鼠标执行或结果验证 |
| [pywinauto](https://github.com/pywinauto/pywinauto) | Windows 自动化库，Win32/UIA 两类后端 | Python，本地 Windows | 适合常见应用的确定性动作与验证；需要自己构建 Agent 及应用适配 |
| [Windows Agent Arena](https://github.com/microsoft/WindowsAgentArena) | Windows 多模态 Agent 测试环境与任务集 | Windows VM；含部署、任务与评估器 | 借鉴实际任务和结果验证方法，不应作为本机桌面产品执行服务直接接入 |
| [OSWorld](https://github.com/xlang-ai/OSWorld) | 开放式电脑任务的基准、环境和评估器 | 使用项目规定的虚拟机/桌面环境 | 可参考评测方法；不同系统、步数预算、模型和候选次数的结果不能直接互比 |

Midscene 的 Windows、截图、多显示器和 RDP 能力以其[桌面官方文档](https://midscenejs.com/platforms/desktop)为依据；不能沿用“Midscene 只支持浏览器”的旧印象。

## 最值得深入验证的实现

### Cua Driver：执行层候选

读取了其 Python SDK、快照/token 源码和 Windows 支持矩阵。它将窗口目标、观察快照及 element token 关联；token 过期要求重新观察。Python SDK 提供异步操作，适合评估为 Ayana 独立执行后端。[SDK](https://github.com/trycua/cua/blob/ea4abe672afc166fa42dcbd991e36749c44edf54/libs/cua-driver/python/README.md)、[token 源码](https://github.com/trycua/cua/blob/ea4abe672afc166fa42dcbd991e36749c44edf54/libs/cua-driver/rust/crates/cua-driver-core/src/element_token.rs)

上游测试要求检查应用状态、焦点、窗口顺序和输入是否泄漏。Windows 已登记的基线为 122 项，其中 99 项送达、23 项正确拒绝；这表示约定的测试结果通过，不是 122 个用户任务全部完成。[动作覆盖证据](https://github.com/trycua/cua/blob/ea4abe672afc166fa42dcbd991e36749c44edf54/libs/cua-driver/docs/action-support.md)、[测试矩阵](https://github.com/trycua/cua/blob/ea4abe672afc166fa42dcbd991e36749c44edf54/libs/cua-driver/docs/test-matrix.md)

后台输入有明确限制。例如该矩阵中 Windows Electron 的后台文本输入/按键并不全部可用。其优势是能明确拒绝并报告边界，仍需在目标软件上验证。[平台支持](https://cua.ai/docs/cua-driver/concepts/platform-support)

版本核对仍有缺口：检查的主分支 Cargo 工作区为 0.33.1；最新 100 条 monorepo release 响应中未找到稳定 Driver tag，未建立“最新稳定 Driver”版本。不能把源码版本当成已验证可下载安装的版本。上游也有 release 扫描范围导致更新失败的[未关闭问题 #4598](https://github.com/trycua/cua/issues/4598)。后续验证应固定一个确实可取得的 Driver 构建及匹配 SDK。

### UFO²：Windows 完整框架候选

UFO 当前仓库同时包含 UFO³ 多设备框架和 UFO² 单机 Windows 框架。Ayana 应先看后者。它有截图/UIA 混合观察、应用选择、控件操作与应用 API，能够参考其完整任务协调方式。[上游介绍](https://github.com/microsoft/UFO)、[UFO² 文档](https://github.com/microsoft/UFO/blob/a795552d976c4c019d7c2f778a0effb5cef7de6b/ufo/README.md)

其 AppUIExecutor 明确暴露控件 ID+名称、设置文本、按键、坐标点击等接口，可研究哪些模块能独立调用。但其中 `click_input` 仍是鼠标点击；“UIA 定位”不应解读为所有操作均通过控件语义 API 完成。[操作接口](https://github.com/microsoft/UFO/blob/a795552d976c4c019d7c2f778a0effb5cef7de6b/documents/docs/mcp/servers/app_ui_executor.md)

判断：值得跑完整任务作为对照，但直接嵌入全部 HostAgent/AppAgent、知识库和设备基础设施成本较高。仓库对稳定性的描述属于项目自身说明，尚未在 Ayana 本机复现。

### Windows-MCP：轻量工具候选

它有控件树观察、Screenshot、Click、Type、WaitFor，以及用户接管协调代码和测试，适合快速验证 MCP 接入。[仓库](https://github.com/CursorTouch/Windows-MCP)、[接管代码](https://github.com/CursorTouch/Windows-MCP/blob/8e32225f96ff9d61513b8fbbb8bfde60a13b0dd3/src/windows_mcp/desktop/control.py)

源码中 Click/Type 的 label 被解析成坐标，然后执行鼠标输入；点击返回的文本本身也不是目标结果证明。不能因为支持控件 label，就放弃 Ayana 的目标与结果复核。[工具源码](https://github.com/CursorTouch/Windows-MCP/blob/8e32225f96ff9d61513b8fbbb8bfde60a13b0dd3/src/windows_mcp/tools/input.py)、[执行源码](https://github.com/CursorTouch/Windows-MCP/blob/8e32225f96ff9d61513b8fbbb8bfde60a13b0dd3/src/windows_mcp/desktop/service.py)

当前源码要求 Python >=3.14，Ayana 本机虚拟环境为 3.11.9；更适合独立进程接入。README 的 Windows 7–11 范围不能代替运行时兼容性核对。[依赖声明](https://github.com/CursorTouch/Windows-MCP/blob/8e32225f96ff9d61513b8fbbb8bfde60a13b0dd3/pyproject.toml)

检索到多屏错误、UIA 遍历卡死等用户报告，部分明确来自旧扩展版 0.7.2。它们是验证场景的来源，不能据此宣称当前 0.8.7 已确认存在同样故障。[多屏报告 #416](https://github.com/CursorTouch/Windows-MCP/issues/416)、[Electron 遍历报告 #383](https://github.com/CursorTouch/Windows-MCP/issues/383)

### UI-TARS / Midscene / Agent S：视觉任务候选

UI-TARS 当前 GUI SDK 通过 Operator 执行动作，并在动作之后重新截图、加入模型输入，已有 Ayana 需要的多步视觉循环。NutJS Operator 提供截图缩放、鼠标、键盘等操作。需分别验证窗口约束、停止行为和模型定位准确度。[GUIAgent 源码](https://github.com/bytedance/UI-TARS-desktop/blob/2ff41a9e515828c5bd5b276e493d73aa0bdf4a3a/multimodal/gui-agent/agent-sdk/src/GUIAgent.ts)、[NutJS Operator](https://github.com/bytedance/UI-TARS-desktop/blob/2ff41a9e515828c5bd5b276e493d73aa0bdf4a3a/multimodal/gui-agent/operator-nutjs/README.md)

Midscene 的优势是已有自然语言等待、视觉断言和交互报告。它可以评估为视觉任务后端，也可以用来验证操作结果；断言依然是模型判断，需要和确定性结果检查搭配。[仓库](https://github.com/web-infra-dev/midscene)、[桌面文档](https://midscenejs.com/platforms/desktop)

Agent S3 需要独立 grounding 模型。README 报告 WindowsAgentArena 单次约 50.2%，三次候选选择约 56.6%；这不能证明本机任务一定完成，也不能把多次候选结果当作单次成功率。hosted Sai 的 73% 是另一产品、另一基准结果。[Agent S 原始说明](https://github.com/simular-ai/Agent-S)

## 维护与许可核对

下表“提交”指查询时默认分支最新提交的 committer UTC 日期，并非 release 日期，也不代表完成质量。SHA 链接用于固定本次观察的源码。13 个仓库查询时均未归档。

| 项目 | 默认分支提交日期 UTC | 检查的提交 | 仓库许可 / 组件边界 |
| --- | --- | --- | --- |
| UFO | 2026-09-29 | [a795552d](https://github.com/microsoft/UFO/commit/a795552d976c4c019d7c2f778a0effb5cef7de6b) | MIT |
| Cua | 2026-10-04 | [ea4abe67](https://github.com/trycua/cua/commit/ea4abe672afc166fa42dcbd991e36749c44edf54) | Driver 为 MIT；Spaces 和可选 perception 组件有独立边界 |
| Windows-MCP | 2026-10-04 | [8e32225f](https://github.com/CursorTouch/Windows-MCP/commit/8e32225f96ff9d61513b8fbbb8bfde60a13b0dd3) | MIT |
| Windows-Use | 2026-09-23 | [582a5669](https://github.com/Jeomon/Windows-Use/commit/582a5669e9251372beb63baf39dac453693ff0d8) | MIT |
| UI-TARS Desktop | 2026-09-24 | [2ff41a9e](https://github.com/bytedance/UI-TARS-desktop/commit/2ff41a9e515828c5bd5b276e493d73aa0bdf4a3a) | Apache-2.0；所选模型权重另查 |
| UI-TARS 模型仓库 | 2025-09-05 | [582f3a7e](https://github.com/bytedance/UI-TARS/commit/582f3a7ea5d285ee8ed9e2e84048d1ab01453c49) | Apache-2.0；不推定所有权重许可相同 |
| Agent S | 2026-09-05 | [3aa272d2](https://github.com/simular-ai/Agent-S/commit/3aa272d23d2994c7bbde1acbbe0ef8e8d06b8693) | Apache-2.0 |
| Midscene | 2026-09-29 | [1c2d8f7d](https://github.com/web-infra-dev/midscene/commit/1c2d8f7d0ab1d45d8d60e3ec476d90c6777f8a2b) | MIT |
| Browser Use | 2026-10-03 | [7be96ed8](https://github.com/browser-use/browser-use/commit/7be96ed8bafa8dfe1eef228b59cf5c884b8b2431) | MIT；云服务另行区分 |
| OmniParser | 2026-07-20 | [35402120](https://github.com/microsoft/OmniParser/commit/354021201345a96178360b28733573e27269f2de) | 仓库 CC-BY-4.0；模型/依赖另查 |
| pywinauto | 2026-05-23 | [18d2a95c](https://github.com/pywinauto/pywinauto/commit/18d2a95cebed2f0061ab4e4c80c3a76ece5dd4f3) | BSD-3-Clause |
| WindowsAgentArena | 2024-11-20 | [6d39ed88](https://github.com/microsoft/WindowsAgentArena/commit/6d39ed88c545a0d40a7a02e39b928e278df7332b) | MIT；最近 pushed_at 为 2026-04-13，不能误写为默认分支最近提交 |
| OSWorld | 本次未取默认分支 commit | [上游](https://github.com/xlang-ai/OSWorld) | Apache-2.0；API pushed_at 为 2026-09-14，不能代替 commit 日期 |

Release API 的最近返回记录：UFO `v3.0.10`（2026-09-22 UTC）；Windows-MCP `v0.8.7`（2026-09-30 UTC）；UI-TARS Desktop `v0.3.0`（2025-11-04 UTC）。UI-TARS monorepo 近期仍更新，但不能据此认为这个桌面安装包包含当前 GUI SDK。[UFO release](https://github.com/microsoft/UFO/releases/tag/v3.0.10)、[Windows-MCP release](https://github.com/CursorTouch/Windows-MCP/releases/tag/v0.8.7)、[UI-TARS release](https://github.com/bytedance/UI-TARS-desktop/releases/tag/v0.3.0)

Cua 的基础 Driver 无需模型权重；可选 perception 包含不同许可的模型工件，不能按根目录 MIT 一并理解。OmniParser README 区分新的 YOLOv9 实现和旧 Ultralytics 检测器；最终以实际下载模型 revision、模型卡和第三方依赖为准。[Cua 许可说明](https://github.com/trycua/cua/blob/ea4abe672afc166fa42dcbd991e36749c44edf54/README.md#license)、[OmniParser 权重说明](https://github.com/microsoft/OmniParser/blob/354021201345a96178360b28733573e27269f2de/README.md#model-weights-license)

## 建议的下一步比较实验

本节是后续建议，本次未执行安装、桌面操作或模型调用。

1. 固定一个可取得的 Cua Driver 构建、一个 UFO² 配置和 Windows-MCP 0.8.7。各自在独立环境运行，通过适配器输出一致的观察、动作结果和失败状态。
2. 先比较确定性执行，不引入模型：中文输入并读回、按钮触发后验证状态、滚动后找目标、窗口移动后的重新定位、遮挡时拒绝或正确操作、用户接管后的停止、模态窗口处理、多屏 DPI。以应用状态为判据。
3. 再比较完整 Agent：同一批 5–10 步任务、相同任务描述、统一步数/时间预算。每项重复至少 5 次，记录单次完成率、错误定位、误输入、停止耗时、恢复次数和成本。不同模型配置单独记账。
4. 有验证程序时检查目标文件/控件状态；只有视觉判断时标明“模型判定”，不要将 API 返回 success 当作任务完成。
5. 如果桌面驱动通过而规划失败，调整模型或任务规划；如果控件定位/输入失败，处理执行后端。网页任务另用 Browser Use 或浏览器原生接口进行对照。

优先实验顺序：Cua Driver 的单步执行 → UFO² 完整任务 → Windows-MCP 轻量对照 → 视觉 SDK。该顺序是接入评估建议，最终选型以本机重复实验为依据。
