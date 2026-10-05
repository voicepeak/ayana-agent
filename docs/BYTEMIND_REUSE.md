# ByteMind 工具复用评估

审阅日期：2026-10-05。参考仓库：<https://github.com/1024XEngineer/bytemind>，固定提交 `f259496ed7f959b3400c57e2d3d4d0a548d4b6a3`。

ByteMind 是 Go 实现，Ayana 后端是 Python，因此复用算法、工具协议和测试案例最直接；Go 的 `internal` 工具包不能直接作为 Python 模块导入。无须为了搜索引入完整 Go agent 和第二套模型循环。

## 搜索：本轮已移植

[ByteMind 搜索实现](https://github.com/1024XEngineer/bytemind/blob/f259496ed7f959b3400c57e2d3d4d0a548d4b6a3/internal/tools/web_search.go) 请求 `https://www.bing.com/search?q=...&format=rss`，解析 RSS 的标题、链接、摘要，再去重和限制条数；无需第三方 API Key。原版还有 HTML 锚点解析兜底。

Ayana 已采用 RSS 路线：默认 `search_provider=auto`，无 Key 时使用 Bing，有 Brave Key 时使用 Brave；也支持显式 `bing` / `brave`。搜索结果继续使用 Ayana 的来源 ID，能直接交给 `web.fetch`，并显示在已有来源面板。

保留的 Ayana 行为：下载 2 MiB 上限、请求超时、公网 URL 验证、DNS 固定、重定向重新验证、取消响应。RSS 链接拒绝本地地址和含凭据的 URL。验证页面、非 RSS 响应、空结果明确报错。

本轮未采用原版的通用 HTML `<a>` 兜底，它可能把登录或导航链接当成搜索结果。后续如接 HTML，应按具体搜索结果结构解析并增加真实页面测试。

本机实测：Bing 直连和现有本机代理均返回 10 条 RSS 结果；Ayana 注册工具在没有搜索 Key 时可见，真实 `web.search` 返回结果，并能用来源 ID 完成 `web.fetch`。Bing 的关键词处理和结果相关性需继续核对原文；RSS 是网页接口，服务行为可能调整。

## 全部内建工具对应关系

以源码注册表为准，这个提交实际注册 16 个内建工具。

| ByteMind 工具 | Ayana 现状 | 复用建议 |
| --- | --- | --- |
| `web_search` | 原来仅 Brave，缺 Key 时隐藏 | 已移植免 Key 的 Bing RSS 路线 |
| `web_fetch` | 已有 `web.fetch` | 不重复注册；可补 JSON/HTML 输出模式和可调正文长度 |
| `list_files` | 已有 `files.list`、`files.find` | 不重复注册 |
| `read_file` | 已有 `files.read`，完整读取限 64 KiB | 借鉴大文件分段读取，明确总行数是否完整 |
| `search_text` | 已有 `files.search`，有目录与文件上限 | 借鉴 `rg --json` 快速路径及原生扫描兜底；保留授权目录边界 |
| `write_file` | 已有 `files.create` 和 `files.propose_edit` | 不覆盖现有的 SHA-256 冲突检查、备份与确认流程 |
| `replace_in_file` | 只能完整提交新文件内容 | 高优先级：添加 `files.replace`，减少模型输出，复用备份/确认流程 |
| `apply_patch` | 没有专用增量补丁工具 | 高优先级：添加 `files.patch`，先预检全部 hunk、处理歧义，再应用与备份 |
| `run_shell` | 已有 `shell.run`，Full access 才可执行 | 不重复注册；现有输出上限、Windows Job 和取消机制保留 |
| `git_status` | 可经 shell 调用，无专用只读工具 | 高优先级：添加 `git.status`，教学模式也能读已选仓库的状态 |
| `git_diff` | 可经 shell 调用，无专用只读工具 | 高优先级：添加 `git.diff`，结构化返回 staged / unstaged 差异 |
| `run_tests` | 可经 shell 执行，需模型猜测试命令 | 高优先级：添加 `project.test`，识别项目、虚拟环境、测试命令，返回真实退出码 |
| `update_plan` | 已有任务预算、状态与暂停，无模型步骤计划 | 次优先级：接入现有任务面板，避免引入第二套审批状态机 |
| `task_output` | 命令结束后一次性返回结果 | 次优先级：先实现受管理的后台任务，再提供增量日志读取 |
| `task_stop` | 用户可取消当前任务，无模型按 ID 停止后台任务 | 与后台任务一起实现，限制为本运行时创建的进程 |
| `delegate_subagent` | 没有对应的助手内部子代理运行时 | 后续：需要独立上下文、预算、取消、结果协议，不能只移植一个 schema |

## 适配时应修正的细节

- `git_status` 解析应使用 `--porcelain=v1 -z`，不要对整段输出 `TrimSpace`，避免首行状态列丢失；同一个文件的 staged 和 unstaged 可以同时存在。中文、空格、重命名也需要覆盖。
- `git_diff` 不应靠空格拆分文件名；读取统计和路径应使用 Git 的结构化/零分隔输出，正文仍然有输出上限。
- `run_tests` 原版的计数主要面向 Go；pytest/npm 的结果不能用同一套 `ok` / `FAIL` 前缀统计，更不能把未识别计数显示成“没有测试”。退出码作为成功依据，无法识别的计数应注明未知。
- Windows Python 项目优先使用项目虚拟环境。自动探测不能只找 `python3`，也不应直接使用桌面包的嵌入式 Python 运行其他项目的测试。
- 局部替换默认要求唯一匹配，显式允许全量替换后才改多个位置；提交前保留原文件 SHA-256 检查。
- 多文件 patch 应先完整预检，再进入写入阶段；部分失败需要恢复已经改动的文件，并保留真实恢复结果。
- 后台任务应复用已有 Windows Job 进程树所有权。当前 `shell.run` 会在结束时清理子进程，因此不能用它伪装一个可持久运行的后台工具。

## 推荐接入顺序

1. 免 Key 搜索：已完成源码接入及真实联网验证。
2. `git.status`、`git.diff`、`project.test`：补齐可核验的仓库工作流程。
3. `files.replace`、`files.patch`：降低修改大文件的模型成本。
4. 后台任务日志/停止、步骤计划、MCP 和内部子代理：按实际桌面任务需求再扩展。

其余工具目前是复用评估，尚未在 Ayana 中新增。ByteMind 的版权和 MIT 许可已加入桌面分发的第三方声明。
