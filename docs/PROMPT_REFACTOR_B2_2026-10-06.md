# B＋2：短句规则与 prompt 组装修复

采用用户选择：通常 10～24 字符，单个语音事件最多 48 字符；集中组装，保留现有身份、气质、世界观和关系设定。原始审查文档与 prompt 全文留作修改前快照，不覆盖。

## 现在从哪里审查

生产入口是 [PromptAssembler.build](D:/ayana-agent/services/agent/prompts/__init__.py)。运行时不再手工拼接 persona + CONTRACT。以下部分通过有名称的标签装入一条 system：

| 部分 | 编辑来源 | 作用 |
|---|---|---|
| persona | [persona.md](D:/ayana-agent/characters/ayana/persona.md) | 身份、气质、世界观、同伴定位、边界和角色示例 |
| speech | [speech-style.md](D:/ayana-agent/characters/ayana/speech-style.md) | 原有日语口语风格、中文字幕、短句、详略、避免固定台词 |
| work | [work-policy.md](D:/ayana-agent/services/agent/prompts/work-policy.md) | 任务推进、工具事实、完整读取、来源与结果核实 |
| events | [event-protocol.md](D:/ayana-agent/services/agent/prompts/event-protocol.md) | NDJSON 字段、speech/translation/key、语音预算、接收回执 |
| tasks | [task-protocol.md](D:/ayana-agent/services/agent/prompts/task-protocol.md) | 目标、完成条件、接续、证据和未完成报告 |
| permissions | [普通权限](D:/ayana-agent/characters/ayana/agent-policy.md) / [Full access](D:/ayana-agent/characters/ayana/full-access-policy.md) | 每次只注入当前分支的具体权限规则 |
| tools | 实时注册工具与可用性 | 原生工具 schemas 或文本工具清单，工具后刷新 |
| expressions | [规则](D:/ayana-agent/characters/ayana/expression-rules.md)、[语义目录](D:/ayana-agent/characters/ayana/expression-guide.json)、[例句](D:/ayana-agent/characters/ayana/expression-examples.ndjson) | 现有 26 种表情的含义与例句保持，拆出可审查文本 |

这些标签用于归属、查找和导出，并不创造 API 消息角色之外的优先级。人格内部尚待讨论的张力不会被标签自动解决。

主请求结构仍为 system、当前仓库证据、历史摘要/完整轮次、最新用户 JSON 与可选当前截图；工具 schema 在请求体的 tools 数组。摘要、重试、日语/字幕修复、工具结果包装、预算与完成核实提示，以及桌面任务目标与最终核实，也由 prompts 包提供。UFO2 自身的上游模板保持独立，不擅改桌面操作策略。

## 已处理的问题

- `validate_speech`、事件 JSON schema、主语言规则、格式重试和修复请求均采用 48 字符硬上限；24 是正常短句目标。校验器还阻止一个事件装入多句，保留日语引号里的问句和句中省略号。
- 人设示例的多句明确拆成独立日语短句；greet/casual 改为 acknowledge，玩笑改为 playful。示例意义与角色取向保持。
- key 统一为同一响应内唯一、工具往返后可复用；运行时保留跨轮次的回执映射。修复拆成多个事件时增加独立 key，翻译准确对应。
- 普通权限下的执行模式与逐步确认规则只放在普通分支。Full access 分支直接说明自己的范围与执行方式，不再靠主 CONTRACT 的普通限制加覆盖声明实现。
- 当前语音预算在同一任务里更新替换，保持原生 assistant/tool 相邻。保存和回放历史时移除预算、格式重试、完成核实等临时 system；已有旧历史也在回放时过滤，不删除用户聊天和真实工具结果。
- 日语修复返回 `sentences: [{speech_ja, display_zh}, ...]`，保留原句全部含义与既有语气，每句立即发出对应翻译。原语句的旧字幕（含内嵌字幕）弃用，修复后的内容进入模型历史；原意图、情绪、表情与姿势沿用。
- 长句可以在首句即修复；已有输出后只修复该事件，保留原生 tool_calls，避免因语音异常重放操作。修复失败时不提交该批修复句子，也不编造任务成功。
- 修复使用本轮已组装的 speech 风格；不加载所有工具/权限/角色世界观，避免为了修复一句话自行扩大含义。
- 表情/姿势缺失或错误仍能兜底播放，在线模型另外产生 `model.validation` 诊断，区分原始选择与回退。离线演示的缺省字段不冒充在线模型异常。
- 表情与缓存检查脚本复用统一组装入口，但仍有意不提供操作工具。协议检查和翻译性能实验保持各自明确用途，未将实验结果冒称生产人格表现。

