"""Regression cases from the failed search and malformed report audit."""
import asyncio
import base64
import json
import sys

import httpx
import pytest

from services.agent.capabilities import CapabilityRuntime
from services.agent.tools.registry import ToolError
from services.agent.tools.web import WebTools
from services.agent.tools.search_terms import restore_search_terms
from test_capabilities import runtime, speech
from test_model import sse_response, VALID


def rss(title="音无彩名", url="https://example.com/ayana"):
    return f"<rss><channel><item><title>{title}</title><link>{url}</link><description>Character reference.</description></item></channel></rss>"


def native_calls(calls):
    delta = {"tool_calls": [{"index": i, "id": cid, "type": "function",
                            "function": {"name": name, "arguments": args}}
                           for i, (cid, name, args) in enumerate(calls)]}
    return httpx.Response(200, text="data: " + json.dumps({"choices": [{"delta": delta, "finish_reason": "tool_calls"}]}) + "\n\ndata: [DONE]\n\n")


@pytest.mark.skipif(sys.platform != "win32", reason="Windows NLS spelling comparison")
def test_original_user_spelling_wins_without_guessing_another_name():
    assert restore_search_terms("音無彩名", "音無彩名", "请搜索音无彩名", "音无彩名") == ("音无彩名", "音无彩名")
    assert restore_search_terms("音無彩名 キャラクター", "音無彩名", "查你自己的资料", "音无彩名") == ("音无彩名 キャラクター", "音无彩名")
    assert restore_search_terms("音無彩名", "音無彩名", "请搜索音無彩名", "音无彩名") == ("音無彩名", "音無彩名")
    assert restore_search_terms("李伟", "李伟", "请搜索张伟") == ("李伟", "李伟")
    assert restore_search_terms("台灣", "台灣", "比较台灣和台湾") == ("台灣", "台灣")


@pytest.mark.asyncio
@pytest.mark.skipif(sys.platform != "win32", reason="Windows NLS spelling comparison")
async def test_model_rewritten_name_is_restored_before_search(tmp_path):
    requests = []
    agent = runtime(tmp_path, lambda r: sse_response([speech()]))
    await agent.web.close()
    def respond(request):
        requests.append(request)
        return httpx.Response(200, text=rss())
    agent.web = WebTools(lambda: "", httpx.MockTransport(respond))
    try:
        await agent.handle({"type": "turn.start", "text": "请搜索音无彩名"})
        await agent.task
        result = await agent._dispatch_tool({"type": "tool", "call_id": "rewritten", "name": "web.search",
            "arguments": {"query": "音無彩名", "subject": "音無彩名"}})
        assert requests[0].url.params["q"] == "音无彩名"
        assert result["result"][0]["subject_used"] == "音无彩名"
        assert any(e["type"] == "tool.progress" and e["stage"] == "original_subject" for e in next(iter(agent.clients)).events)
    finally:
        await agent.close()


@pytest.mark.asyncio
async def test_bing_fallback_preserves_real_links_and_rejects_private_results():
    requests, progress = [], []
    wrapped = "a1" + base64.urlsafe_b64encode(b"https://example.com/ayana").decode().rstrip("=")
    async def report(stage, message):
        progress.append(stage)
    def respond(request):
        requests.append(request)
        if request.url.params.get("format") == "rss":
            return httpx.Response(200, text="<html>Service changed</html>")
        return httpx.Response(200, text=f'''<!doctype html><nav><a href="https://irrelevant.example">Noise</a></nav>
            <li class="b_algo"><h2><a href="https://www.bing.com/ck/a?u={wrapped}">音无彩名</a></h2><p>Real character source.</p></li>
            <li class="b_algo"><h2><a href="http://127.0.0.1/secret">Private</a></h2></li>''')
    tools = WebTools(lambda: "", httpx.MockTransport(respond))
    try:
        result = await tools.search("音无彩名", progress=report)
        assert len(requests) == 2 and [r.url.params["q"] for r in requests] == ["音无彩名"] * 2
        assert progress == ["search_fallback"]
        assert len(result) == 1 and result[0]["url"] == "https://example.com/ayana"
        assert result[0]["format"] == "html"
    finally:
        await tools.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("query", ["音无彩名 角色 介绍", "音无彩名"])
