# B＋2 修改后组装快照

用于全文审查，生成自生产组装入口 `PromptAssembler.build()` 和真实工具注册目录。场景固定为教学模式、无绑定窗口、无仓库与历史、原生工具、校服、默认自动搜索，未读取个人配置或密钥，未发送在线请求。

| 文件 | 内容 |
|---|---|
| [ordinary.system.md](D:/ayana-agent/docs/prompt-audit/2026-10-06-b2/ordinary.system.md) | 普通权限 system 全文 |
| [full-access.system.md](D:/ayana-agent/docs/prompt-audit/2026-10-06-b2/full-access.system.md) | Full access system 全文 |
| ordinary.components.json / full-access.components.json | 八个组件的名称、来源与完整文本 |
| ordinary.tools.json / full-access.tools.json | 对应状态下发送给模型的原生工具 schema |
| auxiliary-prompts.json | 重试、摘要、日语修复、字幕修复、桌面最终核实提示词 |
| speech-events.schema.json | 修改后的语音事件 schema |
| manifest.json | 场景、字符数、工具数量与生成文件校验值 |

这是固定场景的示例。聊天运行时会按模式、窗口、截图、工具可用性、历史、任务和语音预算加入上下文；完整实际请求通过鉴权的 `/debug/prompts/export` 导出。动态包装文本与桌面目标包装集中在 `services/agent/prompts/__init__.py`；UFO2 上游模板仍独立保留。

修改内容、审查入口与导出步骤见 [交付文档](D:/ayana-agent/docs/PROMPT_REFACTOR_B2_2026-10-06.md)。修改前快照保留在 `docs/prompt-audit/2026-10-06/`。
