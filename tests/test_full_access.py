import asyncio
import base64
import json
import os
from pathlib import Path
import threading

import httpx
import pytest

from services.agent.config import Settings
from services.agent.runtime import AgentRuntime
from services.agent.tasks import TaskRunner
from services.agent.tools.registry import ToolError
from services.agent.tools.shell import ShellTools, OUTPUT_LIMIT
from test_runtime import Desktop, Tts
from test_model import native_tool_sse, sse_response

ROOT = Path(__file__).resolve().parents[1]


def runtime_for(tmp_path):
    cfg = Settings(ROOT, data_root=tmp_path)
    cfg.values['full_access'] = False
    return AgentRuntime(cfg, desktop=Desktop(), tts=Tts())


def activate(runtime):
    runtime.settings.values['full_access'] = True
    runtime.active_task = TaskRunner('Full access test', {})
    runtime.write_cancel = threading.Event()


def test_setting_is_strict_boolean_and_persists(tmp_path):
    cfg = Settings(ROOT, data_root=tmp_path)
    for invalid in ['true', 1, None, {}]:
        with pytest.raises(ValueError, match='boolean'):
            cfg.update({'full_access': invalid})
    cfg.update({'full_access': True})
    assert Settings(ROOT, data_root=tmp_path).public()['full_access'] is True
    cfg.update({'full_access': False})
    assert Settings(ROOT, data_root=tmp_path).values['full_access'] is False


@pytest.mark.asyncio
async def test_switch_revokes_filesystem_shell_and_keeps_original_grants(tmp_path):
    runtime = runtime_for(tmp_path)
    directory = tmp_path / 'external'
    directory.mkdir()
    target = directory / '.env'
    target.write_text('test fixture', encoding='utf-8')
    runtime.policy.grant('external', directory, write=False)
    assert 'shell.run' not in {t.name for t in runtime.registry.active_tools()}
    await runtime.handle({'type': 'settings.update', 'settings': {'full_access': True}})
    runtime.active_task = TaskRunner('read/write test', {})
    runtime.write_cancel = threading.Event()
    assert runtime.mode == 'teach' and runtime._execution_enabled()
    assert 'shell.run' in {t.name for t in runtime.registry.active_tools()}
    assert runtime.policy.resolve('filesystem', str(target), write=True) == target
    assert runtime.policy.root('external')['write'] is True
    before = await runtime._file_read('filesystem', path=str(target))
    artifact = await runtime._file_propose(root_id='filesystem', path=str(target), base_sha256=before['sha256'], content='updated')
    assert target.read_text() == 'updated'
    assert not runtime.approvals and artifact['can_restore']
    await runtime._file_restore(artifact_id=artifact['artifact_id'])
    assert target.read_text() == 'test fixture'
    await runtime.handle({'type': 'settings.update', 'settings': {'full_access': False}})
    assert runtime.active_task.state == 'cancelled'
    assert runtime.policy.root('external')['write'] is False
    with pytest.raises(ToolError):
        runtime.policy.resolve('filesystem', str(target))
    with pytest.raises(ToolError) as error:
        await runtime.registry.execute('shell.run', {'command': 'echo hidden'})
    assert error.value.code == 'tool_unavailable'
    with pytest.raises(ToolError):
        runtime.policy.resolve('external', '.env')
    await runtime.close()


@pytest.mark.asyncio
async def test_full_access_writes_selected_repository_and_checks_conflicts(tmp_path):
    runtime = runtime_for(tmp_path)
    runtime.repository = {'root': str(tmp_path)}
    activate(runtime)
    artifact = await runtime._file_create(root_id='repository', path='new.txt', content='before')
    before = await runtime._file_read(path='new.txt')
    (tmp_path / 'new.txt').write_text('changed outside', encoding='utf-8')
    with pytest.raises(ToolError) as error:
        await runtime._file_propose(root_id='repository', path='new.txt', base_sha256=before['sha256'], content='after')
    assert error.value.code == 'file_conflict'
    assert runtime.files.get(artifact['artifact_id'])['changed']
    await runtime.close()


