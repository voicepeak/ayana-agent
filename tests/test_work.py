import json
import threading
from pathlib import Path

import pytest

from services.agent.tasks import TaskRunner
from services.agent.work import local_clock, remember_result
from services.agent.tools.registry import ToolError
from services.agent.tools.system import SystemTools, ApplicationCatalog, app_record
from services.agent.tools.policy import DirectoryPolicy
from tests.test_conversations import make_runtime, ask
from tests.test_model import sse_response


def plan(kind="action", descriptions=("保存指定内容",), detail="normal"):
    return {"type": "task", "kind": kind, "status": "running", "detail": detail,
            "checks": [{"description": description, "evidence": []} for description in descriptions]}


def complete(description, call_id, pointer, value, operator="equals"):
    return {"type": "task", "status": "complete", "checks": [{"description": description,
            "evidence": [{"call_id": call_id, "pointer": pointer, "operator": operator, "value": value}]}]}


def speech(key="s1"):
    return {"type": "speech", "key": key, "speech_ja": "結果を確かめたよ。"}


@pytest.mark.parametrize("result,pointer,value", [
    ({"status": "open_requested"}, "/status", "open_requested"),
    ({"status": "input_sent", "expected_result_verified": None}, "/status", "input_sent"),
    ({"exit_code": 1, "stdout": "done"}, "/stdout", "done"),
    ({"exit_code": 0, "timed_out": True}, "/exit_code", 0),
])
def test_request_receipts_and_failed_commands_cannot_prove_completion(result, pointer, value):
    task = TaskRunner("do something", {})
    task.report(plan())
    task.results["actual"] = {"value": {"result": result}}
    task.report(complete("保存指定内容", "actual", pointer, value))
    assert task.outcome() == "needs_verification"


def test_compound_outcomes_cannot_be_dropped_or_proved_by_invented_calls():
    task = TaskRunner("save and open in chosen app", {})
    task.report(plan(descriptions=("保存指定内容", "在指定应用打开")))
    with pytest.raises(ValueError, match="不能删除"):
        task.report(complete("保存指定内容", "invented", "/path", "report.md"))
    report = complete("保存指定内容", "invented", "/path", "report.md")
    report["checks"].append({"description": "在指定应用打开", "evidence": []})
    task.report(report)
    assert task.outcome() == "needs_verification"
    task.results["invented"] = {"value": {"result": {"path": "another.md"}}}
    assert task.outcome() == "needs_verification"


def test_read_evidence_can_verify_an_already_completed_goal_without_repeating_a_write():
    task = TaskRunner("confirm the earlier report is ready", {})
    task.report(plan())
    task.results["read"] = {"value": {"result": {"content": "requested content"}}}
    task.report(complete("保存指定内容", "read", "/content", "requested content"))
    assert not task.effects and task.outcome() == "succeeded"


@pytest.mark.asyncio
async def test_unrelated_success_retains_pending_goal_and_explicit_continuation_resolves_it(tmp_path):
    runtime = make_runtime(tmp_path)
    try:
        old = TaskRunner("finish earlier operation", {})
        old.report(plan())
        old.transition("needs_verification")
        runtime.active_task = old
        runtime._remember_task()
        other = TaskRunner("unrelated operation", {})
        other.report(plan())
        other.transition("succeeded")
        runtime.active_task = other
        runtime._remember_task()
        assert runtime._work_context()["pending_task"]["task_id"] == old.task_id
        continuation = TaskRunner("continue earlier operation", {})
        continuation.report({**plan(), "continues_task_id": old.task_id})
        continuation.transition("succeeded")
        runtime.active_task = continuation
        runtime._remember_task()
        assert runtime._work_context()["pending_tasks"] == []
    finally:
        await runtime.close()


