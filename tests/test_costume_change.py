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
async def test_saving_outfit_returns_speech_audio_and_catalog_asset_without_user_turn(tmp_path):
    runtime = runtime_for(tmp_path)
    ws = Ws()
    runtime.clients.add(ws)
    costume = other_costume(runtime)
    try:
        await runtime.handle({"type": "settings.update", "settings": {"avatar_costume": costume}})
        await runtime.task
        await asyncio.sleep(.02)
        reply = next(e for e in ws.events if e["type"] == "utterance.ready")
        assert reply["presentation"] == "costume-change"
        assert runtime.avatars.mapping["assets"][reply["asset_id"]]["costume"] == costume
        assert any(e["type"] == "subtitle.ready" and e["utterance_id"] == reply["utterance_id"] for e in ws.events)
        assert any(e["type"] == "audio.ready" and e["utterance_id"] == reply["utterance_id"] for e in ws.events)
        assert not any(e["type"] in {"user.message", "model.usage"} for e in ws.events)
        assert Settings(runtime.settings.root, data_root=tmp_path).values["avatar_costume"] == costume
        await runtime.handle({"type": "playback.ended", "utterance_id": reply["utterance_id"],
                              "generation_id": runtime.generation, "played_samples": 1600})
        assert not runtime.pending
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_same_outfit_other_settings_and_invalid_outfit_do_not_announce(tmp_path):
    runtime = runtime_for(tmp_path)
    ws = Ws()
    runtime.clients.add(ws)
    try:
        await runtime.handle({"type": "settings.update", "settings": {"avatar_costume": "校服", "volume": .5}})
        await runtime.handle({"type": "settings.get"})
        with pytest.raises(ValueError, match="Unknown avatar costume"):
            await runtime.handle({"type": "settings.update", "settings": {"avatar_costume": "missing"}})
        await asyncio.sleep(.02)
        assert runtime.task is None
        assert not any(e["type"] in {"utterance.ready", "audio.ready"} for e in ws.events)
        assert runtime.settings.values["avatar_costume"] == "校服"
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_second_outfit_cancels_pending_first_voice(tmp_path):
    runtime = runtime_for(tmp_path, Tts(.08))
    ws = Ws()
    runtime.clients.add(ws)
    try:
        await runtime.handle({"type": "settings.update", "settings": {"avatar_costume": other_costume(runtime)}})
        first_generation = runtime.generation
        await asyncio.sleep(.01)
        await runtime.handle({"type": "settings.update", "settings": {"avatar_costume": "校服"}})
        await runtime.task
        await asyncio.sleep(.02)
        audio = [e for e in ws.events if e["type"] == "audio.ready"]
        assert len(audio) == 1 and audio[0]["generation_id"] > first_generation
        assert runtime.settings.values["avatar_costume"] == "校服"
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_design_save_does_not_cancel_pending_outfit_voice(tmp_path):
    runtime = runtime_for(tmp_path, Tts(.08))
    ws = Ws()
    runtime.clients.add(ws)
    try:
        await runtime.handle({"type": "settings.update", "settings": {"avatar_costume": other_costume(runtime)}})
        generation, task = runtime.generation, runtime.task
        await runtime.handle({"type": "settings.update", "request_id": "design", "settings": {
            "companion_ui": {"font_size": 26}, "volume": .4, "subtitles": False,
        }})
        assert runtime.generation == generation
        assert runtime.task is task and not task.cancelled()
        await task
        assert any(e["type"] == "audio.ready" and e["generation_id"] == generation for e in ws.events)
        assert any(e["type"] == "settings.ready" and e.get("request_id") == "design" for e in ws.events)
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_failed_outfit_save_keeps_current_generation(tmp_path, monkeypatch):
    runtime = runtime_for(tmp_path, Tts(.08))
    try:
        await runtime.handle({"type": "settings.update", "settings": {"avatar_costume": other_costume(runtime)}})
        generation, task = runtime.generation, runtime.task
        def fail_write(patch):
            raise OSError("disk unavailable")
        monkeypatch.setattr(runtime.settings, "update", fail_write)
        with pytest.raises(OSError, match="disk unavailable"):
            await runtime.handle({"type": "settings.update", "settings": {"avatar_costume": "校服"}})
        assert runtime.generation == generation and runtime.task is task
        await task
    finally:
        await runtime.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("silent", [True, False])
async def test_silent_or_failed_voice_keeps_committed_outfit_and_text(tmp_path, silent):
    class NoVoice(Tts):
        async def synthesize(self, text, generation_id):
            if silent:
                return {"engine": "silent", "duration_ms": 0}
            raise RuntimeError("voice unavailable")

    runtime = runtime_for(tmp_path, NoVoice())
    ws = Ws()
    runtime.clients.add(ws)
    costume = other_costume(runtime)
    try:
        await runtime.handle({"type": "settings.update", "settings": {"avatar_costume": costume}})
        await runtime.task
        await asyncio.sleep(.02)
        assert runtime.settings.values["avatar_costume"] == costume
        assert any(e["type"] == "utterance.ready" for e in ws.events)
        assert any(e["type"] == "subtitle.ready" for e in ws.events)
        assert not any(e["type"] == "audio.ready" for e in ws.events)
        assert not runtime.pending
        assert any(e["type"] == ("utterance.displayed" if silent else "error") for e in ws.events)
    finally:
        await runtime.close()
