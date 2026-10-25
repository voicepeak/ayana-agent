import asyncio
import json
import struct
import sys
import time

from fastapi.testclient import TestClient
import httpx
import pytest

from services.gateway.server import create_app, Gateway, model_events, ReplyEvents, model_context, model_error_code
from services.gateway.store import Store
from services.mobile_transport import audio_frame, read_audio_frame
from services.tts_remote.__main__ import DiagnosticLog, RemoteWorker


@pytest.fixture
def setup_gateway(tmp_path):
    store = Store(tmp_path / "gateway.sqlite3")
    key = store.add_user("one")
    config = {"data_dir": str(tmp_path), "api_key": "provider-secret", "worker_token": "worker-" + "x" * 40,
              "model": "test-model", "base_url": "https://api.deepseek.com", "mobile_root": str(tmp_path / "absent")}
    app = create_app(config, store=store)

    async def model(messages):
        for n in range(1, 3):
            yield {"type": "speech", "key": f"s{n}", "speech_ja": "こんにちは。", "expression": "休闲", "pose": "crossed"}
            yield {"type": "translation", "key": f"s{n}", "display_zh": f"你好{n}。"}

    app.state.gateway.model = model
    yield app, store, key, config
    store.close()


def activate(client, key, device="device_one"):
    response = client.post("/v1/activate", json={"key": key, "device_id": device})
    assert response.status_code == 200
    return response.json()


def turn(turn_id="turn_one", generation=73):
    return {"type": "turn.start", "text": "你好", "turn_id": turn_id,
            "conversation_id": "phone_local_conversation", "generation_id": generation,
            "messages": [{"role": "system", "content": "mobile prompt"}, {"role": "user", "content": "你好"}]}


def receive_kind(socket, kind):
    for _ in range(40):
        event = socket.receive_json()
        if event["type"] == kind:
            return event
    raise AssertionError("Missing event: " + kind)


def test_rejected_turn_is_tagged_with_request_generation(setup_gateway):
    app, store, key, config = setup_gateway
    with TestClient(app) as client:
        session = activate(client, key)
        with client.websocket_connect("/v1/mobile") as phone:
            phone.send_json({"access_token": session["access_token"]})
            receive_kind(phone, "gateway.ready")
            rejected = turn("rejected_turn", generation=91)
            rejected["messages"] = []
            phone.send_json(rejected)
            error = receive_kind(phone, "error")
            assert error["generation_id"] == 91
            assert error["turn_id"] == "rejected_turn"
            assert error["conversation_id"] == rejected["conversation_id"]
            assert receive_kind(phone, "task.state")["state"] == "failed"
            phone.send_json(turn("recovered_turn", generation=93))
            assert receive_kind(phone, "utterance.ready")["generation_id"] == 93
            for _ in range(20):
                if phone.receive_json().get("state") == "idle":
                    break
            else:
                raise AssertionError("Recovered turn did not finish")


def test_activation_refresh_revoke_and_no_provider_secrets(setup_gateway):
    app, store, key, _ = setup_gateway
    with TestClient(app) as client:
        assert client.post("/v1/activate", json={"key": "a" * 40, "device_id": "device"}).status_code == 401
        session = activate(client, key)
        assert "provider-secret" not in json.dumps(session)
        assert store.authenticate(session["access_token"])
        rotated = client.post("/v1/refresh", json={"refresh_token": session["refresh_token"]})
        assert rotated.status_code == 200
        assert store.authenticate(session["access_token"]) is None
        assert client.post("/v1/refresh", json={"refresh_token": session["refresh_token"]}).status_code == 401
        store.revoke_user("one")
        assert store.authenticate(rotated.json()["access_token"]) is None


def test_text_works_with_computer_offline_and_outbox_is_durable(setup_gateway):
    app, store, key, _ = setup_gateway
    with TestClient(app) as client:
        session = activate(client, key)
        with client.websocket_connect("/v1/mobile") as phone:
            phone.send_json({"access_token": session["access_token"]})
            assert receive_kind(phone, "service.state")["state"] == "failed"
            phone.send_json(turn())
            speech = receive_kind(phone, "utterance.ready")
            assert speech["generation_id"] == 73
            assert speech["audio_enabled"] is False
            assert "asset_id" not in speech  # image routing belongs to the phone
            receive_kind(phone, "task.state")
            phone.send_json(turn())
            receive_kind(phone, "error")  # duplicate ID must not run a second model request
        entries = store.next_logs(100)
        assert sum(e["type"] == "user.message" for e in entries) == 1
        assert sum(e["type"] == "utterance.ready" for e in entries) == 2
        assert "provider-secret" not in json.dumps(entries)


