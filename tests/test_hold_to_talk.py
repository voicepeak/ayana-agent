import asyncio
from unittest.mock import AsyncMock

import pytest

from native.windows.hold_key import chord_codes, wait_for_release
from services.agent.runtime import AgentRuntime
from services.agent.config import Settings
from test_runtime import Desktop, Tts, Ws, settings


def test_hotkey_aliases_and_default():
    assert chord_codes('CommandOrControl+Shift+Space') == chord_codes('Shift+Ctrl+Space') == (16, 17, 32)
    assert chord_codes('Alt+F24') == (18, 135)


@pytest.mark.parametrize('key', ['', 'Space', 'Ctrl+Ctrl+A', 'Control+?', 'Ctrl+F25', None, 'Ctrl+Alt+'])
def test_invalid_hold_chords(key):
    with pytest.raises(ValueError):
        chord_codes(key)


def test_settings_reject_alias_conflicts_and_persist(tmp_path):
    cfg = settings(tmp_path)
    cfg.update({'talk_hotkey': 'Control+Shift+Space'})
    assert Settings(tmp_path).values['talk_hotkey'] == 'Control+Shift+Space'
    for patch in [{'talk_hotkey': cfg.values['hotkey']}, {'cancel_hotkey': 'Shift+Ctrl+Space'}, {'hotkey': 'Ctrl+Shift+Space'}]:
        with pytest.raises(ValueError):
            cfg.update(patch)
    assert cfg.values['talk_hotkey'] == 'Control+Shift+Space'


@pytest.mark.asyncio
async def test_release_watches_only_chord_and_ends_when_any_key_released():
    calls = []
    def read(code):
        calls.append(code)
        return len(calls) < 5
    assert await wait_for_release('Ctrl+Shift+Space', read_key=read) == 'released'
    assert set(calls) <= {16, 17, 32}
    assert await wait_for_release('Ctrl+Shift+Space', read_key=lambda code: True, timeout=0) == 'timeout'


@pytest.mark.asyncio
async def test_hold_event_release_cancel_and_close(tmp_path, monkeypatch):
    runtime = AgentRuntime(settings(tmp_path), desktop=Desktop(), tts=Tts())
    ws = Ws(); runtime.clients.add(ws)
    released = AsyncMock(return_value='released')
    monkeypatch.setattr('native.windows.hold_key.wait_for_release', released)
    await runtime.handle({'type': 'input.hold-watch', 'hold_id': 'first'})
    await runtime.hold_task
    assert any(e['type'] == 'input.hold-ended' and e['hold_id'] == 'first' for e in ws.events)
    async def pending(*args):
        await asyncio.Event().wait()
    monkeypatch.setattr('native.windows.hold_key.wait_for_release', pending)
    await runtime.handle({'type': 'input.hold-watch', 'hold_id': 'second'})
    task = runtime.hold_task
    await asyncio.sleep(0)
    await runtime.handle({'type': 'input.hold-cancel'})
    await asyncio.gather(task, return_exceptions=True)
    assert task.cancelled()
    assert not any(e.get('hold_id') == 'second' for e in ws.events)
    await runtime.close()


@pytest.mark.asyncio
async def test_transcript_correlates_recording_and_never_sends_turn(tmp_path):
    runtime = AgentRuntime(settings(tmp_path), desktop=Desktop(), tts=Tts())
    ws = Ws(); runtime.clients.add(ws)
    runtime.stt = AsyncMock()
    runtime.stt.transcribe.return_value = '今天一起去散步吧'
    await runtime.handle({'type': 'input.audio', 'request_id': 'held-1', 'audio_base64': 'test', 'mime_type': 'audio/webm'})
    await runtime.task
    transcript = next(e for e in ws.events if e['type'] == 'input.transcribed')
    assert transcript['request_id'] == 'held-1'
    assert transcript['text'] == '今天一起去散步吧'
    assert not any(e['type'] == 'user.message' for e in ws.events)
    await runtime.close()
