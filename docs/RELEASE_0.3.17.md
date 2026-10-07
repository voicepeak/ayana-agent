# Ayana 0.3.17 · 连续对话与个人记忆

2026-10-07 本机构建，未上传远程发布。

## 改动

- 日常直接连续聊天，回复后在后台提前整理较早上下文，保留完整本机记录。
- 根据明确的用户原话整理个人记忆，跨对话携带；提供来源、修改、忘记和自动记忆开关。
- 新的「对话与记忆」管理页：全文搜索、日期过滤、原话定位、分页、改名、继续、删除，以及完整 Markdown / JSON 导出。
- 查看和整理旧记录不切换当前对话；删除会清理对应上下文、任务与关联记忆，保留生成文件。
- 用户编辑和忘记的记忆受到保护，异步请求不得写回已删除的对话；保存需要后端回执。
- 维护请求的模型用量另存为 `maintenance.usage`，不覆盖当前任务的用量显示。

行为与容量说明见 [连续对话与对话管理](CONTINUOUS_CONVERSATION.md)。

## 验证

- Python：412 passed、8 skipped。跳过的项目依赖特定资源或环境，未计为通过。
- 桌面状态、音频、偏好保存、记忆保存回执等 Node 测试通过。
- TypeScript 检查、Vite / Electron 构建及独立 Python 后端打包验证通过。
- 开发版与实际打包内容的 Electron 检查通过：自动记忆、跨对话使用、搜索定位、分页、改名、全量导出、修改、忘记、来源跳转、重启、继续、删除、紧凑布局。
- 实际 NSIS 便携 EXE 检查通过：隔离档案、嵌入式后端连接、透明立绘窗口、独立设置窗口及正常退出。

管理流程用本机模拟模型 API 验证；没有用用户真实模型 API 声称验证记忆语义判断。打包内容的流程记录位于 `.runtime/benchmarks/conversation-manager-1791329053556/report.json`；便携启动器记录位于 `.runtime/benchmarks/portable-companion/cleanup-report.json`。

## 本机文件

`apps/desktop/release/Ayana-0.3.17-win-x64.exe`

SHA-256：`DFE92DECA7DF83BB46B040EEDC87F9E35D864FD070C08E754F594D322FEDE545`

## 本机旧历史的额外发现

对当前 `%APPDATA%/Ayana/.runtime/history.sqlite3` 做只读备份时，完整性检查报告数据库页损坏。此前使用审计记录到 189 条用户消息；普通恢复副本目前只能校验恢复 55 条，不能当作完整历史。

原库、WAL / SHM 日志、只读快照及恢复副本已单独保留在 `.runtime/history-recovery-0.3.17`，完整性检查通过的候选副本为 `candidate.sqlite3`。

2026-10-07 经用户授权退出旧版、备份关闭前后的原库并载入恢复副本，已启动实际 0.3.17 便携版。服务连接、原档案路径、模型与语音配置及对话管理页已核实；运行中的数据库完整性检查通过，包含 6 个对话和 55 条用户消息。首次安装副本启动失败后改用已校验并关闭连接的候选文件直接替换，再次验证通过。原始材料及失败副本均保留，不能视为完整历史恢复。启动验证见 `.runtime/history-recovery-0.3.17/new-version-startup.json`，运行库检查见 `live-integrity.json`，切换前备份目录见 `latest-switch-backup.txt`。

恢复采用 SQLite 的独立副本流程并校验记录类型与引用，排除损坏的 JSON；保留原始材料供继续核对。恢复结果需要另外验证，不能因为副本完整性检查通过就宣称所有历史找回。[SQLite 官方恢复说明](https://www.sqlite.org/recovery.html)