def test_two_sentences_dispatch_without_playback_ack_and_audio_roundtrip(setup_gateway):
    app, store, key, config = setup_gateway
    with TestClient(app) as client:
        session = activate(client, key)
        with client.websocket_connect("/v1/worker", headers={"Authorization": "Bearer " + config["worker_token"]}) as worker:
            worker.send_json({"type": "worker.state", "state": "ready"})
            with client.websocket_connect("/v1/mobile") as phone:
                phone.send_json({"access_token": session["access_token"]})
                receive_kind(phone, "gateway.ready")
                # Synchronize the worker ready state using the phone's status stream.
                while receive_kind(phone, "service.state")["state"] != "ready":
                    pass
                phone.send_json(turn())
                first = receive_kind(worker, "tts.synthesize")
                second = receive_kind(worker, "tts.synthesize")
                assert first["request_id"] != second["request_id"]
                assert first["generation_id"] == second["generation_id"]
                pcm = b"\x00\x00" * 320
                frame = audio_frame({"type": "audio.ready", "utterance_id": first["request_id"],
                    "generation_id": first["generation_id"], "format": "pcm_s16le", "channels": 1,
                    "sample_rate": 32000, "sample_count": 320, "duration_ms": 10}, pcm)
                worker.send_bytes(frame)
                while True:
                    event = phone.receive()
                    if event.get("bytes"):
                        metadata, payload = read_audio_frame(event["bytes"])
                        assert payload == pcm
                        assert metadata["generation_id"] == 73
                        assert metadata["conversation_id"] == "phone_local_conversation"
                        break
                phone.send_json({"type": "generation.cancel"})
                cancel = receive_kind(worker, "tts.cancel")
                assert cancel["generation_id"] == first["generation_id"]


def test_audio_frame_rejects_corrupt_headers_and_lengths():
    with pytest.raises(ValueError):
        read_audio_frame(struct.pack("<I", 9999) + b"{}")
    frame = audio_frame({"format": "pcm_s16le", "channels": 1, "sample_rate": 32000, "sample_count": 2}, b"\x00" * 4)
    assert read_audio_frame(frame)[1] == b"\x00" * 4
    with pytest.raises(ValueError):
        read_audio_frame(frame[:-1])


def test_outbox_capacity_does_not_accept_unlogged_turn(tmp_path):
    store = Store(tmp_path / "store.sqlite3", outbox_limit=1)
    store.log({"event_id": "one"})
    with pytest.raises(ValueError, match="outbox_full"):
        store.accept_turn("user", "turn", {"event_id": "two"})
    store.ack(store.next_logs()[0]["delivery_id"])
    assert store.accept_turn("user", "turn", {"event_id": "two"})
    assert not store.accept_turn("user", "turn", {"event_id": "two"})
    store.close()


def test_diagnostic_log_is_idempotent(tmp_path):
    log = DiagnosticLog(tmp_path / "dialogue.sqlite3")
    entry = {"event_id": "same", "type": "user.message", "text": "你好", "delivery_id": 1}
    log.append(entry)
    log.append(entry)
    assert log.db.execute("SELECT COUNT(*) FROM events").fetchone()[0] == 1
    assert "delivery_id" not in log.db.execute("SELECT body FROM events").fetchone()[0]
    log.close()


@pytest.mark.parametrize("authentication", [[], {"access_token": {}}, {"access_token": "short"}])
def test_websocket_rejects_malformed_authentication(setup_gateway, authentication):
    app, _, _, _ = setup_gateway
    with TestClient(app) as client, client.websocket_connect("/v1/mobile") as socket:
        socket.send_json(authentication)
        event = socket.receive()
        assert event["type"] == "websocket.close" and event["code"] == 4400


