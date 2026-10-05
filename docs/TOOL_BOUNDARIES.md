# 工具能力与维护边界

本批在既有 20 个工具上增加 3 个进程入口和 3 个浏览器入口，共 26 个注册工具。
实际给模型的工具集合随权限、组件、窗口、浏览器会话和备份状态变化。
添加文档格式不会增加工具数量。

| 能力 | 入口 | 负责的范围 | 实现位置 |
| --- | --- | --- | --- |
| 本机文件 | files.read/list/find/search | 授权路径、分页、来源位置、扫描覆盖范围 | tools/text_reader.py、traversal.py、documents.py |
| 文本写入 | files.create/propose_edit/propose_restore | 内容校验、冲突检测、备份、现有确认机制 | tools/files.py |
| 短命令 | shell.run | 一次命令的退出码和限量输出；结束时清理子进程 | tools/shell.py |
| 后台进程 | process.start/status/stop | 持续运行、增量日志、真实进程 ID、进程树清理 | tools/processes.py |
| 资料检索 | web.search/fetch | 公网搜索与正文读取 | tools/web.py |
| 默认浏览器 | web.open | 在系统默认浏览器打开用户网址 | tools/system.py |
| 网页交互 | browser.open/observe/act | 受管理浏览器中的 DOM、表单、框架和实际页面观察 | tools/browser.py、browser_dom.py |
| 系统入口 | apps.*、files.open、windows.* | 应用发现、指定应用打开文件、可信窗口选择 | tools/system.py、原生 Windows 适配器 |
| 桌面任务 | computer.run、desktop.step | 绑定窗口的整体任务与基于新截图的单步操作 | computer_use.py、原生桌面适配器 |

## 分页规则

文本大于 64 KiB 时自动分段，指定 start_line 可以定位后半段。
有 next_cursor 时，保持 root_id/path（搜索还需保持 query 等参数），用 cursor 继续。
游标绑定实际路径、权限上下文及文件版本；改动后重新读取。
长行返回 start_column/ends_mid_line，UTF-8 字符及 CRLF 不会因分块损坏。
小型完整 UTF-8 文本保留原始换行及完整 sha256；大文件片段不提供编辑哈希。

目录、文件名和内容搜索使用有时限的扫描会话；一页不是全部结果。
next_cursor 可跨越扫描预算继续，scan_complete 表示扫描是否完整。
无法读取的目录、深度限制、预算等通过 truncation_reason 区分。
扫描会话最多 32 个，空闲 5 分钟过期；当前任务取消或新一轮开始时释放句柄。
文本游标有效期为 10 分钟，续读时仍重新检查路径权限和版本。

## 文档读取

files.read 通过扩展名选择解析器，使用 start_unit/max_units 和 cursor 分段：

| 格式 | 单元及出处 | 限制 |
| --- | --- | --- |
| PDF | 页码 | 空白或无可提取文本页标记 requires_ocr；加密文件需先解锁 |
| DOCX | 正文段落、表格行 | 读取正文，暂不包含页眉、页脚、批注及修订解释 |
| XLSX | 工作表名、单元格地址 | 返回已有值、类型及公式；不会执行宏或重新计算公式，日期等原始数值不自动解释 |
| PPTX | 实际演示顺序中的幻灯片 | 读取幻灯片文字，暂不解析图片、备注或动画 |

文档不产生可用于文本覆盖写入的 sha256。
解析器运行在独立进程中：文件/压缩包展开体积有上限，解析最多 15 秒，内存最多 768 MiB。
取消读取会停止解析进程。扩展格式应添加适配器，不新增同义工具。

## 执行回执与错误

每个模型工具结果都有 receipt：execution、verification、scope、code、message、retryable、audience。
保留具体结果数据，因此已有任务证据的 JSON pointer 仍然有效。
回执限定证据的含义：命令正常结束、应用窗口出现、后台进程运行，分别只证明对应事实。
用户目标是否完成，继续由任务完成条件和实际工具证据核对。

工具错误通过正常结果循环交给 Ayana 解释、恢复或报告阻塞，取消信号继续传播。
普通对话不把工具错误转成全局红色报错；命令技术记录默认折叠。
模型或语音服务本身不可用等运行时故障仍保留现有服务反馈机制。

## 进程与浏览器生命周期

后台进程最多同时运行 4 个，最多保留 24 条记录，日志采用有界环形缓冲。
process.status 不带 ID 列表；带 ID 获取日志，后续使用 next_log_cursor。
日志丢失有 logs_truncated 标记；has_more_logs 表示本次还没读完。
相同命令和 cwd 的运行进程会复用；stdin 为关闭状态，不提供交互式终端。

同一话题的新一轮输入保留后台服务和浏览器；取消任务、话题切换、权限或设置变化、
任务超时、应用关闭会清理。暂停停止新动作，已经运行的后台服务继续运行。
持久浏览器登录数据只保存在当前数据目录的独立 .runtime/browser-profile 中。

浏览器最多 4 个页面。页面及元素 ID 由服务端生成；每个动作需要最新快照。
快照记录精确 DOM 节点，输入前检查内容、属性及连接状态；旧节点不会自动重新定位。
正文和元素都有继续读取位置，支持实际 frame_id；密码输入值会隐藏。
异步页面可以通过 wait_for_text 最多等待 5 秒；matched_text 来自实际页面文字。
输入开始后消费快照；观察失败返回 uncertain，必须重新观察，避免重复提交。
弹窗目前会被关闭，其类型和消息保留在 browser_notes；文件上传下载不在本批范围内。
模型无法调用任意 JavaScript；页面内容始终作为不可信任务证据。

## 安装与验证

默认 bootstrap 安装 PDF 及 browser 组件。手动安装：

```powershell
./.venv/Scripts/python.exe -m pip install -e '.[test,browser]'
```

Windows 优先使用已安装的 Edge，再使用 Chrome；其他环境或未安装这些浏览器时，
安装受管理 Chromium：

```powershell
./.venv/Scripts/python.exe -m playwright install chromium
```

打包脚本验证 PDF、文档解析器、进程模块，以及安装后的 Playwright 模块和 Node 驱动。
browser_component_included 写入打包报告；浏览器程序使用目标机器的安装或缓存。
本次没有重新发布便携 EXE，源码更新需要重启开发服务或重新打包。

回归覆盖：真实大文件续读、长行及中文、跨页扫描、变化/伪造游标、真实后台服务、
增量/截断日志、进程停止、PDF/Office 文档，以及真实浏览器表单和过期节点。
任务工具循环同时保留 native 和 NDJSON 的已有测试。

适配接口参考：[Playwright 浏览器](https://playwright.dev/python/docs/browsers)、
[精确 DOM 节点引用](https://playwright.dev/python/docs/api/class-elementhandle)、
[pypdf 文本提取](https://pypdf.readthedocs.io/en/latest/user/extract-text.html)。
