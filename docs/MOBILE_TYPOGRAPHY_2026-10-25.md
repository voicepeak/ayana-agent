# 手机端字体与排版专项复核：build 6

本轮继续保留黑 Ayana 限制，沿用电脑端便签的配色、立绘取景和控制栏。没有把编译通过视为界面验收；先用长文本复现，再逐张查看截图并修正。

## 复现与修复

| 复现的问题 | 修改 |
| --- | --- |
| 长话题名、连续英文和网址将主界面网格撑宽，右侧文字和发送按钮被裁掉 | 主网格明确使用 `minmax(0, 1fr)`，子项允许收缩，正文与地址在卡片内换行，标题省略显示 |
| 多层样式重复覆盖、混用字体；部分说明只有 8–11px，历史与实时对白大小不一致 | 整理样式与字体回退；常规正文 17px、用户消息/输入 16px、译文 13px、提示至少 12px，使用 rem 随基础字号缩放 |
| 日文与中文共用不合适的字体；英文缺失回退中文后仍标为英文 | 按实际内容语言设置 lang，日文字体独立回退；英文缺失时按中文/日文实际内容标记 |
| 逐字显示把组合音标、国旗、肤色与家庭 emoji 拆开 | 使用 Intl.Segmenter 按字素分段，并增加组合字符回归 |
| 260×300 悬浮便签直接截掉长对白与翻译 | 提供“展开全文”，阅读区独立滚动，保留双语、输入与返回入口；阅读时关闭逐字闪动 |
| 多行悬浮输入不能完整显示；键盘压缩高度后首行也被裁切 | 输入按内容增高并设上限，小高度时收紧对白内部留白 |
| 200% 字号时设置字段挤压、提示撑宽、断线信息覆盖标题或对话 | 字段改为自适应列，提示允许换行；连接提示进入正常布局，标题区域实测高度驱动立绘和提示位置 |
| 改变窗口大小或输入区高度后，最新消息底部可能被裁切 | 观察可视区和内容尺寸；跟随最新时维护底部，手动查看旧消息时保留阅读位置 |
| 文本箭头、关闭和缩放符号因字体造成大小、基线差异 | 统一为 SVG 控制图标 |
| 只有一个可选角色却保留不可用下拉框 | 显示静态角色信息“彩名 · 黑制服”，保留黑 Ayana 服装选择 |
| iOS 原生画中画固定文本框以省略号截断长句，短句留白过多 | TextKit 按真实字体分页；主文 48、译文 36（960×640 渲染坐标），完整保留字符；卡片按当前页内容收紧，显示页码，随播放进度或静态阅读时间翻页 |

## 已执行的检查

- 严格排版检查 39 个场景通过，另有 2 张激活页字号截图。主界面覆盖 320×568、390×844、430×932、844×390；悬浮窗覆盖 260×300 至 390×520，以及 340×250 键盘压缩高度。
- 检查 8 种主题、长中文/日文、无空格英文网址、多行输入、长话题名、150% 和 200% 基础字号；检查完整阅读尾部、设置语言/记忆、断线提示。
- 主动向上阅读后改变尺寸，阅读位置没有被拉回；“回到最新”恢复底部。
- 浏览器回读正文实际字重 400，Windows 下中文为 Microsoft YaHei UI、日文为 Yu Gothic UI。iOS/Android 使用各自可用的字体回退，未捆绑 Windows 字体。
- 8 个预设主题在背景上的辅助文字对比度约 4.82–6.77；逐张查看深浅色界面。
- TypeScript/Vite 生产构建通过；前端状态和字符分段 13 项测试通过。
- 模拟网关回归 12 轮、13 项本地运行时检查、5 种尺寸通过；生产 PWA 首次访问后离线重载通过，包含草稿、立绘与设置。
- Android build 6 debug APK 构建通过，使用随包前端资源。

排版截图和机器报告：`.runtime/benchmarks/mobile-typography-final/`。该报告检查横向越界、主要容器范围和过小提示字号，并不能自动判断所有视觉细节，因此同时进行了截图复核。

## iOS 原生检查

在 Mac/Xcode 26 上编译 Release 包和 Simulator Debug 包，使用**生产画中画渲染器**输出 960×640 原图与 240×160 缩小图。覆盖短句、长中日双语、连续英文地址、日文主文、仅主文；断言分页前后文本完整一致，页边界没有拆开组合字符。首轮截图发现小窗译文偏小、短句卡片留白过多，已据此进行第二轮调整。

第二轮构建与截图记录：[Actions 40171489615](https://github.com/voicepeak/ayana-agent/actions/runs/40171489615)，代码快照 `e3e6ede16ad20c110a4e5875902a6a99df67e7f9`。第二轮 Release / Simulator 构建成功；5 类文本共 15 页、30 张原图/缩小图输出成功，已复核分页中间和末页，未见文本裁切。截图与原生报告保存在 `.runtime/benchmarks/mobile-ios-typography-final/`。APK 已核对 versionCode 6、debug 签名与随包前端文件；IPA 的 CFBundleVersion 6、CI SHA256、发布 JS/CSS 与仅黑 Ayana 的原生清单均已回读校验，与本机最终构建一致。11 个前端文件中仅主源映射内 SpeechLine.tsx 的 CRLF/LF 换行不同，规范化后内容一致。交付为 `release/mobile/Ayana-0.2.0-android-build6.apk`、`Ayana-0.2.0-ios-build6-unsigned.ipa`；iOS 包仍需签名，哈希位于同目录的 `SHA256SUMS-0.2.0.txt`。

## 验证边界

本轮没有连接 Android 或 iPhone 实机。网页截图和 iOS 原生绘制截图已覆盖上述字体、换行和裁切场景；系统字体设置、厂商 WebView、真实软键盘、安全区、系统画中画控件、后台与音频路由仍需实机复核。这些项目没有标为验收通过。

## 复验

```powershell
npm --prefix apps/mobile test
npm --prefix apps/mobile run build

# 先启动开发服务器
node scripts/audit_mobile_layout.mjs --playwright-root <node_modules目录> --browser <chrome.exe路径> --strict
node scripts/verify_mobile_ui.mjs --playwright-root <node_modules目录> --browser <chrome.exe路径>

# 生产 PWA，先启动 4175 端口的 preview
node scripts/verify_mobile_offline.mjs --playwright-root <node_modules目录> --browser <chrome.exe路径>
```

Mac 上先运行 `bash scripts/build_mobile_ios.sh`，再运行 `bash scripts/audit_mobile_ios.sh` 获取原生布局截图。