async def test_entity_search_falls_back_to_exact_name_only_for_unrelated_results(query):
    queries, stages = [], []
    def respond(request):
        query = request.url.params["q"]
        queries.append(query)
        return httpx.Response(200, text=rss("音 - 短视频" if len(queries) == 1 else "音无彩名 - 角色百科"))
    async def progress(stage, message):
        stages.append(stage)
    tools = WebTools(lambda: "", httpx.MockTransport(respond))
    try:
        result = await tools.search(query, subject="音无彩名", progress=progress)
        assert queries == [query, '"音无彩名"']
        assert stages == ["exact_search"] and result[0]["subject_mentioned"] is True
        await tools.search("音无彩名", subject="音无彩名")
        assert queries[-1] == "音无彩名" and len(queries) == 3
    finally:
        await tools.close()


@pytest.mark.asyncio
async def test_web_fetch_keeps_links_and_complete_body_for_continuation():
    calls = []
    content = "正确的网页正文。" * 4000
    def respond(request):
        calls.append(request)
        return httpx.Response(200, headers={"Content-Type": "text/html"}, text=f'''<title>Reference</title><p>{content}</p>
            <a href="/original">原文</a><a href="javascript:alert(1)">Bad</a><a href="http://127.0.0.1/x">Private</a>
            <script><a href="https://hidden.example">Secret</a></script>''')
    tools = WebTools(lambda: "", httpx.MockTransport(respond))
    try:
        page = await tools.fetch("https://example.com/reference")
        assert page["links"] == [{"url": "https://example.com/original", "text": "原文"}]
        assert page["truncated"] and page["next_offset"] == 12000
        parts = [page["content"]]
        while page["next_offset"] is not None:
            page = await tools.fetch(page["source_id"], offset=page["next_offset"])
            parts.append(page["content"])
        assert "".join(parts).startswith(content) and len("".join(parts)) == page["total_chars"]
        assert not page["truncated"] and len(calls) == 1
        with pytest.raises(ToolError, match="超出"):
            await tools.fetch(page["source_id"], offset=page["total_chars"])
        tools.pages.clear()
        with pytest.raises(ToolError) as error:
            await tools.fetch(page["source_id"], offset=12000)
        assert error.value.code == "source_expired"
    finally:
        await tools.close()


class Batch(CapabilityRuntime):
    def __init__(self, dispatch):
        self._read_tool = dispatch


@pytest.mark.asyncio
async def test_web_batch_overlaps_but_keeps_results_order_and_write_barriers():
    started, done = [], []
    both = asyncio.Event()
    async def dispatch(request):
        key = request["call_id"]
        started.append(key)
        if key in {"slow", "fast"}:
            if {"slow", "fast"} <= set(started):
                both.set()
            await asyncio.wait_for(both.wait(), 1)
            if key == "slow":
                await asyncio.sleep(.01)
        elif key == "write":
            assert set(done) == {"slow", "fast"}
        elif key == "last":
            assert "write" in done
        done.append(key)
        return {"call_id": key}
    requests = [{"name": name, "call_id": cid} for name, cid in [
        ("web.search", "slow"), ("web.fetch", "fast"), ("files.create", "write"), ("web.fetch", "last")]]
    result = await Batch(dispatch)._dispatch_tools(requests)
    assert [item["call_id"] for item in result] == ["slow", "fast", "write", "last"]
    assert done == ["fast", "slow", "write", "last"]


