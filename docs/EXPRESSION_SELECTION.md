# 按语境选择表情

Ayana 的 26 种表情由 `characters/ayana/expression-guide.json` 定义。每种表情都有适用语境及与相近表情的区别，脸红版本、掩饰、流汗嘟哝等分别保留。目录原名「脸红预哭」不改名。

每个模型 speech 事件都应包含 `expression` 和 `pose`。表情描述 Ayana 说这句台词时的态度、情绪和潜台词，而不是复制用户的情绪或根据话题关键词机械匹配。普通聊天可以有撒娇、得意、轻微抱怨和害羞；哭、愤怒、不屑等需要对应的情绪依据。病娇仅适用于用户明确邀请的角色互动。没有随机换脸、使用配额或表情轮换要求。

系统提示包含完整语义目录和多种输出示例。用户上下文的 `avatar_context` 按时间顺序提供最近三张实际展示过的脸。未展示的排队句子、完全取消的句子、零播放的取消回执和其他服装的记录不参与连续性判断。保存历史时可以从展示记录恢复，关闭历史时使用当前会话的内存记录。逐句情绪可以随真实语义变化，也可以连续保持。

路由保留用户选定的服装，不以情绪强度限制表情。旧模型响应缺少表情或名称不合法时仍能显示台词，按 affect/intent 兜底。单纯 surprised 不再自动映射为害怕。摊手动作保留原有概率和冷却规则。

`utterance.ready` 同时记录模型请求的 `expression`、`pose` 和最终 `resolved_expression`、`resolved_pose`、`asset_id`，`expression_source` 区分 `model_label`、兼容图片 ID 的 `model_asset`、`fallback_missing`、`fallback_invalid` 和 `fallback_costume`。检查实际展示的 utterance 可以判断是模型选择集中、发生了兜底，还是播放被取消。

验证：

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_avatars.py tests/test_expression_context.py -q
.\.venv\Scripts\python.exe -X utf8 scripts/check_expressions.py
```

第二条命令使用本地配置和凭据向当前模型发出真实请求，只发送合成场景，不发送截图或个人聊天历史。报告保存至 `.runtime/benchmarks/expressions.json`。它检查首句表情与场景的匹配，以及每句是否输出有效的表情和动作；后续句子允许自然转变情绪。模型存在波动，场景结果不是所有实际聊天的准确率保证。
