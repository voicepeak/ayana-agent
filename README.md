# Ayana · Personal Agent

Windows 个性化 Agent：快捷键呼出时只显示透明半身立绘、对话框和中文翻译；日语 Ayana 音色、可打断播放。模型、声音、服装、对话动画、仓库和桌面工具位于独立的设置与管理窗口。正式人设见 `characters/ayana/persona.md`。

## 在本机运行

本机交付版可直接双击 `apps/desktop/release/Ayana-0.3.2-win-x64.exe`。它包含独立 Python、桌面程序、立绘与本地识别模型；个人模型配置保存在 `%APPDATA%/Ayana/config/local.json`。首次解包和加载音色需要等待；此前版本首次语音冷启动实测约 43 秒，期间文字输入与界面保持可用。启动新版前请退出旧版。

开发目录也可双击 `启动 Ayana.cmd`，后续修改仍按下面的流程构建。

话题管理版为 `apps/desktop/release/Ayana-0.3.2-context-win-x64.exe`：点击小窗口的「正在聊」切换话题，点「＋」开始新话题；管理窗口的「话题与记录」可以改名、查完整记录和解除材料绑定。长对话自动整理摘要，重启恢复当前话题。具体逻辑与验证见 [话题与上下文管理](docs/CONVERSATION_MANAGEMENT.md)。

Full access 版为 `apps/desktop/release/Ayana-0.3.2-full-access-win-x64.exe`，包含话题管理和访问权限开关。退出旧版后启动，在「任务与结果」开启 Full access 即可。

最新搜索修复版为 `apps/desktop/release/Ayana-0.3.2-bing-search-win-x64.exe`，包含上述功能及默认免 Key 的 Bing 搜索；与当前通用交付包内容一致。

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e '.[test,stt]'
npm --prefix apps/desktop ci
npm --prefix apps/desktop run build
npm --prefix apps/desktop start
```

首次配置你自己的外部资源，路径仅写入被 Git 忽略的 `config/local.json`：

```powershell
.\.venv\Scripts\python.exe scripts/prepare_resources.py --voice-root '你的 ayana-voice 目录' --avatar-root '你的正常立绘目录'
```

联网模型设置 `provider=openai`、`base_url=https://api.deepseek.com`、`model=deepseek-flash`。密钥通过 `AYANA_API_KEY` 或 `DEEPSEEK_API_KEY` 环境变量提供；本机已有密钥使用当前 Windows 用户的 DPAPI 加密保存，界面和日志不接收密钥。

在线模型默认使用原生 function calling（配置项 `native_tools`，默认 `true`）：请求携带注册工具的 `tools` schema，流式解析 `delta.tool_calls`，并以 `role:"tool"` 回传真实结果。因此在对话框里直接描述需求，模型会自行选择工具（读取网页、写入授权文件等），无需在提示里点名工具。若目标端点不支持 `tools`，可将 `native_tools` 设为 `false` 退回既有 NDJSON 工具事件协议。

「设置与管理 → 任务与结果」提供 **Full access** 开关（`full_access`，默认关闭，选择保存在本机）。开启后在对话中直接使用任意本机路径，读写仓库、操作应用、运行 PowerShell 命令；文件修改与恢复会直接应用并保留备份，桌面步骤无需逐次确认。`shell.run` 返回真实退出码与有上限的输出，命令超时、取消、切换开关或关闭助手会停止其进程树；用于持久启动桌面应用请用应用打开工具。关闭开关会停止当前任务并恢复原有目录授权、执行模式与确认规则。Full access 使用当前 Windows 用户权限；在线模型、可选 Brave 搜索凭证和 UFO 桌面组件仍需按对应功能配置，默认 Bing 搜索无需凭证。

## 体验流程

1. 按 **Ctrl+Alt+A** 呼出 Ayana，只出现半身立绘和对话框，可以直接闲聊或请求帮助。
2. 对话框右上角齿轮或托盘「设置与管理」打开独立管理窗口；关闭设置不会收起对话。
3. 素材目录完整包含 234 张原始透明 PNG：26 种表情、9 种服装与姿势组合。选择服装后，模型按每句语境选择表情和动作，路由器验证并限制在所选服装内。
4. 有语音时，立绘跟随实际播放句切换；仅文字时逐句呈现。思考下一句时沿用当前立绘，只有表情真正变化时才下沉 12px 并在 300ms 内回到原位；可在设置关闭，系统减少动态效果也会禁用。
5. 按住麦克风说话、松开识别，文本可修改后发送。**Ctrl+Alt+Space** 立即打断，关闭呼出面板也会停止输出。
6. 需要理解代码或观察窗口时，在设置里选择仓库和目标；需要执行桌面操作时选择「单步执行」并确认具体步骤。
7. 首批新增网页读取、联网搜索接入、文本创建/修改/恢复，以及可暂停和取消的任务循环。对话框启用执行模式后可保存文件；管理窗口的「任务与结果」展示来源、文件与修改差异。Bing 搜索无需凭据；完整用法与实测边界见 [首批交付说明](docs/FIRST_BATCH_DELIVERY.md)。
8. 执行模式现在可直接要求“打开记事本”“打开计算器”“打开这个网址”，也能查找并打开授权目录中的文件/文件夹。应用启动后，模型可选定新窗口继续观察。工具清单及限制见 [系统打开工具交付](docs/SYSTEM_TOOLS_DELIVERY.md)。

