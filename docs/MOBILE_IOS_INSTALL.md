# iPhone 安装：云构建 IPA + Windows 免费签名

2026-10-24。云端 Mac 负责 Xcode 编译，用户无需拥有 Mac；普通 iPhone 安装前仍需要 Apple 签名。未签名 IPA 与已安装可运行应用是两个不同交付状态。

## Windows 上签名安装

可使用 [Sideloadly 官网](https://sideloadly.io/) 的 Windows 版本，使用自己的免费 Apple Account 给自己的设备签名安装。以下是依据官方说明准备的操作路线，本项目尚未完成 iPhone 实机安装验证。

1. 从 `release/mobile/` 取得构建成功的 `Ayana-0.2.0-ios-unsigned.ipa`，并核对同目录 SHA256 清单。
2. 按 Sideloadly 官网的要求安装 Windows 版本及 Apple 设备驱动/组件。连接 iPhone USB 数据线，在手机上确认信任此电脑。
3. 在 Sideloadly 选择自己的 iPhone，将 IPA 拖入程序，使用自己的 Apple Account 完成签名和安装。密码及验证码只在自己操作的登录流程中输入，不发送到聊天、Issue 或仓库。
4. 按系统提示信任开发者。iOS 16 及以上如果提示开发者模式，可在“设置 → 隐私与安全 → 开发者模式”按提示启用；开发者信任入口通常在“设置 → 通用 → VPN 与设备管理”。[Sideloadly 安装与故障说明](https://sideloadly.io/faq)
5. 打开 Ayana，粘贴电脑最新生成的完整 `ayana1.…` 公网激活码，即可使用手机流量或其他 Wi-Fi；手机无需安装 Tailscale，电脑需保持在线。如果仍使用旧局域网激活码，请先退出激活再粘贴新码；本地历史保留。

免费账户的开发描述文件 7 天过期，需重新签名；官方工具提供自动续签选项，需要满足其电脑与设备连接条件。保留相同 Apple Account 和 Bundle ID 覆盖更新，有助于保留手机本地数据；不要先卸载应用。本项目尚无历史导出功能。[Sideloadly FAQ](https://sideloadly.io/faq)、[Apple Personal Team 限制](https://developer.apple.com/help/account/basics/about-your-developer-account)

这条路线省去自己购买 Mac 和先付开发者年费的要求，仍然使用有效签名。未验证任何永久免签、越狱或证书绕过方案；没有把 Apple 凭据交给 GitHub 构建。

## 已有 Mac 时

使用 Xcode 26+ 打开 `apps/mobile/ios/App/App.xcodeproj`，选择 App 的 Signing & Capabilities，选自己的 Personal Team 和唯一 Bundle ID，再连接 iPhone 运行。也可依照 [构建说明](MOBILE_INDEPENDENT_DELIVERY.md) 使用 `APPLE_TEAM_ID`、`IOS_DEVICE_ID` 和脚本自动构建开发签名版本。

## 尚需实机确认

Keychain 凭据读写、实际音频设备播放、后台/锁屏、断线恢复和手机 Wi-Fi/蜂窝延迟都需在目标 iPhone 验证。公网链路已由独立云主机完成真实模型与双句音频测试；构建成功仍不能代替这些实机项目。
