import asyncio
import json
import pytest
from services.agent.tools.receipts import receipt
from services.agent.tools.registry import arguments
from services.agent.work import usable_result
from tests.test_conversations import make_runtime, ask
from tests.test_model import sse_response


def test_receipts_distinguish_request_execution_and_observed_outcome():
    requested = receipt("files.open", {"status": "open_requested"}, "write")
    assert requested["execution"] == "requested" and requested["verification"] == "unverified"
    window = receipt("apps.open", {"status": "window_observed"}, "write")
    assert window["scope"] == "application_window_only"
    command = receipt("shell.run", {"exit_code": 0}, "write")
    assert command["verification"] == "execution_only"
    assert receipt("shell.run", {"exit_code": 7}, "write")["execution"] == "failed"
    assert receipt("shell.run", {"exit_code": 0, "timed_out": True}, "write")["execution"] == "timed_out"
    assert not usable_result({"result": {"exit_code": 7}})
    assert receipt("files.create", {"sha256": "actual"}, "write")["scope"] == "file_contents_hash"


@pytest.mark.asyncio
async def test_failed_read_returns_to_model_and_ayana_explains_without_error_banner(tmp_path):
    calls = []
    def respond(request):
        payload = json.loads(request.content)
        calls.append(payload)
        if len(calls) == 1:
            return sse_response([{"type": "tool", "name": "files.read", "arguments": {"path": "missing.txt"}}])
        result_message = next(message for message in payload["messages"] if "file_missing" in str(message.get("content")))
        assert '"audience": "assistant"' in result_message["content"]
        return sse_response([{"type": "speech", "key": "s1", "speech_ja": "ファイルが見つからなかったよ。", "display_zh": "没有找到这个文件。"},
                             {"type": "speech", "key": "s2", "speech_ja": "場所を確認してね。", "display_zh": "需要确认一下它的位置。"},
                             {"type": "task", "kind": "answer", "status": "blocked", "reason": "没有找到指定文件，需要确认路径"}])
    runtime = make_runtime(tmp_path, respond)
    try:
        await ask(runtime, "读取 missing.txt")
        events = next(iter(runtime.clients)).events
        assert len(calls) == 2 and runtime.active_task.state == "blocked"
        assert any(event["type"] == "utterance.ready" for event in events)
        assert any(event["type"] == "tool.failed" and event["audience"] == "assistant" for event in events)
        assert not any(event["type"] == "error" for event in events)
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_unexpected_executor_failure_is_structured_but_cancel_propagates(tmp_path):
    runtime = make_runtime(tmp_path, lambda _: sse_response([]))
    def broken():
        raise RuntimeError("internal details should not reach user")
    runtime.registry.add("broken", "test", arguments(), broken)
    value = await runtime._dispatch_tool({"type": "tool", "name": "broken", "arguments": {}})
    assert value["receipt"]["execution"] == "failed" and "internal details" not in value["error"]
    async def cancelled():
        raise asyncio.CancelledError()
    runtime.registry.add("cancelled", "test", arguments(), cancelled)
    try:
        with pytest.raises(asyncio.CancelledError):
            await runtime._dispatch_tool({"type": "tool", "name": "cancelled", "arguments": {}})
    finally:
        await runtime.close()
