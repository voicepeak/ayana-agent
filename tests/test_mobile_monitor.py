import json
import sqlite3

from fastapi.testclient import TestClient
import pytest

from services.mobile_monitor.reader import MonitorReader, read_rows
from services.mobile_monitor.server import create_app


NOW = 1_800_000_000
TOKEN = "local-admin-" + "x" * 32
BASE_URL = "http://127.0.0.1:17340"


@pytest.fixture
def data(tmp_path):
    gateway = tmp_path / "gateway.sqlite3"
    logs = tmp_path / "dialogue.sqlite3"
    db = sqlite3.connect(gateway)
    db.executescript("PRAGMA journal_mode=WAL; CREATE TABLE users(id TEXT,active INTEGER,key_hash TEXT);"
                    "CREATE TABLE sessions(user_id TEXT,device TEXT,refresh_expires REAL,token_hash TEXT);"
                    "CREATE TABLE outbox(id INTEGER PRIMARY KEY,body TEXT);")
    db.executemany("INSERT INTO users VALUES(?,?,?)", [("one", 1, "private-key-hash"), ("two", 1, "private-key-hash-2"), ("old", 0, "retired")])
    db.execute("INSERT INTO sessions VALUES(?,?,?,?)", ("one", "private-device", NOW + 1000, "private-session-hash"))
    db.commit()
    events = sqlite3.connect(logs)
    events.executescript("PRAGMA journal_mode=WAL; CREATE TABLE events(id TEXT PRIMARY KEY,created REAL,body TEXT);")
    index = 0

    def append(kind, *, user="one", turn="t1", at=NOW - 10, topic="topic_one", pending=False, **fields):
        nonlocal index
        index += 1
        event = {"event_id": f"e{index}", "timestamp": at, "type": kind, "user_id": user,
                 "turn_id": turn, "conversation_id": topic, **fields}
        if pending:
            db.execute("INSERT INTO outbox(body) VALUES(?)", (json.dumps(event),)); db.commit()
        else:
            events.execute("INSERT INTO events VALUES(?,?,?)", (event["event_id"], at, json.dumps(event))); events.commit()
        return event

    reader = MonitorReader(logs, gateway, {"one": "测试者 01", "two": "测试者 02"}, clock=lambda: NOW)
    yield reader, append, db, events
    events.close(); db.close()


def complete(append, user="one", turn="t1", start=NOW - 10, voice_delay=2, topic="topic_one"):
    append("user.message", user=user, turn=turn, topic=topic, at=start, text="你好")
    append("utterance.ready", user=user, turn=turn, topic=topic, at=start + 1, utterance_id=turn + "s", speech_ja="こんにちは。", audio_enabled=True)
    append("subtitle.ready", user=user, turn=turn, topic=topic, at=start + 1.2, utterance_id=turn + "s", display_zh="你好。")
    append("turn.finished", user=user, turn=turn, topic=topic, at=start + 1.5, state="complete")
    append("tts.completed", user=user, turn=turn, topic=topic, at=start + voice_delay, utterance_id=turn + "s", synthesis_ms=700, duration_ms=900)


def test_bilingual_turn_timing_and_user_scope(data):
    reader, append, _, _ = data
    complete(append)
    complete(append, "two", "second", voice_delay=6, topic="topic_two")
    snapshot = reader.snapshot(user_id="one")
    assert snapshot["summary"]["requests"] == 1
    turn = snapshot["turns"][0]
    assert turn["first_text_ms"] == 1000 and turn["first_audio_ms"] == 2000
    assert turn["status"] == "complete" and turn["speeches"][0]["zh"] == "你好。"
    assert snapshot["summary"]["audio_p50_ms"] == 2000
    assert reader.snapshot(user_id="two")["turns"][0]["status"] == "slow_audio"
    assert reader.snapshot(user_id="one", conversation_id="topic_two")["turns"] == []


def test_live_pending_model_and_late_audio_are_not_reported_as_confirmed_failure(data):
    reader, append, _, _ = data
    append("user.message", at=NOW - 40, text="等待")
    turn = reader.snapshot()["turns"][0]
    assert turn["status"] == "model_wait_long" and turn["severity"] == "warning"
    append("utterance.ready", at=NOW - 39, utterance_id="s", speech_ja="こんにちは。")
    append("turn.finished", at=NOW - 38, state="complete")
    assert reader.snapshot()["turns"][0]["status"] == "audio_wait_long"
    reader.clock = lambda: NOW + 200
    assert reader.snapshot()["turns"][0]["status"] == "unresolved"


def test_failed_and_cancelled_turns_have_different_severity(data):
    reader, append, _, _ = data
    append("user.message", text="first")
    append("model.failed", code="invalid_model_repair")
    append("turn.finished", state="failed")
    append("user.message", turn="cancelled", text="second")
    append("turn.finished", turn="cancelled", state="cancelled")
    result = reader.snapshot(issues_only=True)
    assert len(result["turns"]) == 1
    assert result["summary"]["failed"] == 1
    assert result["turns"][0]["errors"][0]["code"] == "invalid_model_repair"