联网搜索默认 `search_provider=auto`：没有搜索凭据时使用 Bing RSS，无需 API Key；配置 Brave Key 后使用 Brave，也可显式选择 `bing` 或 `brave`。Bing RSS 路线参考 ByteMind 的实现；返回结果保留真实 URL、摘要和来源 ID，空结果或验证页面会明确报错。搜索引擎可能调整 RSS 行为，应继续用 `web.fetch` 核对原文。

Brave 凭据可通过 `.venv\Scripts\python.exe scripts/configure_search.py --installed` 隐藏输入并使用 Windows DPAPI 加密保存。若 Brave 直连失败，可加 `--proxy http://127.0.0.1:7892`（使用本机实际 HTTP 代理端口）；`search_proxy` 只作用于固定 Brave API，网页读取和 Bing RSS 仍使用原有公网地址验证。模型 API Key 与 Brave Search API Key 是独立凭据。

安全演示窗口：`.\.venv\Scripts\python.exe -m native.windows.demo_target`。它仅是练习应用，不会操作其他用户软件。

## 模块与提交

| 目录 | 职责 |
| --- | --- |
| `packages/protocol` | 完整模型对象解析、日语语句与表达验证 |
| `services/agent` | 会话、流式模型、工具证据、背压、取消、SQLite 历史 |
| `services/tts` | 常驻独立推理进程、显式权重加载、参考缓存、单 worker |
| `native/windows` | Win32 截图、独立 MTA UIA、单步输入与结果观察 |
| `apps/desktop` | Electron、受限 IPC、React、唯一 AudioWorklet 播放器 |
| `characters/ayana` | 人设、工具政策、受控表情映射 |

开发按文档、协议、Agent、Windows、语音、桌面、语音输入、发布验证分别提交。实施基线见 `docs/AYANA_IMPLEMENTATION_PLAN.md`，完成情况与实测结果见 `docs/DEMO_DELIVERY.md`。

## 验证与打包

```powershell
.\.venv\Scripts\python.exe -m pytest -q
$env:AYANA_WINDOWS_INTEGRATION='1'
.\.venv\Scripts\python.exe -m unittest discover -s tests -p test_windows.py -v
.\.venv\Scripts\python.exe scripts/check_model.py
.\.venv\Scripts\python.exe scripts/benchmark_tts.py --config config/local.json
.\.venv\Scripts\python.exe scripts/smoke_demo.py
```

基准输出在被忽略的 `.runtime/benchmarks`。PCM 到达耗时不等于设备出声耗时；真实播放器回执以消费的样本数为准。打包步骤由 `scripts/package_backend.py` 准备嵌入式 Python 和非敏感后端文件，再执行 `npm --prefix apps/desktop run package`。

完整打包步骤见 `scripts/PACKAGING.md`。真实桌面回归脚本为 `scripts/verify_desktop.mjs`，需要指定 Playwright 所在的 `node_modules`；它只对自己的练习窗口进行输入和点击。

模型输入缓存使用稳定的系统/仓库前缀和独立模型轮次历史；设置页显示最近一次 API 缓存 token 回执。真实对照可运行 `python scripts/benchmark_prompt_cache.py`（默认六次联网请求，不读取用户聊天历史）。修复、实测与剩余架构问题见 [缓存与架构审查](docs/ARCHITECTURE_REVIEW_2026-10-04.md)。

## 实际边界

普通权限、已解锁、可捕获且未最小化的窗口受到支持；受保护内容和管理员窗口返回明确失败。单步执行需要新鲜截图，动态页面变化会要求重新观察。发送输入不自动等于目标成功，只有实际观察结果可用于判断。

模型权重、GPT-SoVITS 引擎、角色素材、缓存和密钥独立于 Git 管理。发布包提供 Python 与桌面壳，本地 Ayana 引擎通过配置加载。没有资源时可选择文字模式；不会用别的音色冒充 Ayana。

界面使用真实发布的 Kun UI 主题 tokens 与框架无关 core，React 控件由本项目封装；上游 React 组件层尚未发布。Kun UI 的 AGPL-3.0 许可证及来源说明见 `apps/desktop/THIRD_PARTY_NOTICES.md`。

Whisper tiny 对技术词有误识别，语音识别结果会先供用户修改。Jev、嘴眼分层、全双工和真流式合成属于方案里的可选后续扩展，本版使用正常立绘和已实测的句级语音流水线。
