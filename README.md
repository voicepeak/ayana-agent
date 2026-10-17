# Ayana · 桌面聊天伙伴

Windows 聊天伙伴：立绘、细宋体电影对白和紧凑的文字输入收在可定制的便签中，跳字跟随实际语音播放进度；日语 Ayana 音色、可打断播放。便签提供夜墨、茶白、苔绿、雾蓝四套主题，以及自定义图片或纯色。模型、声音、服装与观察开关通过右键菜单或托盘进入独立管理窗口。正式人设见 `characters/ayana/persona.md`。

Ayana 只聊天和陪伴：不读写你的文件、不执行命令、不操作应用。她可以联网查资料、按需看看屏幕，把结果用普通的话说出来。

> 想要“做事的 Agent”版本（文件、命令、浏览器自动化、桌面操作、computer use）？它完整保留在 `beta` 分支，`main` 只维护这个聊天伴侣。

### 主动观察与对话管理

呼出快捷键第一次将彩名置于上层，再按一次隐藏。打开聊天不自动绑定窗口，也不持续截图。

彩名可调用 `desktop.observe` 按需查看前台窗口、指定窗口或整个桌面。
开启“允许彩名偶尔偷看”后，彩名在显示且空闲时按设定的随机区间（默认 45–90 秒，设置里可调整）获得一次观察机会；同一窗口至少间隔约 3 分钟重新关注，相同画面会跳过后续视觉请求。她可以保持安静，主动搭话至少间隔 5 分钟；“偷看时允许搭话”关闭后只看不说。隐藏、播放语音或关闭屏幕观察时不会主动偷看。说“别看了”暂停，“继续看”恢复；明确要求看屏幕时仍可按需观察。

对话切换列表提供删除按钮。确认删除后立即清理该对话的消息、模型上下文、摘要与关联记忆，回收 SQLite 数据页并清理 WAL。其他对话和已经导出的文件保留。

## 项目主页

