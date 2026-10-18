from unittest.mock import AsyncMock

import pytest

from services.agent.runtime import AgentRuntime
from services.agent.config import Settings
from test_runtime import Desktop, Tts, Ws, settings


@pytest.mark.asyncio
async def test_search_publishes_persistent_topic_sources_and_open_receipt(tmp_path):
    cfg = settings(tmp_path)
    runtime = AgentRuntime(cfg, desktop=Desktop(), tts=Tts())
    ws = Ws(); runtime.clients.add(ws)
    cid = runtime.conversations.current_id
    source = {'source_id': 'source-link', 'title': 'Example Domain', 'url': 'https://example.com/'}
    runtime.web.search = AsyncMock(return_value=[source])
    runtime.turn_id = 'turn-with-source'
    await runtime._web_search(query='example')
    published = next(e['source'] for e in ws.events if e['type'] == 'source.ready')
    assert published['conversation_id'] == cid
    assert published['turn_id'] == 'turn-with-source'
    assert runtime.store.get_record('source', 'source-link') == published
    await runtime.handle({'type': 'source.open', 'source_id': 'source-link', 'request_id': 'open-click'})
    event = next(e for e in ws.events if e['type'] == 'source.open')
    assert event['url'] == source['url']
    assert event['request_id'] == 'open-click'
    assert event['source_id'] == 'source-link'
    await runtime.close()

    restored = AgentRuntime(Settings(tmp_path), desktop=Desktop(), tts=Tts())
    ws2 = Ws(); restored.clients.add(ws2)
    try:
        await restored._conversation_snapshot()
        assert any(e['type'] == 'sources.ready' and any(s['source_id'] == 'source-link' for s in e['sources']) for e in ws2.events)
        await restored.handle({'type': 'conversation.create'})
        ws2.events.clear()
        await restored._conversation_snapshot()
        assert not any(e['type'] == 'sources.ready' and e['sources'] for e in ws2.events)
        await restored.handle({'type': 'conversation.select', 'conversation_id': cid})
        assert any(e['type'] == 'sources.ready' and e['sources'] for e in ws2.events)
        restored.web.sources.clear()  # An evicted RAM cache still resolves a saved source.
        await restored.handle({'type': 'source.open', 'source_id': 'source-link', 'request_id': 'restored-open'})
        assert any(e['type'] == 'source.open' and e['request_id'] == 'restored-open' for e in ws2.events)
    finally:
        await restored.close()


@pytest.mark.asyncio
async def test_sources_snapshot_lists_newest_first(tmp_path):
    runtime = AgentRuntime(settings(tmp_path), desktop=Desktop(), tts=Tts())
    ws = Ws(); runtime.clients.add(ws)
    try:
        await runtime._publish_source({'source_id': 'source-old', 'title': 'Old', 'url': 'https://example.com/old'})
        runtime.web.sources['source-old']['published_at'] = 1
        await runtime._publish_source({'source_id': 'source-new', 'title': 'New', 'url': 'https://example.com/new'})
        runtime.web.sources['source-new']['published_at'] = 2
        await runtime._publish_source({'source_id': 'source-revisit', 'title': 'Old again', 'url': 'https://example.com/old'})
        runtime.web.sources['source-revisit']['published_at'] = 3
        await runtime._conversation_snapshot()
        event = next(e for e in ws.events if e['type'] == 'sources.ready')
        assert [source['source_id'] for source in event['sources']] == ['source-revisit', 'source-new']
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_unknown_source_fails_without_open_event(tmp_path):
    runtime = AgentRuntime(settings(tmp_path), desktop=Desktop(), tts=Tts())
    ws = Ws(); runtime.clients.add(ws)
    try:
        with pytest.raises(ValueError, match='来源记录已失效'):
            await runtime.handle({'type': 'source.open', 'source_id': 'missing', 'request_id': 'missing-open'})
        assert not any(e['type'] == 'source.open' for e in ws.events)
    finally:
        await runtime.close()
