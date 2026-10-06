import asyncio
import json
import sqlite3
from pathlib import Path

import httpx
import pytest

from services.agent.storage import ConversationStore
from services.agent.config import Settings
from services.agent.providers.model import OpenAIProvider
from services.agent.prompts import subtitle_language_instruction
from services.agent.runtime import AgentRuntime
from test_runtime import Desktop, Tts, Ws

ROOT = Path(__file__).resolve().parents[1]


def test_language_settings_persist_and_reject_unknown_languages(tmp_path):
    cfg = Settings(ROOT, data_root=tmp_path)
    cfg.update({"companion_ui": {"primary_language": "en", "translation_language": "ja"}})
    assert Settings(ROOT, data_root=tmp_path).values["companion_ui"]["primary_language"] == "en"
    before = cfg.path.read_bytes()
    for patch in [{"primary_language": "none"}, {"translation_language": "fr"}, {"primary_language": []}]:
        with pytest.raises(ValueError):
            cfg.update({"companion_ui": patch})
    assert cfg.path.read_bytes() == before
    assert "display_en" in subtitle_language_instruction(cfg.values)
    assert not subtitle_language_instruction({"companion_ui": {"primary_language": "ja", "translation_language": "zh"}})


def test_legacy_history_migrates_and_english_does_not_erase_chinese(tmp_path):
    path = tmp_path / "history.sqlite3"
    with sqlite3.connect(path) as db:
        db.execute("CREATE TABLE utterances(utterance_id TEXT PRIMARY KEY,session_id TEXT,turn_id TEXT,generation_id INTEGER,speech_ja TEXT,display_zh TEXT DEFAULT '',status TEXT DEFAULT 'generated',played_samples INTEGER DEFAULT 0,total_samples INTEGER DEFAULT 0,sample_rate INTEGER DEFAULT 0,displayed INTEGER DEFAULT 0)")
    store = ConversationStore(path)
    base = {"session_id": "s", "turn_id": "t", "generation_id": 1, "conversation_id": "c", "utterance_id": "u"}
    store.commit({**base, "type": "utterance.ready", "speech_ja": "こんにちは。"})
    store.commit({**base, "type": "subtitle.ready", "display_zh": "你好。"})
    store.commit({**base, "type": "subtitle.translated", "display_en": "Hello."})
    item = store.conversation_history("c")["items"][0]
    assert item["display_zh"] == "你好。" and item["display_en"] == "Hello."
    assert store.subtitle_sources("other-topic", ["u"]) == []
    store.close()
    store = ConversationStore(path)
    assert store.history()[0]["display_en"] == "Hello."
    store.close()


@pytest.mark.asyncio
async def test_batched_english_translation_has_no_tools_and_validates_ids():
    class Config:
        values = {"base_url": "https://example.invalid/v1", "model": "model"}
        def key(self): return "test-key"
    requests = []
    def respond(request):
        body = json.loads(request.content)
        requests.append(body)
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps({"translations": [{"utterance_id": "u", "display_en": "Hello."}]})}}]})
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        translated = await OpenAIProvider(Config(), client).translate_subtitles([{"utterance_id": "u", "speech_ja": "こんにちは。"}])
    assert translated == {"u": "Hello."}
    assert "tools" not in requests[0]
    assert json.loads(requests[0]["messages"][1]["content"])[0]["speech_ja"] == "こんにちは。"
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        with pytest.raises(ValueError, match="unknown sentence"):
            await OpenAIProvider(Config(), client).translate_subtitles([{"utterance_id": "other", "speech_ja": "こんにちは。"}])


@pytest.mark.asyncio
async def test_historical_translation_is_scoped_deduplicated_and_survives_cancel(tmp_path):
    cfg = Settings(ROOT, data_root=tmp_path)
    cfg.update({"provider": "local", "voice": {"voice_mode": "silent"}})
    runtime = AgentRuntime(cfg, desktop=Desktop(), tts=Tts())
    ws = Ws(); runtime.clients.add(ws)
    try:
        cid = runtime.conversations.current_id
        await runtime.emit("utterance.ready", utterance_id="past", speech_ja="うん、ここにいるよ。")
        await runtime.emit("subtitle.ready", utterance_id="past", display_zh="嗯，我在这里。")
        await runtime.cancel()
        await runtime.handle({"type": "subtitles.translate", "utterance_ids": ["past"], "language": "en"})
        await runtime.handle({"type": "subtitles.translate", "utterance_ids": ["past"], "language": "en"})
        await asyncio.gather(*tuple(runtime.subtitle_jobs))
        await asyncio.sleep(.02)
        translated = [e for e in ws.events if e["type"] == "subtitle.translated"]
        assert len(translated) == 1
        assert translated[0]["conversation_id"] == cid
        assert runtime.store.history()[0]["display_en"] == "Yes, I'm right here."
        assert runtime.store.history()[0]["display_zh"] == "嗯，我在这里。"
        assert not runtime.subtitle_pending
    finally:
        await runtime.close()
