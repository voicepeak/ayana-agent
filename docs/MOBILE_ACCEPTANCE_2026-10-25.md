# 手机回复中断修复与验收（2026-10-25）

构建源码：`035f8f5eb652fdd12f5787696acb1392439aa926`，分支 `codex/mobile-independent`。最终网关已部署，原公网地址及激活码继续有效。

## 修复

连续对话在第六轮复现重复句子 key 导致的 `invalid_speech_sequence`，此前短问候测试覆盖不足。第三次用户失败的旧日志未保存原始响应，不能反推该条 `invalid_model_format` 的唯一原因。

- 统一处理旧手机历史、缺失/重复编号、日语分句、内嵌字幕及延迟字幕。重复编号且字幕集中后发时，按语句顺序关联。
- 正常对话只有一次主模型请求。格式错误最多追加一次无工具的格式修复，只处理未提交内容，不重新朗读已提交语句。字幕补全验证日语未改写，修复结果整批校验后提交。
- 真实断流、超时、token 截断及未知工具请求仍明确报错，不伪报成功。主模型流有整体超时。
- 本机失败日志保存最多 12000 字符的模型响应片段，官方 Key/Worker 凭据脱敏；原文不发送到手机或公共 Issue。成功修复另记 `model.repaired`。
- 手机立绘缓存按实际资源地址区分角色，角色/服装切换重新加载，避免旧图片或已撤销的 blob URL。
- 修复共享 TTS 进程快速退出时，首次 stdin 写入失败掩盖进程退出原因的竞态。

手机继续负责上下文、人格、记忆、立绘、字幕与播放，不启动桌面 AgentRuntime。按之前选定的本地网关方式，电脑目前临时承载鉴权与 DeepSeek 转发，尚未迁移到云网关。

## 最终验收

真实模型/语音测试通过公网 HTTPS/WSS，浏览器模拟手机视口，关闭本机系统代理。

| 验收项 | 结果 |
| --- | --- |
| 当前工作区 Python 全量回归 | **449 通过，5 跳过，无失败** |
| 手机模型、接入、语音专项 | **59 通过**，覆盖逐字符流、修复边界、字幕、鉴权、隔离、取消及背压 |
| 彩名最终连续对话与恢复 | **16 轮完成、1 轮主动取消，26 段音频/字幕**，无失败结束事件 |
| 另一角色最终客户端复验 | **4 轮完成、1 轮主动取消，6 段音频/字幕**；此前另通过该角色 14 轮连续对话 |
| 异常格式 → 模型修复 → SoVITS | **5 组通过，11 段音频/字幕，3 次真实格式修复**，PCM 逐包非静音检查通过 |
| 本地状态与恢复 | 打断后继续、WSS 重连、凭据刷新、新话题隔离、角色/称呼/记忆持久化、换角色后断网重载通过 |
| 播放与字幕 | 检查每句字幕关联，并等待所有音频到达及播放完成回执，不把模型 idle 当成播放完成 |
| TypeScript/Vite、Android Gradle | 通过；APK **versionCode 3**，v2 签名校验通过 |
| APK 内容 | 包内资源逐一与验收 dist 比较一致，内置 **288 张**立绘，ZIP 完整性通过 |
| iOS 云构建 | [Mac 构建成功](https://github.com/voicepeak/ayana-agent/actions/runs/40114138271)，arm64、iOS 15+；主 JS 与最终 dist 一致，288 张立绘、ZIP/云端 SHA 校验通过 |

五组异常场景：纯日语正文、重复编号且内嵌字幕、重复编号且字幕集中后发、超长单句、前句缺字幕且后句无效。确定性测试另覆盖损坏 JSON、不递归重试、不重放前缀和字幕不能改写原日语。

最终彩名连续验收第一轮两段音频约 2.94/4.00 秒到达，这是具体测试记录，不是手机运营商或端到端延迟保证。

此前网页离线测试的缓存断言误用了 `blob:` 地址，本轮改查实际图片地址，并修复角色切换的缓存身份问题。最终两个角色断网重载均通过；不代表所有未访问网页图片均已缓存。原生 APK 自带全部立绘。

## 交付

- Android：`release/mobile/Ayana-0.2.0-android-build3.apk`，与 `Ayana-0.2.0-android.apk` 字节相同。SHA256：`01e5e1ed58a83bd2e15c2f5d84dc898913466a0beb810fe8f8892efd10c25afa`。
- iOS：`release/mobile/Ayana-0.2.0-ios-unsigned.ipa`，SHA256：`e5326b2ce5e36aebc0d3986e2a0c9f2d9fa3fc55cd31a48d4a4dde5fa9ac968a`。普通 iPhone 仍需 Apple 签名。
- 同目录包含 iOS 工程、网页包、校验清单及 `IOS_BUILD_INFO.json`。

服务端修复覆盖旧安卓包；build 3 另含手机立绘缓存修复。原激活码继续使用，同包名同签名覆盖更新。

## 复验命令

```powershell
.venv\Scripts\python.exe -m pytest -q
node scripts/test_mobile_model_history.mjs
node scripts/verify_mobile_independent.mjs --playwright-root <playwright-core所在目录> --url https://<公网网关>/ --direct --stress --recovery
node scripts/verify_mobile_independent.mjs --playwright-root <playwright-core所在目录> --url https://<公网网关>/ --direct --character ayana-su --recovery
.venv\Scripts\python.exe -m scripts.verify_mobile_recovery
```

最后一条命令创建临时专用用户并在结束时撤销，实际调用模型和语音。报告/对话原文保留在被 Git 忽略的 `.runtime`，不进入公开提交或安装包。

## 尚未完成实机验收

没有连接 Android/iPhone 实机，主机未启用虚拟化。原生安全存储、实际扬声器听感、后台/锁屏及蜂窝网络实测未完成；未签名 IPA 不能直接安装。STT、搜索、完整桌面工具与云网关尚未实现，麦克风保持禁用。五项跳过测试未算作通过。
