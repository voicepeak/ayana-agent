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
    async def send_json(self, value):
        self.events.append(value)


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
async def test_long_desktop_action_does_not_block_cancel_command(tmp_path):
    import threading
    import time
    started, cancelled = threading.Event(), threading.Event()
    class SlowDesktop(Desktop):
        def cancel(self):
            cancelled.set()
        def execute(self, action, snapshot):
            started.set()
            cancelled.wait(2)
            return {"status": "stopped"}
    runtime = AgentRuntime(settings(tmp_path), desktop=SlowDesktop(), tts=Tts())
    runtime.clients.add(Ws())
    runtime.target = {"target_id": "target"}
    runtime.snapshot = {"snapshot_id": "snap"}
    runtime.mode = "execute"
    await runtime.handle({"type": "tool.execute", "snapshot_id": "snap", "action": {"kind": "type", "text": "demo"}})
    await asyncio.to_thread(started.wait, 1)
    before = time.perf_counter()
    await runtime.handle({"type": "generation.cancel"})
    assert time.perf_counter() - before < .15
    assert cancelled.is_set()
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
async def test_highlight_result_can_keep_its_action_kind(tmp_path):
    class HighlightDesktop(Desktop):
        def execute(self, action, snapshot):
            return {"kind": "highlight", "screen_rect": {"x": 10, "y": 20, "width": 90, "height": 40}}
    runtime = AgentRuntime(settings(tmp_path), desktop=HighlightDesktop(), tts=Tts())
    ws = Ws()
    runtime.clients.add(ws)
    runtime.target = {"target_id": "target"}
    runtime.snapshot = {"snapshot_id": "snap"}
    await runtime.handle({"type": "tool.execute", "snapshot_id": "snap", "action": {"kind": "highlight"}})
    await runtime.action_task
    result = next(e for e in ws.events if e["type"] == "highlight.ready")
    assert result["kind"] == "highlight" and result["screen_rect"]["width"] == 90
    assert not any(e["type"] == "tool.failed" for e in ws.events)
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
async def test_capture_failure_invalidates_old_image_and_actions(tmp_path):
    class ClosedDesktop(Desktop):
        def capture(self, target):
            raise RuntimeError("Target closed")
    runtime = AgentRuntime(settings(tmp_path), desktop=ClosedDesktop(), tts=Tts())
    ws = Ws()
    runtime.clients.add(ws)
    runtime.target = {"target_id": "closed"}
    runtime.snapshot = {"snapshot_id": "old", "png_base64": "old-image"}
    runtime.actions["old"] = {"kind": "click"}
    with pytest.raises(RuntimeError, match="Target closed"):
        await runtime.capture()
    assert runtime.snapshot is None and not runtime.actions
    assert ws.events[-1]["type"] == "snapshot.invalidated"
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
async def test_proposed_highlight_allowed_in_teach_mode_but_click_rejected(tmp_path):
    class ActionDesktop(Desktop):
        def execute(self, action, snapshot):
            return {"kind": action["kind"], "screen_rect": {"x": 0, "y": 0, "width": 30, "height": 30}}
    runtime = AgentRuntime(settings(tmp_path), desktop=ActionDesktop(), tts=Tts())
    ws = Ws()
    runtime.clients.add(ws)
    runtime.target = {"target_id": "target"}
    runtime.snapshot = {"snapshot_id": "snap"}
    await runtime._propose_action({"action": {"kind": "highlight"}})
    action_id = next(iter(runtime.actions))
    await runtime.handle({"type": "tool.execute", "action_id": action_id, "snapshot_id": "snap"})
    await runtime.action_task
    assert any(event["type"] == "highlight.ready" for event in ws.events)
    await runtime._propose_action({"action": {"kind": "click"}})
    action_id = next(iter(runtime.actions))
    with pytest.raises(ValueError, match="单步执行"):
        await runtime.handle({"type": "tool.execute", "action_id": action_id, "snapshot_id": "snap"})
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
    runtime.repository = {"root": "selected", "evidence": [{"content": "unique-repository-evidence"}], "files": []}
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
    assert json.dumps(calls[2]).count("unique-repository-evidence") == 1
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
async def test_switching_back_to_teach_cancels_in_flight_input(tmp_path):
    import threading
    started, cancelled = threading.Event(), threading.Event()
    class SlowDesktop(Desktop):
        def cancel(self): cancelled.set()
        def execute(self, action, snapshot):
            cancelled.clear()
            started.set()
            cancelled.wait(2)
            return {"status": "stopped"}
    runtime = AgentRuntime(settings(tmp_path), desktop=SlowDesktop(), tts=Tts())
    runtime.clients.add(Ws())
    runtime.target = {"target_id": "target"}
    runtime.snapshot = {"snapshot_id": "snap"}
    runtime.mode = "execute"
    await runtime.handle({"type": "tool.execute", "snapshot_id": "snap", "action": {"kind": "type", "text": "demo"}})
    await asyncio.to_thread(started.wait, 1)
    await runtime.handle({"type": "mode.set", "mode": "teach"})
    assert cancelled.is_set() and runtime.mode == "teach" and runtime.action_task is None
    await runtime.close()


@pytest.mark.asyncio
async def test_tool_rounds_and_interrupted_output_keep_factual_context(tmp_path):
    import httpx
    from tests.test_model import sse_response
    root = Path(__file__).resolve().parents[1]
    cfg = Settings(root=root, data_root=tmp_path)
    cfg.values.update(provider="openai", model="test", send_screenshot=False)
    cfg.key = lambda: "test-key"
    runtime = AgentRuntime(cfg, desktop=Desktop(), tts=Tts())
    runtime.repository = {"root": str(root), "files": [], "evidence": []}
    runtime.clients.add(Ws())
    calls = []
    def respond(request):
        calls.append(json.loads(request.content)["messages"])
        if len(calls) == 1:
            return sse_response([{"type": "tool", "name": "list_files", "arguments": {}}])
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
    assert calls[2][:len(calls[1])] == calls[1]  # tool result and complete tool round retained
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
    runtime.repository = {"root": str(tmp_path), "files": [], "evidence": []}
    ws = Ws()
    runtime.clients.add(ws)
    calls = []
    def respond(request):
        calls.append(json.loads(request.content)["messages"])
        if len(calls) == 1:
            return sse_response([{"type": "speech", "key": "s1", "speech_ja": "まず入口を見よう。"},
                                 {"type": "tool", "name": "list_files", "arguments": {}}])
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


def test_computer_tool_is_hidden_until_available(tmp_path):
    runtime = AgentRuntime(settings(tmp_path), desktop=Desktop(), tts=Tts())
    names = [item["function"]["name"] for item in runtime.registry.openai_schemas()]
    assert "computer__run" not in names
    runtime.computer = type("Stub", (), {"status": {"available": True}})()
    names = [item["function"]["name"] for item in runtime.registry.openai_schemas()]
    assert "computer__run" in names


@pytest.mark.asyncio
async def test_unavailable_tool_execution_is_rejected(tmp_path):
    runtime = AgentRuntime(settings(tmp_path), desktop=Desktop(), tts=Tts())
    with pytest.raises(ToolError, match="不可用"):
        await runtime.registry.execute("computer.run", {"goal": "打开设置"})