def test_search_results_preserve_real_application_and_source_references():
    context = {}
    remember_result(context, "apps.search", {}, {"call_id": "app-search", "result": [
        {"app_id": "real-app", "name": "Editor", "source": "installed"}]})
    remember_result(context, "web.search", {}, {"call_id": "web-search", "result": [
        {"source_id": "real-source", "url": "https://example.org/page", "title": "Source"}]})
    assert [item.get("app_id") or item.get("source_id") for item in context["objects"]] == ["real-app", "real-source"]


@pytest.mark.asyncio
async def test_unfinished_action_continues_once_and_verifies_real_file(tmp_path):
    calls = []
    def respond(request):
        body = json.loads(request.content)
        calls.append(body)
        if len(calls) == 1:
            return sse_response([plan(), speech()])
        if len(calls) == 2:
            assert "has not been verified" in body["messages"][-1]["content"]
            return sse_response([{"type": "tool", "call_id": "save", "name": "files.create",
                                 "arguments": {"root_id": "output", "path": "result.txt", "content": "actual content"}}])
        return sse_response([complete("保存指定内容", "save", "/path", "result.txt"), speech("s2")])
    runtime = make_runtime(tmp_path, respond)
    try:
        await runtime.handle({"type": "turn.start", "text": "保存结果", "mode": "execute"})
        await runtime.task
        assert runtime.active_task.state == "succeeded" and len(calls) == 3
        assert (tmp_path / "artifacts/result.txt").read_text() == "actual content"
        assert runtime._work_context()["objects"][-1]["created_by"] == "assistant"
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_partial_completion_never_replays_successful_writes(tmp_path):
    calls = []
    def respond(request):
        body = json.loads(request.content); calls.append(body)
        if len(calls) == 1:
            return sse_response([plan(descriptions=("保存指定内容", "打开指定应用")),
                {"type": "tool", "call_id": "save", "name": "files.create",
                 "arguments": {"root_id": "output", "path": "result.txt", "content": "x"}}])
        if len(calls) == 2:
            report = complete("保存指定内容", "save", "/path", "result.txt")
            report["checks"].append({"description": "打开指定应用", "evidence": []})
            return sse_response([report, speech()])
        assert "do not repeat successful writes" in body["messages"][-1]["content"]
        return sse_response([{"type": "task", "status": "blocked", "reason": "指定应用尚未安装。"}, speech("s2")])
    runtime = make_runtime(tmp_path, respond)
    try:
        await runtime.handle({"type": "turn.start", "text": "保存并打开", "mode": "execute"})
        await runtime.task
        assert runtime.active_task.state == "blocked" and len(calls) == 3
        assert runtime.active_task.calls == 1
        assert runtime._work_context()["pending_task"]["checks"][0]["verified"]
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_detailed_answers_exceed_chat_budget_and_clock_is_current(tmp_path):
    requests = []
    def respond(request):
        body = json.loads(request.content); requests.append(body)
        return sse_response([plan("answer", (), "detailed"), *[speech(str(i)) for i in range(12)],
                             {"type": "task", "status": "complete"}])
    runtime = make_runtime(tmp_path, respond)
    try:
        runtime.settings.values["max_utterances"] = 4
        await ask(runtime, "详细解释一下这个原理")
        assert runtime.active_task.state == "succeeded"
        content = json.loads(requests[0]["messages"][-1]["content"][0]["text"])
        assert content["speech_budget"]["normal"] == 4 and content["speech_budget"]["detailed"] == 32
        assert content["local_clock"]["local_iso"][:10] == local_clock()["local_iso"][:10]
        assert len(runtime.utterances) == 12
    finally:
        await runtime.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("persist", [True, False])
