# Ayana Desktop Demo

Windows 桌面学习助手：快捷键呼出、原窗口截图、DeepSeek Flash 识图与仓库讲解、日语 Ayana 音色、中文字幕、立绘同步、可打断播放和用户确认的单步操作。

## 在本机运行

本机交付版可直接双击 `apps/desktop/release/Ayana-0.1.0-win-x64.exe`，桌面也有「Ayana Demo」快捷方式。它包含独立 Python、桌面程序、立绘与本地识别模型；个人模型配置保存在 `%APPDATA%/Ayana/config/local.json`。首次解包和加载音色需要等待；首次语音冷启动实测约 43 秒，期间文字输入与界面保持可用。

开发目录也可双击 `启动 Ayana.cmd`，后续修改仍按下面的流程构建。

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

## 体验流程

1. 打开想学习的窗口，按 **Ctrl+Alt+A**。Ayana 会在对话面板取得焦点前记录原窗口并获取截图。
2. 在界面选择代码仓库，输入「这个仓库怎么开始学」。相关内容从实际文件读取；模型可以继续检索，路径和行号显示在文件证据中。
3. 日语完整句逐句合成；只有实际播放开始，角色才采用对应表达。中文翻译可以稍后补齐。
4. 按住麦克风按钮提问，松开后在本地用 Whisper tiny 转写到输入框，检查或修改后点发送；录音开始即停止助手播放，采用半双工门控。
5. 点击截图定位，默认可显示穿透高亮。切换「单步执行」后，可以明确确认一次点击、输入、滚动或导航按键；每次重新校验身份、内容、坐标和用户接管，并截图观察结果。
6. **Ctrl+Alt+Space** 立即打断。隐藏面板也停止旧输出；取消后旧音频和后续动作失效。

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

## 实际边界

普通权限、已解锁、可捕获且未最小化的窗口受到支持；受保护内容和管理员窗口返回明确失败。单步执行需要新鲜截图，动态页面变化会要求重新观察。发送输入不自动等于目标成功，只有实际观察结果可用于判断。

模型权重、GPT-SoVITS 引擎、角色素材、缓存和密钥独立于 Git 管理。发布包提供 Python 与桌面壳，本地 Ayana 引擎通过配置加载。没有资源时可选择文字模式；不会用别的音色冒充 Ayana。

界面使用真实发布的 Kun UI 主题 tokens 与框架无关 core，React 控件由本项目封装；上游 React 组件层尚未发布。Kun UI 的 AGPL-3.0 许可证及来源说明见 `apps/desktop/THIRD_PARTY_NOTICES.md`。

Whisper tiny 对技术词有误识别，语音识别结果会先供用户修改。Jev、嘴眼分层、全双工和真流式合成属于方案里的可选后续扩展，本版使用正常立绘和已实测的句级语音流水线。
