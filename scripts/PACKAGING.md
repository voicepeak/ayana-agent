# Windows 安装与打包

在仓库根目录打开 PowerShell。需要 64 位 Python 3.11 和 Node.js；项目中的语音模型使用自己的 Python 环境。

```powershell
./scripts/bootstrap.ps1
```

若 `py` 启动器没有安装，指定 Python 可执行文件：

```powershell
./scripts/bootstrap.ps1 -Python 'C:/Python311/python.exe'
```

导入用户自己的角色和音色资源，启用按住说话，并生成便携版：

```powershell
./scripts/bootstrap.ps1 -WithStt -AvatarRoot '<立绘目录>' -VoiceRoot '<ayana-voice 目录>' -Package
```

`-WithStt` 安装 faster-whisper 并下载 tiny 模型。`-SkipNpm` 可在已有桌面依赖时跳过 `npm ci`。角色和音色的实际路径写入忽略提交的 `config/local.json`；音色权重与 GPT-SoVITS 引擎使用外部资源目录。

修改后重新打包：

```powershell
./.venv/Scripts/python.exe scripts/package_backend.py
cd apps/desktop
npm run package
```

先执行 `package_backend.py`，让打包内容包含最新的后端代码。脚本只重建 `.runtime/python` 和 `.runtime/backend` 两个生成目录；调用前关闭正在使用它们的便携版程序。

打包脚本从 [Python 官方 3.11.9 发布页](https://www.python.org/downloads/release/python-3119/) 下载 AMD64 嵌入式运行时并校验发布页列出的校验和，把 `.venv` 的运行依赖复制到该运行时。验证使用 `python.exe -I`，不读取系统 Python 或用户的 site-packages。桌面程序也须使用 `-I -u -m services.agent` 启动它。

`.runtime/backend` 包含服务代码、Windows 执行层、协议、人设、默认配置、完整素材目录中的 234 张原始透明角色 PNG（另含五个兼容别名）、小型英文发音资料，以及本地已下载的 tiny 识别模型。发布包不会复制个人配置、API 密钥、DPAPI 文件、会话历史或 GPT-SoVITS 权重。个人机器的配置应通过程序设置或用户数据目录提供。

`scripts/package_backend.py --nltk-only` 单独准备英文代码名称的发音字典和词性标注资料；纯日语合成之外的混合日语/英文内容需要它。字典保存在 `.runtime/nltk_data`，打包后保存在 `backend/nltk_data`，TTS 会自动选取。

打包验证记录写入 `.runtime/package-backend-report.json`。真实音色基准：

```powershell
./.venv/Scripts/python.exe scripts/benchmark_tts.py --config config/local.json
```

基准包含整个 TTS 子进程冷启动、预热、日语与英文代码名/数字、合成中取消和恢复。默认只生成 PCM/WAV；加 `--play` 可播放样本。PCM 生成延迟与真实音频设备播放延迟分开计算。
