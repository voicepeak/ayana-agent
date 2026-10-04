# Ayana v0.1.0 demo 交付记录

日期：2026-10-04。实施依据为 `AYANA_IMPLEMENTATION_PLAN.md` 的首版范围；方案已先于实现推送到远端。

## 运行与资源

本机入口：`apps/desktop/release/Ayana-0.1.0-win-x64.exe`，或桌面的「Ayana Demo」。开发入口为仓库根目录的 `启动 Ayana.cmd`。

便携程序包含 Electron、独立 Python 3.11.9、后端依赖、五张正常校服立绘、英文发音资料和本地 Whisper tiny。首次运行会先解包。个人配置、DPAPI 凭证和历史位于 `%APPDATA%/Ayana`，它们不在 Git 或通用发布包内。

这台机器已配置 DeepSeek 官方 `deepseek-flash` 和现有 `D:/ayana-voice` 音色资源。Ayana 权重、参考音频与 GPT-SoVITS 引擎由外部资源目录加载；重新启动电脑后仍可使用同一用户的 DPAPI 凭证。其他机器请按 `scripts/PACKAGING.md` 导入自己的资源和接口配置。

## 完整体验流程

1. 打开普通权限窗口，按 Ctrl+Alt+A，确认右侧截图与原窗口一致。
2. 选择一个代码仓库，提出屏幕或代码问题。日语完整句直接进入合成，中文随后补齐，文件证据带实际路径和行号。
3. 角色与当前播放语句同步；下一句生成或合成完成不会提前换脸。音量可以调整。
4. Ctrl+Alt+Space 或「打断」立即取消当前播放和后续生成。重新提问可以继续，旧音频不能恢复。
5. 在截图选择位置，先「显示高亮」。切换单步执行后，选择输入、点击、滚动或导航键，并确认具体一步。操作后会重新截取目标并展示实际结果。
6. 按住麦克风、松开后本地识别。识别文字先进入输入框，可修正技术词后发送；录音开始先停止 Ayana 播放。
7. 打开对话历史，查看完整播放、部分播放和取消状态，以及实际消费的音频样本。

练习窗口：`.venv/Scripts/python.exe -m native.windows.demo_target`。测试只在此项目拥有的练习应用中输入和点击。

## 模块完成情况

| 阶段 | 本版实现 | 验证依据 |
| --- | --- | --- |
| P0 技术基线 | 显式加载指定 GPT/SoVITS 权重，参考缓存、预热；指定 HWND 截图、UIA；实际播放器 | 真实音色基准、原生窗口测试、Electron 回归 |
| P1 语音核心 | 单独常驻 worker、逐句流水线、三段有界队列、样本消费回执、统一 generation 取消 | 协议/慢任务测试、AudioWorklet 测试、真实中途打断 |
| P2 桌面表现 | 全局快捷键、托盘、对话/立绘/高亮三窗口、五种正常表情、日中字幕、设置 | 实际窗口焦点属性、素材加载、播放关联测试 |
| P3 屏幕教学 | DeepSeek Flash 识图与流式对话、真实文件读取/搜索、受限工具循环、同流字幕 | 联网截图问答、文件证据、翻译 A/B 实验、多轮协议恢复 |
| P4 单步操作 | 用户确认、快照绑定、身份/坐标/内容/输入接管检查、结果观察 | 原生真实输入/点击、桌面确认流程；175% DPI 焦点回归 |
| P5 输入 | 半双工录音、独立本地 tiny STT、识别结果编辑、取消识别恢复 | 实际日语/中文 WAV 与 WebM 录音链路 |
| P6 发布 | 独立隔离 Python、便携 EXE、用户数据目录、鉴权、退出清理、故障提示 | 打包模块导入、包内敏感数据检查、最终程序回归 |

Kun UI 的 Vue 组件层不能直接用于现有 React 技术栈。本版真实使用已发布的 `@kungal/ui-tokens` 和 `@kungal/ui-core` 2.56.2，封装 React 控件；来源、许可证和对应源码地址见 `apps/desktop/THIRD_PARTY_NOTICES.md`。未使用被用户否决的 frontend-design skill。

## 实测与复现

本地测量基于 Windows 当前桌面和 CPU 环境。计时使用单调时钟；样本数量很少，不提供 p95、音质评价或其他机器性能保证。