def test_voice_failure_is_distinguished_from_model_failure(data):
    reader, append, _, _ = data
    append("user.message", text="hello")
    append("utterance.ready", utterance_id="s", speech_ja="こんにちは。")
    append("turn.finished", state="complete")
    append("tts.failed", utterance_id="s", error_type="RuntimeError")
    turn = reader.snapshot()["turns"][0]
    assert turn["status"] == "tts_failed" and turn["model_state"] == "complete"


def test_later_audio_cannot_masquerade_as_the_head_sentence_being_ready(data):
    reader, append, _, _ = data
    append("user.message", at=NOW - 10, text="hello")
    append("utterance.ready", at=NOW - 9, utterance_id="first", speech_ja="こんにちは。")
    append("utterance.ready", at=NOW - 8, utterance_id="second", speech_ja="また話そう。")
    append("turn.finished", at=NOW - 7, state="complete")
    append("tts.completed", at=NOW - 6, utterance_id="second")
    assert reader.snapshot()["turns"][0]["first_audio_ms"] is None
    append("tts.completed", at=NOW - 1, utterance_id="first")
    assert reader.snapshot()["turns"][0]["first_audio_ms"] == 9000


def test_gateway_outbox_is_visible_and_deduplicates_after_archival(data):
    reader, append, gateway, events = data
    event = append("user.message", text="实时", pending=True)
    assert reader.snapshot()["summary"]["requests"] == 1
    events.execute("INSERT INTO events VALUES(?,?,?)", (event["event_id"], event["timestamp"], json.dumps(event))); events.commit()
    result = reader.snapshot()
    assert result["summary"]["requests"] == 1 and result["turns"][0]["event_count"] == 1
    assert result["source"]["pending_delivery"] == 1


def test_revoked_benchmark_accounts_are_hidden_until_selected(data):
    reader, append, _, _ = data
    complete(append, "old")
    assert not reader.snapshot()["turns"]
    assert reader.snapshot(include_inactive=True)["summary"]["requests"] == 1


def test_log_reads_cannot_write_and_remain_available_during_a_writer_transaction(data):
    reader, append, gateway, _ = data
    complete(append)
    gateway.execute("BEGIN IMMEDIATE")
    try:
        assert reader.snapshot()["summary"]["requests"] == 1
    finally:
        gateway.rollback()
    assert read_rows(reader.gateway_db, "DELETE FROM users")[1] == "unavailable"
    assert gateway.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 3


def test_monitor_never_serializes_identity_credentials_or_pcm(data):
    reader, append, _, _ = data
    append("user.message", text="ayana1.ABCDEFGHIJK", access_token="private-token", device_id="private-device")
    append("utterance.ready", utterance_id="s", speech_ja="こんにちは。", pcm_base64="private-audio")
    combined = json.dumps(reader.snapshot()) + json.dumps(reader.detail("one", "t1"))
    for secret in ["private-token", "private-device", "private-key-hash", "private-session-hash", "private-audio", "ayana1.ABCDEFGHIJK"]:
        assert secret not in combined


def test_missing_log_files_are_reported_without_creating_databases(tmp_path):
    reader = MonitorReader(tmp_path / "missing-logs.sqlite3", tmp_path / "missing-users.sqlite3")
    result = reader.snapshot()
    assert result["source"]["logs"] == "missing" and result["turns"] == []
    assert not list(tmp_path.iterdir())


def test_unknown_or_corrupt_log_rows_do_not_break_monitor(data):
    reader, append, _, logs = data
    complete(append)
    logs.execute("INSERT INTO events VALUES(?,?,?)", ("broken", NOW - 1, "broken-json")); logs.commit()
    assert reader.snapshot()["summary"]["requests"] == 1


def test_admin_authentication_origin_guard_and_read_only_routes(data):
    reader, append, gateway, _ = data
    complete(append)
    with TestClient(create_app(reader, TOKEN), base_url=BASE_URL) as client:
        assert client.get("/api/snapshot").status_code == 401
        assert client.post("/api/login", json={"token": TOKEN}).status_code == 403
        headers = {"Origin": BASE_URL}
        assert client.post("/api/login", headers=headers, json={"token": "中文错误口令"}).status_code == 401
        response = client.post("/api/login", headers=headers, json={"token": TOKEN})
        assert response.status_code == 200 and "httponly" in response.headers["set-cookie"].lower()
        assert client.get("/api/snapshot").json()["summary"]["requests"] == 1
        assert client.get("/api/turn/t1?user_id=two").status_code == 404
        assert client.get("/api/turn/t1?user_id=one").json()["turn"]["user_id"] == "one"
        assert client.get("/api/snapshot?hours=999").status_code == 400
        assert client.post("/api/revoke").status_code == 404
        assert client.get("/").headers["cache-control"] == "no-store"
        assert client.get("/", headers={"Host": "attacker.invalid"}).status_code == 400
        assert client.post("/api/logout", headers=headers).status_code == 200
        assert client.get("/api/snapshot").status_code == 401
    assert gateway.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 3


def test_failed_login_attempts_are_bounded(data):
    reader, _, _, _ = data
    with TestClient(create_app(reader, TOKEN), base_url=BASE_URL) as client:
        for _ in range(10):
            assert client.post("/api/login", headers={"Origin": BASE_URL}, json={"token": "wrong"}).status_code == 401
        assert client.post("/api/login", headers={"Origin": BASE_URL}, json={"token": TOKEN}).status_code == 429
