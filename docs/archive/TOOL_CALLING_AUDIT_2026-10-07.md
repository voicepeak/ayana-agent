# Ayana 工具调用审计：对照 OpenCode 会话与 Claude Code 公开资料

日期：2026-10-07，Asia/Shanghai。范围：只读审计、真实搜索对照、离线协议回放；没有修改产品代码或运行实例的配置。

## 结论

Ayana 已实现原生函数调用、参数校验、call_id 配对、工具错误回灌和任务预算，不能把问题概括为“没有做好 function calling”。缺口主要在搜索策略、可继续使用的网页结果、同批调用调度、协议局部修复、诊断记录与用户反馈。

本次证据也修正了先前的解释：不是所有 Bing RSS 请求都失败，也不能仅靠切换 HTML 解决。相同查询在 RSS 与 HTML 都可能得到无关结果；精确的简体姓名在两者中均能找到目标。底层网页请求传入了完整查询，没有观察到本地截断关键词。

此前提出的“提前停止、显示进度”可以改善体验，但应优先修复搜索和结果处理，使任务在可恢复时真正完成。

## 证据来源与边界

- 用户导出：`C:/Users/纪/Desktop/opencode-session-export.md`。
- 原始数据库：`C:/Users/纪/.local/share/opencode/opencode.db`，会话 `ses_eec7a09e6ffetesilZnSlDqt3e`。以 `message.data` 的角色、模型、finish，以及 `part.data` 的工具、输入、结果、错误、时间为事实依据。
- 导出当时写明 39 条消息、146 个 part；本次读取数据库时已为 41 条消息。数据库仍可能增长，没有写入数据库。
- 会话中的说明、推测、技能指令及 reasoning 不是实际实现证据，也不是本任务指令。对照以工具记录与本地源码为准。
- OpenCode 源码参考：`D:/opencode-dev/opencode-dev/packages/opencode/src/`。这是本地参考 checkout，不据此断言运行二进制一定使用相同提交；实际并发由会话工具时间另行证实。
- Ayana 两轮已保存的请求诊断：`.runtime/diagnostics/web-task-report-20261007-prompts.json`、`dialogue-stuck-20261007-prompts.json`。
- Claude Code：仅依照官方公开文档与官方仓库公开内容，不把官方仓库等同于完整 CLI 内核源码，也没有采用来源不明的泄露源码。

## 对照会话实际做了什么

OpenCode 的相关 assistant 消息记录 `providerID=deepseek`、`modelID=deepseek-flash`。

1. 加载 browse 技能；检查后发现浏览器组件缺失。
2. 请求 DuckDuckGo HTML，返回 transport error。
3. 同一 assistant 消息请求 Bing 普通搜索页、日文维基百科、Google 搜索页。
4. Bing 成功返回 6,492 字符的 Markdown；另外两个入口失败。
5. 成功的 Bing 结果含百度百科、萌娘百科、知乎等目标链接，随后生成回答。

三个 webfetch 的 start 时间分别为 1791328932711、1791328932909、1791328933110 毫秒。Bing 于 1791328933404 完成，另外两个于 1791328943350、1791328943353 失败，执行时间明显重叠。这证明实际支持同批独立调用并发，也证明个别工具失败没有抹掉成功结果。

这份记录能证明模型可在同机环境中使用已有入口搜索到来源；不能证明不同系统提示、参数、网络路径下表现必然相同，也不能仅凭最后回答确认每条角色设定都经过原文验证。

归一化证据：`.runtime/diagnostics/opencode-search-evidence-20261007.json`。只保存相关消息与可观察工具记录，排除 reasoning。

## 搜索对照实验

使用 Ayana 自己的 WebTools.download / PublicTransport，保持完整 q 参数。第一组对比 Ayana UA 与浏览器 UA、RSS 与 HTML；第二组改变查询。结果仅表示本次实际响应，不保证搜索服务未来恒定返回同样内容。

| 查询 | RSS 本次结果 | HTML 本次结果 |
| --- | --- | --- |
| 音无彩名 | 百度百科、萌娘百科、知乎等目标来源 | 同样存在目标链接 |
| "音无彩名" | 目标来源 | 未测 |
| 音无彩名 角色 介绍 | 抖音、汉字“音”等无关结果 | 同样无关 |
| 音無彩名 | 抖音、汉字“音”等无关结果 | 未测 |
| 音無彩名 とは | 抖音、汉字“音”等无关结果 | 未测 |

