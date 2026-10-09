# Ayana 上线前审查 — 2026-10-09

**结论：建议暂缓正式上线。** 主流程已经能够运行，回归、真实 Electron、便携 EXE 和本机语音验证取得了明确通过结果；但仍有三个应在正式发布前关闭的问题：跨仓库文件恢复会写错目标、主动观察默认开启、发布产物无法与当前验证过的源码对应。另有输出预算、配置恢复、新用户资源配置和依赖治理问题。

本次是审查，不是修复发布。未修改生产代码，未上传或替换 Release；工作区原有的 17 个未提交文件均保留。验证脚本、隔离工具环境及证据保存在 `.runtime/launch-audit/`；新增交付文件为本报告。

## 范围与判断标准

- 审查对象：`D:/ayana-agent` 当前工作区（HEAD `11fc6cb`，包含原有未提交修改）、后端打包暂存、`win-unpacked` 资源和本地 `Ayana-0.3.21-win-x64.exe`。
- 检查范围：模型请求与协议解析、任务与取消、主动观察、Windows 桌面操作、文件授权与恢复、网络工具、对话与记忆持久化、语音输入输出、Electron 权限边界、设置与角色资源、构建与发布流程。
- P1：应在正式上线前处理的数据完整性、隐私或发布可靠性问题；P2：需要修复或明确产品限制的问题。
- 区分了实际复现、代码确认、依赖扫描告警和需要外部证明的发布条件。通过测试不等于不存在其他缺陷。

## P1-01：切换仓库后，旧产物的恢复操作可能覆盖另一仓库的文件

**状态：已在隔离目录实证复现。**

位置：`services/agent/tools/files.py:101`、`:111`、`:117`、`:252`；`services/agent/tools/policy.py:36`。

产物记录仅保存 `root_id` 和相对 `path`，没有保存创建时的固定仓库身份。`repository` 根目录通过回调取得当前选中仓库。查看、内容校验和恢复旧记录时，都会重新用当前根目录解释路径。

复现过程：

1. 在仓库 A 中，将 `a.txt` 从 `original A` 修改为 `shared new content`，得到含备份的产物记录。
2. 在仓库 B 中准备同名文件，内容也为 `shared new content`。
3. 将当前仓库切换到 B，再查看和恢复 A 的旧产物。
4. 旧记录的 `absolute_path` 变成 B 的文件，`changed` 仍为 `false`；应用恢复后，B 被写成 `original A`，A 保持 `shared new content`。

条件：具备目标写入权限；复现使用完整访问模式。相同模板文件、生成文件或复制出的项目容易满足同路径同内容条件。内容哈希校验只能判断内容是否相同，不能证明目标仍是原来的文件。

建议：持久化创建时的规范根路径、目标路径和根身份；查看、打开、恢复和应用统一使用该身份，再检查当前授权。不能可靠确定原路径的旧记录，应禁止恢复并说明原因。补充跨仓库、跨会话、同名同内容、授权撤销后的回归测试。

证据：`.runtime/launch-audit/reproduce.py`、`reproduction-results.json` 的 `repository_artifact_rebinding`。

## P1-02：配置在线模型后，主动观察会默认发送前台窗口信息，并可能上传截图

**状态：代码路径和全新配置默认值已确认。未向真实外部模型发送审查截图。**

位置：`config/default.json:4`、`:5`、`:12`；`services/agent/attention.py:62`、`:74`、`:167`；`apps/desktop/renderer/SettingsPanel.tsx:104`。

默认配置同时开启 `ambient_attention`、`ambient_speech`、`send_screenshot`。新用户默认使用本地模式，因此不会在首次启动时直接联网；但配置在线模式和 API key 后，只要伙伴窗口显示、空闲且满足调度条件，就会获得主动观察机会，无需先提交一条“看屏幕”的请求。

第一轮请求包含前台窗口标题、窗口类名和对话预览。模型请求观察后，第二轮将截图以 `data:image/png;base64,...` 放入请求，发送到配置的模型服务。机会间隔默认 45–90 秒；同一稳定窗口至少约 3 分钟后才重访，并非每个机会都必然上传截图。

当前隐私说明位于设置内，没有要求用户首次明确选择是否允许主动上传。关闭“偷看时允许搭话”只禁止发言，仍可观察和发送截图。发布说明中的“开启……后”也容易让人理解为默认关闭、主动选择开启。

建议：至少将主动观察默认改为关闭；首次开启时清楚说明上传的是窗口标题和可能的截图、发送给哪个模型服务。将按需观察、主动观察、主动发言分别表达；旧配置迁移也应保留明确选择。验证关闭、隐藏、取消和切换服务后的行为。