`site/` 是 GitHub Pages 静态主页：[voicepeak.github.io/ayana-agent](https://voicepeak.github.io/ayana-agent/)。首次启用：仓库 Settings → Pages 将 Source 设为 **GitHub Actions**；之后推送到 `main` 且改动 `site/**` 时由 `.github/workflows/pages.yml` 自动发布。本地预览：`python -m http.server 4173 --directory site`。

主页立绘、表情清单与截图由 `python site/build_assets.py` 从本机 `assets/ayana`、`characters/ayana` 与 `.runtime` 材料生成（输出已提交，重建需要这些本地素材）。页面只使用校服素材，角色立绘版权归原作及权利方所有。

## 在本机运行

本机交付版可直接双击 `apps/desktop/release/Ayana-0.3.25-win-x64.exe`。它包含独立 Python、桌面程序与立绘；个人模型配置保存在 `%APPDATA%/Ayana/config/local.json`。首次解包和加载音色需要等待；此前版本首次语音冷启动实测约 43 秒，期间文字输入与界面保持可用。启动新版前请退出旧版。

根目录可双击 `启动 Ayana.cmd`，优先打开当前项目版本对应的便携 EXE；尚未打包时回退到开发启动。后续修改仍按下面的流程构建。

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

第二套「彩名（白制服）」立绘与音色同样先导入（`--su-avatar-root` 指向带 `素材索引.json` 的立绘目录，`--su-voice-root` / `--base-voice-root` 指向各自的语音目录），之后在「设置与管理 → 外观与声音 → 角色」中切换。两套资源只替换立绘和声音，人设、记忆与使用设置共用；表情目录、服装和对话中的表情动作随所选角色自动切换。

联网模型设置 `provider=openai`、`base_url=https://api.deepseek.com`、`model=deepseek-flash`。`temperature`（默认 1.0，0–2）控制采样随机度，`history_budget_chars`（默认 128000）决定原样保留的历史字符预算，接近上限时自动摘要；两者均可在「设置与管理 → 模型与连接」中调整并立即生效。密钥通过 `AYANA_API_KEY` 或 `DEEPSEEK_API_KEY` 环境变量提供；本机已有密钥使用当前 Windows 用户的 DPAPI 加密保存，界面和日志不接收密钥。

在线模型默认使用原生 function calling（配置项 `native_tools`，默认 `true`）：请求携带注册工具的 `tools` schema，流式解析 `delta.tool_calls`，并以 `role:"tool"` 回传真实结果。因此在对话框里直接描述需求，模型会自行选择工具（联网搜索、查看屏幕等），无需在提示里点名工具。若目标端点不支持 `tools`，可将 `native_tools` 设为 `false` 退回既有 NDJSON 工具事件协议。

## 体验流程

1. 按 **Ctrl+Alt+A** 呼出 Ayana 便签并聚焦输入；也可点击立绘输入，拖动立绘调整位置。标题栏的设计按钮可以调整便签背景、宽度、立绘和字幕，点「保存设计」保留配置。
2. 右键立绘或托盘「设置与管理」打开独立管理窗口；对话与记忆、设置和观察开关也在菜单中。Esc 先关闭输入，再收起角色。
3. 素材目录完整包含 234 张原始透明 PNG：26 种表情、9 种服装与姿势组合。选择服装后，模型按每句语境选择表情和动作，路由器验证并限制在所选服装内。
4. 有语音时，立绘跟随实际播放句切换；仅文字时逐句呈现。思考下一句时沿用当前立绘，只有表情真正变化时才下沉 12px 并在 300ms 内回到原位；可在设置关闭，系统减少动态效果也会禁用。
5. 按住 **Ctrl+Shift+Space**（或麦克风按钮）说话，松开识别，文本可修改后发送。**Esc** 取消录音或识别，**Ctrl+Alt+Space** 立即打断，关闭呼出面板也会停止输出。三个快捷键均可在设置中修改。
6. 想让她看屏幕时直接说，或让“偶尔偷看”在空闲时留意一眼；网页和屏幕内容只作为证据，不会被当成指令执行。

联网搜索默认 `search_provider=auto`：没有搜索凭据时使用 Bing RSS，无需 API Key；配置 Brave Key 后使用 Brave，也可显式选择 `bing`、`brave` 或 `deepseek`。`deepseek` 直接复用对话模型的 API Key 调用 DeepSeek Search API，返回带权威性和时效性排序的模型友好摘要；网页直连失败时会自动改用 DeepSeek Fetch 读取 Markdown 正文。返回结果保留真实 URL、摘要和来源 ID，空结果或验证页面会明确报错。搜索引擎可能调整 RSS 行为，应继续用 `web.fetch` 核对原文。

Brave 凭据可通过 `.venv\Scripts\python.exe scripts/configure_search.py --installed` 隐藏输入并使用 Windows DPAPI 加密保存。若 Brave 直连失败，可加 `--proxy http://127.0.0.1:7892`（使用本机实际 HTTP 代理端口）；`search_proxy` 只作用于固定 Brave API，网页读取和 Bing RSS 仍使用原有公网地址验证。模型 API Key 与 Brave Search API Key 是独立凭据。

## 模块与提交

| 目录 | 职责 |
| --- | --- |
| `packages/protocol` | 完整模型对象解析、日语语句与表达验证 |
| `services/agent` | 会话、流式模型、工具结果、背压、取消、SQLite 历史 |
| `services/tts` | 常驻独立推理进程、显式权重加载、参考缓存、单 worker |
| `native/windows` | Win32 窗口截图与前台窗口观察 |
| `apps/desktop` | Electron、受限 IPC、React、唯一 AudioWorklet 播放器 |
| `characters` | 角色注册表、人设、聊天观察策略与受控表情映射（ayana / ayana-su） |

## 验证与打包

```powershell
.\.venv\Scripts\python.exe -m pytest -q
.\.venv\Scripts\python.exe scripts/check_model.py
.\.venv\Scripts\python.exe scripts/benchmark_tts.py --config config/local.json
npm --prefix apps/desktop run typecheck
npm --prefix apps/desktop test
```

基准输出在被忽略的 `.runtime/benchmarks`。PCM 到达耗时不等于设备出声耗时；真实播放器回执以消费的样本数为准。打包步骤由 `scripts/package_backend.py` 准备嵌入式 Python 和非敏感后端文件，再执行 `npm --prefix apps/desktop run package`。完整打包步骤见 `scripts/PACKAGING.md`。

### 对话风格检查

人设在 `characters/ayana/persona.md`，日语接话与语音规则在 `characters/ayana/speech-style.md`；表情跟随对白，不以使用新表情为目标。默认允许简短回应，也允许有内容时展开；对方换话题时跟随当前内容。调研依据和小样本结果见 `docs/prompt-design-research-2026-10-16.md`。

查看被测提示词的指纹和测试场景，或用已配置的在线模型跑合成对话：

```powershell
.\.venv\Scripts\python.exe scripts/check_dialogue_style.py --dry-run
.\.venv\Scripts\python.exe scripts/check_dialogue_style.py
```

检查不会读取用户聊天历史、执行工具或播放语音。结果保存在 `.runtime/benchmarks`，包括逐轮日中对白、失败记录、重复开头、称呼与追问等指标；这些指标供人工评估，不是自然度评分。可用 `--scenario daily --scenario continuity` 选择场景，用 `--against-system <旧系统提示词快照>` 在相同条件下作对照。修改源码不会更新已生成的 EXE，使用打包版时需要重新打包。

桌面端与语音相关的真实回归脚本包括 `scripts/verify_attention_companion.mjs`、`scripts/verify_conversation_manager.mjs`、`scripts/verify_conversation_switcher.mjs`、`scripts/verify_settings.mjs` 与 `scripts/verify_portable_demo.mjs`，需要指定 Playwright 所在的 `node_modules`。

## 实际边界

屏幕观察支持普通权限、已解锁、可捕获且未最小化的窗口；受保护内容和管理员窗口返回明确失败。网页与截图都是不可信证据，聊天不会据此执行任何操作。

模型权重、GPT-SoVITS 引擎、角色素材、缓存和密钥独立于 Git 管理。发布包提供 Python 与桌面壳，本地 Ayana 引擎通过配置加载。没有资源时可选择文字模式；不会用别的音色冒充 Ayana。

界面使用真实发布的 Kun UI 主题 tokens 与框架无关 core，React 控件由本项目封装；上游 React 组件层尚未发布。Kun UI 的 AGPL-3.0 许可证及来源说明见 `apps/desktop/THIRD_PARTY_NOTICES.md`。

Whisper tiny 对技术词有误识别，语音识别结果会先供用户修改。Jev、嘴眼分层、全双工和真流式合成属于方案里的可选后续扩展，本版使用正常立绘和已实测的句级语音流水线。
