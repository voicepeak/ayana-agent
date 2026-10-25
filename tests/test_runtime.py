import asyncio
import base64
import json
import struct
from pathlib import Path
import pytest

from services.agent.config import Settings
from services.agent.runtime import AgentRuntime
from services.agent.tools.registry import ToolError


class Ws:
    def __init__(self):
        self.events = []
        self.binary = []
    async def send_json(self, value):
        self.events.append(value)
    async def send_bytes(self, value):
        self.binary.append(value)


class Desktop:
    status = {"available": False}
    def close(self): pass
    def cancel(self): pass


class Tts:
    status = {"state": "ready", "engine": "test"}
    def __init__(self, delay=0):
        self.delay = delay
        self.cancelled = []
    async def start(self): pass
    async def close(self): pass
    async def cancel(self, gen): self.cancelled.append(gen)
    async def synthesize(self, text, generation_id):
        await asyncio.sleep(self.delay)
        return {"sample_rate": 16000, "channels": 1, "duration_ms": 100,
                "pcm_base64": base64.b64encode(struct.pack("<1600f", *([0.1] * 1600))).decode(), "engine": "test"}


def settings(tmp):
    root = Path(__file__).resolve().parents[1]
    (tmp / "config").mkdir()
    (tmp / "config/default.json").write_text((root / "config/default.json").read_text())
    return Settings(tmp)


@pytest.mark.asyncio
async def test_cancel_stops_old_audio_and_marks_partial_history(tmp_path):
    runtime = AgentRuntime(settings(tmp_path), desktop=Desktop(), tts=Tts(0.1))
    ws = Ws()
    runtime.clients.add(ws)
    await runtime.start()
    await runtime.handle({"type": "turn.start", "text": "hello"})
    await asyncio.sleep(0.03)
    old = runtime.generation
    await runtime.cancel()
    await asyncio.sleep(0.15)
    assert not [e for e in ws.events if e["type"] == "audio.ready" and e["generation_id"] == old]
    assert runtime.pending == {}
    assert all(r["status"] == "cancelled" for r in runtime.store.history())
    await runtime.close()


@pytest.mark.asyncio
async def test_audio_generation_association_and_receipts(tmp_path):
    runtime = AgentRuntime(settings(tmp_path), desktop=Desktop(), tts=Tts())
    ws = Ws()
    runtime.clients.add(ws)
    await runtime.start()
    await runtime.handle({"type": "turn.start", "text": "hello"})
    await runtime.task
    ready = [e for e in ws.events if e["type"] == "audio.ready"]
    assert len(ready) == 2
    uid = ready[0]["utterance_id"]
    await runtime.handle({"type": "playback.started", "utterance_id": uid, "generation_id": runtime.generation})
    await runtime.cancel()
    await runtime.handle({"type": "playback.cancelled", "utterance_id": uid, "generation_id": ready[0]["generation_id"], "played_samples": 800})
    record = next(r for r in runtime.store.history() if r["utterance_id"] == uid)
    assert record["status"] == "partial" and record["played_samples"] == 800
    historical = [json.loads(line) for item in runtime.store.context() if item["role"] == "assistant" for line in item["content"].splitlines()]
    interrupted = next(item for item in historical if item["type"] == "speech" and item["key"] == uid)
    assert interrupted["reception"] == "partial" and interrupted["played_samples"] == 800
    assert all(item["type"] in {"speech", "translation"} for item in historical)
    await runtime.close()


