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
