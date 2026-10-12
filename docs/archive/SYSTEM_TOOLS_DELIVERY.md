# 系统打开工具交付

日期：2026-10-05。版本：0.3.2。

上一批交付完成了文本文件、网页读取和任务循环，但没有应用启动入口。当前源码还包含后续加入的原生模型工具调用与 `computer.run`；它只能操作已绑定窗口，不能代替应用启动工具。

## 本次新增

| 工具 | 能做什么 |
| --- | --- |
| `apps.search` | 按中文名称或英文别名查找本机应用；发现开始菜单、App Paths 注册与商店应用；返回真实应用 ID |
| `apps.open` | 用发现的应用 ID 启动应用，返回 Windows 回执和能观察到的窗口 |
| `files.list` | 列举已授权目录的文件和子目录，包含常见非文本格式的名称 |
| `files.find` | 在已授权目录中按名称片段查找，遍历有时长/数量/深度上限 |
| `files.open` | 打开文件夹，或用默认应用打开 PDF、Office 文档、图片和影音；文本和代码使用记事本 |
| `web.open` | 用默认浏览器打开 HTTP/HTTPS 网址，支持用户提供的本地开发网址 |
| `windows.list` | 发现可见窗口及当前身份，返回真实窗口 ID |
| `windows.select` | 选择真实窗口作为后续观察/桌面任务目标，把新截图交给模型 |

新工具已注册到原生 `tools` schema 和 NDJSON 工具路径，两种调用方式复用执行规则。本次 v0.3.2 交付时共注册 20 个工具；后续源码已整理为 18 个并按条件筛选，见 [工具接口整理](TOOL_SIMPLIFICATION.md)。实际可用数量取决于 Windows、桌面组件和模型配置。

打开应用使用 Windows `ShellExecuteExW`，应用入口与参数来自服务端发现结果，模型只提交 ID。文本文件用固定记事本入口和独立参数打开，不能通过文件关联把 Python/JavaScript 源码执行。路径授权、私有文件排除和 junction 检查保留；文件打开支持更多格式，不扩大完整文本读取/修改的范围。[Microsoft ShellExecuteExW](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-shellexecuteexw)、[应用注册](https://learn.microsoft.com/en-us/windows/win32/shell/app-registration)

## 体验方式

退出旧版，再启动 `apps/desktop/release/Ayana-0.3.2-win-x64.exe`。在对话框开启执行模式，可直接说：

- “打开记事本。”
- “打开计算器。”
- “打开 http://localhost:3000。”
- “打开刚才保存的笔记。”
- “在这个目录里找到使用说明 PDF，然后打开它。”

文件与目录需要先在“任务与结果 → 文件访问范围”添加所在目录；只读授权已经允许列举和打开，修改仍需写入授权与差异确认。应用无需绑定窗口即可启动；需要继续操作时，模型可以查找并选择新窗口，再交给现有 `computer.run`。

有多款不同的同名应用或多份同名文件时，需要用户明确目标。相同名称的 Windows/商店重复入口合并，精确名称优先于模糊匹配。

## 验证与实际边界

- 本机真实应用发现已核对：记事本、Windows 设置、Chrome 均能找到实际入口。
- 新工具测试 26 项通过，涵盖授权、私有文件、路径逃逸、文件格式、源代码不执行、模式限制、取消、防重放、窗口句柄复用和最新截图回传。
- 自建 WinForms 程序实际经 Windows 启动，观察到真实窗口，选定目标并取得截图；测试结束只关闭自建窗口。
- 真实联网模型在自然语言请求下完成 4 轮、3 次工具调用：“查找应用 → 打开应用 → 选择窗口并截图”，任务成功。报告：`.runtime/benchmarks/system-open/1791182702608079500/report.json`。应用发现样本限制在测试目录，模型不读取其他用户窗口。
- 完整 Python 回归：187 项通过、9 项跳过；TypeScript、生产构建和前端现有回归通过。
- 最终便携包 `Ayana-0.3.2-win-x64.exe` 的真实 Electron、内置 Python、IPC 和 Windows 验收共 9 项通过，覆盖实际启动测试应用、选定新窗口、文本创建、差异确认及恢复、网页来源卡和目录授权界面。该验收的模型响应使用本地确定性测试服务，真实模型调用另见上一项。报告：`.runtime/benchmarks/capabilities-desktop/1791183813969/report.json`。

`open_requested` 只表示 Windows 接受请求；没观察到目标窗口时，任务显示待核实。`window_observed` 表示观察到匹配窗口，也不证明文档内容或下一步操作已完成。打开请求已经交给 Windows 后，取消会停止后续操作，不关闭用户的应用。默认应用启动可能复用已有窗口。

网页打开与网页读取分开：`web.open` 仅启动浏览器，不把内部站点响应交给后端；`web.fetch` 仍限制为公网。打开文档不等于解析文档内容，本次没有加入 PDF/Office 内容解析。

仍缺少的独立能力包括通用命令执行、浏览器 DOM 操作、文档解析与生成、长期事实记忆、提醒和外部应用连接。下一批如需“运行测试、执行脚本、启动开发服务”，应增加进程执行工具及日志、超时、取消和进程树回收，而不是把这些行为藏在 `apps.open` 的启动参数里。

## 复现

```powershell
.\.runtime\testenv\Scripts\python.exe -m pytest -q tests/test_system_tools.py
.\.runtime\testenv\Scripts\python.exe -X utf8 scripts/smoke_system_open.py
# 使用现有模型凭据；只操作自建测试窗口
.\.runtime\testenv\Scripts\python.exe -X utf8 scripts/smoke_system_open.py --live-model
# Playwright 路径填写本机已有的 node_modules；启动的自建程序及临时应用注册在结束时清理
node scripts/verify_capabilities.mjs --system-open --packaged apps/desktop/release/Ayana-0.3.2-win-x64.exe --playwright-root '你的 Playwright node_modules 路径'
```

生产实现没有额外第三方依赖。探针用本机 .NET Framework 编译器创建测试程序；它不是运行新工具的前提。
