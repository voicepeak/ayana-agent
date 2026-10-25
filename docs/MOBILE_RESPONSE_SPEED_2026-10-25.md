# 手机首句等待与 iPhone 原生测试：build 7

## 修复

用户反馈：第一句等待较久，声音尚未开始时“思考中”已经消失，看起来像卡住。

- 模型完成与语音就绪分开反馈。尚有待播放语句时保留“正在准备语音”，不再由模型的 idle 事件直接清除等待提示。
- 按设定语言拿到首句文字即预览，在语音合成期间可阅读。预览不把语句标为已播放，不提前确认音频消费；PCM 到达后仍正常播放。
- 只预览队首语句，避免后续字幕超前。打断时已读文字保留，未展示的排队语句仍丢弃；切换话题和迟到事件继续隔离。
- iOS 原生传输也支持同样的预览，并修复取消后 DispatchWorkItem 引用未清空、阻止下一轮文字降级的问题。
- 提示模型在自然时用简洁且有实际内容的首句开场，后续完整表达；未强行截句、调整播放速度或删掉句尾。

## 测量

受控测试令模型在约 120ms 完成、音频在约 1700ms 到达：旧版约 1839ms 显示对白，新版约 196ms 显示，并在中间持续提示语音准备。音频均正常播放并且只消费一次。此测试用于复现界面等待断层，不代表模型服务延迟。

另用真实 DeepSeek / SoVITS、Chrome 手机视口，各做三轮相同合成测试题的新话题对照。用 DOM MutationObserver 记录首句可见、AudioWorklet 回执记录播放器开始，避免定位器轮询带来的时间误差：

| 中位耗时 | build 6 | build 7 |
| --- | ---: | ---: |
| 首句文字可见 | 2.541 秒 | 1.326 秒 |
| 首段 PCM 到达 | 2.539 秒 | 2.704 秒 |
| 播放器开始 | 2.540 秒 | 2.705 秒 |

首句可见等待缩短约 48%。**尚未测到声音合成本身的稳定加速**；不同采样生成的句长和语音长度会波动。测试走本机真实网关，不含手机运营商和公网中继延迟，样本量也只有三轮，不能作为实机延迟保证。此前定位器计时对照得到的 2.84→1.33 秒存在轮询误差，上表取代该口头初步结果。

本机为 Core Ultra 7 265K、CPU 版 PyTorch，没有可用的 CUDA 推理设备。对固定句子/种子测试 8、4、2 个线程，中位合成约 1696、1709、2565ms；限制性能核后 8/4 线程约 1631/1747ms。收益不稳定，保留原 8 线程配置。另测关闭极小浮点数运算的实验，中位约 2122ms，没有提速，未采用。未全局修改 CPU 调度、替换声音模型或降低音频质量。

原始记录：

- `.runtime/benchmarks/mobile-response-before/`、`mobile-response-after/`：受控等待截图与事件时间线。
- `.runtime/benchmarks/mobile-response-observer/report.json`：最终真实链路对照。
- `.runtime/benchmarks/mobile-tts-threads/`、`mobile-tts-performance-cores/`：CPU 配置对比。

## 回归与交付

- 17 项状态/字素/首句排队测试通过，包含模型 idle 后仍保留等待提示、预览后仍可播放、预览取消保留已读文字、后续语句不抢先显示。
- 浏览器运行时 13 项、12 轮模拟网关、5 种尺寸通过；排版压力 39 场景通过，首次访问离线重载通过。
- Android build 7 已构建，回读确认随包 JS/CSS 与最终构建一致，签名校验通过。
- iOS Release / Simulator 编译与回归通过：[Actions 40184400300](https://github.com/voicepeak/ayana-agent/actions/runs/40184400300)，代码快照 `1bd8f723`。原生报告确认提前显示、预览不消费音频、取消释放计时器、下一轮文字成功展示；15 页原生字幕输出完整。先前模拟器断言未主动读取启动时缓冲事件，已修正测试并重跑通过。仍未把这些结果当成实机验收。

iPhone 测试按 1 位用户准备独立账号，激活码仅存于本机交付目录，不进入源码或 CI。安装和测试步骤见 [原生测试说明](MOBILE_IOS_TEST_2026-10-25.md)。未签名 IPA 需由测试者使用自己的 Apple Account 签名安装；本轮没有代登 Apple 账号或发布 TestFlight。

## 复验

```powershell
npm --prefix apps/mobile test
npm --prefix apps/mobile run build

# 开发服务器运行时，检查模型结束但音频延迟的场景
node scripts/verify_mobile_first_response.mjs --playwright-root <node_modules目录> --browser <chrome.exe路径> --strict

# 固定种子、句子，比较 CPU 线程；不修改在线服务配置
D:\ayana-voice\venv\Scripts\python.exe scripts/benchmark_mobile_tts_threads.py
```

真实对照脚本为 `scripts/benchmark_mobile_response.mjs`：旧版静态资源监听 4176，新版监听 4175，使用 `AYANA_LATENCY_ACTIVATION` 传入独立临时测试码；运行结束撤销测试用户。激活请求做跨端口测试适配，模型、音频和消费回执走真实 WebSocket。不要在命令行或日志中打印激活凭据。