@pytest.mark.asyncio
async def test_unavailable_voice_falls_back_to_text_without_synthesis_errors(tmp_path):
    class MissingVoice(Tts):
        status = {"state": "failed", "engine": "silent", "error": "voice pack not installed"}
        async def synthesize(self, text, generation_id):
            raise AssertionError("synthesis must not run when the voice engine failed")

    runtime = AgentRuntime(settings(tmp_path), desktop=Desktop(), tts=MissingVoice())
    ws = Ws()
    runtime.clients.add(ws)
    try:
        await runtime.start()
        await runtime.handle({"type": "turn.start", "text": "hello"})
        await runtime.task
        utterances = [event for event in ws.events if event["type"] == "utterance.ready"]
        assert utterances and all(event["audio_enabled"] is False for event in utterances)
        assert not any(event["type"] == "audio.ready" for event in ws.events)
        assert not any(event["type"] == "error" and event.get("source") == "tts" for event in ws.events)
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_online_turn_requires_api_key_and_model(tmp_path, monkeypatch):
    monkeypatch.delenv("AYANA_API_KEY", raising=False)
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    cfg = settings(tmp_path)
    cfg.values.update(provider="openai", model="", voice={"voice_mode": "silent"})
    runtime = AgentRuntime(cfg, desktop=Desktop(), tts=Tts())
    ws = Ws()
    runtime.clients.add(ws)
    try:
        await runtime.handle({"type": "turn.start", "text": "hello"})
        assert runtime.task is None
        assert any(event["type"] == "error" and "API Key" in event.get("message", "") for event in ws.events)
        assert any(event["type"] == "task.state" and event.get("state") == "failed" for event in ws.events)
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_bounded_audio_wait_is_released_by_cancel(tmp_path):
    runtime = AgentRuntime(settings(tmp_path), desktop=Desktop(), tts=Tts())
    runtime.pending.update({"1": 4000, "2": 4000})
    waiting = asyncio.create_task(runtime._reserve_audio("3", 4000, runtime.generation))
    await asyncio.sleep(0.02)
    assert not waiting.done()
    await runtime.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiting
    await runtime.close()


@pytest.mark.asyncio
async def test_stt_settings_replaces_cached_recognizer_and_cancel_restores_input(tmp_path):
    from unittest.mock import AsyncMock
    runtime = AgentRuntime(settings(tmp_path), desktop=Desktop(), tts=Tts())
    ws = Ws()
    runtime.clients.add(ws)
    old_recognizer = type("Recognizer", (), {"close": AsyncMock()})()
    runtime.stt = old_recognizer
    await runtime.handle({"type": "settings.update", "settings": {"stt": {"provider": "disabled"}}})
    old_recognizer.close.assert_awaited_once()
    assert runtime.stt is None
    assert runtime.settings.values["stt"]["provider"] == "disabled"
    assert any(e["type"] == "input.state" and e["state"] == "idle" for e in ws.events)
    await runtime.close()


@pytest.mark.asyncio
async def test_transcript_waits_for_review_and_late_cancelled_result_is_dropped(tmp_path):
    from unittest.mock import AsyncMock
    runtime = AgentRuntime(settings(tmp_path), desktop=Desktop(), tts=Tts())
    ws = Ws()
    runtime.clients.add(ws)
    runtime.stt = type("Recognizer", (), {"transcribe": AsyncMock(return_value="识别到的代码仓库"), "close": AsyncMock()})()
    await runtime._transcribe({"audio_base64": "sample", "mime_type": "audio/wav"}, runtime.generation)
    assert any(e["type"] == "input.transcribed" for e in ws.events)
    assert not any(e["type"] == "user.message" for e in ws.events)
    old = runtime.generation
    await runtime.cancel()
    ws.events.clear()
    await runtime._transcribe({"audio_base64": "sample"}, old)
    assert not any(e["type"] == "input.transcribed" for e in ws.events)
    await runtime.close()


