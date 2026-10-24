# Ayana Mobile

Android / iOS 共用的独立移动客户端。角色资源、提示词、历史/记忆、表情路由和播放运行在手机；独立网关负责 DeepSeek 接入，电脑语音进程负责 SoVITS 与诊断日志。Capacitor 原生包加载随包资源，网页试用由网关的 `/` 托管。

完整部署、激活、构建和排障说明见 [本地交付说明](../../docs/MOBILE_INDEPENDENT_DELIVERY.md)。

```powershell
npm install
npm run build
npm run dev      # http://127.0.0.1:5174/ ，需同时启动独立网关
npm run cap:sync # 生成/同步 Android 与 iOS 工程
```

首次打开粘贴完整 `ayana1.…` 激活码即可自动配置网关和会话。无需填写官方 DeepSeek Key，也不依赖 Tailscale。当前局域网 HTTP 仅供可信 Wi-Fi 测试，正式跨网需 HTTPS。iOS 原生包仍需 Apple 签名。
