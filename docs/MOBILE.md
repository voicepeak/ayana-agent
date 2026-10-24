# Ayana 手机端（PWA / Android / iOS）

> 这是旧版 17321 桌面运行时薄客户端的历史说明，已由独立手机运行版替代。新手机端不兼容以下接入命令；请使用 [0.2.0 本地部署与打包说明](MOBILE_INDEPENDENT_DELIVERY.md)。旧文保留用于排查与迁移。

手机端复用现有运行时：Windows PC 继续负责模型流式输出、GPT-SoVITS 语音和 SQLite 历史；手机只负责界面、播放和麦克风。这样不需要把 Electron 或 Torch 搬到手机上。

```
手机 (PWA / Capacitor)
  ├─ WebSocket：文字事件、播放回执
  ├─ AudioWorklet：按采样时钟播放 PCM
  └─ MediaRecorder：按住说话
        │ Tailscale（WireGuard + TLS）
        ▼
Windows PC
  ├─ FastAPI :17321
  ├─ DeepSeek 流式 API
  ├─ GPT-SoVITS 常驻 worker
  └─ SQLite / 记忆
```

## 1. 构建手机 Web 客户端

```powershell
npm --prefix apps/mobile install
npm --prefix apps/mobile run build
```

产物在 `apps/mobile/dist`。服务端默认会把它挂载到 `/m/`。

## 2. 启动服务端

```powershell
# 可选：使用桌面端已有的用户资料，这样手机和桌面共享历史/语音设置
.\scripts\start_mobile_server.ps1 -DataDir "$env:APPDATA\Ayana"
```

或手动：

```powershell
$env:AYANA_RUNTIME_TOKEN = -join ((1..64) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })
.\.venv\Scripts\python.exe -m services.agent --port 17321 --data-dir "$env:APPDATA\Ayana"
```

注意：

- 不要同时启动桌面 Ayana 和这个独立服务端并指向同一个数据目录，否则会争抢 SQLite 和 TTS 进程。
- 服务端只监听 `127.0.0.1`，不要直接做端口转发。
- 手机访问令牌保存在 `<数据目录>\.runtime\mobile-token`。

查看令牌：

```powershell
.\.venv\Scripts\python.exe scripts\show_mobile_token.py --data-dir "$env:APPDATA\Ayana"
```

## 3. Tailscale 组网与 HTTPS

PC 和手机安装 Tailscale，登录同一 tailnet。PC 上执行：

```powershell
tailscale serve --bg http://127.0.0.1:17321
tailscale serve status
```

然后手机访问：

```text
https://<机器名>.<tailnet>.ts.net/m/
```

`tailscale serve` 会自动提供合法证书并代理 WebSocket，不需要自己配置 Caddy 或安装根证书。手机浏览器打开后：

- Android Chrome：菜单 →「安装应用」/「添加到主屏幕」；
- iOS Safari：分享 →「添加到主屏幕」。

首次打开会要求输入访问令牌。令牌只通过 HTTPS 提交一次，服务端写入 `HttpOnly; Secure; SameSite=Lax` Cookie，之后免登录。取消配对会清除 Cookie。

## 4. Android 原生壳

```powershell
cd apps/mobile
npm run build
npx cap sync android
npx cap open android
```

Android Studio 中连接手机后运行即可。命令行构建：

```powershell
cd apps/mobile/android
.\gradlew.bat assembleDebug
```

APK 在 `apps/mobile/android/app/build/outputs/apk/debug/`。本机已构建一份可直接安装的通用调试包：

```text
release/mobile/Ayana-1.0-android.apk
```

它使用 Android 调试签名，最低 Android 7.0（API 24），首次打开填写服务器地址和令牌即可，不需要把地址写进包里。手机浏览器打开 `https://<机器名>.<tailnet>.ts.net/m/` 时，配对页也会显示“下载 Android 安装包”，直接通过 Tailscale 下载即可。

原生包默认加载打进 APK 的本地 `dist`。首次打开会要求填写：

- 服务器地址：`https://<机器名>.<tailnet>.ts.net`（只填到域名，不要带 `/m/`）；
- 访问令牌：`scripts/show_mobile_token.py` 输出的字符串。

原生模式使用 Bearer 令牌换取 120 秒连接票据，WebSocket 和图片请求不再依赖第三方 Cookie。权限已经写入 `AndroidManifest.xml`：`INTERNET`、`RECORD_AUDIO`、`MODIFY_AUDIO_SETTINGS`、`WAKE_LOCK`。

如果确实想让原生壳直接加载远程页面，也可以设置 `AYANA_MOBILE_URL` 后再 `npx cap sync`，但通用 APK 不需要这样做。

## 5. iOS 原生壳

iOS 构建需要 macOS + Xcode，Windows 只能生成工程文件：