@pytest.mark.asyncio
async def test_summon_does_not_bind_a_window_and_observation_is_on_demand(tmp_path):
    class ForegroundDesktop(Desktop):
        def __init__(self):
            self.calls = 0
        def foreground(self):
            return {"target_id": "front", "title": "Home / X"}
        def capture(self, target):
            self.calls += 1
            return {"snapshot_id": "fresh", "target": {"target_id": "front", "title": "Home / X"}}
    desktop = ForegroundDesktop()
    runtime = AgentRuntime(settings(tmp_path), desktop=desktop, tts=Tts())
    ws = Ws()
    runtime.clients.add(ws)
    try:
        runtime.target = {"target_id": "old"}
        runtime.snapshot = {"snapshot_id": "old"}
        await runtime.handle({"type": "session.start"})
        assert runtime.target is None and runtime.snapshot is None and runtime.companion_visible
        assert desktop.calls == 0
        await runtime._desktop_observe()
        assert desktop.calls == 1 and runtime.snapshot["snapshot_id"] == "fresh"
        await runtime.handle({"type": "session.close"})
        assert not runtime.companion_visible and not runtime._attention_idle()
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_chat_expires_stale_image_without_capturing_hidden_window(tmp_path):
    import httpx
    import time
    from native.windows.desktop import DesktopError
    from tests.test_model import sse_response

    class HiddenDesktop(Desktop):
        def __init__(self):
            self.calls = 0
        def capture(self, target):
            self.calls += 1
            raise DesktopError("window_unavailable", "Target must be visible and not minimized")

    cfg = Settings(root=Path(__file__).resolve().parents[1], data_root=tmp_path)
    cfg.values.update(provider="openai", model="test", send_screenshot=True)
    cfg.key = lambda: "test-key"
    desktop = HiddenDesktop()
    runtime = AgentRuntime(cfg, desktop=desktop, tts=Tts())
    ws = Ws()
    runtime.clients.add(ws)
    runtime.target = {"target_id": "chrome", "title": "Home / X"}
    runtime.snapshot = {"snapshot_id": "old", "png_base64": "stale-image",
                        "captured_at_monotonic_ms": (time.monotonic() - 31) * 1000}
    calls = []
    runtime.model_client = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: calls.append(json.loads(request.content)["messages"]) or sse_response([
        {"type": "speech", "key": "s1", "speech_ja": "大丈夫だよ。", "intent": "explain"}])))
    await runtime.handle({"type": "turn.start", "text": "我错了"})
    await runtime.task
    context = json.loads(calls[0][-1]["content"][0]["text"])
    assert context["observation"]["code"] == "stale_snapshot" and context["snapshot_id"] is None
    assert desktop.calls == 0
    assert "stale-image" not in json.dumps(calls[0])
    assert any(event["type"] == "utterance.ready" for event in ws.events)
    assert not any(event["type"] == "error" for event in ws.events)
    runtime.settings.values["send_screenshot"] = False
    await runtime.close()


@pytest.mark.asyncio
async def test_display_settings_do_not_restart_unchanged_voice_engine(tmp_path):
    from unittest.mock import AsyncMock
    cfg = settings(tmp_path)
    cfg.values["voice"] = {"voice_mode": "sovits", "engine_root": "user-engine", "model_gpt": "user-model"}
    tts = Tts()
    tts.close = AsyncMock()
    runtime = AgentRuntime(cfg, desktop=Desktop(), tts=tts)
    await runtime.start()
    await runtime.start_task
    startup = runtime.start_task
    await runtime.handle({"type": "settings.update", "settings": {"sentence_motion": False, "voice": dict(cfg.values["voice"])}})
    assert runtime.tts is tts
    assert runtime.start_task is startup
    tts.close.assert_not_awaited()
    await runtime.close()


@pytest.mark.asyncio
async def test_deferred_voice_config_persists_without_cancelling_or_reloading(tmp_path):
    from unittest.mock import AsyncMock
    cfg = settings(tmp_path)
    tts = Tts()
    tts.close = AsyncMock()
    runtime = AgentRuntime(cfg, desktop=Desktop(), tts=tts)
    await runtime.start()
    await runtime.start_task
    startup = runtime.start_task
    generation = runtime.generation
    voice = {"voice_mode": "sovits", "python": "pack/python.exe", "engine_root": "pack/engine",
             "model_gpt": "pack/gpt.ckpt", "model_sovits": "pack/sovits.pth",
             "reference_audio": "pack/ref.wav", "device": "cuda", "precision": "fp16", "gpu_index": 0}
    await runtime.handle({"type": "settings.update", "settings": {"voice": voice}, "defer_voice": True})
    assert runtime.generation == generation
    assert runtime.tts is tts
    assert runtime.start_task is startup
    tts.close.assert_not_awaited()
    assert runtime.settings.values["voice"]["voice_mode"] == "sovits"
    assert Settings(cfg.root, data_root=tmp_path).values["voice"]["engine_root"] == "pack/engine"
    await runtime.close()