@pytest.mark.asyncio
async def test_web_batch_bounds_concurrency_and_cancel_drains_children():
    running, peak, stopped = 0, 0, []
    ready, wait = asyncio.Event(), asyncio.Event()
    async def dispatch(request):
        nonlocal running, peak
        running += 1
        peak = max(peak, running)
        if running == 3:
            ready.set()
        try:
            await wait.wait()
        finally:
            running -= 1
            stopped.append(request["call_id"])
    task = asyncio.create_task(Batch(dispatch)._dispatch_tools([
        {"name": "web.fetch", "call_id": str(i)} for i in range(6)]))
    await asyncio.wait_for(ready.wait(), 1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert peak == 3 and running == 0 and len(stopped) == 3


@pytest.mark.asyncio
async def test_malformed_native_sibling_gets_error_without_dropping_success(tmp_path):
    calls, performed = [], []
    def respond(request):
        body = json.loads(request.content)
        calls.append(body)
        if len(calls) == 1:
            return native_calls([("good", "web__fetch", '{"url":"https://example.com/ok"}'),
                                 ("bad", "files__create", '{"path":')])
        receipts = [json.loads(m["content"]) for m in body["messages"] if m["role"] == "tool"]
        assert [r["call_id"] for r in receipts] == ["good", "bad"]
        assert receipts[0]["result"]["content"] == "verified source"
        assert receipts[1]["code"] == "invalid_arguments"
        assistant = next(m for m in reversed(body["messages"]) if m["role"] == "assistant")
        assert assistant["tool_calls"][1]["function"]["arguments"] == '{"path":'
        return sse_response([speech()])
    agent = runtime(tmp_path, respond)
    async def fetch(**args):
        performed.append(args)
        return {"content": "verified source"}
    agent.registry.tools["web.fetch"].handler = fetch
    try:
        await agent.handle({"type": "turn.start", "text": "Find the source"})
        await agent.task
        assert len(calls) == 2 and len(performed) == 1 and agent.active_task.calls == 2
        assert agent.active_task.results["good"]["value"]["result"]["content"] == "verified source"
        assert not list((tmp_path / "artifacts").glob("*.md"))
    finally:
        await agent.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("with_tools", [False, True])
async def test_invalid_report_repairs_metadata_once_without_replaying_committed_work(tmp_path, with_tools):
    calls, performed = [], []
    bad = {"type": "task", "kind": "answer", "status": "complete", "extra_field": "wrong"}
    def respond(request):
        body = json.loads(request.content)
        calls.append(body)
        if len(calls) == 1:
            initial = sse_response([VALID, {"type": "translation", "key": "s1", "display_zh": "一起看看吧。"}, bad])
            if with_tools:
                return httpx.Response(200, text=initial.text.replace("data: [DONE]\n\n", "") +
                    native_calls([("found", "web__fetch", '{"url":"https://example.com/ayana"}')]).text)
            return initial
        assert "tools" not in body
        if with_tools:
            assert any(m["role"] == "tool" and m["tool_call_id"] == "found" for m in body["messages"])
        return sse_response([{"type": "task", "kind": "answer", "status": "complete"}])
    agent = runtime(tmp_path, respond)
    async def fetch(**args):
        performed.append(args)
        return {"content": "real source"}
    agent.registry.tools["web.fetch"].handler = fetch
    try:
        await agent.handle({"type": "turn.start", "text": "Explain this"})
        await agent.task
        assert len(calls) == 2 and len(performed) == int(with_tools)
        assert agent.active_task.state == "succeeded"
        events = next(iter(agent.clients)).events
        assert len([e for e in events if e["type"] == "utterance.ready"]) == 1
        assert not [e for e in events if e["type"] == "error"]
        assert any(r["phase"] == "task_report_validation" for r in agent.prompt_trace.export()["requests"])
    finally:
        await agent.close()


@pytest.mark.asyncio
async def test_report_repair_cannot_execute_ndjson_tools_or_loop_forever(tmp_path):
    calls = []
    def respond(request):
        calls.append(request)
        if len(calls) == 1:
            return sse_response([VALID, {"type": "task", "status": "invalid"}])
        return sse_response([{"type": "tool", "name": "files.create", "arguments": {
            "path": "do-not-write.md", "content": "bad"}}, {"type": "task", "status": "invalid"}])
    agent = runtime(tmp_path, respond)
    try:
        await agent.handle({"type": "turn.start", "text": "Please write something", "mode": "execute"})
        await agent.task
        assert len(calls) == 2 and agent.active_task.state == "failed"
        assert agent.active_task.calls == 0 and not (tmp_path / "artifacts/do-not-write.md").exists()
        assert len([e for e in next(iter(agent.clients)).events if e["type"] == "utterance.ready"]) == 1
    finally:
        await agent.close()


@pytest.mark.asyncio
async def test_report_repair_can_supply_first_answer_without_repeating_tools(tmp_path):
    calls = []
    def respond(request):
        body = json.loads(request.content)
        calls.append(body)
        if len(calls) == 1:
            initial = sse_response([{"type": "task", "status": "not-valid"}]).text.replace("data: [DONE]\n\n", "")
            return httpx.Response(200, text=initial + native_calls([
                ("once", "files__read", '{"path":"evidence.txt","root_id":"output"}')]).text)
        assert "tools" not in body
        return sse_response([VALID, {"type": "task", "kind": "answer", "status": "complete"}])
    agent = runtime(tmp_path, respond)
    (tmp_path / "artifacts/evidence.txt").write_text("real evidence", encoding="utf-8")
    try:
        await agent.handle({"type": "turn.start", "text": "Read this file"})
        await agent.task
        assert len(calls) == 2 and agent.active_task.calls == 1
        assert agent.active_task.state == "succeeded"
    finally:
        await agent.close()


@pytest.mark.asyncio
async def test_report_repair_cannot_change_the_agreed_task_kind_or_checks(tmp_path):
    calls = []
    plan = {"type": "task", "kind": "action", "status": "running",
            "checks": [{"description": "Open and verify the requested page", "evidence": []}]}
    def respond(request):
        calls.append(request)
        if len(calls) == 1:
            return sse_response([plan, VALID, {"type": "task", "status": "invalid"}])
        return sse_response([{"type": "task", "kind": "answer", "status": "complete", "checks": []}])
    agent = runtime(tmp_path, respond)
    try:
        await agent.handle({"type": "turn.start", "text": "Open this page"})
        await agent.task
        assert len(calls) == 2 and agent.active_task.state == "failed"
        assert agent.active_task.kind == "action" and agent.active_task.checks == plan["checks"]
    finally:
        await agent.close()


@pytest.mark.asyncio
async def test_concurrent_search_progress_keeps_per_call_identity(tmp_path):
    agent = runtime(tmp_path, lambda r: sse_response([speech()]))
    await agent.web.close()
    async def respond(request):
        if request.url.params.get("format") == "rss":
            return httpx.Response(200, text="<html>Verify</html>")
        await asyncio.sleep(.005)
        return httpx.Response(200, text='<li class="b_algo"><h2><a href="https://example.com/">Real reference</a></h2></li>')
    agent.web = WebTools(lambda: "", httpx.MockTransport(respond))
    try:
        results = await agent._dispatch_tools([{ "type": "tool", "name": "web.search", "arguments": {
            "query": name}, "call_id": name} for name in ["first", "second"]])
        assert all("result" in result for result in results)
        progress = [e for e in next(iter(agent.clients)).events if e["type"] == "tool.progress"]
        assert {e["call_id"] for e in progress} == {"first", "second"}
    finally:
        await agent.close()


@pytest.mark.asyncio
async def test_cancelled_native_batch_leaves_paired_history_for_the_next_question(tmp_path):
    calls, performed = [], []
    waiting = asyncio.Event()
    async def fetch(url):
        performed.append(url)
        if url.endswith("pending"):
            waiting.set()
            await asyncio.Event().wait()
        return {"content": "preserved real evidence"}
    def respond(request):
        body = json.loads(request.content)
        calls.append(body)
        if len(calls) == 1:
            return native_calls([("finished", "web__fetch", '{"url":"https://example.com/finished"}'),
                                 ("pending", "web__fetch", '{"url":"https://example.com/pending"}')])
        messages = body["messages"]
        position = next(i for i, m in enumerate(messages) if m.get("tool_calls"))
        replies = messages[position + 1:position + 3]
        assert [m["tool_call_id"] for m in replies] == ["finished", "pending"]
        assert json.loads(replies[0]["content"])["result"]["content"] == "preserved real evidence"
        unknown = json.loads(replies[1]["content"])
        assert unknown["code"] == "interrupted" and unknown["receipt"]["execution"] == "uncertain"
        return sse_response([speech()])
    agent = runtime(tmp_path, respond)
    agent.registry.tools["web.fetch"].handler = fetch
    try:
        await agent.handle({"type": "turn.start", "text": "Fetch two sources"})
        await asyncio.wait_for(waiting.wait(), 1)
        await agent.cancel()
        await agent.handle({"type": "turn.start", "text": "Continue discussing the result"})
        await agent.task
        assert len(calls) == 2 and len(performed) == 2
    finally:
        await agent.close()


@pytest.mark.asyncio
async def test_network_error_is_typed_and_other_call_succeeds(tmp_path):
    agent = runtime(tmp_path, lambda r: sse_response([speech()]))
    async def fetch(url):
        if url.endswith("slow"):
            raise httpx.ReadTimeout("secret-proxy-details")
        return {"content": "good"}
    agent.registry.tools["web.fetch"].handler = fetch
    try:
        result = await agent._dispatch_tools([{ "type": "tool", "name": "web.fetch", "arguments": {
            "url": "https://example.com/" + suffix}, "call_id": suffix} for suffix in ["slow", "good"]])
        assert result[0]["code"] == "tool_timeout" and result[0]["receipt"]["retryable"]
        assert "secret" not in result[0]["error"] and result[1]["result"]["content"] == "good"
    finally:
        await agent.close()


@pytest.mark.asyncio
async def test_repeated_observation_without_new_information_breaks_the_loop(tmp_path):
    agent = runtime(tmp_path, lambda r: sse_response([speech()]))
    agent.target = {"target_id": "win"}
    async def observe():
        return [{"name": "新标签页 - Google Chrome"}]
    agent.registry.tools["observe_controls"].handler = observe
    try:
        await agent.handle({"type": "turn.start", "text": "打开网页给我看看"})
        await agent.task
        first = await agent._dispatch_tool({"type": "tool", "name": "observe_controls", "arguments": {}, "call_id": "obs-1"})
        assert first["result"][0]["name"].startswith("新标签页")
        second = await agent._dispatch_tool({"type": "tool", "name": "observe_controls", "arguments": {}, "call_id": "obs-2"})
        assert second["code"] == "repeated_no_progress"
        assert second["receipt"]["retryable"] is False
        async def changed():
            return [{"name": "音无彩名 - 萌娘百科 - Google Chrome"}]
        agent.registry.tools["observe_controls"].handler = changed
        third = await agent._dispatch_tool({"type": "tool", "name": "observe_controls", "arguments": {}, "call_id": "obs-3"})
        assert third["result"][0]["name"].startswith("音无彩名")
        assert [e["type"] for e in next(iter(agent.clients)).events].count("tool.failed") == 1
    finally:
        await agent.close()


@pytest.mark.asyncio
async def test_repeated_searches_stop_network_and_feedback_is_task_local(tmp_path):
    calls = []
    agent = runtime(tmp_path, lambda r: sse_response([speech()]))
    await agent.web.close()
    agent.web = WebTools(lambda: "", httpx.MockTransport(lambda r: (calls.append(r) or httpx.Response(200, text=rss()))))
    try:
        # Start a task to bind the search history to this user turn.
        await agent.handle({"type": "turn.start", "text": "Search"})
        await agent.task
        request = {"type": "tool", "name": "web.search", "arguments": {"query": "音无彩名"}}
        first, second, third = [await agent._dispatch_tool({**request, "call_id": f"search-{i}"}) for i in range(3)]
        assert "result" in first and second["result"][0]["search_feedback"]["new_urls"] == 0
        assert third["code"] == "search_repeated" and len(calls) == 2
        await agent.handle({"type": "turn.start", "text": "Search again"})
        await agent.task
        fresh = await agent._dispatch_tool({**request, "call_id": "fresh"})
        assert "result" in fresh and len(calls) == 3
    finally:
        await agent.close()
