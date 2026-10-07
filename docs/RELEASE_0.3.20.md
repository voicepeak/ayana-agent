# 0.3.20：中断工具死循环，收拢等待卡片

## 工具不再原地反复

聊天里的桌面观察工具（`windows.list`、`windows.select`、`capture_target`、`observe_controls`）此前可能在结果不变的情况下被反复调用，直到「任务工具往返已达到上限」，例如要求打开网页却一直截图核对。运行时现在按调用签名记录只读观察的结果摘要：忽略 `snapshot_id`、时间戳等易变字段后，如果同一个调用第二次返回完全相同的信息，就不再执行，而是作为 `repeated_no_progress` 回灌给模型，并明确要求停止重复、改用其他方法或如实报告受阻。真正发生变化（例如页面标题更新）仍会正常返回。

工作策略同步补充：用户只是要求打开或展示网页/窗口时，确认到匹配的可见标题即可报告完成，不要反复截图；同一个只读观察返回相同结果时不重复、改策略或报告真实阻塞。

## 等待卡片只在工具执行时出现

`在终之空游荡中...` 卡片现在只在确实有工具调用运行、且等待状态成立时显示，用于避免慢调用看起来像卡死；思考、准备语音、整理结果等其他等待恢复为原来安静的小点动画。卡片去掉了计时器与 30 秒提示，只保留固定标题、当前工作状态和停止按钮。

## 验证

- Python 回归：`432 passed, 8 skipped`。新增 `test_repeated_observation_without_new_information_breaks_the_loop` 与 `test_repeated_read_digest_ignores_volatile_fields_and_counts_no_progress`。
- 桌面：`npm --prefix apps/desktop run typecheck` 与 `npm --prefix apps/desktop test` 全部通过。
- 本机便携包：`apps/desktop/release/Ayana-0.3.20-win-x64.exe`（254,404,108 字节，2026-10-07 打包），SHA-256：`3FBD1EBA8C78F570BDAE8186C534FDF1DC9E33B44C40ECE59015D2B42A1CC9E5`。

保留 0.3.19 的聊天窗口对话切换、0.3.18 的工具恢复修复，以及 0.3.17 的连续对话、个人记忆与历史管理功能。
