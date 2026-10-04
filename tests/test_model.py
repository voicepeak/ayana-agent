import json

import httpx
import pytest

from services.agent.providers.model import ModelEventError, OpenAIProvider


class Settings:
    values = {"base_url": "https://api.deepseek.com/v1", "model": "configured-model"}

    def key(self):
        return "private-model-key"


def sse_response(events):
    # Separate SSE chunks expose whether the adapter yielded a committed
    # event before noticing the subsequent invalid object.
    lines = []
    for event in events:
        content = json.dumps(event, ensure_ascii=False)+"\n"
        chunk = {"choices": [{"delta": {"content": content}, "finish_reason": None}]}
        lines.append("data: "+json.dumps(chunk, ensure_ascii=False)+"\n\n")
    lines.append('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
    lines.append("data: [DONE]\n\n")
    return httpx.Response(200, text="".join(lines), headers={"Content-Type": "text/event-stream"})


def native_tool_sse(call_id, name, arguments, finish="tool_calls"):
    """Stream a native OpenAI function call, splitting the arguments string."""
    lines = []
    head = {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": call_id, "type": "function",
            "function": {"name": name, "arguments": arguments[:8]}}]}, "finish_reason": None}]}
    lines.append("data: " + json.dumps(head, ensure_ascii=False) + "\n\n")
    for start in range(8, len(arguments), 8):
        chunk = {"choices": [{"delta": {"tool_calls": [{"index": 0,
                 "function": {"arguments": arguments[start:start + 8]}}]}, "finish_reason": None}]}
        lines.append("data: " + json.dumps(chunk, ensure_ascii=False) + "\n\n")
    lines.append('data: ' + json.dumps({"choices": [{"delta": {}, "finish_reason": finish}]}) + "\n\n")
    lines.append("data: [DONE]\n\n")
    return httpx.Response(200, text="".join(lines), headers={"Content-Type": "text/event-stream"})


VALID = {"type": "speech", "key": "s1", "speech_ja": "一緒に見よう。", "intent": "explain"}


@pytest.mark.asyncio
async def test_retry_missing_type_before_first_event_then_valid():
    calls = []
    messages = [{"role": "system", "content": "contract"}, {"role": "user", "content": "question"}]
    def respond(request):
        calls.append(json.loads(request.content))
        return sse_response([{"speech_ja": "wrapper missing type"}] if len(calls) == 1 else [VALID])
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        provider = OpenAIProvider(Settings(), client)
        assert [event async for event in provider.stream_reply(messages)] == [VALID]
    assert len(calls) == 2
    assert calls[0]["messages"] == messages
    assert calls[1]["messages"][-1]["role"] == "system"
    assert "No wrapper objects" in calls[1]["messages"][-1]["content"]
    assert len(messages) == 2  # caller's stable context was not mutated
    assert calls[0]["temperature"] == .3


@pytest.mark.asyncio
async def test_never_retry_after_any_committed_event():
    calls, committed = [], []
    def respond(request):
        calls.append(request)
        return sse_response([VALID, {"events": [VALID]}])
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        with pytest.raises(ModelEventError):
            async for event in OpenAIProvider(Settings(), client).stream_reply([]):
                committed.append(event)
    assert committed == [VALID]
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_auth_failure_is_not_retried_or_echoed():
    calls = []
    def respond(request):
        calls.append(request)
        return httpx.Response(401, text="private-model-key echoed in provider diagnostics")
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        with pytest.raises(RuntimeError, match="HTTP 401") as caught:
            _ = [event async for event in OpenAIProvider(Settings(), client).stream_reply([])]
    assert len(calls) == 1
    assert "private-model-key" not in str(caught.value)


@pytest.mark.asyncio
async def test_second_structural_failure_exhausts_retry_without_raw_output():
    calls = []
    def respond(request):
        calls.append(request)
        return sse_response([{"type": "unknown", "private": "should-never-be-logged"}])
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        with pytest.raises(ModelEventError) as caught:
            _ = [event async for event in OpenAIProvider(Settings(), client).stream_reply([])]
    assert len(calls) == 2
    assert "should-never-be-logged" not in str(caught.value)