## 查看实际送出的请求

后端内存保留最近 12 次模型请求。阶段包括 main、speech_repair、subtitle_repair、history_summary、desktop_planning 和 desktop_verification。记录发生在发请求前，不包含 Authorization 或模型 API key；图片以长度和 SHA256 元数据替代，文本、上下文、模型参数、工具 schema 原样保留。桌面请求从 worker 的实际 relay 请求收集。

鉴权下载入口：`GET /debug/prompts/export`，使用与其他后端接口相同的每次启动令牌，返回 JSON 附件并设置 `Cache-Control: no-store`。不默认落盘，不添加到聊天历史。

可使用 [export_prompts.py](D:/ayana-agent/scripts/export_prompts.py) 下载。先将当前后端启动令牌放进环境变量 `AYANA_DEBUG_TOKEN`，再执行：

```powershell
.venv\Scripts\python.exe scripts\export_prompts.py --base-url http://127.0.0.1:实际后端端口
```

输出默认在 `.runtime/prompt-exports/`，也可指定 `--output`。该脚本只访问本机，禁止覆盖已有文件。启动令牌不是对话模型的 API key。调试导出是开发入口，当前没有增加设置页按钮。

## 后续人格审查保留项

1. 永远微笑、从不真正慌张，与愤怒、害怕、哭泣等表情范围如何协调。
2. 哲学假设与具体事实回答的表达边界。
3. 固定身份宣言/意象例句与避免固定台词的关系。
4. 疏离、撒娇、害羞、嘴硬、占有式演绎的适用范围。
5. “越线”的具体含义，以及必要澄清与闲聊不追问如何区分。

本轮只记录这些角色选择，不预先删改。

## 生效与验证

Python 组装、事件校验和新导出接口需要重启后端。人格、语言风格、权限和协议文本在新的在线轮次读取；等待确认后的任务继续沿用原请求。表情语义目录仍在 AvatarCatalog 创建时加载。打包版需更新打包后的 backend；复制规则递归包含 services/characters，新协议 Markdown 也声明为 Python 包资源。

提供修改后[普通权限全文](D:/ayana-agent/docs/prompt-audit/2026-10-06-b2/ordinary.system.md)、[Full access 全文](D:/ayana-agent/docs/prompt-audit/2026-10-06-b2/full-access.system.md)，以及[快照目录说明](D:/ayana-agent/docs/prompt-audit/2026-10-06-b2/README.md)。示例场景为教学模式、无绑定窗口、无仓库与历史、原生工具、校服、默认搜索；使用仓库默认配置，不读取本机个人配置或密钥，不是正在运行的聊天请求。实时请求应使用鉴权导出。

验证覆盖 24/25/48/49 边界、多句与引号、修复拆句/字幕/元数据、工具调用不重复、两个权限分支、历史预算隔离、原生工具相邻性、表情回退与实际 HTTP 请求体记录、导出鉴权。完整 Python 回归为 332 通过、8 跳过；最后补充修复 key 最大长度案例后，相关回归为 72 通过。本轮没有联网调用对话模型，也没有执行真实桌面任务，因此角色语气与 UFO 实际操作效果不作为已实测结论。
