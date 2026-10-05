import json
import pytest
from services.agent.tools.registry import ToolError
from tests.test_conversations import make_runtime
from tests.test_model import native_tool_sse, sse_response


@pytest.mark.asyncio
async def test_manual_desktop_entry_returns_failure_to_ayana_in_same_tool_loop(tmp_path):
    calls = []
    def respond(request):
        payload = json.loads(request.content)
        calls.append(payload)
        if len(calls) == 1:
            return native_tool_sse('desktop_task', 'computer__run', json.dumps({'goal': '在当前窗口保存文档'}))
        result = json.loads(next(message['content'] for message in payload['messages'] if message['role'] == 'tool'))
        assert result['code'] == 'computer_incomplete' and result['receipt']['audience'] == 'assistant'
        return sse_response([{'type': 'speech', 'key': 's1', 'speech_ja': '保存ボタンが見つからなかったよ。', 'display_zh': '没有找到保存按钮，这一步还没有完成。'},
                             {'type': 'task', 'kind': 'action', 'status': 'blocked', 'reason': '当前窗口没有可用的保存按钮'}])
    class Computer:
        status = {'available': True, 'detail': 'fixture'}
        async def stop(self):
            pass
        async def run(self, *args, **kwargs):
            raise ToolError('computer_incomplete', '没有找到保存按钮')
    runtime = make_runtime(tmp_path, respond)
    runtime.computer = Computer()
    runtime.mode = 'execute'
    runtime.target = {'target_id': 'fixture'}
    try:
        await runtime.handle({'type': 'computer.start', 'goal': '在当前窗口保存文档'})
        await runtime.task
        assert len(calls) == 2 and runtime.active_task.state == 'blocked'
        events = next(iter(runtime.clients)).events
        assert any(event['type'] == 'utterance.ready' for event in events)
        assert not any(event['type'] == 'error' for event in events)
    finally:
        await runtime.close()
