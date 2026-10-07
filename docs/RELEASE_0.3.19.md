# 0.3.19：直接在聊天窗口切换对话

聊天窗口顶部显示当前对话名称，点开即可搜索标题与最近消息、切换已有对话或新建。日常切换始终留在彩名便签内。

每段对话尚未发送的输入各自保留在本次运行中；发送后清除对应草稿。切换等待后端确认，失败时显示原因；选择当前对话只收起列表。切换其他对话会停止当前任务与语音，再恢复选中对话的记录。

列表支持滚动、键盘操作、Escape 关闭并返回入口、点击外部收起，以及窄窗口布局。便签使用不可滚动的裁切，避免控件聚焦时装饰背景溢出造成整个窗口内容横向偏移。详细搜索、导出与个人记忆整理仍可从更多操作进入。

验证采用独立个人档案及本机模拟模型 API，覆盖直接切换、搜索不更换当前对话、输入草稿、新建、已发送草稿清除、任务中途取消、设置窗口保持关闭，以及 780 / 430 / 320 像素的窗口布局。复验：

```powershell
npm --prefix apps/desktop run build
npm --prefix apps/desktop test
node scripts/verify_conversation_switcher.mjs --playwright-root '<已有 Playwright 的 Node 包目录>'
node scripts/verify_conversation_switcher.mjs --packaged 'D:/ayana-agent/apps/desktop/release/win-unpacked/Ayana.exe' --playwright-root '<已有 Playwright 的 Node 包目录>'
```

开发版与实际 `win-unpacked/Ayana.exe` 均通过上述五项断言；最终打包版报告见 `.runtime/benchmarks/conversation-switcher-1791332613728/report.json`，0.3.18 的打包版工具恢复检查见 `.runtime/benchmarks/tool-recovery-1791332623217/report.json`。Python `430 passed, 8 skipped`，桌面 Node 测试全部通过。`verify_tool_recovery.mjs` 与 `verify_conversation_switcher.mjs` 可分别以 `--packaged 'D:/ayana-agent/apps/desktop/release/win-unpacked/Ayana.exe'` 复验。

本机便携包：`apps/desktop/release/Ayana-0.3.19-win-x64.exe`（254,415,992 字节，2026-10-07 重新打包），SHA-256：`B43AA4AE4AC93E4E7D7AEB8534B0EC3EBF7731F48B009C38D0A875294B90E143`。保留 0.3.18 的工具恢复修复及 0.3.17 的连续对话、个人记忆与历史管理功能。没有公开发布。
