from services.agent.tools.registry import ToolRegistry, arguments


def test_access_descriptions_and_unavailable_reason_share_registry():
    access = [False]
    registry = ToolRegistry(lambda: access[0])
    registry.add("file", "执行模式：在授权目录创建文本", arguments(), lambda: None, "write")
    registry.set_visibility("file", lambda: access[0], "需要 Full access")
    assert registry.catalog() == [{"name": "file", "available": False, "reason": "需要 Full access"}]
    assert not registry.openai_schemas()
    access[0] = True
    assert registry.openai_schemas()[0]["function"]["description"] == "Full access：在本机目录创建文本"
    assert 'Full access：在本机目录创建文本' in registry.prompt()
    assert registry.catalog()[0]["available"]


def test_broken_predicate_fails_closed_with_a_reason():
    registry = ToolRegistry()
    registry.add("test", "test", arguments(), lambda: None)
    registry.set_availability("test", lambda: 1 / 0, "组件暂时不可用")
    assert registry.catalog()[0]["reason"] == "组件暂时不可用"
    assert not registry.active_tools()
