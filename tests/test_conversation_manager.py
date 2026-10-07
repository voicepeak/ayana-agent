import asyncio
import json
from copy import deepcopy
from pathlib import Path

import httpx
import pytest

from services.agent.context import PromptHistory, text_messages
from services.agent.memory import PersonalMemory
from services.agent.prompts import USER_MEMORY_PREFIX
from services.agent.storage import ConversationStore
from tests.test_conversations import ask, make_runtime, response


def last_event(runtime, kind):
    return next(event for event in reversed(next(iter(runtime.clients)).events) if event['type'] == kind)


def fact(source, key='beverage', content='用户喜欢红茶'):
    return {'memories': [{'key': key, 'content': content, 'source_id': source['id'], 'quote': source['text']}]}


def test_search_literal_pagination_date_subtitles_and_monotonic_ids(tmp_path):
    store = ConversationStore(tmp_path / 'history.sqlite3')
    try:
        for i in range(83):
            store.commit({'type': 'user.message', 'conversation_id': 'a', 'text': f'{i} 100%_Steam'})
        store.commit({'type': 'utterance.ready', 'session_id': 's', 'turn_id': 't', 'generation_id': 1,
                      'conversation_id': 'b', 'utterance_id': 'u', 'speech_ja': 'こんにちは'})
        store.commit({'type': 'subtitle.ready', 'utterance_id': 'u', 'display_zh': '中文原话', 'display_en': 'Hello'})
        assert not store.search_history("' OR 1=1 --")['items']
        assert len(store.search_history('%_')['items']) == 40
        all_ids, before = [], None
        while True:
            page = store.search_history('steam', before=before)
            all_ids.extend(item['id'] for item in page['items'])
            if not page['has_more']:
                break
            before = page['before']
        assert len(all_ids) == len(set(all_ids)) == 83
        assert all_ids == sorted(all_ids, reverse=True)
        assert store.search_history('中文')['items'][0]['role'] == 'assistant'
        assert store.search_history('こんにちは')['items'][0]['conversation_id'] == 'b'
        assert store.search_history('hello')['items'][0]['text'] == '中文原话'
        stamp = store.search_history('中文')['items'][0]['created']
        assert not store.search_history('中文', end=stamp)['items']
        assert store.search_history('中文', start=stamp)['items']
        assert not store.search_history('中文', conversation_id='a')['items']
        recent = store.user_memory_sources()
        assert len(recent) == 12 and recent[0]['id'] == 72
        following = store.user_memory_sources(after=40)
        assert [item['id'] for item in following] == list(range(41, 53))
        watermark = recent[-1]['id']
        store.delete_conversation('a'); store.delete_conversation('b')
        store.commit({'type': 'user.message', 'conversation_id': 'c', 'text': '后来的话'})
        assert store.user_memory_sources(after=watermark)[0]['id'] > watermark
    finally:
        store.close()


@pytest.mark.asyncio
@pytest.mark.parametrize('persist', [True, False])
async def test_browse_rename_search_export_do_not_switch_or_cancel_chat(tmp_path, persist):
    runtime = make_runtime(tmp_path, response, persist)
    pending = None
    try:
        old = runtime.conversations.current_id
        await ask(runtime, '旧记录里的针叶森林')
        await runtime.handle({'type': 'conversation.create'})
        active = runtime.conversations.current_id
        await ask(runtime, '当前记录里的海边')
        pending = runtime.task = asyncio.create_task(asyncio.Event().wait())
        generation = runtime.generation
        await runtime.handle({'type': 'conversation.history', 'conversation_id': old, 'request_id': 'browse'})
        page = last_event(runtime, 'conversation.review')
        assert page['review_id'] == old and page['request_id'] == 'browse'
        assert page['items'][0]['text'] == '旧记录里的针叶森林'
        await runtime.handle({'type': 'conversation.rename', 'conversation_id': old, 'title': '森林'})
        await runtime.handle({'type': 'conversation.search', 'query': '针叶'})
        assert last_event(runtime, 'conversation.search-results')['items'][0]['title'] == '森林'
        await runtime.handle({'type': 'conversation.export', 'conversation_id': old, 'format': 'json'})
        exported = Path(last_event(runtime, 'conversation.exported')['path'])
        content = json.loads(exported.read_text(encoding='utf-8'))
        assert content['title'] == '森林' and len(content['messages']) == 2
        assert runtime.conversations.current_id == active and runtime.generation == generation
        assert not pending.done()
        assert not runtime.store.records('memory')
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_export_all_pages_and_delete_records_context_memories_not_files(tmp_path):
    runtime = make_runtime(tmp_path, response)
    try:
        old = runtime.conversations.current_id
        await ask(runtime, '我喜欢红茶')
        old_tasks = [record['task_id'] for record in runtime.store.records('task')]
        source = runtime.store.user_memory_sources()[0]
        runtime.memory.apply(fact(source), [source], runtime.memory.revision)
        for i in range(205):
            await runtime.emit('user.message', text=f'第{i}条留档')
        runtime.prompt_history.compact(1, '旧摘要')
        await runtime.handle({'type': 'conversation.export', 'conversation_id': old, 'format': 'json'})
        exported = Path(last_event(runtime, 'conversation.exported')['path'])
        assert len(json.loads(exported.read_text(encoding='utf-8'))['messages']) == 207
        await runtime.handle({'type': 'conversation.export', 'conversation_id': old, 'format': 'markdown'})
        markdown = Path(last_event(runtime, 'conversation.exported')['path']).read_text(encoding='utf-8')
        assert markdown.index('第0条留档') < markdown.index('第204条留档')
        await runtime.handle({'type': 'conversation.create'})
        active = runtime.conversations.current_id
        await ask(runtime, '保留这段')
        await runtime.handle({'type': 'conversation.delete', 'conversation_id': old})
        assert runtime.conversations.current_id == active and exported.exists()
        assert old not in runtime.conversations.records and not runtime.memory.public()
        assert not runtime.store.search_history('留档')['items']
        assert not runtime.store.model_turns('conversation:' + old)
        assert not runtime.store.context_summary('conversation:' + old)
        assert old_tasks and all(not runtime.store.get_record('task', tid) for tid in old_tasks)
        assert runtime.store.search_history('保留这段')['items']
        await runtime.handle({'type': 'conversation.delete', 'conversation_id': active})
        assert runtime.conversations.current_id not in {active, old}
        assert not runtime.prompt_history.turns and not runtime.prompt_history.summary
        assert not runtime.store.history()
    finally:
        await runtime.close()


