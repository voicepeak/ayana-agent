import asyncio
import json
import os
import threading
from pathlib import Path

import pytest

from services.agent.tools.registry import ToolError
from services.agent.tools.system import ApplicationCatalog, SystemTools, app_record
from services.agent.tools.policy import DirectoryPolicy
from test_capabilities import runtime, speech
from test_model import native_tool_sse, sse_response
from test_runtime import Desktop


@pytest.fixture
def system(tmp_path):
    policy = DirectoryPolicy(tmp_path / 'documents')
    app = tmp_path / 'Example App.exe'
    app.write_bytes(b'fixture only; never launched')
    catalog = ApplicationCatalog(lambda: [app_record('示例应用', app, ['Example App'])])
    requests = []
    def open_target(target, parameters, cancelled):
        if cancelled.is_set():
            raise ToolError('cancelled', 'cancelled')
        requests.append((target, parameters))
        return {'status': 'open_requested', 'process_id': 42}
    tools = SystemTools(policy, open_target, catalog)
    return tools, requests


def test_apps_search_returns_launchable_ids_and_exact_match_wins(system):
    tools, requests = system
    result = tools.apps.search('Example App')
    assert result[0]['name'] == '示例应用'
    assert 'target' not in result[0] and 'parameters' not in result[0]
    tools.open_app(result[0]['app_id'], threading.Event())
    assert len(requests) == 1 and requests[0][1] is None
    with pytest.raises(ToolError, match='应用 ID'):
        tools.open_app('invented-app-id', threading.Event())
    assert len(requests) == 1


def test_search_deduplicates_builtin_and_store_entry_for_same_app(tmp_path):
    tools = ApplicationCatalog(lambda: [app_record('记事本', tmp_path / 'notepad.exe', ['notepad'], source='Windows'),
                                        app_record('记事本', tmp_path / 'store.exe', source='Microsoft Store'),
                                        app_record('第三方记事本插件', tmp_path / 'other.exe')])
    result = tools.search('记事本')
    assert len(result) == 1 and result[0]['source'] == 'Windows'


def test_apps_removed_after_discovery_are_not_launched(system):
    tools, requests = system
    result = tools.apps.search('示例')
    Path(tools.apps.get(result[0]['app_id'])['target']).unlink()
    with pytest.raises(ToolError) as error:
        tools.open_app(result[0]['app_id'], threading.Event())
    assert error.value.code == 'app_missing' and not requests


def test_file_listing_finding_and_opening_documents_keep_text_reading_rules(system):
    tools, requests = system
    root = tools.policy.roots['output']['path']
    (root / '项目').mkdir()
    (root / '项目/使用说明.pdf').write_bytes(b'%PDF fixture')
    (root / '项目/local.json').write_text('private')
    (root / '.env').write_text('private')
    result = tools.find_files('output', '使用说明')
    assert result['matches'][0]['path'] == '项目/使用说明.pdf'
    assert tools.list_files('output', '项目')['entries'] == [{'path': '项目/使用说明.pdf', 'kind': 'file', 'openable': True}]
    tools.open_file('output', result['matches'][0]['path'], threading.Event())
    assert requests == [(str(root / '项目/使用说明.pdf'), None)]
    with pytest.raises(ToolError):
        tools.policy.path('output', '项目/使用说明.pdf', write=True)


def test_source_opening_uses_text_viewer_and_quotes_path_as_one_argument(system):
    tools, requests = system
    root = tools.policy.roots['output']['path']
    source = root / 'script with spaces.py'
    source.write_text('raise RuntimeError("must never execute")')
    tools.open_file('output', source.name, threading.Event())
    target, parameters = requests[0]
    assert Path(target).name.lower() == 'notepad.exe'
    assert parameters == f'"{source}"'


@pytest.mark.parametrize('path', ['../outside.txt', 'C:/secret.txt', '.env.txt', 'local.json', 'script.ps1', 'installer.exe', 'script.bat', 'redirect.lnk', 'book.xlsm', 'reg.reg'])
def test_file_open_rejects_private_escape_and_executable_resources(system, path):
    tools, requests = system
    if '/' not in path:
        (tools.policy.roots['output']['path'] / path).write_text('fixture')
    with pytest.raises(ToolError):
        tools.open_file('output', path, threading.Event())
    assert not requests


def test_open_root_directory_and_bounded_listing(system):
    tools, requests = system
    root = tools.policy.roots['output']['path']
    for index in range(4):
        (root / f'{index}.txt').write_text('sample')
    assert tools.list_files('output', limit=2)['truncated'] is True
    assert len(tools.list_files('output', limit=2)['entries']) == 2
    assert tools.open_file('output', '', threading.Event())['kind'] == 'directory'
    assert requests == [(str(root), None)]


