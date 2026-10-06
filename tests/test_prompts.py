import json
from pathlib import Path

import httpx
import pytest

from packages.protocol import validate_speech
from packages.protocol.events import MAX_SPEECH_CHARS
from services.agent.avatars import AvatarCatalog
from services.agent.config import Settings
from services.agent.context import PromptHistory
from services.agent.prompts import PromptAssembler, tool_prompt, update_budget
from services.agent.prompts.trace import PromptTrace
from services.agent.providers.model import OpenAIProvider, ModelEventError
from services.agent.runtime import AgentRuntime
from services.agent.storage import ConversationStore
from services.agent.tools.registry import ToolRegistry
from test_model import VALID, sse_response, repaired_response, native_tool_sse
from test_runtime import Desktop, Tts, Ws

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize("size", [24, 25, 48])
def test_natural_sentence_lengths_through_48_are_accepted(size):
    assert validate_speech({"speech_ja": "あ" * (size - 1) + "。"})["speech_ja"]


@pytest.mark.parametrize("text", ["あ" * 48 + "。", "ここにいるよ。安心してね。"])
def test_oversize_and_multiple_sentences_cannot_enter_tts(text):
    with pytest.raises(ValueError):
        validate_speech({"speech_ja": text})


@pytest.mark.parametrize("text", ["「本当？」と聞いてみよう。", "そう……まだ見ているよ。", "いいの！？"])
def test_quotes_and_character_pauses_remain_natural(text):
    assert validate_speech({"speech_ja": text})["speech_ja"] == text


def test_protocol_schema_matches_the_runtime_limit():
    schema = json.loads((ROOT / "packages/protocol/speech-events.schema.json").read_text(encoding="utf-8"))
    assert schema["properties"]["speech_ja"]["maxLength"] == MAX_SPEECH_CHARS == 48
    assert "key" in schema["properties"]


def test_permission_branches_and_character_examples_are_consistent():
    catalog = AvatarCatalog(ROOT)
    assembler = PromptAssembler(ROOT, catalog)
    registry = ToolRegistry()
    for full in (False, True):
        bundle = assembler.build(full_access=full, costume="校服",
                                 tools=tool_prompt(registry, native_tools=True, full_access=full))
        policies = [part for part in bundle.components if part["name"] == "permissions"]
        assert len(policies) == 1
        assert policies[0]["source"].endswith("full-access-policy.md" if full else "agent-policy.md")
        if full:
            assert "编辑和恢复必须等待" not in bundle.system
            assert "The following directory, teaching-mode" not in bundle.system
            assert "只访问用户所选仓库" not in bundle.system
            assert "无需逐步确认" in bundle.system
        else:
            assert "任意本机路径、修改仓库" not in bundle.system
            assert "等待用户在界面确认" in bundle.system
        assert "Use fresh speech keys throughout" not in bundle.system
    examples = (ROOT / "characters/ayana/expression-examples.ndjson").read_text(encoding="utf-8")
    for line in examples.splitlines():
        event = json.loads(line)
        validate_speech(event)
        assert event["intent"] in {"acknowledge", "explain", "encourage", "caution", "playful"}


def test_old_and_new_budget_controls_are_not_saved_or_replayed(tmp_path):
    store = ConversationStore(tmp_path / "history.sqlite3")
    legacy = [{"role": "user", "content": "original goal"},
              {"role": "system", "content": 'Current speech_budget: {"remaining":0}'},
              {"role": "assistant", "content": "already done"}]
    store.replace_model_turns("conversation:old", [{"turn_id": "1", "messages": legacy, "keys": {}}])
    history = PromptHistory(store)
    history.select("system", {}, conversation_id="old")
    assert history.messages() == [legacy[0], legacy[2]]
    history.append("2", legacy, {}, persist=True)
    saved = store.model_turns(history.scope)[-1]
    assert saved["messages"] == [legacy[0], legacy[2]]
    store.close()


def test_latest_budget_replaces_earlier_one_without_breaking_native_results():
    messages = [{"role": "user", "content": "goal"},
                {"role": "assistant", "content": "", "tool_calls": [{"id": "one"}]}]
    update_budget(messages, {"remaining": 7})
    messages.append({"role": "tool", "tool_call_id": "one", "content": "actual result"})
    messages.append({"role": "assistant", "content": "", "tool_calls": [{"id": "two"}]})
    update_budget(messages, {"remaining": 5})
    controls = [message for message in messages if message["role"] == "system"]
    assert len(controls) == 1 and '"remaining": 5' in controls[0]["content"]
    index = next(i for i, message in enumerate(messages) if message.get("tool_call_id") == "one")
    assert messages[index - 1]["tool_calls"][0]["id"] == "one"


