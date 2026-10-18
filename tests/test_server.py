from fastapi.testclient import TestClient
from pathlib import Path
from services.agent.config import Settings
from services.agent.runtime import AgentRuntime
from services.agent.server import create_app
from test_runtime import Desktop, Tts, settings
import pytest
from starlette.websockets import WebSocketDisconnect
from services.agent.avatars import AvatarCatalog


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


def test_asset_preview_is_authenticated_bounded_and_does_not_switch_character(tmp_path, monkeypatch):
    cfg = settings(tmp_path)
    runtime = AgentRuntime(cfg, desktop=Desktop(), tts=Tts())
    root = Path(__file__).resolve().parents[1]
    cfg.root = root
    seen = []
    fixture = tmp_path / "portrait.png"
    fixture.write_bytes(b"preview-fixture")

    def resolve(catalog, resource_root, asset_id):
        seen.append((catalog.character, asset_id))
        return fixture if asset_id == "neutral" else None

    monkeypatch.setattr(AvatarCatalog, "asset_file", resolve)
    original = runtime.avatars
    headers = {"Authorization": "Bearer " + "e" * 32}
    with TestClient(create_app("e" * 32, cfg, runtime)) as client:
        assert client.get("/assets/neutral?character=ayana-su").status_code == 401
        assert client.get("/assets/neutral?character=ayana-su", headers=headers).content == b"preview-fixture"
        assert seen[-1] == ("ayana-su", "neutral")
        assert client.get("/assets/neutral", headers=headers).status_code == 200
        assert seen[-1] == (original.character, "neutral")
        assert client.get("/assets/neutral?character=../../other", headers=headers).status_code == 404
        assert client.get("/assets/missing?character=ayana-su", headers=headers).status_code == 404
        assert runtime.avatars is original
        assert cfg.values["character"] == "ayana"


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


def test_shutdown_closes_open_socket_and_rejects_reconnect_without_database_writes(tmp_path):
    cfg = settings(tmp_path)
    runtime = AgentRuntime(cfg, desktop=Desktop(), tts=Tts())
    token = 'd' * 32
    headers = {'Authorization': 'Bearer ' + token}
    with TestClient(create_app(token, cfg, runtime)) as client:
        with client.websocket_connect('/ws', headers=headers) as ws:
            assert ws.receive_json()['type'] in {'session.started', 'service.state'}
            assert client.post('/shutdown', headers=headers).status_code == 200
            with pytest.raises(WebSocketDisconnect) as closed:
                while True:
                    ws.receive_json()
            assert closed.value.code == 1001
        assert runtime.closed
        with client.websocket_connect('/ws', headers=headers) as ws:
            with pytest.raises(WebSocketDisconnect) as closed:
                ws.receive_json()
            assert closed.value.code == 1001
        assert not runtime.clients and not runtime.client_senders and not runtime.client_queues
