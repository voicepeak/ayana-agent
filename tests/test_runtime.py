import asyncio
import base64
import json
import struct
from pathlib import Path
import pytest

from services.agent.config import Settings
from services.agent.runtime import AgentRuntime


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