def test_multiple_users_audio_and_log_identity_are_isolated(setup_gateway):
    app, store, key, config = setup_gateway
    second_key = store.add_user("two")
    with TestClient(app) as client:
        one, two = activate(client, key), activate(client, second_key)
        with client.websocket_connect("/v1/worker", headers={"Authorization": "Bearer " + config["worker_token"]}) as worker:
            worker.send_json({"type": "worker.state", "state": "ready"})
            with client.websocket_connect("/v1/mobile") as a, client.websocket_connect("/v1/mobile") as b:
                for socket, session in ((a, one), (b, two)):
                    socket.send_json({"access_token": session["access_token"]})
                    receive_kind(socket, "gateway.ready")
                    while receive_kind(socket, "service.state")["state"] != "ready":
                        pass
                jobs = []
                for socket in (a, b):
                    # Same client turn/generation cannot collide across different identities.
                    socket.send_json({**turn(), "user_id": "forged_identity"})
                    jobs.append([receive_kind(worker, "tts.synthesize"), receive_kind(worker, "tts.synthesize")])
                assert jobs[0][0]["generation_id"] != jobs[1][0]["generation_id"]
                assert {batch[0]["user_id"] for batch in jobs} == {"one", "two"}
                for socket, batch in ((b, jobs[1]), (a, jobs[0])):
                    request = batch[0]
                    worker.send_bytes(audio_frame({"type": "audio.ready", "utterance_id": request["request_id"],
                        "generation_id": request["generation_id"], "format": "pcm_s16le", "channels": 1,
                        "sample_rate": 32000, "sample_count": 1, "duration_ms": 1}, b"\x00\x00"))
                    while True:
                        event = socket.receive()
                        if event.get("bytes"):
                            metadata, _ = read_audio_frame(event["bytes"])
                            assert metadata["utterance_id"] == request["request_id"]
                            break
                entries = [entry for entry in store.next_logs(100) if entry["type"] == "user.message"]
                assert len(entries) == 2 and len({entry["event_id"] for entry in entries}) == 2


@pytest.mark.asyncio
async def test_worker_keeps_synthesizing_while_audio_network_send_is_blocked(tmp_path):
    class FakeTts:
        calls = []
        async def synthesize(self, text, generation):
            self.calls.append(text)
            return {"pcm_base64": "AAAAAA==", "sample_rate": 32000, "duration_ms": 1}
        async def cancel(self, generation):
            pass

    class Socket:
        def __init__(self):
            self.incoming = asyncio.Queue()
            self.block_audio = asyncio.Event()
            self.sending_audio = asyncio.Event()
        def __aiter__(self):
            return self
        async def __anext__(self):
            return await self.incoming.get()
        async def send(self, message):
            if isinstance(message, bytes):
                self.sending_audio.set()
                await self.block_audio.wait()
        async def close(self):
            pass

    tts, socket = FakeTts(), Socket()
    worker = RemoteWorker({"data_dir": str(tmp_path), "voice_id": "ayana"}, tts=tts)
    task = asyncio.create_task(worker.session(socket))
    try:
        for n in range(2):
            await socket.incoming.put(json.dumps({"type": "tts.synthesize", "request_id": str(n),
                "generation_id": 1, "text": str(n), "voice_id": "ayana"}))
        await asyncio.wait_for(socket.sending_audio.wait(), 3)
        for _ in range(100):
            if len(tts.calls) == 2:
                break
            await asyncio.sleep(.01)
        assert tts.calls == ["0", "1"]
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        worker.logs.close()


@pytest.mark.asyncio
async def test_real_provider_adapter_decodes_sse_ndjson(tmp_path):
    speech = {"type": "speech", "key": "s1", "speech_ja": "こんにちは。"}
    caption = {"type": "translation", "key": "s1", "display_zh": "你好。"}
    content = json.dumps(speech, ensure_ascii=False) + "\n" + json.dumps(caption, ensure_ascii=False)
    # Split at every character inside JSON; only a complete event may commit.
    body = "".join("data: " + json.dumps({"choices": [{"delta": {"content": char}}]}, ensure_ascii=False) + "\n\n" for char in content)
    body += 'data: [DONE]\n\n'
    def respond(request):
        assert request.headers["authorization"] == "Bearer secret"
        assert json.loads(request.content)["stream"] is True
        return httpx.Response(200, text=body)
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        gw = Gateway(None, {"api_key": "secret", "model": "test", "base_url": "https://api.deepseek.com"}, client)
        result = [event async for event in gw.model([{"role": "user", "content": "hello"}])]
        assert [{key: event[key] for key in speech} for event in result if event['type'] == 'speech'] == [speech]
        assert result[-1] == caption