@pytest.mark.parametrize('url', ['file:///C:/x', 'https://user:secret@example.com', 'javascript:alert(1)', 'ms-settings:', 'https://example.com\nrun'])
def test_web_open_uses_only_validated_http_urls(system, url):
    tools, requests = system
    with pytest.raises(ToolError):
        tools.open_url(url, threading.Event())
    assert not requests


def test_open_user_local_website_is_distinct_from_backend_fetch(system):
    tools, requests = system
    result = tools.open_url('http://localhost:3000/project', threading.Event())
    assert result['url'] == 'http://localhost:3000/project'
    assert requests == [('http://localhost:3000/project', None)]
    from services.agent.tools.web import public_url
    with pytest.raises(ToolError):
        public_url(result['url'])


def test_cancel_before_launch_does_not_open_anything(system):
    tools, requests = system
    token = threading.Event()
    token.set()
    with pytest.raises(ToolError):
        tools.open_app(tools.apps.search('示例')[0]['app_id'], token)
    assert not requests


class Windows(Desktop):
    def __init__(self):
        self.window = {'hwnd': 123, 'process_id': 42, 'process_created': 99, 'class_name': 'Test',
                       'title': '示例应用', 'executable': 'C:/Example App.exe', 'window_state': 'visible', 'elevated': False}
        self.binds = []
    def list_windows(self):
        return [dict(self.window)]
    def bind(self, hwnd):
        self.binds.append(hwnd)
        return {**self.window, 'target_id': 'bound-window'}
    def capture(self, target):
        return {'snapshot_id': 'new-window', 'png_base64': 'image-of-new-window', 'target': {'target_id': target}}


@pytest.mark.asyncio
async def test_native_model_search_open_select_receives_real_tool_result_and_new_image(tmp_path, system):
    tools, requests = system
    calls = []
    def respond(request):
        body = json.loads(request.content)
        messages = body['messages']
        names = {item['function']['name'] for item in body['tools']}
        if len(calls) < 3:
            assert 'capture_target' not in names and 'observe_controls' not in names
        else:
            assert 'capture_target' in names and 'observe_controls' in names
        assert 'Registered tools (' not in messages[0]['content']
        calls.append(messages)
        if len(calls) == 1:
            return native_tool_sse('find-app', 'apps__search', json.dumps({'query': '示例'}))
        previous = json.loads(messages[-1]['content']) if messages[-1]['role'] == 'tool' else None
        if len(calls) == 2:
            return native_tool_sse('open-app', 'apps__open', json.dumps({'app_id': previous['result'][0]['app_id']}))
        if len(calls) == 3:
            assert previous['result']['status'] == 'window_observed'
            return native_tool_sse('select-window', 'windows__select', json.dumps({'window_id': previous['result']['windows'][0]['window_id']}))
        assert messages[-1]['content'][1]['image_url']['url'].endswith('image-of-new-window')
        return sse_response([speech()])
    desktop = Windows()
    agent = runtime(tmp_path, respond, desktop)
    agent.system = tools
    try:
        await agent.handle({'type': 'turn.start', 'text': '打开示例应用并观察', 'mode': 'execute'})
        await agent.task
        assert agent.active_task.state == 'needs_verification'
        assert len(requests) == 1 and desktop.binds == [123]
        assert agent.target['target_id'] == 'bound-window'
    finally:
        await agent.close()


@pytest.mark.asyncio
async def test_teaching_mode_rejects_open_and_call_replay_never_opens_twice(tmp_path, system):
    tools, requests = system
    agent = runtime(tmp_path, lambda request: sse_response([speech()]), Windows())
    agent.system = tools
    from services.agent.tasks import TaskRunner
    agent.active_task = TaskRunner('open app', {})
    app_id = tools.apps.search('示例')[0]['app_id']
    try:
        denied = await agent._dispatch_tool({'name': 'apps.open', 'call_id': 'denied', 'arguments': {'app_id': app_id}})
        assert denied['code'] == 'execution_mode_required' and not requests
        agent.mode = 'execute'
        call = {'name': 'apps.open', 'call_id': 'once', 'arguments': {'app_id': app_id}}
        first = await agent._dispatch_tool(call)
        assert await agent._dispatch_tool(call) == first and len(requests) == 1
        with pytest.raises(ToolError):
            await agent._dispatch_tool({**call, 'arguments': {'app_id': 'different'}})
    finally:
        await agent.close()


@pytest.mark.asyncio
async def test_window_id_cannot_bind_a_reused_hwnd(tmp_path):
    desktop = Windows()
    agent = runtime(tmp_path, lambda request: sse_response([speech()]), desktop)
    from services.agent.tasks import TaskRunner
    agent.active_task = TaskRunner('choose window', {})
    agent.mode = 'execute'
    try:
        choices = await agent._windows_list()
        desktop.window['process_created'] = 100
        result = await agent._dispatch_tool({'name': 'windows.select', 'arguments': {'window_id': choices[0]['window_id']}})
        assert result['code'] == 'window_changed' and not desktop.binds
    finally:
        await agent.close()