@pytest.mark.asyncio
async def test_real_shell_success_failure_and_output_limit(tmp_path):
    shell = ShellTools(lambda: True)
    command = "[IO.File]::WriteAllText('receipt.txt', '实际执行'); Write-Output '实际执行'" if os.name == 'nt' else "printf 'actual execution' > receipt.txt; cat receipt.txt"
    result = await shell.run(command, str(tmp_path))
    assert result['exit_code'] == 0 and not result['timed_out']
    assert (tmp_path / 'receipt.txt').read_text(encoding='utf-8') in result['stdout']
    failed = await shell.run('exit 7', str(tmp_path))
    assert failed['exit_code'] == 7
    native_failed = await shell.run('cmd /c exit 9' if os.name == 'nt' else 'sh -c "exit 9"', str(tmp_path))
    assert native_failed['exit_code'] == 9
    if os.name == 'nt':
        long_script = '# comment\n' * 1500 + "Write-Output 'long script executed'"
        assert 'long script executed' in (await shell.run(long_script, str(tmp_path)))['stdout']
    large = "Write-Output ('a' * 100000)" if os.name == 'nt' else 'head -c 100000 /dev/zero | tr "\\0" a'
    bounded = await shell.run(large, str(tmp_path))
    assert bounded['truncated'] and len(bounded['stdout']) <= OUTPUT_LIMIT
    assert shell.process is None and shell.job is None


@pytest.mark.asyncio
@pytest.mark.skipif(os.name != 'nt', reason='Windows Job process-tree ownership')
async def test_shell_timeout_terminates_spawned_child(tmp_path):
    import ctypes
    from ctypes import wintypes
    child_script = base64.b64encode('Start-Sleep -Seconds 60'.encode('utf-16-le')).decode('ascii')
    command = (f"$child = Start-Process -WindowStyle Hidden -FilePath $PSHOME/powershell.exe "
               f"-ArgumentList @('-NoProfile', '-EncodedCommand', '{child_script}') -PassThru; "
               "[IO.File]::WriteAllText('child.pid', [string]$child.Id); Start-Sleep -Seconds 60")
    shell = ShellTools(lambda: True)
    assert (await shell.run(command, str(tmp_path), 2))['timed_out']
    pid = int((tmp_path / 'child.pid').read_text())
    api = ctypes.WinDLL('kernel32', use_last_error=True)
    api.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    api.OpenProcess.restype = wintypes.HANDLE
    api.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    api.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = api.OpenProcess(0x00100000, False, pid)
    try:
        assert not handle or api.WaitForSingleObject(handle, 3000) == 0
    finally:
        if handle:
            api.CloseHandle(handle)


@pytest.mark.asyncio
async def test_shell_timeout_and_switch_off_kill_running_command(tmp_path):
    shell = ShellTools(lambda: True)
    command = "Start-Sleep -Seconds 10; [IO.File]::WriteAllText('late.txt', 'bad')" if os.name == 'nt' else 'sleep 10; touch late.txt'
    result = await shell.run(command, str(tmp_path), 1)
    assert result['timed_out'] and not (tmp_path / 'late.txt').exists()
    runtime = runtime_for(tmp_path)
    activate(runtime)
    runtime.task = asyncio.create_task(runtime._shell_run(command, str(tmp_path)))
    task = runtime.task
    for _ in range(100):
        if runtime.shell.process and (os.name != 'nt' or runtime.shell.job):
            break
        await asyncio.sleep(.01)
    assert runtime.shell.process is not None
    await runtime.handle({'type': 'settings.update', 'settings': {'full_access': False}})
    assert task.done() and runtime.shell.process is None
    assert not (tmp_path / 'late.txt').exists()
    await runtime.close()


@pytest.mark.asyncio
async def test_full_access_desktop_receipt_and_auto_confirmation(tmp_path):
    class ReceiptDesktop(Desktop):
        def execute(self, action, snapshot_id):
            assert snapshot_id == 'fresh' and action['kind'] == 'type'
            return {'expected_result_verified': True, 'result_snapshot': {'snapshot_id': 'after'}}
    runtime = runtime_for(tmp_path)
    runtime.desktop = ReceiptDesktop()
    activate(runtime)
    runtime.target = {'target_id': 'target'}
    runtime.snapshot = {'snapshot_id': 'fresh'}
    result = await runtime._dispatch_tool({'name': 'desktop.step', 'arguments': {'snapshot_id': 'fresh', 'kind': 'type', 'text': 'hello'}})
    assert result['result']['expected_result_verified'] is True
    assert not runtime.approvals and runtime.snapshot['snapshot_id'] == 'after'
    with pytest.raises(ToolError) as error:
        await runtime._desktop_step('fresh', kind='type', text='stale')
    assert error.value.code == 'stale_snapshot'
    from unittest.mock import AsyncMock
    runtime.computer.control = AsyncMock()
    await runtime._computer_progress({'type': 'confirmation', 'approval_id': 'sensitive', 'message': 'requested action'})
    runtime.computer.control.assert_awaited_once_with('confirm', approval_id='sensitive', accept=True)
    assert runtime.active_task.state == 'running' and not runtime.approvals
    await runtime.close()


