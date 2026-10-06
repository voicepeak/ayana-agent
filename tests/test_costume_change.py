import asyncio
import json
from pathlib import Path

import pytest

from services.agent.config import Settings
from services.agent.runtime import AgentRuntime
from test_runtime import Desktop, Tts, Ws


def runtime_for(tmp_path, tts=None):
    (tmp_path / "config").mkdir(exist_ok=True)
    (tmp_path / "config/local.json").write_text(json.dumps({
        "provider": "local", "avatar_costume": "校服", "voice": {"voice_mode": "silent"},
    }), encoding="utf-8")
    cfg = Settings(Path(__file__).resolve().parents[1], data_root=tmp_path)
    return AgentRuntime(cfg, desktop=Desktop(), tts=tts or Tts())


def other_costume(runtime):
    current = runtime.settings.values.get("avatar_costume", "校服")
    return next(item["costume"] for item in runtime.avatars.mapping["assets"].values()
                if item["costume"] != current)


@pytest.mark.asyncio
async def test_idle_outfit_save_only_updates_settings_without_speech(tmp_path):
    runtime = runtime_for(tmp_path)
    ws = Ws()
    runtime.clients.add(ws)
    costume = other_costume(runtime)
    generation, turn, conversation = runtime.generation, runtime.turn_id, runtime.conversations.current_id
    try:
        await runtime.handle({"type": "settings.update", "request_id": "outfit", "settings": {"avatar_costume": costume}})
        await asyncio.sleep(.02)
        assert runtime.task is None
        assert (runtime.generation, runtime.turn_id, runtime.conversations.current_id) == (generation, turn, conversation)
        assert not runtime.utterances
        assert not any(e["type"] in {"utterance.ready", "subtitle.ready", "audio.ready", "user.message", "generation.cancelled", "task.state"} for e in ws.events)
        assert any(e["type"] == "settings.ready" and e.get("request_id") == "outfit" for e in ws.events)
        assert Settings(runtime.settings.root, data_root=tmp_path).values["avatar_costume"] == costume
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_outfit_switch_during_generation_keeps_voice_task_and_turn(tmp_path):
    runtime = runtime_for(tmp_path, Tts(.08))
    ws = Ws()
    runtime.clients.add(ws)
    try:
        await runtime.handle({"type": "turn.start", "text": "hello"})
        await asyncio.sleep(.015)
        generation, task, turn = runtime.generation, runtime.task, runtime.turn_id
        assert task and not task.done()
        cancel_count = len(runtime.tts.cancelled)
        await runtime.handle({"type": "settings.update", "settings": {"avatar_costume": other_costume(runtime)}})
        await runtime.handle({"type": "settings.update", "settings": {"avatar_costume": "校服"}})
        assert runtime.generation == generation and runtime.task is task and runtime.turn_id == turn
        assert len(runtime.tts.cancelled) == cancel_count
        await task
        await asyncio.sleep(.02)
        audio = [e for e in ws.events if e["type"] == "audio.ready"]
        assert len(audio) == 2 and all(e["generation_id"] == generation for e in audio)
        assert not any(e.get("presentation") == "costume-change" for e in ws.events)
        # Existing playback receipts still release the same queue after dressing.
        for reply in audio:
            await runtime.handle({"type": "playback.ended", "utterance_id": reply["utterance_id"],
                                  "generation_id": generation, "played_samples": 1600})
        assert not runtime.pending
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_same_outfit_and_invalid_outfit_do_not_announce(tmp_path):
    runtime = runtime_for(tmp_path)
    ws = Ws()
    runtime.clients.add(ws)
    try:
        await runtime.handle({"type": "settings.update", "settings": {"avatar_costume": "校服", "volume": .5}})
        with pytest.raises(ValueError, match="Unknown avatar costume"):
            await runtime.handle({"type": "settings.update", "settings": {"avatar_costume": "missing"}})
        assert runtime.task is None
        assert not runtime.utterances
        assert runtime.settings.values["avatar_costume"] == "校服"
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_design_save_does_not_cancel_pending_speech(tmp_path):
    runtime = runtime_for(tmp_path, Tts(.08))
    ws = Ws()
    runtime.clients.add(ws)
    try:
        await runtime.handle({"type": "turn.start", "text": "hello"})
        generation, task = runtime.generation, runtime.task
        await runtime.handle({"type": "settings.update", "request_id": "design", "settings": {
            "companion_ui": {"font_size": 26, "show_bubbles": False, "bubble_color": "#faf3e5", "background_x": 23}, "volume": .4,
        }})
        assert runtime.generation == generation
        assert runtime.task is task and not task.cancelled()
        await task
        await asyncio.sleep(.02)
        assert any(e["type"] == "audio.ready" and e["generation_id"] == generation for e in ws.events)
        assert any(e["type"] == "settings.ready" and e.get("request_id") == "design" for e in ws.events)
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_failed_outfit_save_keeps_current_generation(tmp_path, monkeypatch):
    runtime = runtime_for(tmp_path, Tts(.08))
    try:
        await runtime.handle({"type": "turn.start", "text": "hello"})
        generation, task = runtime.generation, runtime.task
        def fail_write(patch):
            raise OSError("disk unavailable")
        monkeypatch.setattr(runtime.settings, "update", fail_write)
        with pytest.raises(OSError, match="disk unavailable"):
            await runtime.handle({"type": "settings.update", "settings": {"avatar_costume": other_costume(runtime)}})
        assert runtime.generation == generation and runtime.task is task
        assert runtime.settings.values["avatar_costume"] == "校服"
        await task
    finally:
        await runtime.close()
