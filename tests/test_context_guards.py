"""Regression tests for the six context-management defects found 2026-10-06."""
import json

import httpx
import pytest

from services.agent.context import PromptHistory, summary_batches
from services.agent.storage import ConversationStore
from services.agent.tasks import TaskRunner
from services.agent.work import remember_result
from tests.test_conversations import make_runtime, response
from tests.test_model import sse_response


def test_fixed_material_over_budget_raises_instead_of_sending(tmp_path):
    store = ConversationStore(tmp_path / "history.sqlite3")
    history = PromptHistory(store, max_chars=1000)
    history.select("system", {}, conversation_id="chat-1")
    with pytest.raises(ValueError, match="材料过大"):
        history.compaction_count(reserve_chars=1000)
    store.close()


@pytest.mark.asyncio
async def test_cap_request_compresses_old_tool_evidence_within_a_turn(tmp_path):
    runtime = make_runtime(tmp_path, response)
    try:
        messages = [{"role": "system", "content": "system"},
                    {"role": "user", "content": "question"},
                    {"role": "tool", "tool_call_id": "call-1", "content": "a" * 40000},
                    {"role": "tool", "tool_call_id": "call-2", "content": "b" * 40000}]
        before = len(json.dumps(messages, ensure_ascii=False))
        runtime.prompt_history.max_chars = 20000
        runtime._cap_request(messages, prefix_length=1, reserve_chars=1000)
        after = len(json.dumps(messages, ensure_ascii=False))
        assert after < before
        assert messages[2]["content"].startswith("Tool result omitted")
        assert "call-1" in messages[2]["content"]
        # The live question is never compressed.
        assert messages[1]["content"] == "question"
    finally:
        await runtime.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("native", [True, False])
async def test_cap_request_does_not_subtract_fixed_prefix_twice(tmp_path, native):
    runtime = make_runtime(tmp_path, response)
    try:
        # A long retained conversation still fits the full request ceiling.
        # The fixed prefix was already reserved when history was assembled.
        result = {"name": "apps.search", "call_id": "find-steam", "result": [
            {"app_id": "app-steam", "name": "Steam"}]}
        tool_message = ({"role": "tool", "tool_call_id": "find-steam",
                         "content": json.dumps(result)} if native
                        else runtime._tool_message([result]))
        messages = [{"role": "system", "content": "s" * 14000},
                    {"role": "assistant", "content": "h" * 30000},
                    {"role": "user", "content": "open Steam"},
                    {"role": "assistant", "content": ""}, tool_message]
        original = json.dumps(messages, ensure_ascii=False)
        assert len(original) < runtime.prompt_history.max_chars
        assert len(original) > runtime.prompt_history.max_chars - 23000
        runtime._cap_request(messages, prefix_length=2, reserve_chars=23000)
        assert json.dumps(messages, ensure_ascii=False) == original
        assert "app-steam" in messages[-1]["content"]
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_failed_turn_seals_already_read_tool_evidence(tmp_path):
    marker = "unique-proof-marker-9381"
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir(exist_ok=True)
    (artifacts / "proof.txt").write_text(marker, encoding="utf-8")
    calls = []
    def respond(request):
        calls.append(json.loads(request.content)["messages"])
        if len(calls) == 1:
            return sse_response([{"type": "tool", "name": "files.read",
                                  "arguments": {"root_id": "output", "path": "proof.txt"}}])
        return httpx.Response(503)
    runtime = make_runtime(tmp_path, respond)
    try:
        await runtime.handle({"type": "turn.start", "text": "read the proof"})
        await runtime.task
        assert len(calls) == 2
        sealed = json.dumps(runtime.prompt_history.turns, ensure_ascii=False)
        assert marker in sealed  # the real tool result survived the failure
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_tool_rounds_stay_within_the_project_budget(tmp_path):
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir(exist_ok=True)
    (artifacts / "big.txt").write_text("z" * 16000, encoding="utf-8")
    calls = []
    def respond(request):
        body = json.loads(request.content)
        calls.append(len(json.dumps(body["messages"], ensure_ascii=False)))
        if len(calls) <= 6:
            return sse_response([{"type": "tool", "name": "files.read",
                                  "arguments": {"root_id": "output", "path": "big.txt"}}])
        return sse_response([{"type": "speech", "key": "s1", "speech_ja": "読んだよ。"}])
    runtime = make_runtime(tmp_path, respond)
    try:
        await runtime.handle({"type": "turn.start", "text": "read repeatedly"})
        await runtime.task
        assert len(calls) == 7
        assert max(calls) <= runtime.prompt_history.max_chars
    finally:
        await runtime.close()


def test_summary_batches_split_and_truncate_oversized_turns():
    small = [{"turn_id": f"t{i}", "keys": {}, "messages": [{"role": "user", "content": "x" * 6000}]}
             for i in range(4)]
    batches = summary_batches(small, budget=10000)
    assert len(batches) >= 2
    assert all(len(json.dumps(batch, ensure_ascii=False)) <= 11000 for batch in batches)

    huge = [{"turn_id": "t", "keys": {}, "messages": [{"role": "user", "content": "y" * 100000}]}]
    batches = summary_batches(huge, budget=10000)
    assert len(batches) == 1 and batches[0][0]["truncated"] is True
    assert "truncated for summary" in batches[0][0]["messages"][0]["content"]


def test_file_reference_identity_prefers_stable_absolute_path():
    context = {}
    remember_result(context, "files.read", {}, {"call_id": "a", "result": {
        "root_id": "repository", "path": "config.py", "absolute_path": "/repo-a/config.py"}})
    remember_result(context, "files.read", {}, {"call_id": "b", "result": {
        "root_id": "repository", "path": "config.py", "absolute_path": "/repo-b/config.py"}})
    # Same root_id and relative path, but different real files: not merged.
    assert len(context["objects"]) == 2


def test_remember_result_binds_resolved_absolute_path():
    context = {}
    remember_result(context, "files.read", {"root_id": "output", "path": "a.txt"},
                    {"call_id": "c", "result": {"root_id": "output", "path": "a.txt"}},
                    resolver=lambda root_id, path: "C:/resolved/" + path)
    assert context["objects"][0]["absolute_path"] == "C:/resolved/a.txt"


@pytest.mark.asyncio
async def test_prompt_context_marks_references_from_another_repository(tmp_path):
    runtime = make_runtime(tmp_path, response)
    try:
        runtime.repository = {"root": str(tmp_path / "repo-b"), "files": [], "evidence": []}
        remember_result(runtime._work_context(), "files.read", {}, {"call_id": "a", "result": {
            "root_id": "repository", "path": "config.py",
            "absolute_path": str(tmp_path / "repo-a" / "config.py")}})
        prompt = runtime._prompt_work_context()
        assert prompt["objects"][0].get("stale") is True
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_restart_reconciles_work_context_task_state(tmp_path):
    runtime = make_runtime(tmp_path, response)
    task = TaskRunner("unfinished original task", {})
    try:
        runtime._work_context()["current_task"] = task.public()
        runtime.conversations.save()
        runtime.store.put_record("task", task.task_id, task.public())
    finally:
        await runtime.close()
    reopened = make_runtime(tmp_path, response)
    try:
        assert reopened.store.get_record("task", task.task_id)["state"] == "interrupted"
        context = reopened.conversations.current.get("work_context")
        assert context["current_task"]["state"] == "interrupted"
    finally:
        await reopened.close()
