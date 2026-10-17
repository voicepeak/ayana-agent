# Windows 安装与打包

在仓库根目录打开 PowerShell。需要 64 位 Python 3.11 和 Node.js；项目中的语音模型使用自己的 Python 环境。

```powershell
./scripts/bootstrap.ps1
```

若 `py` 启动器没有安装，指定 Python 可执行文件：

```powershell
./scripts/bootstrap.ps1 -Python 'C:/Python311/python.exe'
```

导入用户自己的角色和音色资源，启用按住说话，并生成安装包：

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

`npm run package` 同时生成一键安装器 `release/Ayana-<版本>-win-x64-setup.exe` 和便携版 `release/Ayana-<版本>-win-x64.exe`。安装器使用 per-user one-click NSIS，不要求管理员权限，安装后自动启动；语音包仍由应用内的可选下载提供。

首次启动开场的固定讲解在 `apps/desktop/public/welcome/*.wav`，Vite 会一起复制进桌面包；它们不依赖完整语音模型或网络。修改台词 `config/welcome-script.json` 后，运行 `./.venv/Scripts/python.exe scripts/build_welcome_audio.py --force`，使用本机已配置的 Ayana 音色重新生成，再构建桌面包。首次启动通过用户配置的 `onboarding_version` 判断，完成和跳过都要求先保存称呼；旧版个人配置自动沿用原来的“紀”，可在设置中重看。

打包成功后会自动按最终 EXE 内容生成 `release/SHA256SUMS-<版本>.txt`；重新构建同一版本也会更新清单。打包失败时不会生成新的成功清单。发布前应再次核对 EXE 的 SHA256 与清单一致，并对该文件执行冒烟测试。

先执行 `package_backend.py`，让打包内容包含最新的后端代码。脚本只重建 `.runtime/python` 和 `.runtime/backend` 两个生成目录；调用前关闭正在使用它们的已安装版或便携版程序。

打包脚本从 [Python 官方 3.11.9 发布页](https://www.python.org/downloads/release/python-3119/) 下载 AMD64 嵌入式运行时并校验发布页列出的校验和，把 `.venv` 的运行依赖复制到该运行时。验证使用 `python.exe -I`，不读取系统 Python 或用户的 site-packages。桌面程序也须使用 `-I -u -m services.agent` 启动它。

`.runtime/backend` 包含服务代码、Windows 执行层、协议、人设、默认配置、完整素材目录中的 234 张原始透明角色 PNG（另含五个兼容别名）、小型英文发音资料，以及本地已下载的 tiny 识别模型。发布包不会复制个人配置、API 密钥、DPAPI 文件、会话历史或 GPT-SoVITS 权重。个人机器的配置应通过程序设置或用户数据目录提供。

`scripts/package_backend.py --nltk-only` 单独准备英文代码名称的发音字典和词性标注资料；纯日语合成之外的混合日语/英文内容需要它。字典保存在 `.runtime/nltk_data`，打包后保存在 `backend/nltk_data`，TTS 会自动选取。

### 语音资源包

应用内的语音包下载不进入主安装器。如果已有可用的本地语音工作目录（venv、GPT-SoVITS、权重和参考音频），先把它整理成可重定位目录：

```powershell
./.venv/Scripts/python.exe scripts/stage_voice_pack.py `
  --source-root 'D:/ayana-voice' `
  --device cuda `
  --output '.runtime/voice-pack/ayana-v2pro-cu124'
```

`--device cuda` 要求源 venv 中的 torch 是 CUDA 版；脚本会把 Python 运行时、site-packages、v2Pro 所需的引擎文件和底模、权重、参考音频、ffmpeg 一起放进 staging 目录，并用 staging 内的 Python 验证 torch 和 GPT-SoVITS 能否加载。无 N 卡但已安装 CUDA torch 的构建机可加 `--allow-cpu` 跳过 GPU 可见性检查；CPU 包用 `--device cpu`。

然后生成 ZIP 与发布清单：

```powershell
./.venv/Scripts/python.exe scripts/package_voice.py `
  --pack-root '<staged-voice-pack>' `
  --output 'release/ayana-v2pro-cu124-1.0.0.zip' `
  --manifest 'release/voice-pack.json' `
  --url 'https://your-cdn.example/ayana-v2pro-cu124-1.0.0.zip' `
  --variant-id cu124 --kind cuda `
  --min-driver 551.61 --min-vram-mb 6144 `
  --compute-capability 7.5 --compute-capability 8.0 `
  --compute-capability 8.6 --compute-capability 8.9
```

把清单地址填入 `config/voice-pack.json` 的 `manifest_url`（或用户目录的 `%APPDATA%/Ayana/config/voice-pack.json`、环境变量 `AYANA_VOICE_PACK_MANIFEST`）。未配置时，应用仍可导入本地语音包。CUDA 包必须从 CUDA 版 torch 的 venv staging；脚本会把 site-packages 复制到可重定位的 embeddable Python，用户不需要安装 Python 或 CUDA Toolkit。

打包验证记录写入 `.runtime/package-backend-report.json`。真实音色基准：

```powershell
./.venv/Scripts/python.exe scripts/benchmark_tts.py --config config/local.json
```

基准包含整个 TTS 子进程冷启动、预热、日语与英文代码名/数字、合成中取消和恢复。默认只生成 PCM/WAV；加 `--play` 可播放样本。PCM 生成延迟与真实音频设备播放延迟分开计算。

0.2.4 的 v2/v2Pro 适配器在首次 EOS 后保留 4 个语义帧（约 160ms）的句尾收音，超过 20 帧的语句保留 6 帧（约 240ms），再等待实际 EOS；达到长度上限会报错，避免把未完成的前缀当成完整语音。每个语义帧都检查取消。播放器的完整消费回执只能证明采样已播放，不能证明模型读全了原句。句尾回归须另行对照生成 WAV 的语音内容；本机验证覆盖「こんにちは。」「今日は、どんなことを話したい？」「うん、ここにいるよ。」的多次合成。

```powershell
./.venv/Scripts/python.exe scripts/verify_voice_tails.py --config config/local.json --asr-model '<已下载的本地 Whisper 模型目录>'
```

此检查使用本地 ASR 辅助核对尾字，重复短句与多句合成，并验证打断后恢复；不会自动下载模型。
