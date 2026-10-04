import json

from services.agent.context import PromptHistory
from services.agent.storage import ConversationStore


def test_immutable_turns_survive_restart_and_scope_changes(tmp_path):
    store = ConversationStore(tmp_path / "history.sqlite3")
    cfg = {"base_url": "https://example.com", "model": "one"}
    history = PromptHistory(store)
    history.select("system", cfg)
    messages = [{"role": "user", "content": [{"type": "text", "text": '{"question":"hello"}'}]},
                {"role": "assistant", "content": '{ "type": "speech", "key": "s1" }\n'}]
    history.append("turn-1", messages, {"s1": "u1"}, persist=True)
    messages[0]["content"][0]["text"] = "mutated by caller"
    loaded = PromptHistory(store)
    loaded.select("system", cfg)
    assert loaded.messages() == history.messages()
    result = loaded.messages()
    result[0]["content"][0]["text"] = "mutated returned context"
    assert loaded.messages()[0]["content"][0]["text"] == '{"question":"hello"}'
    loaded.select("system", {**cfg, "model": "two"})
    assert loaded.messages() == []
    loaded.select("system", cfg)
    assert loaded.messages() == history.messages()
    store.close()


def test_budget_evicts_whole_turns_in_batches(tmp_path):
    store = ConversationStore(tmp_path / "history.sqlite3")
    history = PromptHistory(store, max_chars=1800)
    history.select("system", {})
    for index in range(5):
        history.append(str(index), [{"role": "user", "content": "a" * 80},
                                  {"role": "assistant", "content": "b" * 80}], {}, persist=True)
    before = history.messages()
    after = history.messages(reserve_chars=1000)
    assert len(after) < len(before)
    assert [message["role"] for message in after] == ["user", "assistant"] * (len(after) // 2)
    history.append("next", [{"role": "user", "content": "next"}, {"role": "assistant", "content": "reply"}], {}, True)
    assert history.messages()[:len(after)] == after  # no further sliding eviction
    assert len(json.dumps(history.turns, ensure_ascii=False)) < 1800
    store.close()


def test_screenshots_not_retained_and_disabled_history_not_loaded(tmp_path):
    store = ConversationStore(tmp_path / "history.sqlite3")
    history = PromptHistory(store)
    history.select("system", {})
    history.append("one", [{"role": "user", "content": [
        {"type": "text", "text": "question"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,private-image"}}]}], {}, True)
    assert "private-image" not in json.dumps(history.messages())
    disabled = PromptHistory(store)
    disabled.select("system", {"save_history": False})
    assert disabled.messages() == []
    disabled.append("temporary", [{"role": "user", "content": "private-question"}], {}, False)
    reloaded = PromptHistory(store)
    reloaded.select("system", {})
    assert "private-question" not in json.dumps(reloaded.messages())
    store.close()


def test_legacy_history_is_frozen_once_without_repeating_current_question(tmp_path):
    store = ConversationStore(tmp_path / "history.sqlite3")
    store.commit({"type": "user.message", "text": "old", "turn_id": "old"})
    store.commit({"type": "user.message", "text": "current", "turn_id": "current"})
    history = PromptHistory(store)
    history.select("system", {}, exclude_turn="current")
    assert history.messages() == [{"role": "user", "content": "old"}]
    history.append("current", [{"role": "user", "content": "current"}], {}, True)
    reloaded = PromptHistory(store)
    reloaded.select("system", {})
    assert reloaded.messages() == history.messages()
    reloaded.select("different system", {})
    assert reloaded.messages() == []
    store.close()
