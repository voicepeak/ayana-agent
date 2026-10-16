import json
import time
from pathlib import Path

import pytest

from services.agent.config import Settings
from services.agent.emotion import EmotionState, suggest_faces
from services.agent.runtime import AgentRuntime
from services.agent.storage import ConversationStore
from tests.test_runtime import Desktop, Tts, Ws


ROOT = Path(__file__).resolve().parents[1]


def state_for(tmp_path):
    store = ConversationStore(tmp_path / "emotion.sqlite3")
    return store, EmotionState(store)


def face(label, intensity=1.0, **extra):
    return {"resolved_expression": label, "expression": label, "intensity": intensity, **extra}


def test_repeated_faces_are_damped_and_flip_mood_once(tmp_path):
    store, emotion = state_for(tmp_path)
    now = time.time()
    drops = []
    for index in range(3):
        before = emotion.state["patience"]
        emotion.apply_turn([face("嘟哝")], now=now + index * 60, hour=14)
        drops.append(before - emotion.state["patience"])
    assert drops[0] == pytest.approx(1.0, abs=0.05)
    assert drops[1] == pytest.approx(drops[0] / 2, rel=0.3)
    assert drops[2] == pytest.approx(drops[0] / 4, rel=0.3)
    assert emotion.state["mood"] == "别扭"
    store.close()


def test_weak_opposite_evidence_does_not_flip_a_fresh_mood(tmp_path):
    store, emotion = state_for(tmp_path)
    now = time.time()
    emotion.apply_turn([face("卖萌", 0.9)], now=now, hour=14)
    assert emotion.state["mood"] == "愉快"
    emotion.apply_turn([face("担忧", 0.25)], now=now + 60, hour=14)
    assert emotion.state["mood"] == "愉快"
    store.close()


def test_strong_evidence_can_switch_within_the_dwell_window(tmp_path):
    store, emotion = state_for(tmp_path)
    now = time.time()
    emotion.apply_turn([face("卖萌", 0.9)], now=now, hour=14)
    emotion.apply_turn([face("委屈", 0.5)], now=now + 30, hour=14)
    assert emotion.state["mood"] == "愉快"
    emotion.apply_turn([face("委屈", 0.5), face("哭", 1.0)], now=now + 60, hour=14)
    assert emotion.state["mood"] == "低落"
    store.close()


def test_sleep_reset_and_night_energy_cap(tmp_path):
    store, emotion = state_for(tmp_path)
    now = time.time()
    emotion.apply_turn([face("得意")], now=now, hour=20)
    assert emotion.state["mood"] == "愉快"
    emotion.settle(now=now + 8 * 3600, hour=3)
    assert emotion.state["mood"] == "困倦"
    assert emotion.state["energy"] == pytest.approx(34.0)
    assert emotion.state["intensity"] >= 0.4
    emotion.settle(now=now + 13 * 3600, hour=8)
    assert emotion.state["mood"] == "平静"
    assert emotion.state["energy"] >= 50
    store.close()


def test_prompt_reports_away_hours_and_state_persists(tmp_path):
    store, emotion = state_for(tmp_path)
    now = time.time()
    emotion.apply_turn([face("卖萌", 0.8)], now=now, hour=14)
    data = emotion.prompt(now=now + 26 * 3600, hour=14)
    assert data["away_hours"] == pytest.approx(26.0)
    assert data["mood"] == "平静"
    assert data["intensity"] == pytest.approx(0.15)
    assert data["energy"] == pytest.approx(72.0)
    reopened = EmotionState(store)
    assert reopened.state["mood"] == "平静"
    assert reopened.prompt(now=now + 26 * 3600, hour=14).get("away_hours") is None
    store.close()


def test_events_without_a_face_fall_back_to_affect_then_intent(tmp_path):
    store, emotion = state_for(tmp_path)
    now = time.time()
    emotion.apply_turn([{"affect": "concerned", "intensity": 0.8}], now=now, hour=12)
    assert emotion.state["mood"] == "担心"
    emotion.apply_turn([{"intent": "explain", "intensity": 0.8}], now=now + 310, hour=12)
    assert emotion.state["mood"] == "认真"
    emotion.apply_turn([face("病娇", 0.8, affect="neutral")], now=now + 620, hour=12)
    assert emotion.state["mood"] == "平静"
    store.close()


