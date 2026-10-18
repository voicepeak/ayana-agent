# Ayana · 桌面聊天伙伴

**Windows 上的彩名：立绘、对白、日语声音和一点点小心思，收进一张可以随便摆放的便签。**

[一键安装](#一键安装) · [项目主页](https://voicepeak.github.io/ayana-agent/) · [GitHub Releases](https://github.com/voicepeak/ayana-agent/releases) · [0.3.28 发布说明](docs/RELEASE_0.3.28.md)

`v0.3.28` · Windows 10/11 x64 · 当前公开版本 · 需要配置在线模型 API

> 想要“做事的 Agent”版本（文件、命令、浏览器自动化、桌面操作、computer use）？它完整保留在 `beta` 分支，`main` 只维护这个聊天伴侣。

---

## 一键安装

| 方式 | 下载 | 说明 |
| --- | --- | --- |
| **安装包（推荐）** | [Ayana-0.3.28-win-x64-setup.exe](https://github.com/voicepeak/ayana-agent/releases/download/v0.3.28/Ayana-0.3.28-win-x64-setup.exe) | per-user 一键安装，不要求管理员权限，安装后自动启动 |
| 便携版 | [Ayana-0.3.28-win-x64.exe](https://github.com/voicepeak/ayana-agent/releases/download/v0.3.28/Ayana-0.3.28-win-x64.exe) | 双击即用，不写入安装目录 |
| 校验值 | [SHA256SUMS-0.3.28.txt](https://github.com/voicepeak/ayana-agent/releases/download/v0.3.28/SHA256SUMS-0.3.28.txt) | 安装包与便携版的 SHA256 |

安装包约 **342 MB**。安装完成后打开 Ayana，按开屏导览完成称呼与模型配置；语音包可以稍后再下载，不影响文字聊天。

SHA256（安装包）：

```text
ff8c703e83c1788cfcf0da5442fe06f7ea5e28e17b61586cf427e4da34b55ca1
```

### 安装后三步

1. **配置模型**：打开「设置 → 模型与连接」，填写服务地址、模型名称和 API Key。推荐 DeepSeek：`https://api.deepseek.com` + `deepseek-flash`。
2. **认识彩名**：在开屏导览里填写称呼，选主题、服装和快捷键。默认呼出键为 `Ctrl + Alt + A`。
3. **按需下载声音**：在便签的语音包气泡或设置里下载完整 Ayana 音色；不下载时对话会按纯文字显示。

> 本版不提供本地演示模型。没有 API Key 和模型名称时，不能进入桌面开始对话。

---

## 她会什么

- **互动开屏导览**：名字、聊天、按住说话、搜索、屏幕观察、摆放、主题和呼出快捷键都可以亲手点一遍。
- **电影对白便签**：每句台词跟随真实语音播放进度点亮；静音时也有相同的阅读节奏。
- **日语 Ayana 音色**：GPT-SoVITS 本地推理，可打断播放；完整音色包支持 CPU 与 CUDA 版本。
- **按住说话**：按住 `Ctrl + Shift + Space` 说，松开后识别为文字，修改后再发送。
- **八套主题**：夜墨、茶白、苔绿、雾蓝、樱夜、晴空、琥珀、竹月，也支持纯色和私人背景图片。
- **服装与摆放**：黑制服、内衣与裸露三种服装状态；便签可拖动、缩放，立绘可在框内移动。
- **联网与来源**：通过 Bing RSS、Brave 或 DeepSeek 搜索；真实网页与来源会留在对话旁边。
- **屏幕观察**：只在需要或你允许时查看前台窗口；可以随时关闭或说“别看了”。
- **记忆与话题**：跨话题摘要、长期记忆、对话搜索、改名、导出和删除都留在本机。
- **纯文字兜底**：语音引擎不可用时直接显示文字，不再反复重试或让对话卡片抽搐、重放。

Ayana 只聊天和陪伴：**不读写你的文件、不执行命令、不操作应用**。她可以查资料、按需看屏幕，并把结果用普通的话说出来。

---

## 第一次见面

新安装首次启动会进入彩名的互动导览。你可以：

- 写下希望被称呼的名字；
- 模拟发送一句聊天，看回复如何在便签里出现；
- 按住说话键，松开后得到可编辑的识别文字；
- 打开一条搜索结果并保留来源；
- 决定是否允许偶尔看屏幕；
- 调整立绘大小和便签位置；
- 在八套主题之间切换；
- 修改呼出与说话快捷键，并当场检验。

导览里的设置会真实保存。称呼统一写入后端人设，之后可在「设置 → 外观与声音」修改，也可以重看开场。

开发预览：构建桌面端后双击根目录的 `预览初次见面.cmd`，会使用独立的临时配置打开完整开场，不改正式用户资料。

---

## 快捷键

| 功能 | 默认快捷键 |
| --- | --- |
| 呼出 / 隐藏 Ayana | `Ctrl + Alt + A` |
| 按住说话 | `Ctrl + Shift + Space` |
| 立即打断 | `Ctrl + Alt + Space` |
| 收起输入 / 关闭便签 | `Esc` |

三个快捷键都可以在「设置 → 高级设置 → 快捷键」中修改。保存时会检查格式、重复占用和系统注册冲突。

---

## 模型与 API Key

在线模型走 OpenAI 兼容接口。推荐：

```text
provider   = openai
base_url   = https://api.deepseek.com
model      = deepseek-flash
temperature = 1.0
```

`temperature`（0–2）控制采样随机度；`history_budget_chars`（默认 128000）决定原样保留的历史字符预算，接近上限时自动摘要。两者都可以在「设置 → 模型与连接」中调整并立即生效。

**API Key 的保存方式：**

- 在「设置 → 模型与连接」直接填写、替换或清除；
- 使用当前 Windows 用户的 DPAPI 加密保存在本机；
- 不写入 `config/local.json`，界面和日志不回显密钥；
- 也可以改用 `AYANA_API_KEY` 或 `DEEPSEEK_API_KEY` 环境变量，环境变量优先。

在线模型默认使用原生 function calling（`native_tools=true`）：请求携带注册工具的 `tools` schema，流式解析 `delta.tool_calls`，并以 `role:"tool"` 回传真实结果。目标端点不支持 `tools` 时，可以设为 `false` 退回 NDJSON 工具事件协议。

---

## 语音包

开屏内置三段 Ayana 日语语音片段，安装后即可听到开场。完整音色包在应用内下载：

| 变体 | 适用设备 | 大小 |
| --- | --- | --- |
| CPU | 无 NVIDIA 显卡 | 约 4.86 GB |
| CUDA 12.4 | RTX 20/30/40（计算能力 7.5 / 8.0 / 8.6 / 8.9） | 约 8.3 GB |
| CUDA 12.8 | RTX 50（计算能力 12.0） | 约 9.5 GB |

下载逻辑会自动选择镜像并使用 **8 线程分段下载**，支持断点续传和失败回退。安装期间仍可正常文字聊天；下载完成后重启 Ayana 生效。也可以导入本地语音包，或把 `.zip` 放到下载目录让应用自动识别。

语音包目录：

```text
%LOCALAPPDATA%\Ayana\voice
```

---

## 主题、服装与界面

- **主题**：八套预设，外加自定义纯色或背景图片。图片支持自动适配底色、气泡和文字明暗。
- **服装**：当前发布版只提供黑制服彩名，设置和开屏都不再出现白制服切换；便签内保留黑制服、内衣与裸露状态。
- **对白**：主语言可选日语、中文或英文，翻译语言可另选；字幕逐句显示，滚动时只突出一条。
- **窗口**：便签默认 760px 宽，支持拖动、缩放和立绘位置调整；透明像素不会挡住桌面点击。

---

## 对话、记忆与隐私

- 对话保存可按开关切换；关闭只停止新增记录，不删除已有历史。
- 对话切换列表支持搜索、改名、导出和删除。删除会清理该对话的消息、上下文摘要、任务与关联记忆，并回收 SQLite 数据页。
- “允许彩名偶尔偷看”默认关闭。开启后按 45–90 秒的随机区间获得观察机会；同一窗口至少间隔约 3 分钟重新关注，相同画面会跳过后续请求。
- 她说“别看了”会暂停观察，“继续看”会恢复；明确要求看屏幕时仍可按需观察。
- 网页、截图和屏幕内容都只作为不可信证据，不会变成指令或授权。

本地数据位置：

| 内容 | 路径 |
| --- | --- |
| 非敏感设置 | `%APPDATA%\Ayana\config\local.json` |
| API Key（DPAPI） | `%APPDATA%\Ayana\.runtime\credentials.dpapi` |
| 对话历史 | `%APPDATA%\Ayana\.runtime\history.sqlite3` |
| 语音包 | `%LOCALAPPDATA%\Ayana\voice` |
| 运行日志 | `%APPDATA%\Ayana\logs\ayana-runtime.log` |

---

## 从源码运行

需要 Windows x64、Python 3.11+ 和 Node.js。

```powershell
./scripts/bootstrap.ps1
```

或手动安装：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e '.[test,stt]'
npm --prefix apps/desktop ci
npm --prefix apps/desktop run build
npm --prefix apps/desktop start
```

开发目录也可以双击 `启动 Ayana.cmd`，优先打开当前版本对应的便携 EXE；尚未打包时回退到开发启动。

### 导入本地角色资源

路径只写入被 Git 忽略的 `config/local.json`：

```powershell
.\.venv\Scripts\python.exe scripts/prepare_resources.py `
  --voice-root '你的 ayana-voice 目录' `
  --avatar-root '你的正常立绘目录'
```

当前发布版不提供白制服角色入口。开屏换装使用彩名自己的服装状态，设置中的服装选择继续保留。

### 打包

```powershell
.\.venv\Scripts\python.exe scripts/package_backend.py
npm --prefix apps/desktop run package
```

产物在 `apps/desktop/release/`：NSIS 安装包、便携版和当前版本 SHA256 清单。完整步骤见 [scripts/PACKAGING.md](scripts/PACKAGING.md)。

### 测试

```powershell
.\.venv\Scripts\python.exe -m pytest -q
npm --prefix apps/desktop run typecheck
npm --prefix apps/desktop test
```

桌面与语音相关的真实回归脚本包括 `scripts/verify_welcome.mjs`、`scripts/verify_settings.mjs`、`scripts/verify_cinematic.mjs`、`scripts/verify_conversation_manager.mjs`、`scripts/verify_conversation_switcher.mjs` 和 `scripts/verify_portable_demo.mjs`。这些脚本需要指定 Playwright 所在的 `node_modules`。

---

## 项目结构

| 目录 | 职责 |
| --- | --- |
| `packages/protocol` | 模型事件、日语语句与表达验证 |
| `services/agent` | 会话、流式模型、工具结果、背压、取消、SQLite 历史 |
| `services/tts` | 常驻独立推理进程、显式权重加载、参考缓存、单 worker |
| `native/windows` | Win32 窗口截图与前台窗口观察 |
| `apps/desktop` | Electron、受限 IPC、React、AudioWorklet 播放器 |
| `characters/ayana` | 角色注册表、人设、观察策略、表情与服装映射 |
| `site/` | GitHub Pages 主页 |

---

## 版本记录

| 版本 | 重点 | 链接 |
| --- | --- | --- |
| **0.3.28** | 新 Logo、随声音 Q 弹立绘、点击回弹、Ayana 品牌回归 | [Release](https://github.com/voicepeak/ayana-agent/releases/tag/v0.3.28) · [说明](docs/RELEASE_0.3.28.md) |
| 0.3.27 | 搜索来源校正、来源顺序与去重、安装器与界面品牌整理 | [Release](https://github.com/voicepeak/ayana-agent/releases/tag/v0.3.27) · [说明](docs/RELEASE_0.3.27.md) |
| 0.3.26 | 互动开屏、在线模型必配、八套主题、语音下载加速、纯文字对话稳定 | [Release](https://github.com/voicepeak/ayana-agent/releases/tag/v0.3.26) · [说明](docs/RELEASE_0.3.26.md) |
| 0.3.25 | 退出、回执与 WebSocket 清理；SHA256 清单 | [Release](https://github.com/voicepeak/ayana-agent/releases/tag/v0.3.25) |
| 0.3.24 | 本地测试构建；安装包校验不一致，由 0.3.25 取代 | 未发布 |
| 0.3.23 | 跨对话心情、表情轮换、温度与历史预算 | [源码/校验记录](https://github.com/voicepeak/ayana-agent/releases/tag/v0.3.23) |
| 0.3.22 | 偷看时允许搭话、表情引导、思考回复修复 | [Release](https://github.com/voicepeak/ayana-agent/releases/tag/v0.3.22) |
| 0.3.21 | 按需观察、双角色（后续版本移除白制服入口）、对话删除 | [Release](https://github.com/voicepeak/ayana-agent/releases/tag/v0.3.21) |

全部公开版本：[GitHub Releases](https://github.com/voicepeak/ayana-agent/releases)

---

## 项目主页

`site/` 是 GitHub Pages 静态主页：[voicepeak.github.io/ayana-agent](https://voicepeak.github.io/ayana-agent/)。推送到 `main` 且改动 `site/**` 时，由 `.github/workflows/pages.yml` 自动部署。

本地预览：

```powershell
python -m http.server 4173 --directory site
```

页面立绘、表情清单与截图由 `python site/build_assets.py` 从本机素材生成；输出已提交。角色立绘与声音版权归原作及权利方所有。

---

## 边界与许可

- 屏幕观察支持普通权限、已解锁、可捕获且未最小化的窗口；受保护内容和管理员窗口会明确失败。
- 模型权重、GPT-SoVITS 引擎、角色素材、缓存和密钥独立于 Git 管理。没有语音资源时文字模式完整可用；不会用别的音色冒充 Ayana。
- 界面使用 Kun UI 主题 tokens 与框架无关 core；GSAP 用于开屏动画。第三方字体、动画与依赖许可见 [THIRD_PARTY_NOTICES.md](apps/desktop/THIRD_PARTY_NOTICES.md)。
- 角色与声音仅供个人研究使用；请勿商业使用或用于冒充他人。