@pytest.mark.asyncio
async def test_no_retry_for_model_refusal():
    calls = []
    def respond(request):
        calls.append(request)
        return httpx.Response(200, text='data: {"choices":[{"delta":{"refusal":"no"}}]}\n\n', headers={"Content-Type": "text/event-stream"})
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        with pytest.raises(RuntimeError, match="declined"):
            _ = [event async for event in OpenAIProvider(Settings(), client).stream_reply([])]
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_all_committed_event_types_disable_retry():
    for first in [{"type": "translation", "key": "s1", "display_zh": "一句"},
                  {"type": "evidence", "path": "README.md", "line": 1},
                  {"type": "tool", "name": "capture_target", "arguments": {}},
                  {"type": "action", "action": {"kind": "highlight"}}]:
        calls = []
        def respond(request):
            calls.append(request)
            return sse_response([first, {"type": None}])
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            with pytest.raises(ModelEventError):
                _ = [event async for event in OpenAIProvider(Settings(), client).stream_reply([])]
        assert len(calls) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("usage_only", [False, True])
async def test_usage_on_final_choice_or_separate_chunk_is_not_a_model_event(usage_only):
    usage = {"prompt_tokens": 1000, "completion_tokens": 70, "total_tokens": 1070,
             "prompt_cache_hit_tokens": 896, "prompt_cache_miss_tokens": 104}
    requests = []
    def respond(request):
        requests.append(json.loads(request.content))
        response = sse_response([VALID])
        raw = response.text
        chunk = {"choices": [] if usage_only else [{"delta": {}, "finish_reason": "stop"}], "usage": usage}
        raw = raw.replace("data: [DONE]", "data: " + json.dumps(chunk) + "\n\ndata: [DONE]")
        return httpx.Response(200, text=raw)
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        provider = OpenAIProvider(Settings(), client)
        assert [event async for event in provider.stream_reply([])] == [VALID]
    assert provider.usage["cache_hit_ratio"] == .896
    assert provider.usage["prompt_cache_hit_tokens"] == 896
    assert json.loads(provider.response_text) == VALID
    assert requests[0]["stream_options"] == {"include_usage": True}


@pytest.mark.asyncio
async def test_native_tool_calls_are_accumulated_and_replayed():
    arguments = json.dumps({"root_id": "output", "path": "note.md", "content": "hello"}, separators=(",", ":"))
    calls = []
    def respond(request):
        calls.append(json.loads(request.content))
        return native_tool_sse("call_abc", "files__create", arguments)
    tools = [{"type": "function", "function": {"name": "files__create", "description": "write",
              "parameters": {"type": "object", "properties": {}, "required": [], "additionalProperties": False}}}]
    names = {"files__create": "files.create"}
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        provider = OpenAIProvider(Settings(), client)
        events = [event async for event in provider.stream_reply(
            [{"role": "user", "content": "make a file"}], tools=tools, tool_names=names)]
    assert events == [{"type": "tool", "name": "files.create", "arguments": json.loads(arguments), "call_id": "call_abc"}]
    assert calls[0]["tools"] == tools and calls[0]["tool_choice"] == "auto"
    assert provider.used_native_tools is True
    assistant = provider.assistant_message()
    assert assistant["tool_calls"][0]["id"] == "call_abc"
    assert assistant["tool_calls"][0]["function"]["name"] == "files__create"
    assert json.loads(assistant["tool_calls"][0]["function"]["arguments"]) == json.loads(arguments)


@pytest.mark.asyncio
async def test_native_tool_call_with_no_content_is_valid_output():
    def respond(request):
        return native_tool_sse("call_1", "list_files", "{}")
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        provider = OpenAIProvider(Settings(), client)
        events = [event async for event in provider.stream_reply([{"role": "user", "content": "q"}],
            tools=[{"type": "function", "function": {"name": "list_files", "parameters": {"type": "object"}}}])]
    assert events == [{"type": "tool", "name": "list_files", "arguments": {}, "call_id": "call_1"}]
    assert provider.response_text == ""


@pytest.mark.asyncio
async def test_compatible_provider_cached_tokens_and_usage_reset_between_requests():
    cfg = Settings()
    cfg.values = {"base_url": "https://example.com/v1", "model": "test"}
    calls = []
    def respond(request):
        calls.append(json.loads(request.content))
        raw = sse_response([VALID]).text
        if len(calls) == 1:
            raw = raw.replace("data: [DONE]", 'data: {"choices":[],"usage":{"prompt_tokens":100,"prompt_tokens_details":{"cached_tokens":64}}}\n\ndata: [DONE]')
        return httpx.Response(200, text=raw)
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        provider = OpenAIProvider(cfg, client)
        _ = [event async for event in provider.stream_reply([])]
        assert provider.usage["cache_hit_ratio"] == .64
        _ = [event async for event in provider.stream_reply([])]
        assert provider.usage is None
    assert "stream_options" not in calls[0]  # optional extensions must not break other endpoints
