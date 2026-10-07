import asyncio
import json
from pathlib import Path

import httpx
import pytest

from services.agent.config import Settings
from services.agent.context import PromptHistory
from services.agent.conversations import Conversations
from services.agent.runtime import AgentRuntime
from services.agent.storage import ConversationStore
from tests.test_model import sse_response
from tests.test_runtime import Desktop, Tts, Ws


def make_runtime(tmp_path, respond=None, persist=True):
    settings = Settings(root=Path(__file__).resolve().parents[1], data_root=tmp_path)
    settings.values.update(provider="openai", model="one", send_screenshot=False, save_history=persist, remember_user=False,
                           voice={"voice_mode": "silent"})
    settings.key = lambda: "test-key"
    tts = Tts()
    async def silent(text, generation):
        return {"duration_ms": 0, "engine": "silent", "pcm_base64": ""}
    tts.synthesize = silent
    runtime = AgentRuntime(settings, desktop=Desktop(), tts=tts)
    runtime.clients.add(Ws())
    if respond:
        runtime.model_client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
    return runtime


def response(request):
    return sse_response([{"type": "speech", "key": "s1", "speech_ja": "覚えているよ。"},
                         {"type": "translation", "key": "s1", "display_zh": "我记得。"}])


async def ask(runtime, text):
    await runtime.handle({"type": "turn.start", "text": text})
    await runtime.task


@pytest.mark.asyncio
@pytest.mark.parametrize("persist", [True, False])
async def test_topic_isolation_return_model_change_and_restart(tmp_path, persist):
    calls = []
    def respond(request):
        calls.append(json.loads(request.content)["messages"])
        return response(request)
    runtime = make_runtime(tmp_path, respond, persist)
    try:
        first = runtime.conversations.current_id
        await ask(runtime, "独属于话题甲的细节")
        assert runtime.conversations.current["title"] == "独属于话题甲的细节"
        await runtime.handle({"type": "conversation.create"})
        second = runtime.conversations.current_id
        await ask(runtime, "独属于话题乙的细节")
        assert "独属于话题甲" not in json.dumps(calls[-1], ensure_ascii=False)
        await runtime.handle({"type": "conversation.select", "conversation_id": first})
        runtime.settings.values["model"] = "two"
        await ask(runtime, "继续甲")
        prompt = json.dumps(calls[-1], ensure_ascii=False)
        assert "独属于话题甲" in prompt and "独属于话题乙" not in prompt
        page = runtime.conversations.history(first)
        assert [item["role"] for item in page["items"]] == ["user", "assistant", "user", "assistant"]
        assert page["items"][1]["display_zh"] == "我记得。"
        assert "独属于话题乙" not in json.dumps(page, ensure_ascii=False)
        if not persist:
            assert runtime.store.records("conversation") == []
            assert runtime.store.history() == []
    finally:
        await runtime.close()
    reopened = make_runtime(tmp_path, response, persist)
    try:
        if persist:
            assert reopened.conversations.current_id == first
            assert second in reopened.conversations.records
            await ask(reopened, "重启后继续")
            assert len(reopened.prompt_history.turns) == 3
        else:
            assert reopened.conversations.current_id != first
            assert reopened.conversations.history(reopened.conversations.current_id)["items"] == []
    finally:
        await reopened.close()


@pytest.mark.asyncio
async def test_switch_cancels_audio_tasks_approvals_and_routes_late_receipts(tmp_path):
    runtime = make_runtime(tmp_path, response)
    try:
        first = runtime.conversations.current_id
        await ask(runtime, "旧话题")
        uid = next(iter(runtime.utterances))
        generation = runtime.generation
        runtime.utterances[uid].update(total_samples=1600, sample_rate=16000)
        await runtime.handle({"type": "playback.started", "utterance_id": uid, "generation_id": generation})
        runtime.approvals["old"] = {"approval_id": "old"}
        runtime.target = {"target_id": "old", "title": "旧窗口"}
        runtime.snapshot = {"snapshot_id": "old"}
        runtime.repository = {"root": "old", "files": [], "evidence": []}
        async def forever():
            await asyncio.Event().wait()
        task = runtime.task = asyncio.create_task(forever())
        await runtime.handle({"type": "conversation.create"})
        assert task.cancelled() and not runtime.approvals and runtime.active_task is None
        assert runtime.target is runtime.snapshot is runtime.repository is None
        await runtime.handle({"type": "playback.cancelled", "utterance_id": uid,
                              "generation_id": generation, "played_samples": 800})
        assert runtime.conversations.history(runtime.conversations.current_id)["items"] == []
        old = runtime.conversations.history(first)["items"][-1]
        assert old["status"] == "partial" and old["played_samples"] == 800
        assert runtime._avatar_context() == []
    finally:
        await runtime.close()


def test_legacy_migration_adopts_once_and_pagination_keeps_user_messages(tmp_path):
    store = ConversationStore(tmp_path / "history.sqlite3")
    for i in range(205):
        store.commit({"type": "user.message", "text": str(i), "turn_id": str(i)})
    history = PromptHistory(store)
    history.select("legacy", {})
    history.append("old", [{"role": "user", "content": "original"}], {}, True)
    conversations = Conversations(store)
    first = conversations.current_id
    assert conversations.current["title"] == "之前的对话"
    assert store.model_turns("conversation:" + first)[-1]["messages"][0]["content"] == "original"
    page = conversations.history(first)
    previous = conversations.history(first, page["before"])
    last = conversations.history(first, previous["before"])
    assert page["has_more"] and previous["has_more"] and not last["has_more"]
    assert [item["text"] for item in last["items"] + previous["items"] + page["items"]] == [str(i) for i in range(205)]
    conversations.create()
    reopened = Conversations(store)
    assert reopened.history(reopened.current_id)["items"] == []
    store.close()