def test_legacy_history_reply_reaches_phone_as_speech_and_subtitle(setup_gateway):
    app, store, key, config = setup_gateway
    legacy = {"speech_ja": "ここにいるよ。", "display_zh": "我在这里。", "displayed": True,
              "status": "played", "played_samples": 48000, "total_samples": 48000}
    content = json.dumps(legacy, ensure_ascii=False)
    wire = "".join("data: " + json.dumps({"choices": [{"delta": {"content": char}}]}) + "\n\n" for char in content)
    wire += "data: [DONE]\n\n"
    transport = httpx.MockTransport(lambda request: httpx.Response(200, text=wire))
    provider = httpx.AsyncClient(transport=transport)
    actual = create_app(config, store=store, model_client=provider)
    with TestClient(actual) as client:
        session = activate(client, key)
        with client.websocket_connect("/v1/mobile") as phone:
            phone.send_json({"access_token": session["access_token"]})
            receive_kind(phone, "gateway.ready")
            phone.send_json(turn())
            speech = receive_kind(phone, "utterance.ready")
            subtitle = receive_kind(phone, "subtitle.ready")
            done = receive_kind(phone, "task.state")
            assert speech["speech_ja"] == legacy["speech_ja"]
            assert subtitle["display_zh"] == legacy["display_zh"]
            assert speech["utterance_id"] == subtitle["utterance_id"]
            assert done["state"] == "idle"
            assert not set(speech) & {"displayed", "status", "played_samples", "total_samples"}
    assert any(e["type"] == "turn.finished" and e["state"] == "complete" for e in store.next_logs(100))
    asyncio.run(provider.aclose())


@pytest.mark.parametrize("value", [
    {"speech_ja": "ここにいるよ。", "name": "run_tool", "arguments": {}},
    {"speech_ja": "https://example.com"},
    {"speech_ja": "ここにいるよ。", "display_zh": {"nested": "invalid"}},
    {"events": [{"speech_ja": "ここにいるよ。"}]},
])
def test_legacy_adapter_rejects_actions_and_invalid_speech(value):
    with pytest.raises(ValueError):
        model_events(value, "legacy_s1")


@pytest.mark.asyncio
async def test_grouped_speech_streams_before_translation_and_preserves_caption_pairing():
    release_translation = asyncio.Event()
    def sse(event):
        return ("data: " + json.dumps({"choices": [{"delta": {"content": json.dumps(event)}}]}) + "\n\n").encode()
    class Stream(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield sse({"type": "speech", "key": "s1", "speech_ja": "うん。ここにいるよ。", "expression": "休闲"})
            await release_translation.wait()
            yield sse({"type": "translation", "key": "s1", "display_zh": "嗯。我在这里。"})
            yield b"data: [DONE]\n\n"
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, stream=Stream()))) as client:
        gateway = Gateway(None, {"api_key": "secret", "model": "test", "base_url": "https://api.deepseek.com"}, client)
        stream = gateway.model([{"role": "user", "content": "hi"}])
        first = await asyncio.wait_for(anext(stream), 2)
        second = await asyncio.wait_for(anext(stream), 2)
        assert [first["speech_ja"], second["speech_ja"]] == ["うん。", "ここにいるよ。"]
        assert first["expression"] == second["expression"] == "休闲"
        assert first["key"] != second["key"]
        release_translation.set()
        captions = [event async for event in stream]
        assert [(e["key"], e["display_zh"]) for e in captions] == [(first["key"], "嗯。"), (second["key"], "我在这里。")]


def test_grouped_legacy_reply_retains_unalignable_caption_without_inventing_translation():
    events = model_events({"speech_ja": "うん。ここにいるよ。", "display_zh": "嗯，我在这里。", "status": "played"}, "s1")
    assert [e["type"] for e in events] == ["speech", "speech", "translation", "translation"]
    assert [e["display_zh"] for e in events[2:]] == ["嗯，我在这里。"] * 2
    assert [e["key"] for e in events[:2]] == [e["key"] for e in events[2:]]


def test_grouped_reply_validates_all_sentences_before_publication():
    normalizer = ReplyEvents()
    with pytest.raises(ValueError):
        normalizer.feed({"type": "speech", "key": "s1", "speech_ja": "うん。https://example.com。"}, "unused")
    assert normalizer.groups == {} and normalizer.used == set()


def test_old_phone_context_migration_preserves_text_and_drops_playback_example():
    legacy = {"speech_ja": "ここにいるよ。", "display_zh": "我在这里。", "status": "played", "played_samples": 200}
    messages = [{"role": "system", "content": "persona"}, {"role": "assistant", "content": json.dumps(legacy)},
                {"role": "user", "content": "你好"}]
    actual = model_context(messages)
    assert actual[0] == messages[0] and actual[-1] == messages[-1]
    assert "played_samples" not in actual[1]["content"]
    assert [json.loads(line)["type"] for line in actual[1]["content"].splitlines()] == ["speech", "translation"]
    assert messages[1]["content"] == json.dumps(legacy)


def test_model_failure_codes_distinguish_format_from_connection_errors():
    assert model_error_code(httpx.ReadTimeout("private transport context")) == "model_timeout"
    assert model_error_code(ValueError("Only complete sentences may be committed")) == "incomplete_speech"
    assert model_error_code(ValueError("unrecognized private context")) == "invalid_model_format"
