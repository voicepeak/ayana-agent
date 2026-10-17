import asyncio

import pytest

from services.agent.runtime import AgentRuntime
from test_runtime import Desktop, Tts, Ws, settings


@pytest.mark.asyncio
async def test_shutdown_drains_active_command_rejects_queued_work_and_closes_once(tmp_path):
    class DelayedCancel(Tts):
        def __init__(self):
            super().__init__()
            self.entered = asyncio.Event()
            self.release = asyncio.Event()
            self.closes = 0

        async def cancel(self, gen):
            self.cancelled.append(gen)
            if len(self.cancelled) == 1:
                self.entered.set()
                await self.release.wait()

        async def close(self):
            self.closes += 1

    voice = DelayedCancel()
    runtime = AgentRuntime(settings(tmp_path), desktop=Desktop(), tts=voice)
    active = asyncio.create_task(runtime.handle({"type": "turn.start", "text": "active"}))
    await asyncio.wait_for(voice.entered.wait(), 1)
    queued = asyncio.create_task(runtime.handle({"type": "turn.start", "text": "queued"}))
    await asyncio.sleep(0)
    closing = asyncio.create_task(runtime.close())
    try:
        await asyncio.sleep(.01)
        assert runtime.closing and not runtime.closed and not closing.done()
        with pytest.raises(RuntimeError, match="closing"):
            await runtime.handle({"type": "settings.get"})
        with pytest.raises(RuntimeError, match="closing"):
            await runtime.connected(Ws())
        voice.release.set()
        await asyncio.wait_for(active, 2)
        with pytest.raises(RuntimeError, match="closing"):
            await queued
        await asyncio.wait_for(asyncio.gather(closing, runtime.close()), 2)
        assert runtime.closed and voice.closes == 1
        assert runtime.task is None
        # Error handling or a final disconnect after shutdown cannot write SQLite.
        await runtime.emit("error", source="command", message="late error")
        await runtime.disconnected(Ws())
        assert not runtime.client_senders and not runtime.client_queues
    finally:
        voice.release.set()
        await asyncio.gather(active, queued, closing, return_exceptions=True)
        await runtime.close()


@pytest.mark.asyncio
async def test_disconnect_releases_idle_sender_without_interrupting_other_client(tmp_path):
    runtime = AgentRuntime(settings(tmp_path), desktop=Desktop(), tts=Tts())
    gone, healthy = Ws(), Ws()
    try:
        await runtime.connected(gone)
        await runtime.connected(healthy)
        await runtime.client_queues[gone].join()
        old_sender = runtime.client_senders[gone]
        generation = runtime.generation
        await asyncio.gather(runtime.disconnected(gone), runtime.disconnected(gone))
        assert old_sender.done()
        assert gone not in runtime.clients
        assert gone not in runtime.client_senders and gone not in runtime.client_queues
        assert runtime.generation == generation
        await runtime.emit("test.event")
        await runtime.client_queues[healthy].join()
        assert healthy.events[-1]["type"] == "test.event"
        await runtime.disconnected(healthy)
        assert runtime.generation == generation + 1
        assert not runtime.clients and not runtime.client_senders and not runtime.client_queues
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_playback_progress_is_monotonic_and_completed_speech_is_terminal(tmp_path):
    runtime = AgentRuntime(settings(tmp_path), desktop=Desktop(), tts=Tts())
    try:
        await runtime.handle({"type": "turn.start", "text": "receipts"})
        await runtime.task
        uid = next(iter(runtime.utterances))
        base = {"utterance_id": uid, "generation_id": runtime.generation}
        await runtime.handle({**base, "type": "playback.started"})
        for samples in (1000, 500):
            await runtime.handle({**base, "type": "playback.progress", "played_samples": samples})
        assert runtime.utterances[uid]["played_samples"] == 1000
        await runtime.handle({**base, "type": "playback.ended", "played_samples": 1600})
        generation = runtime.generation
        for kind in ("playback.started", "playback.progress", "playback.ended", "playback.cancelled", "playback.error"):
            await runtime.handle({**base, "type": kind, "played_samples": 500})
        assert runtime.generation == generation
        assert runtime.utterances[uid]["status"] == "played"
        saved = next(row for row in runtime.store.history() if row["utterance_id"] == uid)
        assert saved["status"] == "played" and saved["played_samples"] == 1600
        assert uid not in runtime.pending
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_late_cancel_receipts_refine_partial_consumption_without_reviving_speech(tmp_path):
    runtime = AgentRuntime(settings(tmp_path), desktop=Desktop(), tts=Tts())
    try:
        await runtime.handle({"type": "turn.start", "text": "interrupted"})
        await runtime.task
        uid = next(iter(runtime.utterances))
        base = {"utterance_id": uid, "generation_id": runtime.generation}
        await runtime.handle({**base, "type": "playback.started"})
        await runtime.handle({**base, "type": "playback.progress", "played_samples": 400})
        await runtime.cancel()
        for samples in (800, 200, 800, 1200):
            await runtime.handle({**base, "type": "playback.cancelled", "played_samples": samples})
        for kind in ("playback.started", "playback.progress", "playback.ended"):
            await runtime.handle({**base, "type": kind, "played_samples": 1600})
        saved = next(row for row in runtime.store.history() if row["utterance_id"] == uid)
        assert saved["status"] == "partial" and saved["played_samples"] == 1200
        assert runtime.utterances[uid]["status"] == "partial"
    finally:
        await runtime.close()