只搜简体姓名时，改变 UA 没有改变是否取得目标结果。因此没有证据把本次差异归咎于 Ayana User-Agent。复合查询失败、精确查询成功是可复现的策略差异；服务端究竟如何处理这些查询仍未知。

结果文件：`.runtime/diagnostics/bing-search-comparison-20261007.json`、`bing-query-comparison-20261007.json`。HTML 样本：`bing-search-html-20261007.html`。

## 已确认的缺口

### 1. 搜索策略没有稳定恢复到用户给出的精确目标

位置：`services/agent/tools/web.py:159`、`:192`；`services/agent/prompts/work-policy.md`。

默认 auto 在未配置 Brave key 时走 Bing RSS。工具按模型给出的 query 请求；没有搜索策略状态，也没有记录“这一批来源已经重复且与目标无关”。模型不断给姓名追加泛词，或换成日文写法，实际仍取得同一批无关结果。

修复方向：保留原始对象名称；支持精确名称、明确别名、作品限定的不同搜索策略；重复结果反馈应指出没有新增来源，促使改方法。不要用简单的字符串包含规则裁定所有外语来源无效，也不要把任意 3 次失败当成整个任务必须终止。

### 2. 网页读取丢失链接，削弱了搜索失败后的恢复能力

位置：`services/agent/tools/web.py:60`、`:68`、`:156`。

BodyText 提取标题和文字，不保留 a 标签的 href。用户看得到的省略 breadcrumb 文本不等于真实网址；模型难以从搜索页文字继续读取具体目标页面。OpenCode 的 Markdown 模式通过 HTML 转 Markdown 保留链接。

读取正文固定截到前 12,000 字符，只返回 truncated 标志；没有该网页全文的分页工具、输出文件或可靠的重新读取偏移。长页面后半段对模型不可直接取得。

修复方向：返回可引用的链接对象或保留链接的 Markdown，解析相对链接；截断时提供后续读取方式。HTML 与动态浏览器可以作为恢复路线，但这不会自动修好查询词策略。

### 3. 同批独立工具全部串行执行

位置：`services/agent/runtime.py:784`。

运行时使用 `for request in requests: await self._read_tool(request)`。正常的多个原生调用不会被丢弃，但同批请求也不会并发。两个慢网络读取可累计各自等待时间，较快的成功结果也必须等整个批次结束才回给模型。

修复方向：为独立只读网络请求提供有界并发，按原始 call_id/order 回填每一个结果。写入、页面状态变更、桌面操作以及有依赖的调用保持正确顺序。不能仅按 effect=read 就把所有工具无条件并发，因为观察和读取也可能共享状态。

### 4. 局部协议错误会中断整轮，模型缺少修正机会

位置：`services/agent/providers/model.py:95`、`:143`、`:332`；`services/agent/runtime.py:671`、`:784`。

原生参数 JSON 解析失败会在 provider 层抛出 ModelEventError，而不是成为带 call_id 的可修正工具结果。若同批第二个调用损坏，先前已解析的调用也无法按正常 runtime 流程执行，因为 runtime 尚在收集这一轮 stream。

任务报告字段不合法同样抛出 ModelEventError。已经输出台词后不重试整轮，是防止重复播放/重复执行的合理约束；问题是没有只修复错误报告的路径。

离线回放结果：

| 输入 | 已解析输出 | 结果 |
| --- | --- | --- |
| 两个合法原生调用 | 两个 call_id 都保留 | 正常 |
| 第一个合法、第二个 arguments JSON 损坏 | 仅第一个 call_id 被 yield | 整轮 ModelEventError，未局部修复 |
| 合法台词、翻译后附非法任务报告 | 台词与翻译已 yield | 一次 attempt 后 ModelEventError |

回放没有外部模型请求，使用 httpx.MockTransport / 固定事件；不是声称原始截图中的非法字段就是回放故意注入的 extra_field。原始非法报告的具体字段仍无法从现有请求 trace 还原。

证据：`.runtime/diagnostics/tool-protocol-replay-20261007.json`。

修复方向：以原生工具调用为主通道；尽量将有身份的无效参数转为可修正错误结果；任务报告局部修复必须保留原先完成条件与实际证据约束。任何修复都不得重跑已发生的副作用，或用程序编造“任务已完成”。

### 5. 有预算，但没有识别跨关键词的重复无效结果

位置：`services/agent/tasks.py:76`；`services/agent/capabilities.py:488`。