@pytest.mark.asyncio
async def test_desktop_schema_rejects_unsupported_input_before_execution(tmp_path):
    runtime = runtime_for(tmp_path)
    activate(runtime)
    runtime.target = {'target_id': 'target'}
    runtime.snapshot = {'snapshot_id': 'fresh'}
    for action in [
        {'kind': 'scroll', 'point': {'x': 1, 'y': 1}, 'delta': 21},
        {'kind': 'scroll', 'point': {'x': 1, 'y': 1}, 'delta': 0},
        {'kind': 'key', 'key': 'ctrl+a'},
        {'kind': 'click'}, {'kind': 'scroll'}, {'kind': 'type'}, {'kind': 'key'},
    ]:
        with pytest.raises(ToolError) as error:
            await runtime.registry.execute('desktop.step', {'snapshot_id': 'fresh', **action})
        assert error.value.code == 'invalid_arguments'
        assert runtime.snapshot['snapshot_id'] == 'fresh'
    await runtime.close()


@pytest.mark.asyncio
async def test_desktop_failure_preserves_executor_reason_and_invalidates_snapshot(tmp_path):
    from native.windows.desktop import DesktopError
    class FailedDesktop(Desktop):
        def execute(self, action, snapshot_id):
            raise DesktopError('target_occluded', 'Target point is covered by another window')
    runtime = runtime_for(tmp_path)
    runtime.desktop = FailedDesktop()
    activate(runtime)
    runtime.target = {'target_id': 'target'}
    runtime.snapshot = {'snapshot_id': 'fresh'}
    with pytest.raises(ToolError) as error:
        await runtime.registry.execute('desktop.step', {'snapshot_id': 'fresh', 'kind': 'click', 'point': {'x': 1, 'y': 1}})
    assert error.value.code == 'target_occluded'
    assert 'covered' in str(error.value)
    assert runtime.snapshot is None
    await runtime.close()


@pytest.mark.asyncio
@pytest.mark.parametrize('native', [True, False])
async def test_model_dispatches_real_shell_and_receives_receipt(tmp_path, native):
    runtime = runtime_for(tmp_path)
    runtime.settings.values.update({'provider': 'openai', 'model': 'test', 'full_access': True,
                                    'native_tools': native, 'voice': {'voice_mode': 'silent'}})
    runtime.settings.key = lambda: 'fixture-key'
    calls = []
    command = "[IO.File]::WriteAllText('model-created.txt', 'done'); Write-Output 'verified'" if os.name == 'nt' else "printf done > model-created.txt; printf verified"
    arguments = {'command': command, 'cwd': str(tmp_path)}
    def respond(request):
        body = json.loads(request.content)
        calls.append(body)
        if len(calls) == 1:
            return (native_tool_sse('command-call', 'shell__run', json.dumps(arguments)) if native else
                    sse_response([{'type': 'tool', 'name': 'shell.run', 'arguments': arguments}]))
        return sse_response([{'type': 'speech', 'key': 's1', 'speech_ja': 'できたよ。', 'expression': '正经', 'pose': 'crossed'}])
    runtime.model_client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
    await runtime.handle({'type': 'turn.start', 'text': 'create a file'})
    await runtime.task
    assert runtime.active_task.state == 'succeeded'
    assert (tmp_path / 'model-created.txt').read_text() == 'done'
    assert len(calls) == 2 and not runtime.approvals
    assert 'Full access' in calls[0]['messages'][0]['content']
    receipt = calls[1]['messages'][-1]['content']
    assert 'verified' in receipt and 'exit_code' in receipt
    if native:
        assert calls[1]['messages'][-1]['role'] == 'tool'
        assert 'shell__run' in {tool['function']['name'] for tool in calls[0]['tools']}
    await runtime.close()
