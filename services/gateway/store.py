"""Small durable identity/diagnostic outbox, separate from desktop chat history."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import secrets
import sqlite3
import threading
import time


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


class Store:
    def __init__(self, path: Path, outbox_limit=10000):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        self.outbox_limit = outbox_limit
        self.db.executescript("""
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, key_hash TEXT UNIQUE, active INTEGER DEFAULT 1);
            CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, refresh_hash TEXT UNIQUE,
                user_id TEXT, device TEXT, expires REAL, refresh_expires REAL);
            CREATE TABLE IF NOT EXISTS turns(user_id TEXT, turn_id TEXT, created REAL,
                PRIMARY KEY(user_id,turn_id));
            CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL);
        """)
        self.db.commit()

    def add_user(self, user_id, key=None):
        key = key or secrets.token_urlsafe(32)
        with self.lock, self.db:
            self.db.execute("INSERT INTO users(id,key_hash) VALUES(?,?)", (user_id, digest(key)))
        return key

    def revoke_user(self, user_id):
        with self.lock, self.db:
            self.db.execute("UPDATE users SET active=0 WHERE id=?", (user_id,))
            self.db.execute("DELETE FROM sessions WHERE user_id=?", (user_id,))

    def activate(self, key, device):
        with self.lock:
            user = self.db.execute("SELECT id FROM users WHERE key_hash=? AND active=1", (digest(key),)).fetchone()
            if not user:
                return None
            count = self.db.execute("SELECT COUNT(DISTINCT device) FROM sessions WHERE user_id=? AND refresh_expires>?",
                                    (user["id"], time.time())).fetchone()[0]
            known = self.db.execute("SELECT 1 FROM sessions WHERE user_id=? AND device=?", (user["id"], device)).fetchone()
            if count >= 5 and not known:
                raise ValueError("device_limit")
            with self.db:
                self.db.execute("DELETE FROM sessions WHERE user_id=? AND device=?", (user["id"], device))
            return self._session(user["id"], device)

    def _session(self, user_id, device):
        access, refresh = secrets.token_urlsafe(32), secrets.token_urlsafe(40)
        now = time.time()
        with self.db:
            self.db.execute("INSERT INTO sessions VALUES(?,?,?,?,?,?)",
                            (digest(access), digest(refresh), user_id, device, now + 900, now + 30 * 86400))
        return {"access_token": access, "refresh_token": refresh, "expires_at": now + 900,
                "user_id": user_id, "device_id": device}

    def refresh(self, token):
        with self.lock:
            row = self.db.execute("SELECT s.* FROM sessions s JOIN users u ON s.user_id=u.id "
                                  "WHERE refresh_hash=? AND refresh_expires>? AND u.active=1",
                                  (digest(token), time.time())).fetchone()
            if not row:
                return None
            with self.db:
                self.db.execute("DELETE FROM sessions WHERE token_hash=?", (row["token_hash"],))
            return self._session(row["user_id"], row["device"])

    def authenticate(self, token):
        with self.lock:
            row = self.db.execute("SELECT s.* FROM sessions s JOIN users u ON s.user_id=u.id "
                                  "WHERE token_hash=? AND expires>? AND u.active=1",
                                  (digest(token), time.time())).fetchone()
            return dict(row) if row else None

    def logout(self, token):
        with self.lock, self.db:
            self.db.execute("DELETE FROM sessions WHERE token_hash=?", (digest(token),))

    def accept_turn(self, user_id, turn_id, body):
        with self.lock, self.db:
            if self.db.execute("SELECT 1 FROM turns WHERE user_id=? AND turn_id=?", (user_id, turn_id)).fetchone():
                return False
            self._capacity()
            recent = self.db.execute("SELECT COUNT(*) FROM turns WHERE user_id=? AND created>?",
                                     (user_id, time.time() - 60)).fetchone()[0]
            if recent >= 12:
                raise ValueError("rate_limit")
            self.db.execute("INSERT INTO turns VALUES(?,?,?)", (user_id, turn_id, time.time()))
            self._append(body)
            return True

    def _capacity(self):
        if self.db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0] >= self.outbox_limit:
            raise ValueError("log_outbox_full")

    def _append(self, body):
        self.db.execute("INSERT INTO outbox(body) VALUES(?)", (json.dumps(body, ensure_ascii=False),))

    def log(self, body):
        with self.lock, self.db:
            self._capacity()
            self._append(body)

    def next_logs(self, limit=32):
        with self.lock:
            return [{"delivery_id": row["id"], **json.loads(row["body"])} for row in
                    self.db.execute("SELECT * FROM outbox ORDER BY id LIMIT ?", (limit,)).fetchall()]

    def ack(self, delivery_id):
        with self.lock, self.db:
            self.db.execute("DELETE FROM outbox WHERE id=?", (delivery_id,))

    def close(self):
        with self.lock:
            self.db.close()
