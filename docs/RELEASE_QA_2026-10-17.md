# Ayana 0.3.24 发布前测试

测试日期：2026-10-17（Asia/Shanghai）。测试对象为当前工作区、`win-unpacked/Ayana.exe` 和实际便携启动器 `Ayana-0.3.24-win-x64.exe`。仓库 HEAD 为 `cd30a11`，工作区已有未提交变更，因此结果针对本机文件内容，不等同于该提交单独构建的结果。

**以下保留 0.3.24 的初次测试结论；后续修复与复测见 [0.3.25 修复记录](D:/ayana-agent/docs/RELEASE_0.3.25.md)。** 初次发布建议为先处理下列四项问题，再生成发布候选包并复测。正常聊天、语音、记录管理和多数并发路径通过，但专项测试复现了三处状态/资源问题，随包 SHA256 也已失配。初次测试只添加测试和修复测试脚本。

## 已复现问题

### 1. 发布文件与 SHA256 清单不一致

对象：`apps/desktop/release/Ayana-0.3.24-win-x64.exe`（266,142,982 bytes）。

- `SHA256SUMS-0.3.24.txt` 中的预期值：`b72fc0390920dc9a0634e6aabac35d66775526cd912ba6f4aec674364308593f`
- 当前 EXE 的实际值：`60fc6cb68d20d097add4a1fcf910dcc014ab2ba2cf6096e52f7a0554444be39d`
- 结果：按照当前清单验证当前 EXE 必然失败。此结果证明发布材料不一致，不证明文件遭到篡改。
- 建议：完成修复后生成唯一发布候选包，在构建结束时自动生成并验证校验清单；发布材料冻结后再做最后验收。

复现：

```powershell
Get-FileHash apps/desktop/release/Ayana-0.3.24-win-x64.exe -Algorithm SHA256
Get-Content apps/desktop/release/SHA256SUMS-0.3.24.txt
```

### 2. 退出与在途命令并发，会访问已关闭数据库（P2）

位置：`services/agent/runtime.py` 中 `handle()`（约 222 行）、`close()` / `_close()`（约 923–956 行）。

- 条件：`turn.start` 已进入命令锁，在等待语音取消；另一条任务执行 `close()` 并关闭 SQLite；原命令随后恢复。
- 实测：原命令抛出 `sqlite3.ProgrammingError: Cannot operate on a closed database.`
- 原因：命令使用 `command_lock`，关闭使用独立的 `close_lock`，二者没有协调；`closed` 直到关闭末尾才置位。
- 范围：开发源码和发布包内的独立 Python/后端均复现。用可控取消屏障强制构造交错顺序，未测得自然操作下发生概率，也未观察到数据库损坏。
- 建议：关闭开始时拒绝新命令，协调正在执行的命令、后台写入与数据库关闭的顺序，并让 WebSocket 退出路径能处理运行时已关闭的情况。
- 复现探针：`close_during_command`。

### 3. 播放结束后，迟到进度回执会倒退状态和进度（P2）

位置：`services/agent/runtime.py` 的 `_receipt()`（约 342–370 行）。

- 注入顺序：相同 utterance/generation 先收到 `playback.ended`，`played_samples=1600`，再收到 `playback.progress`，`played_samples=800`。
- 预期：已完成的语句保持完成，消费进度不倒退。
- 实测：内存记录从 `played` 变回 `playing`，采样数退回 800；该回执还会发送给持久化层。
- 范围：源码和打包后端均复现。这是定向乱序注入，并不表示正常单连接 WebSocket 自身会重排消息；正常语音测试通过。
- 建议：约束播放状态迁移，保护终态，使采样数单调递增，并对重复/迟到回执做幂等处理；允许合法的取消补记。
- 复现探针：`duplicate_playback_receipts`。

### 4. WebSocket 断线后，发送任务和队列没有及时释放（P2）

位置：`services/agent/server.py` 的 WebSocket `finally`（约 96–99 行），以及 `services/agent/runtime.py` 的 `_send_events()`（约 137–156 行）。

