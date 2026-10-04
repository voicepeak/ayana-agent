from __future__ import annotations

import json
import sqlite3
import time
import threading
from functools import wraps
from pathlib import Path


def locked(fn):
    @wraps(fn)
    def call(self, *args, **kwargs):
        with self.lock:
            return fn(self, *args, **kwargs)
    return call


def without_media(value):
    if isinstance(value, dict):
        return {k: without_media(v) for k, v in value.items() if k not in {"pcm_base64", "png_base64"}}
    if isinstance(value, list):
        return [without_media(v) for v in value]
    return value


class ConversationStore:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript("""
          CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, created REAL, session_id TEXT, generation_id INTEGER, type TEXT, payload TEXT);
          CREATE TABLE IF NOT EXISTS utterances(utterance_id TEXT PRIMARY KEY, session_id TEXT, turn_id TEXT, generation_id INTEGER, speech_ja TEXT, display_zh TEXT DEFAULT '', status TEXT DEFAULT 'generated', played_samples INTEGER DEFAULT 0, total_samples INTEGER DEFAULT 0, sample_rate INTEGER DEFAULT 0, displayed INTEGER DEFAULT 0);
          CREATE TABLE IF NOT EXISTS preferences(key TEXT PRIMARY KEY, value TEXT);
          CREATE TABLE IF NOT EXISTS model_turns(id INTEGER PRIMARY KEY, scope TEXT, payload TEXT);
          CREATE INDEX IF NOT EXISTS model_turns_scope ON model_turns(scope, id);
        """)

    @locked
    def commit(self, event: dict):
        kind = event["type"]
        if kind not in {"audio.ready", "snapshot.ready", "playback.progress"}:
            payload = without_media(event)
            self.db.execute("INSERT INTO events(created,session_id,generation_id,type,payload) VALUES(?,?,?,?,?)",
                            (time.time(), event.get("session_id"), event.get("generation_id", 0), kind, json.dumps(payload, ensure_ascii=False)))
        uid = event.get("utterance_id")
        if kind == "utterance.ready":
            self.db.execute("INSERT INTO utterances(utterance_id,session_id,turn_id,generation_id,speech_ja) VALUES(?,?,?,?,?)",
                            (uid, event["session_id"], event["turn_id"], event["generation_id"], event["speech_ja"]))
        elif kind == "subtitle.ready":
            self.db.execute("UPDATE utterances SET display_zh=? WHERE utterance_id=?", (event["display_zh"], uid))
        elif kind in {"playback.started", "playback.progress", "playback.ended", "playback.cancelled"}:
            status = {"playback.started": "playing", "playback.progress": "playing", "playback.ended": "played", "playback.cancelled": "partial"}[kind]
            self.db.execute("UPDATE utterances SET status=?,played_samples=?,total_samples=?,sample_rate=?,displayed=1 WHERE utterance_id=?",
                            (status, event.get("played_samples", 0), event.get("total_samples", 0), event.get("sample_rate", 0), uid))
        elif kind == "utterance.displayed":
            self.db.execute("UPDATE utterances SET displayed=1 WHERE utterance_id=?", (uid,))
        elif kind == "generation.cancelled":
            self.db.execute("UPDATE utterances SET status=CASE WHEN status='playing' THEN 'partial' ELSE 'cancelled' END WHERE generation_id=? AND session_id=? AND status IN ('generated','playing')",
                            (event.get("cancelled_generation_id"), event["session_id"]))
        self.db.commit()

    @locked
    def history(self, limit=60):
        self.db.row_factory = sqlite3.Row
        rows = self.db.execute("SELECT * FROM utterances ORDER BY rowid DESC LIMIT ?", (limit,)).fetchall()
        return [dict(r) for r in reversed(rows)]

    @locked
    def context(self, exclude_turn=None):
        known = {r["utterance_id"]: r for r in self.history(60)}
        events = self.db.execute("SELECT payload FROM events WHERE type IN ('user.message','utterance.ready') ORDER BY id DESC LIMIT 60").fetchall()
        result = []
        for event in reversed(events):
            e = json.loads(event[0])
            if e.get("turn_id") == exclude_turn:
                continue
            if e["type"] == "user.message":
                result.append({"role": "user", "content": e["text"]})
            else:
                r = known.get(e.get("utterance_id"))
                if r and (r["displayed"] or r["status"] in {"played", "partial"}):
                    # Historical examples must retain the current event format;
                    # otherwise the model imitates an untyped wrapper next turn.
                    speech = {"type": "speech", "key": r["utterance_id"], "speech_ja": r["speech_ja"],
                              "intent": e.get("intent", "explain"), "affect": e.get("affect", "neutral"), "intensity": e.get("intensity", .25),
                              "reception": r["status"], "played_samples": r["played_samples"]}
                    events = [speech]
                    if r["display_zh"]:
                        events.append({"type": "translation", "key": r["utterance_id"], "display_zh": r["display_zh"]})
                    result.append({"role": "assistant", "content": "\n".join(json.dumps(item, ensure_ascii=False) for item in events)})
        return result[-16:]

    @locked
    def model_turns(self, scope):
        return [json.loads(row[0]) for row in self.db.execute(
            "SELECT payload FROM model_turns WHERE scope=? ORDER BY id", (scope,))]

    @locked
    def has_model_turns(self):
        return self.db.execute("SELECT 1 FROM model_turns LIMIT 1").fetchone() is not None

    @locked
    def replace_model_turns(self, scope, turns):
        with self.db:
            self.db.execute("DELETE FROM model_turns WHERE scope=?", (scope,))
            self.db.executemany("INSERT INTO model_turns(scope,payload) VALUES(?,?)",
                                [(scope, json.dumps(turn, ensure_ascii=False)) for turn in turns])

    @locked
    def reception(self, turn_id, keys):
        rows = self.db.execute(
            "SELECT utterance_id,status,displayed,played_samples,total_samples FROM utterances WHERE turn_id=? ORDER BY rowid",
            (turn_id,)).fetchall()
        reverse = {uid: key for key, uid in keys.items()}
        return [{"key": reverse[row[0]], "status": row[1], "displayed": bool(row[2]),
                 "played_samples": row[3], "total_samples": row[4]}
                for row in rows if row[0] in reverse]

    @locked
    def close(self):
        self.db.close()