def test_dimensions_stay_within_bounds_under_repeated_pressure(tmp_path):
    store, emotion = state_for(tmp_path)
    now = time.time()
    for index in range(30):
        emotion.apply_turn([face("愤怒"), face("哭")], now=now + index * 5, hour=12)
    assert 0 <= emotion.state["patience"] <= 100
    assert 0 <= emotion.state["warmth"] <= 100
    assert emotion.state["mood"] == "生气"
    for index in range(30):
        emotion.apply_turn([face("卖萌"), face("得意")], now=now + 600 + index * 5, hour=12)
    assert 0 <= emotion.state["energy"] <= 100
    assert emotion.state["mood"] == "愉快"
    store.close()


def test_flavor_suggestions_rotate_and_respect_mood():
    pool = ["休闲", "正经", "卖萌", "脸红卖萌", "得意", "嘟哝", "担忧", "委屈", "哭", "病娇"]
    assert suggest_faces(pool, "平静") == ["卖萌", "脸红卖萌"]
    assert suggest_faces(pool, "愉快") == ["卖萌", "脸红卖萌"]
    assert suggest_faces(pool, "别扭") == ["嘟哝", "卖萌"]
    assert suggest_faces(pool, "低落") == ["委屈", "卖萌"]
    assert suggest_faces(["哭", "病娇"], "平静") == []


def test_su_vocabulary_feeds_the_same_moods(tmp_path):
    store, emotion = state_for(tmp_path)
    now = time.time()
    emotion.apply_turn([face("闭眼嘟嘴")], now=now, hour=12)
    assert emotion.state["mood"] == "别扭"
    emotion.apply_turn([face("自然微笑")], now=now + 310, hour=12)
    assert emotion.state["mood"] == "愉快"
    emotion.apply_turn([face("脸红委屈")], now=now + 620, hour=12)
    assert emotion.state["mood"] == "低落"
    store.close()


@pytest.mark.asyncio
async def test_committed_faces_update_emotion_and_reach_next_turn_context(tmp_path, monkeypatch):
    contexts = []

    class Model:
        usage = None
        def __init__(self, settings, client=None, *, thinking=False):
            self.request_messages = []
            self.response_text = ""

        async def stream_reply(self, messages, tools=None, tool_names=None):
            contexts.append(json.loads(messages[-1]["content"][0]["text"]))
            self.request_messages = messages
            event = {"type": "speech", "key": "s1", "speech_ja": "うぅ。", "expression": "委屈",
                     "pose": "crossed", "intent": "acknowledge", "intensity": 0.9}
            self.response_text = json.dumps(event, ensure_ascii=False) + "\n"
            yield event
            yield {"type": "translation", "key": "s1", "display_zh": "呜。"}

        def assistant_message(self):
            return {"role": "assistant", "content": self.response_text}

    monkeypatch.setattr("services.agent.runtime.OpenAIProvider", Model)
    monkeypatch.setattr("services.agent.emotion.local_hour", lambda now: 14)
    cfg = Settings(ROOT, data_root=tmp_path)
    cfg.values.update(provider="openai", voice={"voice_mode": "silent"})
    tts = Tts()

    async def silent(text, generation):
        return {"duration_ms": 0, "engine": "silent", "pcm_base64": ""}

    tts.synthesize = silent
    runtime = AgentRuntime(cfg, desktop=Desktop(), tts=tts)
    runtime.clients.add(Ws())
    try:
        await runtime.handle({"type": "turn.start", "text": "你怎么了"})
        await runtime.task
        assert runtime.emotion.state["mood"] == "低落"
        assert runtime.emotion.state["intensity"] > 0
        await runtime.handle({"type": "turn.start", "text": "对不起"})
        await runtime.task
        assert contexts[-1]["emotion"]["mood"] == "低落"
    finally:
        await runtime.close()
