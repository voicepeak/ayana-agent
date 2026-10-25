# Ayana Mobile

Android / iOS 共用的独立移动客户端。角色资源、提示词、历史/记忆、表情路由和播放运行在手机；独立网关负责 DeepSeek 接入，电脑语音进程负责 SoVITS 与诊断日志。Capacitor 原生包加载随包资源，网页试用由网关的 `/` 托管。

完整部署、激活、构建和排障说明见 [本地交付说明](../../docs/MOBILE_INDEPENDENT_DELIVERY.md)。

2026-10-25 最新为 **build 6**，只启用黑制服 Ayana，在电脑端风格的悬浮便签与原生画中画基础上修复字体、长内容溢出、放大字号和长字幕裁切。专项截图与验证边界见 [字体与排版复核](../../docs/MOBILE_TYPOGRAPHY_2026-10-25.md)。悬浮入口见 [悬浮陪伴说明](../../docs/MOBILE_FLOATING_2026-10-25.md)，此前运行逻辑修复见 [检查记录](../../docs/MOBILE_UI_AUDIT_2026-10-25.md)。

```powershell
npm install
npm run build
npm test         # 前端状态与历史协议回归
npm run dev      # http://127.0.0.1:5174/ ，需同时启动独立网关
npm run cap:sync # 生成/同步 Android 与 iOS 工程
```

首次打开粘贴完整 `ayana1.…` 激活码即可自动配置网关和会话。无需填写官方 DeepSeek Key，手机无需安装 Tailscale。电脑执行 `scripts/enable_mobile_public.ps1` 后生成 HTTPS 公网激活码，支持蜂窝和其他 Wi-Fi；也可接入自行部署的 HTTPS 网关。局域网 HTTP 仅供可信 Wi-Fi 测试。iOS 原生包仍需 Apple 签名。