- 条件：已连接的客户端完成接收后正常关闭，发送任务此时等待空队列。
- 实测：16 个真实 WebSocket 客户端，加上一个超限请求测试连接，全部断开后仍有 **17 个 `client_senders` 和 17 个 `client_queues`**。
- 原因：断线只从 `clients` 移除连接；没有唤醒或取消等待 `queue.get()` 的发送任务。它的 `finally` 因而没有执行。
- 影响：同一后端进程多次断线重连时，任务和对象引用会累积；完整关闭后端时才统一释放。本次没有做长时间内存曲线测试。
- 建议：提供统一断开清理流程，取消并等待该连接的 sender，移除队列，避免和 sender 自身清理重复竞争。
- 范围：源码直接探针、发布后端真实网络测试均复现。
- 复现探针：`disconnected_client_cleanup`，以及 `network_load` 的断线后任务计数。

## 通过的测试与测量

| 类别 | 覆盖与结果 |
| --- | --- |
| Python 基线 | `pytest -q`：327 passed，5 skipped，36.51s。一个 Starlette/httpx 弃用警告。 |
| 跳过项补测 | 在真实音色 Python 中运行语义解码、句尾释放和 PCM 检查：10 项通过；显式开启本地 STT 集成测试：1 项通过。覆盖了基线因 numpy/torch 环境及开关而跳过的路径。 |
| 桌面静态验证 | `npm test`、TypeScript 类型检查、Vite 生产构建和 Electron 主进程构建全部通过。 |
| 发送竞争 | 100 个并发 `turn.start`，最终只有当前 generation 的有效语音记录，没有遗留有效旧语句。 |
| 设置竞争 | 200 次并发保存全部有唯一关联回执，磁盘内容与内存一致，嵌套设置字段得到保留。 |
| 对话竞争 | 30 次并发创建，混合 20 次删除和 20 次发送，删除结果正确，SQLite `integrity_check=ok`。 |
| 慢客户端 | 广播 500 条事件，阻塞客户端被淘汰，健康客户端完整收到 500 条，慢连接的 sender/queue 释放。正常断线的遗漏见问题 4。 |
| 真网络并发 | 发布包嵌入式 Python：16 个连接、320 次并发保存，320 个回执齐全；1.951s 完成，约 164 次/秒；从发送到回执的 P50 970.2ms、P95 1841.9ms。 |
| 协议与认证 | 未认证健康检查、关闭和提示词导出拒绝访问；无令牌/不可信 Origin 的 WS 拒绝连接；非法 JSON、数组、缺少类型及空消息后连接继续服务；超过 2MiB 的消息以 1009 关闭；正常事件 seq 有序。 |
| 设置真实 UI | 设置草稿跨导航保留、嵌套资源路径保留、错误代理不写盘、外部设置变更合并、输出上限保存及刷新、窄窗保存按钮可见。 |
| 对话切换真实 UI | 列表过滤、独立草稿恢复、新建对话、模型请求期间切换并取消旧代、780/430/320px 下列表和控件边界通过。 |
| 记录与记忆真实 UI | 自动提取引用记忆、跨对话搜索、分页、非当前记录重命名、UTF-8 JSON 导出、重启恢复、修改/忘记记忆、删除后保留其他对话及导出文件通过。开发版及 win-unpacked 均执行。 |
| 观察/删除流程 | 呼出与隐藏、设置窗口打开时置顶、删除当前/非当前/最后一段对话通过；数据库清理后完整性正常，删除样本标记不残留在主数据库文件。透明窗口像素截图不可用，不能据此确认该项视觉效果。 |
| 原生生命周期 | 销毁全部真实 Electron 窗口后注入 600 条延迟 IPC，无已销毁对象访问错误，主进程正常退出。 |
| 实际语音 | win-unpacked 使用真实 GPT-SoVITS：两句完整 PCM 消费回执、可见日中字幕、播放中打断、后续新轮完整恢复，renderer 无错误。测试静音输出，不含人工听感判断。 |
| 在线模型 | 实际已配置 DeepSeek 模型：两句日语和对应中文协议输出正常；首句 1198ms，总计 1752ms。只是一轮小样本，不代表长期可用性或自然度评分。 |
| 保存故障注入 | 制造真实配置写入失败后，当前外观回滚、草稿保留、刷新不重放失败预览；重试成功、图片替换不会覆盖已保存图片、隐藏编辑器不修改实时外观、重启加载已保存配置，共 9 项通过。 |
| 发布包内容 | 抽查 54 个 Python/角色/协议源文件，与工作区内容一致；未发现 `local.json`、DPAPI、SQLite、临时文件或日志混入后端；239 个立绘 ID 均能解析到文件（234 张原图和兼容 ID）。 |

