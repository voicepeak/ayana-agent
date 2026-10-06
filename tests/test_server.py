from fastapi.testclient import TestClient
from pathlib import Path
from services.agent.config import Settings
from services.agent.runtime import AgentRuntime
from services.agent.server import create_app
from test_runtime import Desktop, Tts, settings
import pytest


def test_health_requires_token_and_bad_origin_is_rejected(tmp_path):
    cfg = settings(tmp_path)
    runtime = AgentRuntime(cfg, desktop=Desktop(), tts=Tts())
    token = 'a' * 32
    app = create_app(token, cfg, runtime)
    with TestClient(app) as client:
        assert client.get('/health').status_code == 401
        assert client.get('/health', headers={'Authorization': 'Bearer ' + token}).status_code == 200
        with pytest.raises(Exception):
            with client.websocket_connect('/ws', headers={'Authorization': 'Bearer ' + token, 'origin': 'https://untrusted.example'}):
                pass


def test_unauthorized_socket_receives_no_session(tmp_path):
    cfg = settings(tmp_path)
    runtime = AgentRuntime(cfg, desktop=Desktop(), tts=Tts())
    with TestClient(create_app('b' * 32, cfg, runtime)) as client:
        with pytest.raises(Exception):
            with client.websocket_connect('/ws'):
                pass


def test_prompt_export_requires_launch_token_and_uses_no_store(tmp_path):
    cfg = settings(tmp_path)
    runtime = AgentRuntime(cfg, desktop=Desktop(), tts=Tts())
    runtime.prompt_trace.record({"model": "fixture", "messages": [{"role": "user", "content": "actual question"}]}, phase="main")
    token = "c" * 32
    with TestClient(create_app(token, cfg, runtime)) as client:
        assert client.get('/debug/prompts/export').status_code == 401
        response = client.get('/debug/prompts/export', headers={'Authorization': 'Bearer ' + token})
        assert response.status_code == 200
        assert response.headers['cache-control'] == 'no-store'
        assert response.json()['requests'][0]['body']['messages'][0]['content'] == 'actual question'
