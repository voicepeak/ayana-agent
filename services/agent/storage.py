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
          CREATE INDEX IF NOT EXISTS events_conversation_history
            ON events(json_extract(payload,'$.conversation_id'),id)
            WHERE type IN ('user.message','utterance.ready');
          CREATE TABLE IF NOT EXISTS utterances(utterance_id TEXT PRIMARY KEY, session_id TEXT, turn_id TEXT, generation_id INTEGER, speech_ja TEXT, display_zh TEXT DEFAULT '', status TEXT DEFAULT 'generated', played_samples INTEGER DEFAULT 0, total_samples INTEGER DEFAULT 0, sample_rate INTEGER DEFAULT 0, displayed INTEGER DEFAULT 0);
          CREATE TABLE IF NOT EXISTS preferences(key TEXT PRIMARY KEY, value TEXT);
          CREATE TABLE IF NOT EXISTS model_turns(id INTEGER PRIMARY KEY, scope TEXT, payload TEXT);
          CREATE INDEX IF NOT EXISTS model_turns_scope ON model_turns(scope, id);
          CREATE TABLE IF NOT EXISTS context_summaries(scope TEXT PRIMARY KEY, summary TEXT);
          CREATE TABLE IF NOT EXISTS capability_records(kind TEXT, key TEXT, payload TEXT, updated REAL, PRIMARY KEY(kind,key));
        """)

    @locked
    def commit(self, event: dict):
        kind = event["type"]
        # Derived UI snapshots contain copies of historical data. Persist their
        # source records, not another full transcript on every refresh.
        if kind not in {"audio.ready", "snapshot.ready", "playback.progress", "history.ready",
                        "conversations.ready", "conversation.changed", "context.state"}:
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
    def recent_work_results(self, conversation_id, limit=40):
        rows = self.db.execute("""
            SELECT payload FROM events
            WHERE type IN ('tool.completed','tool.failed') AND json_extract(payload,'$.conversation_id')=?
            ORDER BY id DESC LIMIT ?
        """, (conversation_id, limit)).fetchall()
        return [json.loads(row[0]) for row in reversed(rows)]

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
                              "expression": e.get("resolved_expression", e.get("expression", "")),
                              "pose": e.get("resolved_pose", e.get("pose", "crossed")),
                              "reception": r["status"], "played_samples": r["played_samples"]}
                    events = [speech]
                    if r["display_zh"]:
                        events.append({"type": "translation", "key": r["utterance_id"], "display_zh": r["display_zh"]})
                    result.append({"role": "assistant", "content": "\n".join(json.dumps(item, ensure_ascii=False) for item in events)})
        return result[-16:]

    @locked
    def recent_avatar_speeches(self, conversation_id=None):
        rows = self.db.execute("""
            SELECT e.payload,u.status,u.played_samples FROM events e
            JOIN utterances u ON u.utterance_id=json_extract(e.payload,'$.utterance_id')
            WHERE e.type='utterance.ready' AND u.displayed=1
              AND (u.status!='partial' OR u.played_samples>0)
              AND (? IS NULL OR json_extract(e.payload,'$.conversation_id')=?)
            ORDER BY e.id DESC LIMIT 12
        """, (conversation_id, conversation_id)).fetchall()
        return [{**json.loads(row[0]), "displayed": True, "status": row[1], "played_samples": row[2]}
                for row in reversed(rows)]

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
    def context_summary(self, scope):
        row = self.db.execute("SELECT summary FROM context_summaries WHERE scope=?", (scope,)).fetchone()
        return row[0] if row else ""

    @locked
    def compact_context(self, scope, turns, summary):
        # The summary and the remaining whole turns must survive restart together.
        with self.db:
            self.db.execute("DELETE FROM model_turns WHERE scope=?", (scope,))
            self.db.executemany("INSERT INTO model_turns(scope,payload) VALUES(?,?)",
                                [(scope, json.dumps(turn, ensure_ascii=False)) for turn in turns])
            self.db.execute("INSERT OR REPLACE INTO context_summaries VALUES(?,?)", (scope, summary))

    @locked
    def migrate_conversation(self, conversation_id):
        """Adopt old records once, keeping the latest model partition intact."""
        with self.db:
            self.db.execute("UPDATE events SET payload=json_set(payload,'$.conversation_id',?) "
                            "WHERE json_extract(payload,'$.conversation_id') IS NULL", (conversation_id,))
            row = self.db.execute("SELECT scope FROM model_turns ORDER BY id DESC LIMIT 1").fetchone()
            turns = self.model_turns(row[0]) if row else []
            if not turns:
                messages = self.context()
                if messages:
                    turns = [{"turn_id": "legacy-import", "messages": messages, "keys": {}}]
            self.replace_model_turns("conversation:" + conversation_id, turns)
        return bool(turns)

    @locked
    def conversation_history(self, conversation_id, before=None, limit=100):
        rows = self.db.execute("""
            SELECT e.id,e.created,e.type,e.payload,u.speech_ja,u.display_zh,u.status,
                   u.displayed,u.played_samples,u.total_samples,u.sample_rate
            FROM events e LEFT JOIN utterances u ON e.type='utterance.ready'
              AND u.utterance_id=json_extract(e.payload,'$.utterance_id')
            WHERE e.type IN ('user.message','utterance.ready')
              AND json_extract(e.payload,'$.conversation_id')=? AND (? IS NULL OR e.id<?)
            ORDER BY e.id DESC LIMIT ?
        """, (conversation_id, before, before, limit + 1)).fetchall()
        items = []
        for row in reversed(rows[:limit]):
            event = json.loads(row[3])
            item = {"id": row[0], "created": row[1], "turn_id": event.get("turn_id"),
                    "role": "user" if row[2] == "user.message" else "assistant"}
            if item["role"] == "user":
                item["text"] = event["text"]
            else:
                item.update(utterance_id=event["utterance_id"], speech_ja=row[4], display_zh=row[5],
                            status=row[6], displayed=bool(row[7]), played_samples=row[8],
                            total_samples=row[9], sample_rate=row[10])
            items.append(item)
        return {"items": items, "has_more": len(rows) > limit,
                "before": items[0]["id"] if items else None}

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
    def put_record(self, kind, key, value):
        with self.db:
            self.db.execute("INSERT OR REPLACE INTO capability_records VALUES(?,?,?,?)",
                            (kind, key, json.dumps(without_media(value), ensure_ascii=False), time.time()))
            limit = {"task": 60, "source": 100, "artifact": 200}.get(kind)
            if limit:
                self.db.execute("DELETE FROM capability_records WHERE kind=? AND key NOT IN "
                                "(SELECT key FROM capability_records WHERE kind=? ORDER BY updated DESC LIMIT ?)",
                                (kind, kind, limit))

    @locked
    def get_record(self, kind, key):
        row = self.db.execute("SELECT payload FROM capability_records WHERE kind=? AND key=?", (kind, key)).fetchone()
        return json.loads(row[0]) if row else None

    @locked
    def delete_record(self, kind, key):
        with self.db:
            self.db.execute("DELETE FROM capability_records WHERE kind=? AND key=?", (kind, key))

    @locked
    def records(self, kind, limit=60):
        return [json.loads(row[0]) for row in self.db.execute(
            "SELECT payload FROM capability_records WHERE kind=? ORDER BY updated DESC LIMIT ?", (kind, limit))]

    @locked
    def close(self):
        self.db.close()