@pytest.mark.asyncio
async def test_invalid_settings_do_not_cancel_running_generation(tmp_path):
    runtime = AgentRuntime(settings(tmp_path), desktop=Desktop(), tts=Tts())
    generation = runtime.generation
    try:
        with pytest.raises(ValueError):
            await runtime.handle({"type": "settings.update", "settings": {"volume": 2}})
        assert runtime.generation == generation
        assert runtime.tts.cancelled == []
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_save_ack_is_correlated_and_search_capability_is_refreshed(tmp_path):
    runtime = AgentRuntime(settings(tmp_path), desktop=Desktop(), tts=Tts())
    ws = Ws()
    runtime.clients.add(ws)
    try:
        await runtime.handle({"type": "settings.update", "request_id": "settings-test", "settings": {"search_provider": "bing"}})
        await asyncio.sleep(.02)
        ack = next(e for e in ws.events if e["type"] == "settings.ready")
        assert ack["request_id"] == "settings-test"
        assert ack["settings"]["search_provider"] == "bing"
        assert any(e["type"] == "capabilities.ready" and e["search_configured"] for e in ws.events)
    finally:
        await runtime.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("save_history", [True, False])
async def test_online_context_preserves_request_prefix_across_turns_and_receipts(tmp_path, save_history):
    import httpx
    from tests.test_model import sse_response
    root = Path(__file__).resolve().parents[1]
    cfg = Settings(root=root, data_root=tmp_path)
    cfg.values.update(provider="openai", model="test", send_screenshot=False, save_history=save_history)
    cfg.key = lambda: "test-key"
    runtime = AgentRuntime(cfg, desktop=Desktop(), tts=Tts())
    ws = Ws()
    runtime.clients.add(ws)
    calls = []
    def respond(request):
        calls.append(json.loads(request.content)["messages"])
        return sse_response([{"type": "speech", "key": "s1", "speech_ja": "一緒に見よう。", "intent": "explain"},
                             {"type": "translation", "key": "s1", "display_zh": "一起看。"}])
    runtime.model_client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
    for text in ["第一轮", "第二轮", "第三轮"]:
        await runtime.handle({"type": "turn.start", "text": text})
        await runtime.task
        audio = [event for event in ws.events if event["type"] == "audio.ready"][-1]
        await runtime.handle({"type": "playback.ended", "utterance_id": audio["utterance_id"],
                              "generation_id": runtime.generation, "played_samples": 1600})
    assert len(calls) == 3
    assert calls[1][:len(calls[0])] == calls[0]
    assert calls[2][:len(calls[1])] == calls[1]
    assistant = calls[1][-2]
    assert json.loads(assistant["content"].splitlines()[0])["key"] == "s1"
    assert "played_samples" not in assistant["content"]
    reception = json.loads(calls[2][-1]["content"][0]["text"])["previous_reply_reception"]
    assert reception[0]["status"] == "played" and reception[0]["played_samples"] == 1600
    assert bool(runtime.store.model_turns(runtime.prompt_history.scope)) == save_history
    await runtime.close()


@pytest.mark.asyncio
async def test_concurrent_commands_cannot_leave_an_untracked_old_turn(tmp_path):
    runtime = AgentRuntime(settings(tmp_path), desktop=Desktop(), tts=Tts(.1))
    runtime.clients.add(Ws())
    await asyncio.gather(runtime.handle({"type": "turn.start", "text": "one"}),
                         runtime.handle({"type": "turn.start", "text": "two"}))
    await runtime.task
    assert all(record["generation_id"] == runtime.generation or record["status"] == "cancelled"
               for record in runtime.store.history())
    await asyncio.gather(runtime.close(), runtime.close())
    assert runtime.closed


