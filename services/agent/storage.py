from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path


class ConversationStore:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript("""
          CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, created REAL, session_id TEXT, generation_id INTEGER, type TEXT, payload TEXT);
          CREATE TABLE IF NOT EXISTS utterances(utterance_id TEXT PRIMARY KEY, session_id TEXT, turn_id TEXT, generation_id INTEGER, speech_ja TEXT, display_zh TEXT DEFAULT '', status TEXT DEFAULT 'generated', played_samples INTEGER DEFAULT 0, total_samples INTEGER DEFAULT 0, sample_rate INTEGER DEFAULT 0, displayed INTEGER DEFAULT 0);
          CREATE TABLE IF NOT EXISTS preferences(key TEXT PRIMARY KEY, value TEXT);
        """)

    def commit(self, event: dict):
        kind = event["type"]
        if kind not in {"audio.ready", "snapshot.ready", "playback.progress"}:
            payload = {k: v for k, v in event.items() if k not in {"pcm_base64", "png_base64"}}
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

    def history(self, limit=60):
        self.db.row_factory = sqlite3.Row
        rows = self.db.execute("SELECT * FROM utterances ORDER BY rowid DESC LIMIT ?", (limit,)).fetchall()
        return [dict(r) for r in reversed(rows)]

    def context(self):
        return [{"role": "assistant", "content": json.dumps({"speech_ja": r["speech_ja"], "display_zh": r["display_zh"], "reception": r["status"], "played_samples": r["played_samples"]}, ensure_ascii=False)}
                for r in self.history(12) if r["displayed"] or r["status"] in {"played", "partial"}]

    def close(self):
        self.db.close()
