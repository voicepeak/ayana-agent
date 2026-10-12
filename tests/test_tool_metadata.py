from services.agent.tools.registry import ToolRegistry, arguments


def test_unavailable_tools_are_hidden_with_a_reason():
    allowed = [False]
    registry = ToolRegistry()
    registry.add("web.fetch", "读取公网网页正文", arguments(), lambda: None)
    registry.set_availability("web.fetch", lambda: allowed[0], "当前搜索服务尚未配置完成")
    assert registry.catalog() == [{"name": "web.fetch", "available": False, "reason": "当前搜索服务尚未配置完成"}]
    assert not registry.openai_schemas() and not registry.active_tools()
    allowed[0] = True
    assert registry.openai_schemas()[0]["function"]["description"] == "读取公网网页正文"
    assert "读取公网网页正文" in registry.prompt()
    assert registry.catalog()[0]["available"]


def test_broken_predicate_fails_closed_with_a_reason():
    registry = ToolRegistry()
    registry.add("test", "test", arguments(), lambda: None)
    registry.set_availability("test", lambda: 1 / 0, "组件暂时不可用")
    assert registry.catalog()[0]["reason"] == "组件暂时不可用"
    assert not registry.active_tools()