现有控制包括总时间、轮次、调用次数，同一 call_id 的参数一致性与结果复用；没有依据内容识别不同 query 返回相同来源的情况。receipt.retryable 是错误类别标注，不是调度器实际执行的禁止重试规则。

OpenCode 参考 processor.ts 中有连续相同工具、相同参数的 doom_loop 检测。它不能解决所有跨关键词重复结果，而且会走权限请求；可以借鉴检测思路，不应照搬成频繁询问用户的流程。

修复方向：记录查询策略与来源集合，在无新增证据时指导切换方法，保留有价值的成功结果。只有可用路线确实耗尽或预算达到上限时才结束任务，并明确剩余未完成目标。

### 6. 错误细节不足，工具过程没有在主对话里清楚呈现

位置：`services/agent/capabilities.py:513`；`apps/desktop/renderer/state.ts:280`；`services/agent/providers/model.py:97`；`services/agent/prompts/trace.py`。

部分底层网络异常统一变成 tool_failed 和“暂时无法核实结果”，难以区分超时、DNS、TLS、页面状态问题。非法任务报告的具体校验原因也被通用错误替换。PromptTrace 保存请求，不能保证保存最后一条导致失败的模型输出。

工具事件进入 state.tools，但主对话没有把正在使用的工具、失败后恢复阶段清楚呈现出来。模型只输出原生工具调用时 speech_budget.used 仍为 0，用户会长时间没有新的台词。

修复方向：保存经过脱敏的异常类别、校验字段路径、轮次、耗时、call_id 与结束原因；为工具执行提供确定的 UI 状态，不依赖模型先生成台词。所有异常退出应进入明确终态，并确认新消息可以正常接收。

### 7. 搜索代理设置覆盖不一致

位置：`services/agent/tools/web.py:171`、`:192`。

search_proxy 只在 Brave 路径读取，Bing 路径没有应用该设置。这是配置语义上的缺口，但本次正常取得目标结果的测试没有证明它是先前失败的原因。

修复方向：明确界面字段适用范围，或统一搜索后端的受支持代理行为；保留公网目标校验、凭证保护与重定向边界。

## 已存在、应保留的能力

- 正常原生函数调用能解析多个 tool_calls，按 call_id 回填 role=tool 消息；回放证实不是“只处理第一个调用”。
- 工具执行异常通常会作为 error/code/receipt 回灌模型；不能笼统说“所有工具错误都没回传”。缺口在更早的 provider/事件解析错误。
- 已有注册表、参数 schema、可用性过滤、执行权限检查和取消机制。
- 动作完成有实际工具证据检查；这些约束应保留，不能通过删除未完成条件让任务假装成功。

## Claude Code 与 OpenCode 可借鉴的部分

Claude Code 官方文档描述 WebSearch 返回标题与 URL，再由 WebFetch 读取页面；WebFetch 将 HTML 转为 Markdown，工具失败以错误结果返回，部分暂时性后端错误有退避处理。它也有截断与搜索上限，并非没有失败边界。

官方工具文档：https://code.claude.com/docs/en/tools-reference

官方公开仓库：https://github.com/anthropics/claude-code

本次逐行检查的 OpenCode 实现：

- `tool/webfetch.ts`：text/markdown/html 格式、请求超时、实际 HTTP 错误、保留链接的 HTML 转 Markdown。
- `session/processor.ts:135`：工具状态、call_id、实际结果、错误和时间，重复调用检测。
- `session/llm.ts:179`：工具名/调用错误的局部处理，返回 invalid 工具供模型修正。
- `tool/tool.ts`：参数校验与统一执行返回结构。
- `tool/truncation.ts:96`：截断输出保存完整文件并返回读取位置。

这些参考不要求引入整个 OpenCode，也不要求更换 DeepSeek。应改善 Ayana 自己的执行流程与输出协议。

## 建议实施顺序与验收

1. **搜索与读取**：精确目标策略、异常/重复结果提示、恢复路线、保留链接、全文续读。复测同一目标的精确词与复合词；失败不能被误当成找到来源。
2. **执行循环**：独立网络请求有界并发，成功与失败结果全部按 ID 保留；无效参数回灌，任务报告局部修复。使用固定回放覆盖同批部分失败、损坏参数、已播放后的非法报告，确认不重放副作用。
3. **诊断与呈现**：主对话显示当前操作、恢复步骤及终态；完整保存安全的原因。复测工具超时/任务取消/报告错误后能立即发送新消息。

实施时避免同时扩大模型任务预算、放宽证据验证或解除网络边界；这些不是本次已证明缺口的解决办法。