def test_memory_citations_user_edits_forgetting_and_restart(tmp_path):
    path = tmp_path / 'history.sqlite3'
    store = ConversationStore(path)
    source = {'id': 12, 'text': '我喜欢红茶', 'conversation_id': 'a', 'created': 10}
    memory = PersonalMemory(store)
    try:
        invalid = fact(source); invalid['memories'][0]['quote'] = '模型编造'
        with pytest.raises(ValueError, match='实际说过'):
            memory.apply(invalid, [source], memory.revision)
        assert not memory.public() and memory.watermark == 0
        memory.apply(fact(source), [source], memory.revision)
        mid = memory.public()[0]['memory_id']
        revision = memory.revision
        memory.update(mid, '我现在偏好咖啡')
        assert not memory.apply(fact(source), [source], revision)
        memory.apply(fact(source, key='renamed'), [source], memory.revision)
        assert len(memory.public()) == 1 and memory.prompt()[0]['content'] == '我现在偏好咖啡'
        memory.forget(mid)
        memory.apply(fact(source, key='another-key'), [source], memory.revision)
        assert memory.public() == [] and '红茶' not in json.dumps(memory.records(), ensure_ascii=False)
    finally:
        store.close()
    store = ConversationStore(path)
    try:
        restored = PersonalMemory(store)
        restored.apply(fact(source), [source], restored.revision)
        assert restored.watermark == 12 and not restored.public()
    finally:
        store.close()


def test_history_does_not_freeze_old_memory_snapshots():
    original = [{'role': 'user', 'content': [{'type': 'text', 'text': json.dumps({'question': 'hello', 'user_memory': [{'content': 'old'}]})}]}]
    retained = text_messages(original)
    assert 'user_memory' not in retained[0]['content'][0]['text']
    assert 'user_memory' in original[0]['content'][0]['text']


@pytest.mark.asyncio
async def test_memory_learns_in_background_survives_new_chat_and_restart(tmp_path):
    entered, release = asyncio.Event(), asyncio.Event()
    requests = []
    async def respond(request):
        body = json.loads(request.content); requests.append(body)
        if body['stream']:
            return response(request)
        entered.set(); await release.wait()
        sources = json.loads(body['messages'][-1]['content'])['messages']
        assert 'tools' not in body
        return httpx.Response(200, json={'choices': [{'message': {'content': json.dumps(fact(sources[0]))}}],
                                        'usage': {'prompt_tokens': 120, 'completion_tokens': 25}})
    runtime = make_runtime(tmp_path, respond)
    runtime.settings.values['remember_user'] = True
    try:
        for text in ['我喜欢红茶', '今天有点累', '晚安', '明天聊']:
            await ask(runtime, text)
        await asyncio.wait_for(entered.wait(), 2)
        assert runtime.task.done() and not runtime.memory_task.done()
        await runtime.handle({'type': 'conversation.create'})
        release.set(); await runtime.memory_task
        assert last_event(runtime,'maintenance.usage')['usage']['prompt_tokens'] == 120
        assert runtime.memory.public()[0]['source']['quote'] == '我喜欢红茶'
        await ask(runtime, '你记得我的喜好吗')
        message = next(body for body in reversed(requests) if body['stream'])['messages'][-1]
        assert message['content'].startswith(USER_MEMORY_PREFIX)
        assert json.loads(message['content'][len(USER_MEMORY_PREFIX):])[0]['content'] == '用户喜欢红茶'
        assert 'user_memory' not in json.dumps(runtime.prompt_history.turns)
        await runtime.handle({'type': 'settings.update', 'settings': {'remember_user': False}})
        await ask(runtime, '继续')
        context = json.loads(requests[-1]['messages'][-1]['content'][0]['text'])
        assert 'user_memory' not in context
        assert runtime.memory.public()
    finally:
        release.set(); await runtime.close()
    reopened = make_runtime(tmp_path, response)
    try:
        assert reopened.memory.public()[0]['content'] == '用户喜欢红茶'
    finally:
        await reopened.close()