| 项目 | 实测 |
| --- | --- |
| DeepSeek 纯文本首次完整日语 | 初次连通约 1.22 秒；短句翻译实验 0.41–0.72 秒 |
| 同流中文字幕滞后 | 翻译实验三个问题约 53–95 ms |
| 独立翻译的配对结果 | 首句日语中位差 +127.5 ms，中文字幕 +581.5 ms；保留同流默认 |
| Ayana 首次 worker 冷启动 | 43.1 秒；已缓存后新进程一次测得约 17.9 秒 |
| 日语热合成 | 三个样本 1.00–1.83 秒，音频 1.63–2.99 秒，RTF 0.61–0.64 |
| 首次混合英文发音前端 | README/英文代码名样本约 4.15 秒，不能视为日语热路径 |
| 本地 tiny 日语识别 | 启动约 688 ms；2.99 秒 WAV 识别约 390 ms |
| 最终打包版首句 | 完整日语约 1.21 秒；带冷启动首次 PCM 约 20.90 秒 |
| 实际播放取消 | 最终打包版点击到消费取消回执 31 ms；此前回归为 19–34 ms |

首次 PCM 生成、播放器样本消费和音箱的真实声学出声是不同指标。后端 `smoke_demo.py` 的回执是协议模拟；桌面 `verify_desktop.mjs` 才验证实际 AudioWorklet 消费。麦克风自动化以真实日语 WAV 输入 Chromium 模拟录音设备，验证 WebM 编码/上传/本地识别；它不等同于真人或物理麦克风准确率测试。

验证记录（本机忽略提交）：

- `.runtime/benchmarks/tts/tts-benchmark.json` 与 `tts-mixed/tts-benchmark.json`：真实音色、参考缓存、混合文本和推理中取消。
- `.runtime/benchmarks/translation/translation-benchmark.json`：同流/并行翻译，正文见 `TRANSLATION_EXPERIMENT.md`。
- `.runtime/benchmarks/stt/stt-benchmark.json`：真实中日合成样本与识别错误。
- `.runtime/benchmarks/native-focus-caption`：175% DPI 原生标题栏变化的定位图片。
- `.runtime/benchmarks/packaged-desktop/report.json`：最终程序交互、音频消费、确认操作、录音识别和截图。
- `.runtime/package-backend-report.json`：独立 Python 隔离导入和打包排除检查。

最终验收通过：启用真实 Windows 和 STT 集成标志后，Python **81 项测试全部通过**；桌面类型检查、AudioWorklet/状态回归与构建通过。最终 `win-unpacked/Ayana.exe` 在 `app.isPackaged=true` 下，完整交互回归通过且 `errors=[]`：原窗口快捷键绑定、立绘加载、真实样本播放、重新提问恢复、播放中取消、高亮、用户确认输入、点击 Apply 后精确结果、WebM 本地识别、可编辑文本和真实文件证据。

最终回归使用包内 Python、后端与离线 tiny 模型。角色/模型服务读取本机用户数据配置。退出后没有残留本项目的 Agent、TTS、STT 或练习窗口进程。便携 EXE 由同一已核对源码/暂存/打包文件哈希的资源生成，electron-builder portable 构建成功；完整交互自动化在解包后的程序上运行。

| 交付文件 | 值 |
| --- | --- |
| 便携 EXE | `apps/desktop/release/Ayana-0.1.0-win-x64.exe` |
| 大小 | 245,581,287 字节，约 234.2 MiB |
| SHA256 | `2B2DE22A51B4B53A60B6906903E64E3F0916409AF56A0BE1E17C74E27E641029` |
| 桌面入口 | `Ayana Demo.lnk`，指向上述固定文件路径 |
| 源码远端 | `https://github.com/voicepeak/ayana-agent` 的 `main` |

包内个人配置、DPAPI 凭证、历史、GPT/SoVITS 权重的扫描数量为 0。真实联网凭证只在当前用户数据目录中加密保存，源码检查未发现真实 API 密钥。

## 2026-10-04 语音修复

用户运行便携 EXE 后报告没有语音。旧进程的历史显示它使用默认系统语音，系统未安装日语 System.Speech 音色；随后语音 worker 启动直接退出。现场检查发现便携版的临时 `resources/backend` 已被清空，Python 的 `_pth` 等未锁定文件也被删除。

