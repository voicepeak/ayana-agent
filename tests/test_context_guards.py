"""Regression tests for the six context-management defects found 2026-10-06."""
import json

import httpx
import pytest

from services.agent.context import PromptHistory, summary_batches
from services.agent.storage import ConversationStore
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
        result = {"name": "web.search", "call_id": "find-example", "result": [
            {"source_id": "src-example", "url": "https://example.com/"}]}
        tool_message = ({"role": "tool", "tool_call_id": "find-example",
                         "content": json.dumps(result)} if native
                        else runtime._tool_message([result]))
        messages = [{"role": "system", "content": "s" * 30000},
                    {"role": "assistant", "content": "h" * 80000},
                    {"role": "user", "content": "open the page"},
                    {"role": "assistant", "content": ""}, tool_message]
        original = json.dumps(messages, ensure_ascii=False)
        assert len(original) < runtime.prompt_history.max_chars
        assert len(original) > runtime.prompt_history.max_chars - 23000
        runtime._cap_request(messages, prefix_length=2, reserve_chars=23000)
        assert json.dumps(messages, ensure_ascii=False) == original
        assert "src-example" in messages[-1]["content"]
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_failed_turn_seals_already_read_tool_evidence(tmp_path):
    calls = []
    def respond(request):
        calls.append(json.loads(request.content)["messages"])
        if len(calls) == 1:
            return sse_response([{"type": "tool", "name": "attention.configure",
                                  "arguments": {"enabled": True}}])
        return httpx.Response(503)
    runtime = make_runtime(tmp_path, respond)
    try:
        await runtime.handle({"type": "turn.start", "text": "toggle the setting"})
        await runtime.task
        assert len(calls) == 2
        sealed = json.dumps(runtime.prompt_history.turns, ensure_ascii=False)
        plain = sealed.replace('\\"', '"')
        assert '"attention.configure"' in plain and '"enabled": true' in plain  # the real tool result survived the failure
        failed = next(e for e in next(iter(runtime.clients)).events if e["type"] == "error")
        assert "模型服务暂时不可用" in failed["message"]
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_tool_round_budget_ends_the_loop(tmp_path):
    calls = []
    def respond(request):
        calls.append(1)
        return sse_response([{"type": "tool", "name": "attention.configure",
                              "arguments": {"enabled": True}}])
    runtime = make_runtime(tmp_path, respond)
    runtime.settings.values["max_tool_rounds"] = 3
    try:
        await runtime.handle({"type": "turn.start", "text": "loop"})
        await runtime.task
        # Three tool rounds plus the tools-free wrap-up round.
        assert len(calls) == 4
        assert any(event["type"] == "error" for event in next(iter(runtime.clients)).events)
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_history_budget_setting_applies_immediately_and_scales_summaries(tmp_path):
    runtime = make_runtime(tmp_path, response)
    try:
        assert runtime.prompt_history.max_chars == 128000
        assert runtime._summary_budget() == 80000
        await runtime.handle({"type": "settings.update", "settings": {"history_budget_chars": 200000}})
        assert runtime.prompt_history.max_chars == 200000
        assert runtime._summary_budget() == 125000
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