@pytest.mark.asyncio
async def test_automatic_summary_keeps_recent_six_and_complete_visible_records(tmp_path):
    def respond(request):
        body = json.loads(request.content)
        assert not body['stream']
        return httpx.Response(200,json={'choices':[{'message':{'content':'老对话的背景'}}]})
    runtime = make_runtime(tmp_path,respond)
    try:
        runtime._select_history()
        cid = runtime.conversations.current_id
        for i in range(8):
            await runtime.emit('user.message',text=f'第{i}次原话')
            runtime.prompt_history.append(str(i),[{'role':'user','content':'长对话'+str(i)+'x'*6200}],{},True)
        runtime._queue_maintenance(10000)
        assert runtime.context_job is not None
        await runtime.context_job
        assert runtime.conversations.current_id == cid
        assert len(runtime.prompt_history.turns) == 6
        assert runtime.prompt_history.turns[0]['turn_id'] == '2'
        assert runtime.prompt_history.summary == '老对话的背景'
        assert len(runtime.conversations.history(cid)['items']) == 8
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_learning_failure_does_not_fail_dialogue_or_retry_every_turn(tmp_path):
    maintenance_calls = []
    def respond(request):
        body = json.loads(request.content)
        if body['stream']:
            return response(request)
        maintenance_calls.append(body)
        return httpx.Response(503)
    runtime = make_runtime(tmp_path,respond)
    runtime.settings.values['remember_user'] = True
    try:
        for i in range(4):
            await ask(runtime,f'日常对话{i}')
        await runtime.memory_task
        assert runtime.memory_state == 'failed' and not runtime.memory.watermark
        assert not [e for e in next(iter(runtime.clients)).events if e['type']=='error']
        await ask(runtime,'继续接着聊')
        assert len(maintenance_calls) == 1
        assert last_event(runtime,'task.state')['state'] == 'idle'
    finally:
        await runtime.close()
@pytest.mark.asyncio
async def test_pending_learning_cannot_recreate_deleted_memories(tmp_path):
    entered, release = asyncio.Event(), asyncio.Event()
    async def respond(request):
        body = json.loads(request.content)
        entered.set(); await release.wait()
        sources = json.loads(body['messages'][-1]['content'])['messages']
        return httpx.Response(200, json={'choices': [{'message': {'content': json.dumps(fact(sources[0]))}}]})
    runtime = make_runtime(tmp_path, respond)
    runtime.settings.values['remember_user'] = True
    try:
        await runtime.emit('user.message', text='我喜欢红茶')
        sources = runtime.store.user_memory_sources()
        task = asyncio.create_task(runtime._learn_memories(sources))
        await entered.wait()
        await runtime.handle({'type': 'conversation.delete', 'conversation_id': runtime.conversations.current_id})
        release.set(); await task
        assert not runtime.memory.public() and not runtime.memory.watermark
    finally:
        release.set(); await runtime.close()


@pytest.mark.asyncio
@pytest.mark.parametrize('action', ['switch', 'delete', 'fail'])
async def test_background_summary_checks_snapshot_and_does_not_recreate_deleted_chat(tmp_path, action):
    entered, release = asyncio.Event(), asyncio.Event()
    async def respond(request):
        entered.set(); await release.wait()
        return httpx.Response(503) if action == 'fail' else httpx.Response(200, json={'choices': [{'message': {'content': '老话的摘要'}}]})
    runtime = make_runtime(tmp_path, respond)
    try:
        runtime._select_history()
        cid, scope = runtime.conversations.current_id, runtime.prompt_history.scope
        for i in range(8):
            runtime.prompt_history.append(str(i), [{'role': 'user', 'content': '旧话' * 100}], {}, True)
        original = deepcopy(runtime.prompt_history.turns)
        task = asyncio.create_task(runtime._background_summary(cid, scope, deepcopy(original[:2]), ''))
        await entered.wait()
        if action == 'switch':
            await runtime.handle({'type': 'conversation.create'})
        elif action == 'delete':
            await runtime.handle({'type': 'conversation.delete', 'conversation_id': cid})
        release.set(); await task
        if action == 'switch':
            assert runtime.store.context_summary(scope) == '老话的摘要'
            assert len(runtime.store.model_turns(scope)) == 6
            assert not runtime.prompt_history.turns and not runtime.prompt_history.summary
        elif action == 'delete':
            assert not runtime.store.model_turns(scope) and not runtime.store.context_summary(scope)
        else:
            assert runtime.prompt_history.turns == original
    finally:
        release.set(); await runtime.close()
