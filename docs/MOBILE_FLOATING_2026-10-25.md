# 手机悬浮陪伴与画中画：build 5

2026-10-25。本轮只启用 **黑制服 Ayana**。白 Ayana 的选择入口已禁用；加载旧设置或收到角色切换命令时，手机客户端统一恢复黑 Ayana，历史文字不删除。原生画中画的角色清单和图片加载也限定黑 Ayana。

## 使用

安装 Android build 5，进入「菜单 → 随身陪伴 → 开启悬浮陪伴」。首次开启会打开系统的「显示在其他应用上层」权限页，返回后显示便签。拖动标题栏移动，松手贴边；右下角拖动缩放；「−」收成小立绘，点击展开；「↗」返回完整聊天；「×」关闭并打断本轮。系统通知也提供返回和关闭入口。

iOS 进入「菜单 → 随身陪伴 → 开启画中画」。系统小窗显示黑 Ayana、主字幕与翻译，并播放当前回复；通过系统控件暂停、恢复或返回 Ayana。输入文字仍在主界面完成。当前交付 IPA 未签名，需要按已有 iOS 安装说明签名。

浏览器的「预览悬浮便签」可体验同一布局、发送、收起和返回流程；跨应用悬浮与原生画中画使用安装包。

## 设计与运行

- 沿用桌面 `companion-frame.css` 的圆角便签、标题栏、暖色描边、对白卡片与底部输入。立绘按桌面 `portraitLayout` 的 72% 可见高度取景，显示到膝部附近；保留主题、表情、对白语言和逐字点亮。
- Android 前台服务把同一个 Capacitor WebView 移入 `TYPE_APPLICATION_OVERLAY` 窗口，返回时移回原容器。聊天运行时、IndexedDB、连接和音频播放器均不另建。服务不自动开机启动，关闭或移除任务后停止；权限被撤回时收尾。
- 悬浮窗保存大小和位置，适配屏幕旋转与小屏边界；输入时申请焦点并显示软键盘，失焦后释放，窗口范围以外可继续操作其他 App。
- iOS 使用 `AVSampleBufferDisplayLayer` / `AVPictureInPictureController` 输出立绘与字幕帧，通过原生 `URLSessionWebSocketTask` 和 `AVAudioPlayer` 接收、排队和消费 PCM。浏览器暂停期间，原生层继续处理当前回复和画面，并在回到前台时按顺序补交语义事件与播放回执。
- iOS 与前台共用一个传输入口。逐句完成即确认音频消费，音频队列最多 3 句；关闭画中画会取消当前轮次，使用系统返回入口则保留会话。原生层处理短暂断线重试与到期刷新，刷新凭据写回同一 Keychain 项。
- 主界面、悬浮便签及画中画统一使用同一 generation 取消机制。切换模式不重发消息，也不重复播放已经消费的音频。

## 验证

- TypeScript/Vite 生产构建及 12 项前端状态测试通过。
- 浏览器运行时 13 项检查、12 轮模拟网关对话与 5 种尺寸检查通过；覆盖白 Ayana 禁用、悬浮发送、唯一连接、收起展开、草稿与返回主界面的历史一致性。
- 生产 PWA 首次访问后的离线重载通过。
- Android 原生代码与 debug APK 构建通过；窗口边界的 6 项 JUnit 测试通过。当前主机的 Gradle Test Executor 因缓存 worker 类路径未能启动，因此直接使用已编译测试类与 JUnitCore 执行这 6 项测试。
- iOS 已使用项目的 GitHub Mac/Xcode 26 构建流程编译，并交付对应未签名 IPA；构建记录见 `codex/mobile-floating-pip-20261025` 分支的 Actions。
- 本轮未连接 Android/iPhone 实机。跨应用拖动与软键盘、系统画中画启停、音频路由及后台状态仍需实机确认；浏览器预览和原生编译不能代替这些验证。

## 产物与复验

`release/mobile/Ayana-0.2.0-android-build5.apk`、`Ayana-0.2.0-ios-unsigned.ipa` 和 `Ayana-0.2.0-ios-project.zip`。SHA256 位于同目录的清单。

```powershell
npm --prefix apps/mobile test
npm --prefix apps/mobile run build

# 启动 apps/mobile 开发服务器后验证主界面和悬浮便签
node scripts/verify_mobile_ui.mjs --playwright-root <node_modules目录> --browser <chrome.exe路径>

# 原生同步后构建 Android；iOS 在 Mac 上运行现有脚本
cd apps/mobile
npx cap sync
cd android
.\gradlew.bat assembleDebug
```

未迁移独立 STT，麦克风仍明确禁用。本轮没有修改桌面端的角色入口或已有个人历史。