@pytest.mark.asyncio
async def test_summary_replaces_only_complete_old_turns_and_survives_restart(tmp_path):
    calls = []
    def respond(request):
        body = json.loads(request.content)
        calls.append(body)
        if not body["stream"]:
            assert "older_turns" in body["messages"][-1]["content"]
            return httpx.Response(200, json={"choices": [{"message": {"content": "用户目标：完成甲。已经确定方案，尚未执行。"}}]})
        return response(request)
    runtime = make_runtime(tmp_path, respond)
    try:
        runtime._select_history()
        for i in range(8):
            runtime.prompt_history.append(str(i), [{"role": "user", "content": "原始细节" * 2300}], {}, True)
        original = len(runtime.prompt_history.turns)
        await runtime._compact_history(10000, runtime.generation)
        assert 0 < len(runtime.prompt_history.turns) < original
        assert runtime.prompt_history.summary.startswith("用户目标")
        loaded = PromptHistory(runtime.store)
        loaded.select("new system", {"model": "different"}, conversation_id=runtime.conversations.current_id)
        assert loaded.messages() == runtime.prompt_history.messages()
        await ask(runtime, "继续未完成事项")
        prompt = json.dumps(calls[-1]["messages"], ensure_ascii=False)
        assert "用户目标：完成甲" in prompt
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_failed_or_cancelled_summary_never_discards_context(tmp_path):
    runtime = make_runtime(tmp_path, lambda request: httpx.Response(503))
    try:
        runtime._select_history()
        runtime.prompt_history.append("old", [{"role": "user", "content": "原始" * 35000}], {}, True)
        original = runtime.prompt_history.messages()
        with pytest.raises(RuntimeError, match="原始上下文已保留"):
            await runtime._compact_history(10000, runtime.generation)
        assert runtime.prompt_history.messages() == original
        assert runtime.store.model_turns(runtime.prompt_history.scope) == runtime.prompt_history.turns
        async def delayed(request):
            await asyncio.Event().wait()
        await runtime.model_client.aclose()
        runtime.model_client = httpx.AsyncClient(transport=httpx.MockTransport(delayed))
        task = runtime.task = asyncio.create_task(runtime._compact_history(10000, runtime.generation))
        await asyncio.sleep(.02)
        await runtime.handle({"type": "conversation.create"})
        assert task.cancelled()
        assert runtime.store.context_summary("conversation:" + runtime.conversations.current_id) == ""
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_disabled_history_is_separate_and_enabling_does_not_save_private_topics(tmp_path):
    runtime = make_runtime(tmp_path, response)
    try:
        first = runtime.conversations.current_id
        await ask(runtime, "保存的内容")
        await runtime.handle({"type": "settings.update", "settings": {"save_history": False}})
        private = runtime.conversations.current_id
        await ask(runtime, "不保存的内容")
        await runtime.handle({"type": "settings.update", "settings": {"save_history": True}})
        assert runtime.conversations.current_id == first
        assert private not in runtime.conversations.records
        assert "不保存的内容" not in json.dumps(runtime.store.conversation_history(first), ensure_ascii=False)
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_unfinished_question_survives_leaving_and_invalid_selection_is_harmless(tmp_path):
    started = asyncio.Event()
    async def delayed(request):
        started.set()
        await asyncio.Event().wait()
    runtime = make_runtime(tmp_path, delayed)
    try:
        cid = runtime.conversations.current_id
        await runtime.handle({"type": "turn.start", "text": "还没回答的原始目标"})
        await started.wait()
        task, generation = runtime.task, runtime.generation
        with pytest.raises(ValueError, match="找不到"):
            await runtime.handle({"type": "conversation.select", "conversation_id": "missing"})
        assert runtime.task is task and runtime.generation == generation
        await runtime.handle({"type": "conversation.create"})
        assert task.cancelled()
        await runtime.handle({"type": "conversation.select", "conversation_id": cid})
        assert "还没回答的原始目标" in json.dumps(runtime.prompt_history.messages(), ensure_ascii=False)
        assert "unconfirmed proposals were cancelled" in json.dumps(runtime.prompt_history.messages())
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_materials_are_optional_and_repository_restores_without_old_window(tmp_path):
    runtime = make_runtime(tmp_path, response)
    class CapturingDesktop(Desktop):
        def capture(self, target):
            return {"snapshot_id": "fresh", "png_base64": "image", "target": {"target_id": target}}
    runtime.desktop = CapturingDesktop()
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "readme.md").write_text("repository evidence", encoding="utf-8")
    try:
        first = runtime.conversations.current_id
        await runtime.handle({"type": "repository.inspect", "root": str(repo)})
        runtime.target = {"target_id": "window", "title": "当前窗口"}
        await runtime.handle({"type": "conversation.create", "keep_materials": True})
        assert runtime.repository["root"] == str(repo.resolve())
        assert runtime.target["target_id"] == "window" and runtime.snapshot["snapshot_id"] == "fresh"
        await runtime.handle({"type": "conversation.create"})
        assert runtime.target is runtime.repository is runtime.snapshot is None
        await runtime.handle({"type": "conversation.select", "conversation_id": first})
        assert runtime.repository["root"] == str(repo.resolve()) and runtime.target is None
        await runtime.handle({"type": "conversation.materials.clear"})
        assert runtime.repository is None and runtime.conversations.current["repository_root"] is None
    finally:
        await runtime.close()