```bash
cd apps/mobile
npm run build
npx cap sync ios
npx cap open ios
```

在 Xcode 里选择 Team、连接 iPhone 运行。首次打开同样填写 Tailscale 地址和令牌。`Info.plist` 已加入：

- `NSMicrophoneUsageDescription`（按住说话）；
- `NSLocalNetworkUsageDescription`；
- `UIBackgroundModes: audio`（尽力而为，WebView 锁屏后仍可能被系统挂起）。

真机首次使用麦克风会弹出系统授权。App Store 对角色服装状态和素材授权较敏感，建议先用 TestFlight/侧载验证。

## 6. 流式与传输实现

- 模型在服务端按句流式输出，`utterance.ready` 先到，`audio.ready` 紧随其后；
- 手机连接 `/ws?client=mobile` 时，服务端把整句 PCM 从 float32 转成 **int16 little-endian**，元数据走 JSON、音频走二进制帧，体积减半且不再有 base64 膨胀；
- 手机把 int16 解码成 float32，交给同一个 AudioWorklet 采样时钟；
- 每 100ms 回传 `playback.progress`，字幕按 `played_samples / total_samples` 逐字显示；
- 音频按句缓冲，最多 3 句 / 12 秒；网络抖动只影响下一句开始时间。

传输量参考（32kHz 单声道）：

| 格式 | 速率 | 连续 10 分钟 |
| --- | --- | --- |
| f32 + base64（桌面端仍使用） | ~1.36 Mbps | ~100 MB |
| int16 二进制（手机端） | 512 kbps | ~38 MB |
| AAC 64kbps（后续） | 64 kbps | ~4.8 MB |
| Opus 32kbps（后续） | 32 kbps | ~2.4 MB |

实际说话占空比通常 30–50%，手机端约为 1–2 MB/分钟。后续可在 `services/tts/audio.py` 增加 AAC/Opus 编码，客户端解码后再送入现有播放器，同步逻辑不需要改。

## 7. 已知限制

- **单活跃端**：运行时目前只有一个全局音频队列。桌面和手机同时连接会重复播放同一句；当前建议只连接手机，或只连接桌面。
- **后台**：Android 原生壳可以继续播放一段时间；iOS 锁屏/切后台后 WebView 可能挂起，不能保证后台陪伴。
- **屏幕观察**：`native/windows` 只适用于 Windows。手机端暂不支持截屏观察/悬浮窗。
- **推送**：没有 APNs/FCM，手机锁屏时不会主动通知。
- **多客户端历史**：共享 SQLite，但同时操作最好只由一个端发起。
- **商店合规**：角色素材与服装状态可能触发审核；优先 PWA/TestFlight/侧载。

## 8. 故障排查

| 现象 | 排查 |
| --- | --- |
| 一直要求配对 | 检查 `show_mobile_token.py`；确认 Cookie 未被浏览器隐私模式清掉 |
| WebSocket 4401 | 令牌错误或 Cookie 失效，重新配对 |
| WebSocket 4403 | origin 不在白名单；使用 Tailscale HTTPS 地址，或给服务端加 `--allowed-origin` |
| 麦克风不可用 | 必须 HTTPS；Android 已加录音权限；iOS 检查系统麦克风授权 |
| 语音识别失败 | iOS 录音通常是 `audio/mp4`；本地 faster-whisper 需要 ffmpeg 解码，或改用远程 STT |
| 图片 401 | Cookie 未带上；确认页面和 `/assets` 同源 |
| 没有声音 | `/health` 查看 TTS 状态；确认语音包已安装；查看服务端日志 |
| `/m/` 404 | 先执行 `npm --prefix apps/mobile run build`，或检查 `--mobile-root` |
| Tailscale 访问失败 | `tailscale serve status`；确认手机和 PC 在同一 tailnet |

## 9. 安全

- 只通过 Tailscale 访问，不要公网暴露 17321；
- 移动令牌只存在服务端文件（建议 NTFS ACL 限制）和手机 HttpOnly Cookie 中；
- API Key 始终留在 PC（DPAPI/环境变量），不会下发到手机；
- 删除 `<数据目录>\.runtime\mobile-token` 后重启服务端即可让所有手机失效，再重新配对；
- 页面资源与 `/assets` 都要求会话 Cookie；静态壳本身可公开，但不含隐私数据。

## 10. 回归测试

```powershell
node scripts/verify_mobile.mjs `
  --url https://<机器名>.<tailnet>.ts.net/m/ `
  --token <令牌> `
  --playwright-root <含 playwright 的 node_modules 目录>
```

脚本会完成配对、发送“你好”、等待语音/文字回复，并保存截图到 `.runtime/benchmarks/`。需要本机安装 Chrome。Android/iOS 原生壳的图标和启动图已替换为 Ayana 品牌资源。