已确认重复启动的打包缺陷：本机 electron-builder 26.15.3 默认让同一构建的启动器共用解压目录，第二个实例退出时会递归清理第一个实例正在使用的文件。改为每次独立的 NSIS `$PLUGINSDIR/app`，并在打包前执行已安装构建器的真实 define 生成检查，防止配置或依赖升级后重新使用共享目录。

同时保留语音 worker 的具体失败原因和退出码，输出有界、经过凭证及文本过滤的故障摘要；新增启动诊断，记录实际配置路径、模型和音色模式。新便携 EXE 首次启动已确认读取 `%APPDATA%/Ayana/config/local.json`：`openai`、`deepseek-flash`、`sovits`、凭证已配置。实际播放器完整消费首句 34,240 个 32 kHz 来源样本，输出设备采样率为 96 kHz。

直接从便携 EXE 验证：第二次打开的启动器正常退出，第一个主进程、Agent、连接与 worker/persona/_pth 文件全部保留；重复打开后再次完整播放 18,880 个样本。退出后从新解压目录重新启动，仍加载同一配置和音色，完整播放 17,600 个样本。记录为 `.runtime/benchmarks/portable-launcher/report.json`，三个实际播放检查均通过；验收范围仍为真实播放器样本消费，不对音箱声学效果作判断。Windows 默认 Realtek USB Audio 扬声器正常启用，主音量 8%、未静音；播放时 Ayana 会话音量 100%、未静音。

首轮验收脚本保持 Node Inspector 连接，造成两次退出等待超时，其原始警告保留在 `report.json`。修正脚本为退出前断开调试器后，单独执行正常退出检查：`.runtime/benchmarks/portable-launcher/cleanup-report.json` 的配置加载与主进程/Agent/启动器正常退出全部通过，`errors=[]`，无残留测试进程。

独立提交为 `81ad10b`（语音故障诊断）、`d016801`（便携解压隔离）、`230ce78`（实际配置诊断）、`cbc4c03`（便携启动器实际回归）。复现命令为 `node scripts/verify_portable_demo.mjs --playwright-root <Playwright 的 node_modules 目录>`；`--cleanup-only` 单独验证退出并保存独立报告。本轮语音单元测试 9 项通过，相关 Agent/服务与输入测试通过，桌面类型检查、Worklet/状态测试和打包构建通过。桌面入口仍指向本页交付表中的固定 EXE 路径。

## 决策与实际边界

传输使用单声道 float32 little-endian PCM，而非原方案候选的 PCM16。它直接对应浏览器音频处理，播放器按引擎报告的 32 kHz 来源与设备实际采样率重采样，消费计数仍使用来源样本。

Windows 截图使用公开 PrintWindow API 的薄绑定；UIA 在独立 COM MTA 工作线程中读取。操作使用经过检查的 SendInput；没有把 UIA 支持某个 pattern 当作该操作已经执行。程序不操作管理员、最小化、受保护或内容发生变化的窗口，不自动执行多步任务。发送输入只说明输入已发送，目标成功由结果观察判断。

本机实际验证 175% DPI；其他缩放与负坐标有单元验证，尚未在完整的多显示器硬件矩阵和另一台干净 Windows 上逐项验证。隔离 Python 不读取系统/用户 site-packages；外部音色环境是用户资源配置，不是隐藏的开发插件依赖。

Whisper tiny 对中日技术名词有误识别，因此识别结果先供用户编辑。缺少模型或素材有明确故障与回退显示；配置 Ayana 引擎失败时不会换音色冒充成功。

方案中的 Jev、眼嘴分层、Live2D、口型、全双工回声处理、多参考语气、真流式合成与长期项目记忆是可选后续扩展。首版采用已实测的句级合成和正常 PNG 表情，尚未对这些扩展做收益宣称。字幕 C 路径「中文先行再译日语」未实测；A/B 结果已足够支持本版默认选择。

## 后续迭代入口

Git 提交分别覆盖方案、协议、Agent、Windows、语音、输入、桌面、运行时修复、性能对照和打包验收。主要模块各有接口与测试，可以按模块修改；生成缓存、个人配置、API 凭证和音色权重不混入源码提交。

修改后先执行合适的单元测试；涉及操作、播放或录音时，再依次运行真实窗口/桌面回归，不要同时运行争夺焦点的 UI 测试。最终重新执行 `scripts/package_backend.py`，再 `npm --prefix apps/desktop run package`。
