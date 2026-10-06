import json
from pathlib import Path

import pytest

from packages.protocol import validate_speech
from services.agent.avatars import AvatarCatalog
from services.agent.config import Settings
from services.agent.runtime import AgentRuntime
from services.agent.storage import ConversationStore


ROOT = Path(__file__).resolve().parents[1]


def test_all_26_expressions_have_semantics_and_remain_routable():
    catalog = AvatarCatalog(ROOT)
    labels = {item["source_expression"] for item in catalog.mapping["assets"].values()}
    assert len(labels) == 26 and set(catalog.guide) == labels
    for label in labels:
        speech = validate_speech({"speech_ja": "ここにいるよ。", "expression": label, "intensity": .1})
        resolved = catalog.resolve(speech)
        assert resolved["resolved_expression"] == label
        assert resolved["expression_source"] == "model_label"
        assert f"- {label}:" in catalog.prompt()


def test_diagnostics_distinguish_missing_invalid_and_explicit_choices():
    catalog = AvatarCatalog(ROOT)
    for requested, source in [("", "fallback_missing"), ("开心", "fallback_invalid"), ("脸红得意", "model_label")]:
        speech = validate_speech({"speech_ja": "うまくできたよ。", "expression": requested, "affect": "pleased"})
        result = catalog.resolve(speech)
        assert result["expression_source"] == source
        assert result["resolved_expression"] == (requested if source == "model_label" else "卖萌")
    speech = validate_speech({"speech_ja": "そうだったの？", "affect": "surprised", "intent": "acknowledge"})
    assert catalog.resolve(speech)["resolved_expression"] == "休闲"


def test_continuity_crosses_outfits_and_ignores_unshown_cancelled_zero_playback():
    catalog = AvatarCatalog(ROOT)
    def face(uid, expression, **kwargs):
        return {"utterance_id": uid, "asset_id": catalog.route({"expression": expression, "intent": "explain"}),
                "displayed": True, "status": "played", **kwargs}
    speeches = [face("a", "担忧"), face("b", "卖萌"), face("c", "得意"), face("d", "脸红卖萌"),
                face("e", "哭", displayed=False), face("f", "愤怒", status="cancelled", displayed=False),
                face("g", "委屈", status="partial", played_samples=0)]
    other = next(key for key, item in catalog.mapping["assets"].items() if item["costume"] != "校服")
    speeches.append({"utterance_id": "h", "asset_id": other, "displayed": True})
    assert [face["expression"] for face in catalog.recent_context(speeches)] == ["得意", "脸红卖萌", catalog.mapping["assets"][other]["source_expression"]]
    # A late receipt overrides the older persisted state for the same sentence.
    speeches.append(face("d", "脸红卖萌", status="partial", played_samples=0))
    assert [face["expression"] for face in catalog.recent_context(speeches)] == ["卖萌", "得意", catalog.mapping["assets"][other]["source_expression"]]


def test_shown_expression_survives_restart_and_legacy_history(tmp_path):
    catalog = AvatarCatalog(ROOT)
    store = ConversationStore(tmp_path / "history.sqlite3")
    for uid, expression, receipt in [("shown", "掩饰", "utterance.displayed"),
                                     ("unshown", "哭", None), ("cancelled", "愤怒", "playback.cancelled")]:
        resolved = catalog.resolve({"expression": expression, "intent": "playful"})
        store.commit({"type": "utterance.ready", "utterance_id": uid, "session_id": "s", "turn_id": "t",
                      "generation_id": 1, "speech_ja": "別に寂しくないよ。", "expression": expression, **resolved})
        if receipt:
            store.commit({"type": receipt, "utterance_id": uid, "played_samples": 0})
    store.close()
    reopened = ConversationStore(tmp_path / "history.sqlite3")
    recent = reopened.recent_avatar_speeches()
    assert [speech["utterance_id"] for speech in recent] == ["shown"]
    historical = [json.loads(line) for message in reopened.context() if message["role"] == "assistant"
                  for line in message["content"].splitlines()]
    assert next(e for e in historical if e["key"] == "shown")["expression"] == "掩饰"
    assert catalog.recent_context(recent) == [{"expression": "掩饰", "pose": "crossed"}]
    reopened.close()