@pytest.mark.asyncio
async def test_tool_rounds_and_interrupted_output_keep_factual_context(tmp_path):
    import httpx
    from tests.test_model import sse_response
    root = Path(__file__).resolve().parents[1]
    cfg = Settings(root=root, data_root=tmp_path)
    cfg.values.update(provider="openai", model="test", send_screenshot=False)
    cfg.key = lambda: "test-key"
    runtime = AgentRuntime(cfg, desktop=Desktop(), tts=Tts())
    runtime.clients.add(Ws())
    calls = []
    def respond(request):
        calls.append(json.loads(request.content)["messages"])
        if len(calls) == 1:
            return sse_response([{"type": "tool", "name": "attention.configure", "arguments": {"enabled": True}}])
        speech = {"type": "speech", "key": "s1", "speech_ja": "一緒に見よう。"}
        if len(calls) == 3:
            return sse_response([speech, {"type": "unknown"}])
        return sse_response([speech])
    runtime.model_client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
    await runtime.handle({"type": "turn.start", "text": "inspect"})
    await runtime.task
    assert len(calls) == 2
    await runtime.handle({"type": "turn.start", "text": "interrupted"})
    await runtime.task
    uid = runtime.last_reply_keys["s1"]
    await runtime.handle({"type": "utterance.displayed", "utterance_id": uid, "generation_id": runtime.generation})
    await runtime.handle({"type": "turn.start", "text": "continue"})
    await runtime.task
    from services.agent.context import text_messages
    retained = text_messages(calls[1])
    assert calls[2][:len(retained)] == retained  # factual tool exchange retained, old control hints omitted
    tail = json.loads(calls[3][-1]["content"][0]["text"])
    assert tail["previous_interrupted_reply"][0]["speech_ja"] == "一緒に見よう。"
    assert tail["previous_interrupted_reply"][0]["displayed"] is True
    assert tail["previous_interrupted_reply"][0]["status"] == "cancelled"
    await runtime.close()


@pytest.mark.asyncio
async def test_repeated_speech_key_across_tool_rounds_keeps_both_sentences(tmp_path):
    import httpx
    from tests.test_model import sse_response
    root = Path(__file__).resolve().parents[1]
    cfg = Settings(root=root, data_root=tmp_path)
    cfg.values.update(provider="openai", model="test", send_screenshot=False)
    cfg.key = lambda: "test-key"
    runtime = AgentRuntime(cfg, desktop=Desktop(), tts=Tts())
    ws = Ws()
    runtime.clients.add(ws)
    calls = []
    def respond(request):
        calls.append(json.loads(request.content)["messages"])
        if len(calls) == 1:
            return sse_response([{"type": "speech", "key": "s1", "speech_ja": "まず入口を見よう。"},
                                 {"type": "tool", "name": "attention.configure", "arguments": {"enabled": True}}])
        return sse_response([{"type": "speech", "key": "s1", "speech_ja": "次に進もう。"},
                             {"type": "translation", "key": "s1", "display_zh": "接着往下。"}])
    runtime.model_client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
    await runtime.handle({"type": "turn.start", "text": "inspect"})
    await runtime.task
    speeches = [event for event in ws.events if event["type"] == "utterance.ready"]
    assert [event["speech_ja"] for event in speeches] == ["まず入口を見よう。", "次に進もう。"]
    assert len({event["utterance_id"] for event in speeches}) == 2
    assert not any(event["type"] == "error" for event in ws.events)
    subtitle = next(event for event in ws.events if event["type"] == "subtitle.ready")
    assert subtitle["display_zh"] == "接着往下。"
    # The second round's sentence, not the first, receives the translation.
    assert subtitle["utterance_id"] == speeches[1]["utterance_id"]
    await runtime.close()


@pytest.mark.asyncio
async def test_keyless_speech_with_stale_translation_key_delivers_turn(tmp_path):
    # Regression: the model omitted the speech key and used an unrelated key
    # for its Chinese subtitle; the turn must deliver both instead of failing.
    import httpx
    from tests.test_model import sse_response
    root = Path(__file__).resolve().parents[1]
    cfg = Settings(root=root, data_root=tmp_path)
    cfg.values.update(provider="openai", model="test", send_screenshot=False)
    cfg.key = lambda: "test-key"
    runtime = AgentRuntime(cfg, desktop=Desktop(), tts=Tts())
    ws = Ws()
    runtime.clients.add(ws)
    runtime.model_client = httpx.AsyncClient(transport=httpx.MockTransport(
        lambda request: sse_response([{"type": "speech", "speech_ja": "好きって言われても、困るな。", "intent": "playful"},
                                      {"type": "translation", "key": "0", "display_zh": "就算你说喜欢我，我也会很为难。"}])))
    await runtime.handle({"type": "turn.start", "text": "我喜欢你"})
    await runtime.task
    speech = next(event for event in ws.events if event["type"] == "utterance.ready")
    subtitle = next(event for event in ws.events if event["type"] == "subtitle.ready")
    assert subtitle["utterance_id"] == speech["utterance_id"]
    assert subtitle["display_zh"] == "就算你说喜欢我，我也会很为难。"
    assert not any(event["type"] == "error" for event in ws.events)
    assert any(event["type"] == "task.state" and event["state"] == "idle" for event in ws.events)
    await runtime.close()