证据：`reproduction-results.json` 的 `fresh_profile`；主动观察调度与 `_attention_turn` 实现。

## P1-03：同版本产物、校验文件、源码和下载入口不一致

**状态：本地文件哈希、暂存文件差异及 GitHub Release 元数据均已核对。**

位置：`apps/desktop/release/SHA256SUMS-0.3.21.txt:1`；`docs/RELEASE_0.3.21.md:27`；`scripts/package_backend.py:79`；`pyproject.toml:7`；`site/index.html:38`。

| 对象 | 大小（字节） | SHA-256 |
| --- | ---: | --- |
| 本地 `Ayana-0.3.21-win-x64.exe` | 266,218,513 | `A207FF220C04F7AE74C8E233770330F01718820116094FFD1A2D82B81A0C03F2` |
| 本地校验文件、发布文档及线上 Release 元数据对应的 EXE | 266,215,993 | `963C48AAFE1CA73492D4BC9DF8FF311A0520DCD0F667E06AB0813FF80F29C0B2` |

线上发布文档和 GitHub 提供的 asset 大小、digest 是一致的；发现的是本地同版本 EXE 被重新打包后没有更新校验记录，不能据此判断线上包遭篡改。本次没有重新下载整个线上 EXE 做独立哈希校验。线上元数据来源：[GitHub v0.3.21 Release](https://github.com/voicepeak/ayana-agent/releases/tag/v0.3.21)。

另对暂存后端和 `win-unpacked/resources/backend` 中选取的 82 个源码、配置与角色规则文件进行比较，发现以下 5 个文件与当前工作区不同：

- `services/agent/attention.py`
- `services/agent/config.py`
- `services/agent/runtime.py`
- `services/agent/providers/model.py`
- `config/default.json`

因此，当前源码的 `477 passed` 不能直接当成本地 EXE 内代码的验证结果。本地 EXE 冒烟通过也不能证明其包含当前源码的全部修复。后端版本仍为 `0.3.20`，官网主要下载按钮仍指向 `0.3.20`。

建议：冻结要发布的提交，使用新的统一版本号；从干净、锁定依赖的环境重新暂存和构建。产物中记录 commit、依赖版本及源码文件摘要；在最终 EXE 生成后生成 checksum，并用该 EXE 做独立配置验证。官网、发布文档、校验文件必须来自同一次构建。

证据：`.runtime/launch-audit/staging-diff.json`；本地 `Get-FileHash`、`Get-Item`；GitHub Release API 元数据。

## P2-01：DeepSeek 思考模式覆盖用户设置的单次 token 上限

**状态：使用 MockTransport 捕获实际请求，已复现。没有产生在线模型费用。**

位置：`services/agent/providers/model.py:344`；`services/agent/runtime.py:620`、`:668`；`apps/desktop/renderer/SettingsPanel.tsx:108`。

设置中“单次请求输出上限”允许用户设置 1,000–12,000 tokens，但请求发往 `api.deepseek.com` 且启用思考时，代码将 `max_tokens` 提高到至少 65,536。主请求及续接请求使用 `thinking=True`。

复现：配置 `model_max_tokens=1000`，捕获的请求实际为 `max_tokens=65536`。这不表示每次都会消耗 65,536 tokens，但用户设置无法作为该请求的预算上限，可能带来费用和延迟超出预期。

建议：尊重明确的请求预算；若思考需要另设预算，应在界面和请求构造中明确区分，不能在用户不知情时抬高上限。增加各 provider 的请求预算测试。

证据：`reproduction-results.json` 的 `configured_output_limit`。

## P2-02：个人配置损坏后，应用无法自行恢复启动

**状态：已复现 `JSONDecodeError`。**

位置：`services/agent/config.py:25`。

构造设置对象时直接读取并合并 `config/local.json`，没有损坏隔离、最后可用配置或默认值恢复路径。非法 JSON 会在后端初始化前抛出异常；重启仍读取同一文件，用户无法通过应用设置修复。

现有保存操作使用临时文件替换，已降低普通写入中断的风险。这里的触发条件是文件确实损坏，例如手工编辑错误、迁移错误或磁盘问题，并非正常保存必然损坏。

建议：保留损坏原文件供诊断，恢复最后可用配置或默认值，在界面展示可操作的恢复提示；加载时验证字段类型，避免结构错误在后续运行中才暴露。

证据：`reproduction-results.json` 的 `corrupt_profile`。

## P2-03：第二角色的首次使用受声音资源配置阻塞，文字模式也无法切换

**状态：全新配置和角色就绪判定已验证。属于新用户体验与功能限制。**

位置：`services/agent/config.py:45`、`:181`；`apps/desktop/renderer/SettingsPanel.tsx:80`；`config/default.json:34`。

打包脚本包含两套立绘，但默认 `character_profiles` 为空。未配置声音 profile 的非当前角色被判定为未就绪，设置选项禁用；`_switch_character` 同样拒绝没有 voice 的目标，即使用户选择了“仅显示文字”。当前开发机已导入资源，容易掩盖这一情况。

这并不表示主角色不能使用。现有 README 提供外部声音与资源导入脚本；问题是文字显示能力也被声音配置耦合，便携包首次使用者无法在应用内完成该配置。

建议：分开立绘就绪和声音就绪判定，文字模式允许切换已有立绘。若产品坚持同时切换声音，则首次使用应提供明确的资源导入入口，并在发布说明中说明条件。

证据：`reproduction-results.json` 的 `fresh_character_options`。

## P2-04：构建依赖与打包环境需要整理

**状态：依赖扫描结果已确认；没有将全部告警认定为可利用的运行时漏洞。**

- `npm audit --omit=dev`：生产依赖告警为 **0**。
- 完整 `npm audit`：**10** 条，包含 1 high、8 moderate、1 low，主要位于 electron-builder 的构建依赖链及 esbuild 开发服务器。高等级项是构建链中的 `http-cache-semantics`，参考 [GitHub 安全公告](https://github.com/advisories/GHSA-ch52-4w7c-c8xp)。
- 对暂存 Python 环境 42 个发行包扫描：`setuptools 65.5.0` 出现 8 条记录，按 GHSA 合并后实际为 **4 个不同公告**。包括 package_index 的下载/写入问题，以及一个针对 macOS 源码分发排除规则的告警；不能把后者当成本项目 Windows 运行时漏洞。示例：[setuptools 上游安全公告](https://github.com/pypa/setuptools/security/advisories/GHSA-5rjg-fvgr-3xxf)。
- 当前运行链中没有发现直接调用上述 setuptools 下载功能的路径；扫描结果不证明应用已可被远程执行代码。
- `package_backend.py` 从开发 `.venv/Lib/site-packages` 整体复制依赖，暂存包仍包含旧 setuptools 和部分测试辅助包。Python 依赖未锁定，仓库现有 CI 仅部署官网，没有自动回归和发布包验证门槛。
- 本地 EXE 的 Authenticode 状态为 `NotSigned`，构建配置关闭签名。应评估公开分发的系统信誉提示和签名计划，不能据此断言所有机器都会阻止运行。

建议：建立独立、锁定依赖的发布环境，删除不需要的构建/测试包；更新实际构建链后重新验证便携解包、启动和退出。不要盲目使用可能改变 electron-builder 版本行为的强制修复命令。为代码回归、真实包冒烟、源码与 checksum 一致性设置发布门槛。

证据：`.runtime/launch-audit/python-packaged-requirements.txt`、`python-dependency-audit.json`；`scripts/package_backend.py:110`；`.github/workflows/pages.yml`；`apps/desktop/package.json:71`。

## 需要核实的发布条件

这部分需要项目方已有授权或许可信息，不属于已经证实的代码故障，也不代表认定侵权。

1. `apps/desktop/THIRD_PARTY_NOTICES.md` 明确使用 AGPL-3.0 的 KunUI 包，但仓库未发现项目根许可证文件。应明确本项目许可、适用的源码提供方式，并确保发布二进制对应的完整源码可获得。上游许可证见 [KunUI LICENSE](https://github.com/kungal/kun-ui/blob/main/LICENSE)。公开仓库和 notice 不能替代对具体分发义务的核对。
2. 打包脚本会复制两套角色实际 PNG。需要确认立绘、角色形象、声音参考与模型等各自的公开分发授权范围。官网“素材不随仓库分发”的说明，不能证明 EXE 中素材的分发权限；如果已有授权，保留可核验的证明即可。

## 已执行验证

| 验证 | 结果与实际范围 |
| --- | --- |
| Python 全量回归 | **477 passed, 8 skipped**；约 75 秒，1 条 TestClient/httpx 弃用警告 |
| 前端回归与构建 | `npm --prefix apps/desktop test`、`npm --prefix apps/desktop run build` 通过，包含 TypeScript 和 Vite/Electron 构建 |
| Python 依赖一致性 | `pip check` 通过 |
| 真实 Electron 对话删除与呼出 | 删除普通/当前/最后一个对话后数据库记录清理、SQLite integrity、呼出隐藏与置顶行为通过；透明窗口像素捕获不可用，未据此声称完成全部视觉验收 |
| 真实 Electron 生命周期 | 窗口销毁后 600 条延迟 IPC 消息不会访问失效对象，主进程正常退出 |
| 真实 Electron 工具恢复与取消 | 错误任务元数据恢复、保留已提交语音、显示检索回退和停止按钮、取消挂起模型请求通过 |
| 真实 Electron 对话切换 | 检索、各对话草稿恢复、新会话、切换时取消任务、320/430/780 像素窗口布局通过；原脚本按钮选择器过时，修正隔离副本后通过，生产脚本仍需同步调整 |
| 本地真实便携 EXE | 使用隔离 profile，启动、透明伙伴窗口、独立设置窗口、加载配置和退出通过；本轮为本地模式/静音启动冒烟，没有对该 EXE 做全套线上模型验证 |
| 真实 Windows 自有测试窗口 | 第一次 opt-in 检查 26 通过、1 次按钮点击断言失败；单独重跑两个集成案例通过，另建测试窗口的输入和点击在 175% DPI 下通过。属于一次不稳定结果，尚不足以认定稳定产品缺陷 |
| 独立声音 Python 回归 | unittest 执行语义解码 6 项、TTS 9 项全部通过，补充了主环境缺少 torch/numpy 的部分覆盖 |
| 真实 GPT-SoVITS CPU 合成 | 5 段实际音频产生有效 PCM；冷启动约 **18 秒**，每段请求到 PCM 约 **2.0–4.7 秒**；取消返回约 0.14 ms、后续请求恢复通过 |
| 打包 Python 的真实本地 STT | bundled tiny/int8/CPU 模型启动约 **1.19 秒**；3.43 秒的实际日语合成音频转写约 **0.49 秒**，返回可读日语并含“ファイル” |

主要证据目录：

- `.runtime/launch-audit/`：文件恢复与 token 复现、配置默认值、依赖报告、Windows 输入记录、真实 STT。
- `.runtime/launch-audit/tts/tts-benchmark.json`：语音合成参数、时延、取消与恢复结果；同目录保存 5 个 WAV。
- `.runtime/benchmarks/attention-companion-1791526381100/report.json`
- `.runtime/benchmarks/companion-lifecycle-1791526400046/report.json`
- `.runtime/benchmarks/tool-recovery-1791526539908/report.json`
- `.runtime/benchmarks/conversation-switcher-1791526741170/report.json`
- `.runtime/benchmarks/portable-companion/cleanup-report.json`

## 已确认的安全基础与验证边界

已检查到的安全措施包括：后端仅绑定 `127.0.0.1`；Electron 每次启动生成 32 随机字节 token，HTTP/WebSocket 接口鉴权并限制 WebSocket Origin；renderer 开启 sandbox/contextIsolation、关闭 nodeIntegration，有 CSP 和外部导航限制。网络读取工具限制公共地址、校验 DNS 并固定连接目标、检查重定向；普通授权模式有目录限制和重解析点检查。文件修改有备份、哈希冲突检查和替换校验。模型调试导出会移除截图字节，保留截图摘要而非图像本体。

本次未发现可以据此确认的公网未鉴权入口，也未发现已跟踪文件中的真实 API key；这不构成对全部历史提交或所有运行时状态的保证。

仍有以下实际验证边界：

- 没有调用付费在线模型，模型网络行为主要由本地 fixture/MockTransport 验证；需在正式提供支持的 provider 上补验流式、思考、工具调用、断连和费用限制。
- 浏览器工具的真实 Playwright/浏览器整合和 UFO 路径未完成端到端覆盖；不要把可选功能的跳过测试算成通过。实际准备宣传这些能力时需用最终包验证。
- Windows 操作只对本机自有测试窗口执行；多显示器、不同 DPI、权限提升窗口、其他 Windows 版本及干净电脑尚未完成矩阵验收。
- 合成时延排除实际音频设备延迟；本轮没有播放这些音频做音质或发音主观验收，STT 成功也不代表识别准确率已经评估。
- 包的验证针对本地 EXE；没有替换线上版本，也没有证明旧发布版本包含当前所有修改。

## 建议处理顺序与发布门槛

1. 先修复产物的固定路径身份，补上跨仓库同路径同内容恢复测试；确认旧记录迁移不会写入错误目标。
2. 主动观察默认关闭，完成首次开启说明和关闭行为验证；对 DeepSeek 请求落实可核对的预算上限。
3. 加入配置损坏恢复，处理文字模式角色切换或明确首次资源配置入口。
4. 核实素材分发与第三方许可，整理并锁定发布依赖。
5. 冻结提交、统一新版本号、重新构建，生成最终 checksum 和源码摘要；用最终 EXE 在干净 Windows 机器上验证首次配置、聊天、取消、角色切换、语音输入输出和退出，再更新官网下载与发布文档。

正式上线的判断应以这些问题关闭后生成的最终产物为准，不能仅以当前源码回归通过作为发布依据。