def test_runtime_continuity_works_with_history_disabled(tmp_path):
    cfg = Settings(ROOT, data_root=tmp_path)
    cfg.values["save_history"] = False
    cfg.values["avatar_costume"] = "校服"  # Match resolve()'s fixture costume, independent of personal settings.
    runtime = AgentRuntime(cfg, desktop=object(), tts=object())
    runtime.utterances["shown"] = {"displayed": True, **runtime.avatars.resolve({"expression": "担忧", "intent": "caution"})}
    runtime.utterances["queued"] = runtime.avatars.resolve({"expression": "哭", "intent": "caution"})
    assert runtime._avatar_context() == [{"expression": "担忧", "pose": "crossed"}]
    runtime.store.close()


@pytest.mark.asyncio
async def test_audio_receipts_control_continuity_when_history_disabled(tmp_path):
    cfg = Settings(ROOT, data_root=tmp_path)
    cfg.values["save_history"] = False
    cfg.values["avatar_costume"] = "校服"
    runtime = AgentRuntime(cfg, desktop=object(), tts=object())
    runtime.utterances["audio"] = {"generation_id": 0, "total_samples": 1000,
                                   **runtime.avatars.resolve({"expression": "卖萌", "intent": "encourage"})}
    try:
        assert runtime._avatar_context() == []
        await runtime._receipt({"type": "playback.started", "utterance_id": "audio", "generation_id": 0})
        assert runtime._avatar_context() == [{"expression": "卖萌", "pose": "crossed"}]
        await runtime._receipt({"type": "playback.cancelled", "utterance_id": "audio", "generation_id": 0, "played_samples": 0})
        assert runtime._avatar_context() == []
    finally:
        runtime.store.close()


@pytest.mark.asyncio
async def test_model_choices_reach_display_and_next_turn_context(tmp_path, monkeypatch):
    messages_seen = []
    labels = list(AvatarCatalog(ROOT).guide)
    class Model:
        usage = None
        def __init__(self, settings, client=None):
            self.request_messages = []
            self.response_text = ""
        async def stream_reply(self, messages, tools=None, tool_names=None):
            messages_seen.append(messages)
            self.request_messages = messages
            for i, label in enumerate(labels):
                event = {"type": "speech", "key": str(i), "speech_ja": "ここにいるよ。",
                         "expression": label, "pose": "crossed", "intent": "acknowledge"}
                self.response_text += json.dumps(event, ensure_ascii=False) + "\n"
                yield event
        def assistant_message(self):
            return {"role": "assistant", "content": self.response_text}
    class Desktop:
        status = {}
        def close(self): pass
        def cancel(self): pass
    class Tts:
        status = {"state": "ready"}
        async def start(self): pass
        async def close(self): pass
        async def cancel(self, generation_id): pass
        async def synthesize(self, text, generation_id):
            return {"engine": "silent", "duration_ms": 0}
    class Ws:
        def __init__(self): self.events = []
        async def send_json(self, event): self.events.append(event)
    monkeypatch.setattr("services.agent.runtime.OpenAIProvider", Model)
    cfg = Settings(ROOT, data_root=tmp_path)
    cfg.values.update(provider="openai", save_history=False, max_utterances=30)
    runtime = AgentRuntime(cfg, desktop=Desktop(), tts=Tts())
    ws = Ws()
    runtime.clients.add(ws)
    try:
        await runtime.handle({"type": "turn.start", "text": "hello"})
        await runtime.task
        ready = [e for e in ws.events if e["type"] == "utterance.ready"]
        assert [e["resolved_expression"] for e in ready] == labels
        assert all(e["expression_source"] == "model_label" for e in ready)
        assert len([e for e in ws.events if e["type"] == "utterance.displayed"]) == 26
        await runtime.handle({"type": "turn.start", "text": "next"})
        await runtime.task
        context = json.loads(messages_seen[-1][-1]["content"][0]["text"])
        assert [item["expression"] for item in context["avatar_context"]] == labels[-3:]
    finally:
        await runtime.close()
