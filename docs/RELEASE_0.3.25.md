# Ayana 0.3.25 · 发布测试问题修复

修复日期：2026-10-17。对应 [0.3.24 发布前测试](D:/ayana-agent/docs/RELEASE_QA_2026-10-17.md) 中的四项发现。

## 修复内容

- 退出开始时设置关闭状态，拒绝新命令和新连接；在命令锁内等待在途命令完成，再取消后台工作、释放服务与关闭 SQLite。关闭数据库与事件写入使用同一持久化锁，关闭后的迟到事件不再写盘。关闭期间不再安排新的观察、记忆或摘要工作。
- 播放完成后保留终态，忽略迟到的开始、进度、取消和错误回执；消费样本数保持单调。中断后仍接收合法的最终取消回执，补记实际消费进度。
- WebSocket 断开统一调用清理流程，取消并等待发送任务，移除队列。最后一个客户端离开时，在命令锁下确认没有新连接且未在关闭，再取消当前生成。关闭中的连接返回 1001。
- 打包成功后读取最终 EXE，流式计算 SHA256 并原子更新同版本清单；重打同一版本也会刷新清单。原 0.3.24 EXE 的清单亦已按现有文件纠正。

版本号统一更新为 0.3.25，包括桌面 package、lockfile 根项、Python 项目与 README 的本机交付路径。未执行对外发布。

## 源码和后端验证

- `pytest -q`：**332 passed，5 skipped**。原先因环境和开关跳过的路径在相应环境补测：音色 Python 的语义/PCM 检查 10 项通过、本地 STT 集成 1 项通过。
- `npm test`、类型检查、Vite 与 Electron 生产构建通过。新增校验和测试验证同版本重建后清单更新，其他版本文件不混入。
- 新增 5 项后端回归覆盖关闭与在途/排队命令、关闭期间连接拒绝、真实 HTTP/WS 关闭、断线释放、播放进度与终态，以及中断后最终消费回执。
- [源码并发专项](D:/ayana-agent/.runtime/benchmarks/release-concurrency-1792218839868326200/report.json)：8/8 通过。
- [发布后端并发专项](D:/ayana-agent/.runtime/benchmarks/release-concurrency-1792219054972201300/report.json)：8/8 通过。100 次并发发送、200 次并发设置保存、30 次创建混合 20 次删除与 20 次发送、500 条慢客户端广播均通过；16 个真实 WS 连接提交的 320 次保存全部收到回执，SQLite 完整性正常。全部断线后发送任务和队列均为 **0**。
- 新包后端受检的 54 个源文件与当前工作区一致，无源码遗漏。

并发压测使用固定模型和语音桩；不代表在线模型吞吐量。新包压测与资源压缩同时执行，耗时不用于性能基线比较。

## 发布包验收

- [Ayana-0.3.25-win-x64.exe](D:/ayana-agent/apps/desktop/release/Ayana-0.3.25-win-x64.exe)，266,131,339 bytes。
- [SHA256SUMS-0.3.25.txt](D:/ayana-agent/apps/desktop/release/SHA256SUMS-0.3.25.txt)，已按实际 EXE 核对一致。
- SHA256：`f799a2f85fd0f7cc4f46c876f10d8be21a50f79f7bd46a2dc858e6c5eaa3ea26`。
- [真实语音回归](D:/ayana-agent/.runtime/benchmarks/voice-recovery-1792219268062/report.json)：新包 GPT-SoVITS 两句完整播放、日中字幕、播放中打断及下一轮恢复通过，无 renderer 错误。静音输出的消费回执验证，不包含人工听感判断。
- [记录与记忆管理](D:/ayana-agent/.runtime/benchmarks/conversation-manager-1792219314684/report.json)：新包搜索、分页、重命名、导出、记忆编辑/忘记、服务重启恢复和对话删除通过。
- [窗口生命周期](D:/ayana-agent/.runtime/benchmarks/companion-lifecycle-1792219322281/report.json)：销毁所有窗口后的 600 条迟到 IPC 无错误，正常退出。
- [实际 NSIS 便携启动器](D:/ayana-agent/.runtime/benchmarks/portable-companion/cleanup-report-0.3.25.json)：透明角色窗口、独立设置窗口、同时另外启动三个包装器、原实例和后端资源保留、最终正常退出与 staging 目录移除全部通过，无错误。

[文件校验记录](D:/ayana-agent/.runtime/benchmarks/release-0.3.25-artifact.json)。本机仍运行的 0.3.24 个人实例、配置与聊天记录未被修改；使用修复版前需自行退出旧版，再启动新 EXE。

## 主要回归入口

```powershell
.\.venv\Scripts\python.exe -m pytest -q
npm --prefix apps/desktop test
.\.venv\Scripts\python.exe scripts/check_release_concurrency.py

apps/desktop/release/win-unpacked/resources/python/python.exe -I -B -X utf8 `
  scripts/check_release_concurrency.py `
  --backend-root apps/desktop/release/win-unpacked/resources/backend
```

测试对象为本机当前工作区和生成的发布文件。干净虚拟机、其他 Windows/杀毒软件组合、长时间稳定性和人工语音听感的覆盖边界沿用初次报告，不能将本轮通过理解为所有环境的保证。