async def test_grounded_objects_are_topic_local_and_survive_compaction_and_restart(tmp_path, persist):
    prompts = []
    def respond(request):
        prompts.append(json.loads(request.content)["messages"])
        return sse_response([plan("chat", ()), speech(), {"type": "task", "status": "complete"}])
    runtime = make_runtime(tmp_path, respond, persist)
    first = runtime.conversations.current_id
    try:
        remember_result(runtime._work_context(), "files.create", {}, {"call_id": "old", "result": {
            "artifact_id": "actual-artifact", "root_id": "output", "path": "alpha.md", "absolute_path": "/actual/alpha.md"}})
        runtime.conversations.save()
        await ask(runtime, "继续这个文件")
        assert "actual-artifact" in json.dumps(prompts[-1], ensure_ascii=False)
        runtime.prompt_history.compact(len(runtime.prompt_history.turns), "简短摘要，不含路径")
        await runtime.handle({"type": "conversation.create"})
        await ask(runtime, "另一个任务")
        assert "actual-artifact" not in json.dumps(prompts[-1], ensure_ascii=False)
        await runtime.handle({"type": "conversation.select", "conversation_id": first})
        await ask(runtime, "换个应用打开")
        assert "actual-artifact" in json.dumps(prompts[-1], ensure_ascii=False)
    finally:
        await runtime.close()
    runtime = make_runtime(tmp_path, respond, persist)
    try:
        await ask(runtime, "重启后继续")
        assert ("actual-artifact" in json.dumps(prompts[-1], ensure_ascii=False)) is persist
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_existing_topic_backfills_real_references_without_cross_topic_leak(tmp_path):
    runtime = make_runtime(tmp_path)
    try:
        runtime.store.commit({"type": "tool.completed", "conversation_id": runtime.conversations.current_id,
            "tool": "files.create", "call_id": "real", "result": {"root_id": "output", "path": "existing.md"}})
        runtime.store.commit({"type": "tool.completed", "conversation_id": "other-topic",
            "tool": "files.create", "call_id": "other", "result": {"root_id": "output", "path": "private-other.md"}})
        assert runtime._work_context()["objects"][0]["path"] == "existing.md"
        assert "private-other" not in json.dumps(runtime._work_context())
    finally:
        await runtime.close()


@pytest.mark.parametrize("executable", ["code.exe", "notepad++.exe", "WINWORD.EXE", "SumatraPDF.exe"])
def test_requested_document_application_receives_exact_quoted_path(tmp_path, executable):
    policy = DirectoryPolicy(tmp_path / "output")
    path = policy.roots["output"]["path"] / "用户的 report with spaces.md"
    path.write_text("document")
    app = tmp_path / executable; app.write_bytes(b"never executed")
    catalog = ApplicationCatalog(lambda: [app_record("chosen", app)])
    calls = []
    tools = SystemTools(policy, lambda *args: calls.append(args) or {"status": "open_requested"}, catalog)
    app_id = catalog.search("chosen")[0]["app_id"]
    result = tools.open_file("output", path.name, threading.Event(), app_id=app_id)
    assert calls[0][0] == str(app) and f'"{path}"' in calls[0][1]
    assert result["app_id"] == app_id and result["absolute_path"] == str(path)
    assert result["status"] == "open_requested"


def test_discovered_shortcut_resolves_without_accepting_model_arguments(tmp_path):
    policy = DirectoryPolicy(tmp_path / "output")
    (policy.roots["output"]["path"] / "doc.md").write_text("x")
    app = tmp_path / "code.exe"; app.write_bytes(b"fixture")
    link = tmp_path / "Editor.lnk"; link.write_bytes(b"fixture")
    catalog = ApplicationCatalog(lambda: [app_record("chosen", link)])
    calls = []
    tools = SystemTools(policy, lambda *args: calls.append(args) or {"status": "open_requested"}, catalog,
                        shortcut_resolver=lambda path: (str(app), None))
    tools.open_file("output", "doc.md", threading.Event(), catalog.search("chosen")[0]["app_id"])
    assert calls[0][0] == str(app) and calls[0][1].startswith("--reuse-window -- ")
    unknown = tmp_path / "powershell.exe"; unknown.write_bytes(b"fixture")
    tools.shortcut_resolver = lambda path: (str(unknown), None)
    with pytest.raises(ToolError, match="暂不支持"):
        tools.open_file("output", "doc.md", threading.Event(), catalog.search("chosen")[0]["app_id"])
    assert len(calls) == 1
