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
          CREATE TABLE IF NOT EXISTS event_sequence(id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS model_turns(id INTEGER PRIMARY KEY, scope TEXT, payload TEXT);
          CREATE INDEX IF NOT EXISTS model_turns_scope ON model_turns(scope, id);
          CREATE TABLE IF NOT EXISTS context_summaries(scope TEXT PRIMARY KEY, summary TEXT);
          CREATE TABLE IF NOT EXISTS capability_records(kind TEXT, key TEXT, payload TEXT, updated REAL, PRIMARY KEY(kind,key));
        """)
        self.db.execute('INSERT OR IGNORE INTO event_sequence VALUES(1,0)')
        self.db.execute('UPDATE event_sequence SET value=max(value,(SELECT coalesce(max(id),0) FROM events)) WHERE id=1')
        self.db.commit()
        columns = {row[1] for row in self.db.execute("PRAGMA table_info(utterances)")}
        if "display_en" not in columns:
            self.db.execute("ALTER TABLE utterances ADD COLUMN display_en TEXT DEFAULT ''")
            self.db.commit()

    @locked
    def commit(self, event: dict):
        kind = event["type"]
        # Derived UI snapshots contain copies of historical data. Persist their
        # source records, not another full transcript on every refresh.
        if kind not in {"audio.ready", "snapshot.ready", "playback.progress", "history.ready",
                        "conversations.ready", "conversation.changed", "context.state",
                        "conversation.review", "conversation.search-results", "memory.ready", "attention.state"}:
            payload = without_media(event)
            event_id = self.db.execute('UPDATE event_sequence SET value=value+1 WHERE id=1 RETURNING value').fetchone()[0]
            self.db.execute("INSERT INTO events(id,created,session_id,generation_id,type,payload) VALUES(?,?,?,?,?,?)",
                            (event_id,time.time(), event.get("session_id"), event.get("generation_id", 0), kind, json.dumps(payload, ensure_ascii=False)))
        uid = event.get("utterance_id")
        if kind == "utterance.ready":
            self.db.execute("INSERT INTO utterances(utterance_id,session_id,turn_id,generation_id,speech_ja) VALUES(?,?,?,?,?)",
                            (uid, event["session_id"], event["turn_id"], event["generation_id"], event["speech_ja"]))
        elif kind in {"subtitle.ready", "subtitle.translated"}:
            for field in ("display_zh", "display_en"):
                if isinstance(event.get(field), str):
                    self.db.execute(f"UPDATE utterances SET {field}=? WHERE utterance_id=?", (event[field], uid))
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
    def displayed_expressions(self, conversation_id=None):
        """Expressions the user actually saw in one conversation."""
        rows = self.db.execute("""
            SELECT DISTINCT json_extract(e.payload,'$.resolved_expression')
            FROM events e JOIN utterances u ON u.utterance_id=json_extract(e.payload,'$.utterance_id')
            WHERE e.type='utterance.ready' AND u.displayed=1
              AND (u.status!='partial' OR u.played_samples>0)
              AND json_extract(e.payload,'$.resolved_expression') IS NOT NULL
              AND (? IS NULL OR json_extract(e.payload,'$.conversation_id')=?)
        """, (conversation_id, conversation_id)).fetchall()
        return [row[0] for row in rows if row[0]]

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
                   u.displayed,u.played_samples,u.total_samples,u.sample_rate,u.display_en
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
                            total_samples=row[9], sample_rate=row[10], display_en=row[11])
            items.append(item)
        return {"items": items, "has_more": len(rows) > limit,
                "before": items[0]["id"] if items else None}

    @locked
    def search_history(self, query, before=None, start=None, end=None, conversation_id=None, limit=40):
        # instr treats %, _, quotes and SQL-like user input as literal text.
        rows = self.db.execute("""
            SELECT e.id,e.created,e.type,e.payload,u.speech_ja,u.display_zh,u.display_en
            FROM events e LEFT JOIN utterances u ON e.type='utterance.ready'
              AND u.utterance_id=json_extract(e.payload,'$.utterance_id')
            WHERE e.type IN ('user.message','utterance.ready')
              AND (? IS NULL OR e.id<?) AND (? IS NULL OR e.created>=?) AND (? IS NULL OR e.created<?)
              AND (? IS NULL OR json_extract(e.payload,'$.conversation_id')=?)
              AND (?='' OR instr(lower(coalesce(json_extract(e.payload,'$.text'),'') || ' ' ||
                coalesce(u.speech_ja,'') || ' ' || coalesce(u.display_zh,'') || ' ' || coalesce(u.display_en,'')),lower(?))>0)
            ORDER BY e.id DESC LIMIT ?
        """, (before,before,start,start,end,end,conversation_id,conversation_id,query,query,limit+1)).fetchall()
        items = []
        for row in rows[:limit]:
            event = json.loads(row[3])
            items.append({"id":row[0],"created":row[1],"conversation_id":event.get("conversation_id"),
                          "role":"user" if row[2]=='user.message' else "assistant",
                          "text":event.get("text", "") if row[2]=='user.message' else row[5] or row[4] or ""})
        return {"items":items,"has_more":len(rows)>limit,"before":items[-1]["id"] if items else None}

    @locked
    def user_memory_sources(self, after=0, limit=12):
        # Bootstrap from recent messages. Once started, consume every new batch
        # in order so a burst of messages cannot fall behind the watermark.
        order = 'ASC' if after else 'DESC'
        rows = self.db.execute(f"""SELECT id,created,payload FROM events
            WHERE type='user.message' AND id>? ORDER BY id {order} LIMIT ?""", (after,limit)).fetchall()
        if not after:
            rows.reverse()
        return [{"id":row[0],"created":row[1],"conversation_id":json.loads(row[2]).get("conversation_id"),
                 "text":json.loads(row[2]).get("text", "")} for row in rows]

    @locked
    def delete_conversation(self, cid):
        scope = "conversation:" + cid
        self.db.execute("PRAGMA secure_delete=ON")
        with self.db:
            task_ids = [row[0] for row in self.db.execute("""SELECT DISTINCT json_extract(payload,'$.task.task_id')
                FROM events WHERE type='task.updated' AND json_extract(payload,'$.conversation_id')=?""", (cid,))]
            for kind in ("source", "artifact"):
                path = f"$.{kind}.{kind}_id"
                exclusive = self.db.execute("""SELECT DISTINCT json_extract(payload,?) FROM events
                    WHERE json_extract(payload,'$.conversation_id')=? AND json_extract(payload,?) IS NOT NULL
                    AND json_extract(payload,?) NOT IN (SELECT json_extract(payload,?) FROM events
                        WHERE json_extract(payload,'$.conversation_id')<>? AND json_extract(payload,?) IS NOT NULL)""",
                    (path, cid, path, path, path, cid, path)).fetchall()
                self.db.executemany("DELETE FROM capability_records WHERE kind=? AND key=?",
                                    [(kind, row[0]) for row in exclusive])
            self.db.execute("""DELETE FROM utterances WHERE utterance_id IN (SELECT json_extract(payload,'$.utterance_id')
                FROM events WHERE json_extract(payload,'$.conversation_id')=?)""", (cid,))
            self.db.execute("DELETE FROM events WHERE json_extract(payload,'$.conversation_id')=?", (cid,))
            self.db.execute("DELETE FROM model_turns WHERE scope=?", (scope,))
            self.db.execute("DELETE FROM context_summaries WHERE scope=?", (scope,))
            self.db.execute("DELETE FROM capability_records WHERE kind='conversation' AND key=?", (cid,))
            self.db.executemany("DELETE FROM capability_records WHERE kind='task' AND key=?", [(tid,) for tid in task_ids if tid])
            self.db.execute("DELETE FROM capability_records WHERE json_extract(payload,'$.conversation_id')=?", (cid,))
            self.db.execute("DELETE FROM capability_records WHERE kind='memory' AND json_extract(payload,'$.source.conversation_id')=?", (cid,))
        # Reclaim deleted pages now, rather than retaining them in the database/WAL.
        self.db.execute("VACUUM")
        self.db.execute("PRAGMA wal_checkpoint(TRUNCATE)")

    @locked
    def subtitle_sources(self, conversation_id, utterance_ids):
        if not utterance_ids:
            return []
        placeholders = ",".join("?" for _ in utterance_ids)
        cursor = self.db.execute(f"""SELECT u.utterance_id,u.speech_ja,u.display_zh,u.display_en,u.generation_id
            FROM utterances u JOIN events e ON e.type='utterance.ready' AND u.utterance_id=json_extract(e.payload,'$.utterance_id')
            WHERE json_extract(e.payload,'$.conversation_id')=? AND u.utterance_id IN ({placeholders})""", [conversation_id, *utterance_ids])
        names = [column[0] for column in cursor.description]
        return [dict(zip(names, row)) for row in cursor.fetchall()]

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