@pytest.mark.asyncio
@pytest.mark.parametrize("source_key", ["s2", "s" * 100])
async def test_split_repair_preserves_metadata_translations_and_native_call_once(source_key):
    requests = []
    bad = {**VALID, "key": source_key, "speech_ja": "原因は確認できたよ。次に設定を見よう。", "expression": "正经", "pose": "open"}
    parts = [{"speech_ja": "原因は確認できたよ。", "display_zh": "原因已经确认了。"},
             {"speech_ja": "次に設定を見よう。", "display_zh": "接着看看设置。"}]
    def respond(request):
        body = json.loads(request.content)
        requests.append(body)
        if not body["stream"]:
            return repaired_response({"sentences": parts})
        raw = sse_response([VALID, bad, {"type": "translation", "key": source_key, "display_zh": "错误的旧字幕"}]).text
        native = native_tool_sse("call_1", "files__read", '{"path":"README.md"}').text
        return httpx.Response(200, text=raw.replace("data: [DONE]\n\n", "") + native)
    messages = [{"role": "system", "content": "<ayana_speech>\n保持温柔，不加口头禅。\n</ayana_speech>"}]
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        provider = OpenAIProvider(type("Cfg", (), {"values": {"model": "test", "base_url": "https://api.deepseek.com/v1"}, "key": lambda self: "fixture"})(), client)
        events = [event async for event in provider.stream_reply(messages, tool_names={"files__read": "files.read"})]
    assert len(requests) == 2 and sum(body["stream"] for body in requests) == 1
    assert "保持温柔，不加口头禅。" in requests[1]["messages"][0]["content"]
    assert "tools" not in requests[1]
    repaired = [event for event in events if event["type"] == "speech"][1:]
    subtitles = [event for event in events if event["type"] == "translation"]
    assert [event["speech_ja"] for event in repaired] == [part["speech_ja"] for part in parts]
    assert [event["display_zh"] for event in subtitles] == [part["display_zh"] for part in parts]
    assert len({event["key"] for event in repaired}) == 2
    assert all(len(event["key"]) <= 100 for event in repaired)
    assert all(speech["key"] == subtitle["key"] for speech, subtitle in zip(repaired, subtitles))
    assert all(event["expression"] == "正经" and event["pose"] == "open" for event in repaired)
    assert sum(event["type"] == "tool" for event in events) == 1
    history = provider.assistant_message()
    assert len(history["tool_calls"]) == 1 and "错误的旧字幕" not in history["content"]


@pytest.mark.asyncio
async def test_first_long_sentence_is_split_without_retrying_the_round(tmp_path):
    calls = []
    cfg = Settings(ROOT, data_root=tmp_path)
    cfg.values.update(provider="openai", model="test")
    cfg.key = lambda: "fixture"
    source = "あ" * 49 + "。"
    def respond(request):
        body = json.loads(request.content); calls.append(body)
        return (sse_response([{**VALID, "speech_ja": source}]) if body["stream"] else
                repaired_response({"sentences": [{"speech_ja": "長い説明を分けて話そう。", "display_zh": "分开说明。"}]}))
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        events = [event async for event in OpenAIProvider(cfg, client).stream_reply([])]
    assert [event["type"] for event in events] == ["speech", "translation"]
    assert len(calls) == 2 and calls[0]["stream"] and not calls[1]["stream"]


def test_request_trace_is_bounded_and_omits_images_headers():
    trace = PromptTrace(limit=2)
    body = {"model": "test", "authorization": "private", "messages": [
        {"role": "user", "content": [{"type": "text", "text": "actual question"},
                                     {"type": "image_url", "image_url": {"url": "data:image/png;base64,private-image"}}]}]}
    trace.record(body, phase="main"); body["messages"][0]["content"][0]["text"] = "changed"
    for phase in ("speech_repair", "subtitle_repair"):
        trace.record({"messages": []}, phase=phase)
    result = trace.export()
    assert len(result["requests"]) == 2
    trace.record(body, phase="main")
    rendered = json.dumps(trace.export())
    assert "private-image" not in rendered and "private\"" not in rendered
    assert "sha256" in rendered


@pytest.mark.asyncio
async def test_runtime_records_actual_request_and_expression_fallback(tmp_path):
    cfg = Settings(ROOT, data_root=tmp_path)
    cfg.values.update(provider="openai", model="test", send_screenshot=False)
    cfg.key = lambda: "fixture"
    runtime = AgentRuntime(cfg, desktop=Desktop(), tts=Tts())
    ws = Ws(); runtime.clients.add(ws)
    calls = []
    def respond(request):
        calls.append(json.loads(request.content))
        return sse_response([VALID])
    runtime.model_client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
    try:
        await runtime.handle({"type": "turn.start", "text": "实际问题"})
        await runtime.task
        traces = runtime.prompt_trace.export()["requests"]
        assert traces[-1]["body"] == calls[-1]
        assert traces[-1]["conversation_id"] == runtime.conversations.current_id
        assert any(event["type"] == "model.validation" and "expression:fallback_missing" in event["issues"] for event in ws.events)
        assert len([event for event in ws.events if event["type"] == "utterance.ready"]) == 1
    finally:
        await runtime.close()