压测使用固定的本地模型与 TTS 桩，真实使用运行时、SQLite 和网络协议。上述每秒命令数不是在线大模型并发能力，也不是多用户服务容量。设置保存共用全局命令锁，批量请求会排队。

## 实际便携 EXE

独立测试 profile 启动了实际 NSIS 便携 EXE，确认透明角色窗口、独立设置窗口、配置目录、后端连接和正常退出。使用 `--repeat-launches 3` 同时启动另外三个包装器，三者均正常退出，原实例与后端保持存活，资源完整；最终退出后 staging 目录移除。全部检查通过，详见本轮 [便携版报告](D:/ayana-agent/.runtime/benchmarks/portable-companion/cleanup-report-0.3.24.json)。

## 复现与证据

核心探针：

```powershell
.\.venv\Scripts\python.exe scripts/check_release_concurrency.py

apps/desktop/release/win-unpacked/resources/python/python.exe -I -X utf8 `
  scripts/check_release_concurrency.py `
  --backend-root apps/desktop/release/win-unpacked/resources/backend
```

脚本逐项执行并汇总，发现问题时退出码为 1。每次生成独立数据目录，不依赖用户聊天记录或在线 API。`close_during_command`、`duplicate_playback_receipts`、`disconnected_client_cleanup` 当前应失败，其余专项应通过。

主要证据保存在被 Git 忽略的本地目录：

- [发布后端并发报告](D:/ayana-agent/.runtime/benchmarks/release-concurrency-1792218452145768700/report.json)
- [源码并发报告](D:/ayana-agent/.runtime/benchmarks/release-concurrency-1792218387232701900/report.json)
- [设置 UI 报告](D:/ayana-agent/.runtime/benchmarks/settings-1792218495559/report.json)
- [对话切换报告](D:/ayana-agent/.runtime/benchmarks/conversation-switcher-1792218280307/report.json)
- [发布版对话管理报告](D:/ayana-agent/.runtime/benchmarks/conversation-manager-1792218470295/report.json)
- [真实语音恢复报告](D:/ayana-agent/.runtime/benchmarks/voice-recovery-1792218257661/report.json)
- [窗口生命周期报告](D:/ayana-agent/.runtime/benchmarks/companion-lifecycle-1792218461229/report.json)
- [观察/删除报告](D:/ayana-agent/.runtime/benchmarks/attention-companion-1792218447648/report.json)
- [保存失败回滚报告](D:/ayana-agent/.runtime/design-save-rollback-qa/report.json)
- [发布内容检查](D:/ayana-agent/.runtime/benchmarks/release-payload-2026-10-17.json)
- [在线模型探测](D:/ayana-agent/.runtime/benchmarks/model.json)

本轮修复了四份回归脚本：设置页使用当前可见控件；对话选择限定到列表项避免与删除按钮同名；窗口聚焦改用 Electron API 并等待后端同步；便携脚本识别 staging 后的 Python 路径，并增加重复启动与清理验证。初跑失败中已确认属于这些脚本兼容性问题的项，不计为产品缺陷。

## 覆盖边界和再次验收要求

本轮为当前 Windows 机器上的发布前验证，未覆盖干净虚拟机、未安装 Python/Node 的全新机器、不同 Windows 版本/杀毒软件、管理员/普通用户组合、多 GPU 设备、长时间稳定性、人工语音听感、多轮在线模型质量以及所有第三方网站的联网兼容性。没有修改正在运行的个人 Ayana 配置、凭据或聊天记录。

处理四项问题后，应重新执行核心并发探针，确认所有项通过；重新构建 EXE 和校验清单；对最终 EXE 补跑实际语音、重复启动和退出清理，再以该候选包做干净机器验收。
