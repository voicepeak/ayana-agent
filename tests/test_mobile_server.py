import base64
import struct

import pytest
from fastapi.testclient import TestClient

from services.agent.audio_codec import f32le_base64_to_s16le_base64
from services.agent.runtime import AgentRuntime
from services.agent.server import create_app
from test_runtime import Desktop, Tts, Ws, settings


def test_f32_payload_is_converted_to_little_endian_int16():
    source = struct.pack("<4f", -1.0, -0.5, 0.0, 1.0)
    converted = base64.b64decode(f32le_base64_to_s16le_base64(base64.b64encode(source).decode()))
    assert struct.unpack("<4h", converted) == (-32767, -16383, 0, 32767)


def test_mobile_session_cookie_static_shell_and_socket(tmp_path):
    cfg = settings(tmp_path)
    runtime = AgentRuntime(cfg, desktop=Desktop(), tts=Tts())
    root = tmp_path / "mobile"
    root.mkdir()
    (root / "index.html").write_text("<!doctype html><title>mobile</title>", encoding="utf-8")
    token = "a" * 32
    mobile = "m" * 32
    app = create_app(token, cfg, runtime, mobile_token=mobile, mobile_root=root)
    with TestClient(app) as client:
        assert client.get("/m/").status_code == 200
        assert client.get("/mobile/session").json()["paired"] is False
        assert client.post("/mobile/session", json={"token": "wrong"}).status_code == 401
        response = client.post("/mobile/session", json={"token": mobile})
        assert response.status_code == 200
        assert client.get("/mobile/session").json()["paired"] is True
        bootstrap = client.get("/mobile/bootstrap")
        assert bootstrap.status_code == 200
        assert bootstrap.json()["default_asset_id"]
        headers = {"Cookie": f"ayana_mobile={mobile}", "origin": "http://testserver"}
        with client.websocket_connect("/ws?client=mobile", headers=headers) as ws:
            event = ws.receive_json()
            assert event["type"] in {"session.started", "settings.ready"}
        assert client.delete("/mobile/session").status_code == 200
        assert client.get("/mobile/session").json()["paired"] is False


def test_mobile_socket_rejects_untrusted_origin_and_missing_cookie(tmp_path):
    cfg = settings(tmp_path)
    runtime = AgentRuntime(cfg, desktop=Desktop(), tts=Tts())
    app = create_app("b" * 32, cfg, runtime, mobile_token="n" * 32)
    with TestClient(app) as client:
        try:
            with client.websocket_connect("/ws?client=mobile", headers={"origin": "http://testserver"}) as ws:
                ws.receive_json()
        except Exception:
            pass
        else:
            raise AssertionError("socket without a mobile cookie must not connect")
        try:
            with client.websocket_connect("/ws?client=mobile", headers={
                "Cookie": "ayana_mobile=" + "n" * 32,
                "origin": "https://untrusted.example",
            }) as ws:
                ws.receive_json()
        except Exception:
            pass
        else:
            raise AssertionError("untrusted origin must not connect")


def test_native_ticket_authenticates_browser_socket_and_rejects_tampering(tmp_path):
    cfg = settings(tmp_path)
    runtime = AgentRuntime(cfg, desktop=Desktop(), tts=Tts())
    mobile = "t" * 32
    app = create_app("c" * 32, cfg, runtime, mobile_token=mobile)
    with TestClient(app) as client:
        preflight = client.options("/mobile/ticket", headers={
            "Origin": "https://localhost",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization",
        })
        assert preflight.status_code == 200
        assert preflight.headers["access-control-allow-origin"] == "https://localhost"
        assert "authorization" in preflight.headers["access-control-allow-headers"].lower()
        assert client.post("/mobile/ticket").status_code == 401
        ticket = client.post("/mobile/ticket", headers={"Authorization": "Bearer " + mobile}).json()["ticket"]
        assert "." in ticket
        with client.websocket_connect(f"/ws?client=mobile&ticket={ticket}",
                                      headers={"origin": "https://localhost"}) as ws:
            assert ws.receive_json()["type"] in {"session.started", "settings.ready", "service.state"}
        tampered = ticket[:-1] + ("0" if ticket[-1] != "0" else "1")
        try:
            with client.websocket_connect(f"/ws?client=mobile&ticket={tampered}",
                                          headers={"origin": "https://localhost"}) as ws:
                ws.receive_json()
        except Exception:
            pass
        else:
            raise AssertionError("tampered ticket must not connect")


def test_android_package_is_offered_without_pairing(tmp_path):
    cfg = settings(tmp_path)
    runtime = AgentRuntime(cfg, desktop=Desktop(), tts=Tts())
    apk = tmp_path / "Ayana-test.apk"
    apk.write_bytes(b"apk-fixture")
    app = create_app("d" * 32, cfg, runtime, mobile_token="p" * 32, mobile_apk=apk)
    with TestClient(app) as client:
        assert client.get("/mobile/session").json()["android_apk"] is True
        response = client.get("/mobile/app.apk")
        assert response.status_code == 200
        assert response.content == b"apk-fixture"
        assert response.headers["content-type"] == "application/vnd.android.package-archive"


@pytest.mark.asyncio
async def test_mobile_client_receives_int16_audio(tmp_path):
    runtime = AgentRuntime(settings(tmp_path), desktop=Desktop(), tts=Tts())
    ws = Ws()
    await runtime.connected(ws, client={"audio_format": "pcm_s16le"})
    try:
        await runtime.handle({"type": "turn.start", "text": "hello"})
        await runtime.task
        audio = [event for event in ws.events if event["type"] == "audio.ready"]
        assert audio and all(event["format"] == "pcm_s16le" and event["transport"] == "binary" for event in audio)
        assert ws.binary and len(ws.binary[0]) % 2 == 0
        assert "pcm_base64" not in audio[0]
    finally:
        await runtime.close()