def test_unavailable_tools_are_hidden_from_the_model(tmp_path):
    runtime = AgentRuntime(settings(tmp_path), desktop=Desktop(), tts=Tts())
    names = [item["function"]["name"] for item in runtime.registry.openai_schemas()]
    assert "desktop__observe" not in names
    assert "attention__configure" in names and "web__fetch" in names


@pytest.mark.asyncio
async def test_late_model_failure_does_not_discard_committed_audio(tmp_path):
    import httpx
    from tests.test_model import sse_response, VALID
    cfg = Settings(root=Path(__file__).resolve().parents[1], data_root=tmp_path)
    cfg.values.update(provider="openai", model="test", send_screenshot=False)
    cfg.key = lambda: "test-key"
    runtime = AgentRuntime(cfg, desktop=Desktop(), tts=Tts(.05))
    ws = Ws()
    runtime.clients.add(ws)
    runtime.model_client = httpx.AsyncClient(transport=httpx.MockTransport(
        lambda request: sse_response([VALID, {**VALID, "key": "s2"}, {"type": "unknown"}])))
    await runtime.handle({"type": "turn.start", "text": "hello"})
    await runtime.task
    speeches = [e for e in ws.events if e["type"] == "utterance.ready"]
    audio = [e for e in ws.events if e["type"] == "audio.ready"]
    assert len(speeches) == 2
    assert [e["utterance_id"] for e in audio] == [e["utterance_id"] for e in speeches]
    assert any(e["type"] == "error" and e["source"] == "turn" for e in ws.events)
    await runtime.close()


@pytest.mark.asyncio
async def test_unavailable_subtitle_repair_completes_turn_with_committed_speech(tmp_path):
    import httpx
    from tests.test_model import sse_response, VALID
    cfg = Settings(root=Path(__file__).resolve().parents[1], data_root=tmp_path)
    cfg.values.update(provider="openai", model="test", send_screenshot=False)
    cfg.key = lambda: "test-key"
    runtime = AgentRuntime(cfg, desktop=Desktop(), tts=Tts())
    ws = Ws()
    runtime.clients.add(ws)
    def respond(request):
        if json.loads(request.content)["stream"]:
            raw = sse_response([VALID]).text
            chunk = {"choices": [{"delta": {"content": '{"type":"translation","key":"s1","display_zh":"未完'}, "finish_reason": None}]}
            raw = raw.replace("data: [DONE]", "data: " + json.dumps(chunk) + "\n\ndata: [DONE]")
            return httpx.Response(200, text=raw)
        return httpx.Response(503, text="unavailable")
    runtime.model_client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
    await runtime.handle({"type": "turn.start", "text": "hello"})
    await runtime.task
    assert any(event["type"] == "utterance.ready" for event in ws.events)
    assert not any(event["type"] == "error" for event in ws.events)
    assert not any(event["type"] == "subtitle.ready" for event in ws.events)
    assert any(event["type"] == "task.state" and event["state"] == "idle" for event in ws.events)
    await runtime.close()


@pytest.mark.asyncio
async def test_speech_drain_does_not_hang_when_worker_exits_with_full_queue(tmp_path):
    runtime = AgentRuntime(settings(tmp_path), desktop=Desktop(), tts=Tts())
    queue = asyncio.Queue(maxsize=1)
    await queue.put("pending")
    async def stop():
        await asyncio.sleep(.01)
    speaker = asyncio.create_task(stop())
    await asyncio.wait_for(runtime._drain_speech(queue, speaker), .5)
    assert queue.qsize() == 1
    await runtime.close()


@pytest.mark.asyncio
async def test_unavailable_tool_execution_is_rejected(tmp_path):
    runtime = AgentRuntime(settings(tmp_path), desktop=Desktop(), tts=Tts())
    try:
        with pytest.raises(ToolError) as failure:
            await runtime.registry.execute("desktop.observe", {})
        assert failure.value.code == "tool_unavailable"
    finally:
        await runtime.close()
