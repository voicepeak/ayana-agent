from __future__ import annotations

from collections import Counter
import json
from pathlib import Path
import re
import sqlite3
import time


EVENT_LIMIT = 4000
TURN_LIMIT = 120
SECRET_FIELDS = {"api_key", "worker_token", "access_token", "refresh_token", "key_hash",
                 "token_hash", "refresh_hash", "pcm_base64", "pcm_bytes", "device_id", "session_id"}


def redact(value):
    if isinstance(value, dict):
        return {key: redact(item) for key, item in value.items() if key not in SECRET_FIELDS}
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, str):
        value = re.sub(r"ayana1\.[A-Za-z0-9_-]+", "[激活码已隐藏]", value)
        value = re.sub(r"\bsk-[A-Za-z0-9_-]{20,}", "[API Key 已隐藏]", value)
        return value
    return value


def read_rows(path, query, parameters=()):
    if not path.is_file():
        return [], "missing"
    try:
        db = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=.25)
        try:
            db.execute("PRAGMA query_only=ON")
            return db.execute(query, parameters).fetchall(), "ready"
        finally:
            db.close()
    except sqlite3.Error:
        return [], "unavailable"


def percentile(values, fraction):
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    return round(ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower))


class MonitorReader:
    def __init__(self, log_db: Path, gateway_db: Path, labels=None, clock=time.time):
        self.log_db, self.gateway_db = Path(log_db), Path(gateway_db)
        self.labels, self.clock = labels or {}, clock

    def events(self, hours):
        now = self.clock()
        persisted, logs_state = read_rows(self.log_db,
            "SELECT id,created,body FROM events ORDER BY rowid DESC LIMIT ?", (EVENT_LIMIT + 1,))
        outbox, gateway_state = read_rows(self.gateway_db,
            "SELECT id,body FROM outbox ORDER BY id DESC LIMIT ?", (EVENT_LIMIT + 1,))
        combined = {}
        cutoff = now - hours * 3600
        for delivery, body in outbox[:EVENT_LIMIT]:
            try:
                event = json.loads(body)
                created = float(event.get("timestamp", 0))
                if cutoff <= created <= now + 60:
                    identifier = str(event.get("event_id") or f"outbox:{delivery}")
                    combined[identifier] = {"id": identifier, "at": created, "event": redact(event)}
            except (ValueError, TypeError, AttributeError):
                continue
        for identifier, created, body in persisted[:EVENT_LIMIT]:
            try:
                event = json.loads(body)
                if not isinstance(event, dict) or not cutoff <= created <= now + 60:
                    continue
                key = str(event.get("event_id") or identifier)
                combined[key] = {"id": key, "at": created, "event": redact(event)}
            except (ValueError, TypeError):
                continue
        events = sorted(combined.values(), key=lambda row: (row["at"], row["id"]))
        source = {"logs": logs_state, "gateway": gateway_state,
                  "last_event_at": max((row["at"] for row in events), default=None),
                  "event_limit_reached": len(persisted) > EVENT_LIMIT or len(outbox) > EVENT_LIMIT,
                  "pending_delivery": len(outbox)}
        return events, source

    def users(self):
        rows, state = read_rows(self.gateway_db,
            "SELECT u.id,u.active,COUNT(DISTINCT s.device) FROM users u LEFT JOIN sessions s "
            "ON s.user_id=u.id AND s.refresh_expires>? GROUP BY u.id,u.active", (self.clock(),))
        return [{"id": uid, "label": self.labels.get(uid, "本机管理员" if uid == "owner" else uid),
                 "enabled": bool(active), "activated_devices": devices} for uid, active, devices in rows], state

    def turns(self, events):
        grouped = {}
        for row in events:
            event = row["event"]
            uid, tid = event.get("user_id"), event.get("turn_id")
            if uid and tid:
                grouped.setdefault((uid, tid), []).append(row)
        return [self.summarize(uid, tid, rows) for (uid, tid), rows in grouped.items()]

    def summarize(self, uid, tid, rows):
        now = self.clock()
        messages = [row for row in rows if row["event"].get("type") == "user.message"]
        start = messages[0]["at"] if messages else rows[0]["at"]
        incoming = messages[0]["event"] if messages else {}
        speeches, captions, audio = {}, {}, {}
        errors, finished = [], None
        first_text = first_translation = first_audio = None
        model_finished = None
        for row in rows:
            event, at = row["event"], row["at"]
            kind, sid = event.get("type"), str(event.get("utterance_id", ""))
            if kind == "utterance.ready":
                speeches[sid] = {"id": sid, "ja": str(event.get("speech_ja", "")),
                                 "audio_enabled": event.get("audio_enabled") is not False, "at": at}
                first_text = at if first_text is None else min(first_text, at)
            elif kind in {"subtitle.ready", "subtitle.translated"}:
                captions[sid] = str(event.get("display_zh", ""))
                first_translation = at if first_translation is None else min(first_translation, at)
            elif kind == "tts.completed":
                audio[sid] = {"synthesis_ms": event.get("synthesis_ms"), "duration_ms": event.get("duration_ms"), "at": at}
                first_audio = at if first_audio is None else min(first_audio, at)
            elif kind in {"model.failed", "tts.failed"}:
                errors.append({"type": kind, "code": str(event.get("code") or event.get("error_type") or kind), "at": at})
            elif kind == "turn.finished":
                finished, model_finished = str(event.get("state", "unknown")), at
        expected = {sid for sid, speech in speeches.items() if speech["audio_enabled"]}
        missing_audio = expected - set(audio)
        head = next((sid for sid, speech in speeches.items() if speech["audio_enabled"]), None)
        if head:
            first_audio = audio[head]["at"] if head in audio else None
        age = max(0, now - start)
        audio_ms = round(max(0, first_audio - start) * 1000) if first_audio is not None else None
        if any(error["type"] == "model.failed" for error in errors) or finished == "failed":
            status, severity = "failed", "error"
        elif errors:
            status, severity = "tts_failed", "error"
        elif finished == "cancelled":
            status, severity = "cancelled", "neutral"
        elif not finished:
            status, severity = ("unresolved", "warning") if age > 180 else ("model_wait_long", "warning") if age > 30 else ("thinking", "neutral")
        elif missing_audio:
            status, severity = ("unresolved", "warning") if age > 180 else ("audio_wait_long", "warning") if age > 30 else ("preparing_audio", "neutral")
        elif audio_ms is not None and audio_ms > 5000:
            status, severity = "slow_audio", "warning"
        else:
            status, severity = "complete", "good"
        for sid, speech in speeches.items():
            speech.update({"zh": captions.get(sid, ""), "audio": audio.get(sid)})
        topic = incoming.get("conversation_id") or next((row["event"].get("conversation_id") for row in rows if row["event"].get("conversation_id")), "")
        return {"id": tid, "user_id": uid, "conversation_id": str(topic), "started_at": start,
                "last_at": max(row["at"] for row in rows), "text": str(incoming.get("text", "[本轮较早消息不在读取窗口]")),
                "status": status, "severity": severity, "model_state": finished, "age_seconds": round(age),
                "first_text_ms": round(max(0, first_text - start) * 1000) if first_text is not None else None,
                "translation_ms": round(max(0, first_translation - start) * 1000) if first_translation is not None else None,
                "first_audio_ms": audio_ms, "model_ms": round(max(0, model_finished - start) * 1000) if model_finished is not None else None,
                "speeches": list(speeches.values()), "audio_expected": len(expected), "audio_completed": len(set(audio) & expected),
                "errors": errors, "event_count": len(rows), "record_incomplete": not bool(messages)}

    def snapshot(self, user_id="", conversation_id="", hours=24, include_inactive=False, issues_only=False):
        events, source = self.events(hours)
        users, users_state = self.users()
        source["users"] = users_state
        known = {user["id"]: user for user in users}
        # If the identity database is temporarily unavailable, show observed IDs
        # without guessing whether those accounts remain enabled.
        if users_state != "ready":
            for row in events:
                uid = row["event"].get("user_id")
                if uid and uid not in known:
                    known[uid] = {"id": uid, "label": self.labels.get(uid, uid), "enabled": None, "activated_devices": None}
            users = list(known.values())
        permitted = {uid for uid, user in known.items() if include_inactive or user["enabled"] is not False}
        all_turns = [turn for turn in self.turns(events) if turn["user_id"] in permitted]
        for user in users:
            items = [turn for turn in all_turns if turn["user_id"] == user["id"]]
            user.update({"requests": len(items), "attention": sum(t["severity"] in {"warning", "error"} for t in items),
                         "last_request_at": max((t["started_at"] for t in items), default=None)})
        users = [user for user in users if user["id"] in permitted]
        users.sort(key=lambda user: (user["id"] == "owner", user["label"]))
        selected = [turn for turn in all_turns if not user_id or turn["user_id"] == user_id]
        topic_map = {}
        for turn in sorted(selected, key=lambda turn: turn["started_at"]):
            if turn["conversation_id"]:
                topic_map.setdefault(turn["conversation_id"], turn["text"][:32])
        if conversation_id:
            selected = [turn for turn in selected if turn["conversation_id"] == conversation_id]
        values = [turn["first_audio_ms"] for turn in selected if turn["first_audio_ms"] is not None]
        summary = {"accounts": len(users), "requests": len(selected), "failed": sum(t["severity"] == "error" for t in selected),
                   "attention": sum(t["severity"] in {"warning", "error"} for t in selected),
                   "audio_p50_ms": percentile(values, .5), "audio_p95_ms": percentile(values, .95),
                   "audio_samples": len(values), "completed": sum(t["status"] in {"complete", "slow_audio"} for t in selected)}
        recent_audio = [{"at": turn["started_at"], "ms": turn["first_audio_ms"], "id": turn["id"]}
                        for turn in sorted(selected, key=lambda turn: turn["started_at"]) if turn["first_audio_ms"] is not None][-24:]
        if issues_only:
            selected = [turn for turn in selected if turn["severity"] in {"warning", "error"}]
        selected.sort(key=lambda turn: turn["started_at"], reverse=True)
        return {"now": self.clock(), "source": source, "users": users, "topics": [{"id": tid, "title": title} for tid, title in topic_map.items()],
                "summary": summary, "audio_trend": recent_audio, "turns": selected[:TURN_LIMIT],
                "turn_limit_reached": len(selected) > TURN_LIMIT, "window_hours": hours,
                "limitations": ["完整系统提示词、手机称呼及本机记忆未采集。", "合成完成不代表手机已经实际出声或听完。",
                                "等待告警为日志推断；缺少后续记录也可能由主动打断、断网或日志延后造成。"]}

    def detail(self, user_id, turn_id, hours=24):
        events, _ = self.events(hours)
        matching = [row for row in events if row["event"].get("user_id") == user_id and row["event"].get("turn_id") == turn_id]
        if not matching:
            return None
        return {"turn": self.summarize(user_id, turn_id, matching), "events": matching}
