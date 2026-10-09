import asyncio
import base64
import json
import time

import pytest

from services.agent.tools.registry import ToolError
from tests.test_conversations import make_runtime
from tests.test_model import sse_response
from tests.test_runtime import Desktop


class Screen(Desktop):
    status = {"available": True}
    def __init__(self):
        self.calls = 0
        self.front = {"target_id": "front", "hwnd": 12, "process_created": 4, "title": "下载页面"}

    def foreground(self):
        return self.front

    def capture(self, target):
        self.calls += 1
        return {"snapshot_id": "snap-new", "target": self.front, "content_sha256": "same-image",
                "captured_at_monotonic_ms": time.monotonic() * 1000,
                "png_base64": base64.b64encode(b"fixture-image").decode()}

    def capture_desktop(self):
        return {**self.capture(None), "snapshot_id": "desk-overview", "target": None, "actionable": False}


def runtime_for(tmp_path, response):
    runtime = make_runtime(tmp_path, response)
    runtime.desktop = Screen()
    runtime.companion_visible = True
    runtime.settings.values.update(send_screenshot=True, ambient_attention=True)
    return runtime


@pytest.mark.asyncio
async def test_ambient_can_choose_silence_without_capturing_or_writing_history(tmp_path):
    requests = []
    def response(request):
        requests.append(json.loads(request.content))
        return sse_response([{"type": "silence"}])
    runtime = runtime_for(tmp_path, response)
    try:
        await runtime._attention_turn(runtime.desktop.front, runtime.conversations.current_id, runtime.generation)
        assert runtime.desktop.calls == 0
        assert runtime.conversations.history(runtime.conversations.current_id)["items"] == []
        assert runtime.store.db.execute("SELECT count(*) FROM events").fetchone()[0] == 0
        assert [tool["function"]["name"] for tool in requests[0]["tools"]] == ["desktop__observe"]
        assert requests[0]["max_tokens"] == 800
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_ambient_observes_once_stays_quiet_and_does_not_replace_action_target(tmp_path):
    requests = []
    def response(request):
        requests.append(json.loads(request.content))
        return sse_response([{"type": "tool", "name": "desktop.observe", "arguments": {"scope": "foreground"}}]
                            if len(requests) % 2 else [{"type": "silence", "observation_summary": "页面显示下载进度。"}])
    runtime = runtime_for(tmp_path, response)
    runtime.target = {"target_id": "task-window"}
    runtime.snapshot = {"snapshot_id": "task-snapshot"}
    try:
        await runtime._attention_turn(runtime.desktop.front, runtime.conversations.current_id, runtime.generation)
        assert runtime.desktop.calls == 1 and len(requests) == 2
        assert "image_url" in json.dumps(requests[-1])
        assert runtime.target["target_id"] == "task-window"
        assert runtime.snapshot["snapshot_id"] == "task-snapshot"
        assert runtime.recent_observations[-1]["summary"] == "页面显示下载进度。"
        assert not runtime.store.history()
        await runtime._attention_turn(runtime.desktop.front, runtime.conversations.current_id, runtime.generation)
        assert len(requests) == 3  # Same pixels do not trigger a second visual model request.
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_ambient_speech_needs_real_observation_and_has_no_fake_user_turn(tmp_path):
    calls = []
    def response(request):
        calls.append(request)
        if len(calls) == 1:
            return sse_response([{"type": "tool", "name": "desktop.observe", "arguments": {}}])
        return sse_response([{"type": "speech", "key": "s1", "speech_ja": "もうすぐ終わりそうだね。", "intent": "acknowledge"},
                             {"type": "translation", "key": "s1", "display_zh": "看起来快结束了呢。"}])
    runtime = runtime_for(tmp_path, response)
    try:
        await runtime._attention_turn(runtime.desktop.front, runtime.conversations.current_id, runtime.generation)
        items = runtime.conversations.history(runtime.conversations.current_id)["items"]
        assert [item["role"] for item in items] == ["assistant"]
        assert items[0]["display_zh"] == "看起来快结束了呢。"
        assert not runtime.store.db.execute("SELECT id FROM events WHERE type='user.message'").fetchall()
        assert not runtime.store.records("task")
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_ambient_drops_unsolicited_speech_without_a_screenshot(tmp_path):
    runtime = runtime_for(tmp_path, lambda request: sse_response([
        {"type": "speech", "key": "s1", "speech_ja": "見ているよ。"},
        {"type": "translation", "key": "s1", "display_zh": "我在看。"}]))
    try:
        await runtime._attention_turn(runtime.desktop.front, runtime.conversations.current_id, runtime.generation)
        assert not runtime.store.history() and runtime.desktop.calls == 0
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_disabled_ambient_speech_observes_but_never_records_or_plays_speech(tmp_path):
    requests = []
    def response(request):
        requests.append(json.loads(request.content))
        if len(requests) % 2:
            return sse_response([{"type": "tool", "name": "desktop.observe", "arguments": {"scope": "foreground"}}])
        return sse_response([{"type": "speech", "key": "s1", "speech_ja": "見えたよ。"},
                             {"type": "translation", "key": "s1", "display_zh": "看到了。"}])
    runtime = runtime_for(tmp_path, response)
    runtime.settings.values["ambient_speech"] = False
    try:
        await runtime._attention_turn(runtime.desktop.front, runtime.conversations.current_id, runtime.generation)
        assert runtime.desktop.calls == 1 and len(requests) == 2
        assert "disabled proactive speaking" in requests[0]["messages"][0]["content"]
        assert runtime.recent_observations[-1]["summary"] == ""
        assert not runtime.store.history()
        assert not runtime.store.db.execute("SELECT id FROM events WHERE type='utterance.ready'").fetchall()
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_attention_interval_follows_settings_and_reschedules(tmp_path):
    runtime = runtime_for(tmp_path, lambda request: sse_response([{"type": "silence"}]))
    try:
        runtime.settings.values.update(ambient_interval_min=30, ambient_interval_max=30)
        assert runtime._attention_interval() == 30
        runtime.settings.values.update(ambient_interval_min=100, ambient_interval_max=100)
        runtime._attention_reschedule()
        assert 99 <= runtime.attention_next_at - time.monotonic() <= 101
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_observe_overview_is_not_a_window_input_target_and_disabled_means_no_capture(tmp_path):
    runtime = runtime_for(tmp_path, lambda request: sse_response([{"type": "silence"}]))
    try:
        await runtime.registry.execute("desktop.observe", {"scope": "desktop"})
        assert runtime.target is None and runtime.snapshot["actionable"] is False
        assert not runtime.registry.available(runtime.registry.tools["desktop.step"])
        runtime.settings.values["send_screenshot"] = False
        with pytest.raises(ToolError):
            await runtime._observe_data()
        assert runtime.desktop.calls == 1
        assert not runtime._attention_idle()
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_hide_interrupts_a_pending_glance_and_cannot_emit_a_late_reply(tmp_path):
    entered = asyncio.Event()
    async def response(request):
        entered.set()
        await asyncio.Event().wait()
    runtime = runtime_for(tmp_path, response)
    try:
        runtime.task = asyncio.create_task(runtime._attention_turn(runtime.desktop.front, runtime.conversations.current_id, runtime.generation))
        task = runtime.task
        await asyncio.wait_for(entered.wait(), 2)
        await runtime.handle({"type": "session.close"})
        assert task.cancelled() and runtime.task is None and not runtime.companion_visible
        assert not runtime.store.history()
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_pause_and_resume_are_persisted_and_attention_never_interrupts_a_task(tmp_path):
    runtime = runtime_for(tmp_path, lambda request: sse_response([{"type": "silence"}]))
    try:
        assert runtime._attention_idle()
        await runtime.registry.execute("attention.configure", {"enabled": False})
        assert not runtime._attention_idle()
        assert json.loads(runtime.settings.path.read_text(encoding="utf-8"))["ambient_attention"] is False
        await runtime.registry.execute("attention.configure", {"enabled": True})
        runtime.pending["audio"] = 100
        assert not runtime._attention_idle()
        runtime.pending.clear()
        runtime.task = asyncio.create_task(asyncio.Event().wait())
        assert not runtime._attention_idle()
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_explicit_observation_can_see_the_window_behind_ayana(tmp_path):
    runtime = runtime_for(tmp_path, lambda request: sse_response([{"type": "silence"}]))
    runtime.desktop.foreground = lambda: None
    runtime.desktop.list_windows = lambda: [{**runtime.desktop.front, "window_state": "visible", "elevated": False}]
    runtime.desktop.bind = lambda hwnd: runtime.desktop.front
    try:
        await runtime.registry.execute("desktop.observe", {})
        assert runtime.snapshot["snapshot_id"] == "snap-new" and runtime.desktop.calls == 1
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_scheduler_shutdown_cancels_inflight_attention_without_hanging(tmp_path):
    entered = asyncio.Event()
    async def response(request):
        entered.set()
        await asyncio.Event().wait()
    runtime = runtime_for(tmp_path, response)
    runtime.attention_next_at = 0
    await runtime.start()
    try:
        await asyncio.wait_for(entered.wait(), 7)
        await asyncio.wait_for(runtime.close(), 2)
        assert runtime.attention_runner.cancelled()
    finally:
        if not runtime.closed:
            await runtime.close()
