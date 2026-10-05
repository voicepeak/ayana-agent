"""User-owned topics; independent of the process session, model and foreground app."""
from __future__ import annotations

from copy import deepcopy
import time
import uuid


class Conversations:
    def __init__(self, store, persist=True):
        self.store, self.persist = store, persist
        self.records = {c["conversation_id"]: c for c in store.records("conversation", 100000)} if persist else {}
        self.live = {}
        saved = store.get_record("conversation-state", "active") if persist else None
        self.current_id = saved.get("conversation_id") if saved else None
        if self.current_id not in self.records:
            self.current_id = next(iter(self.records), None)
        if not self.current_id:
            record = self.create()
            if persist and store.migrate_conversation(record["conversation_id"]):
                record["title"] = "之前的对话"
                record["auto_title"] = False
                self.save()

    @property
    def current(self):
        return self.records[self.current_id]

    def save(self):
        if self.persist:
            self.store.put_record("conversation", self.current_id, self.current)
            self.store.put_record("conversation-state", "active", {"conversation_id": self.current_id})

    def create(self):
        now = time.time()
        cid = "chat-" + uuid.uuid4().hex[:12]
        record = {"conversation_id": cid, "title": "新话题", "auto_title": True,
                  "preview": "", "created": now, "updated": now, "repository_root": None}
        self.records[cid] = record
        self.live[cid] = {}
        self.current_id = cid
        self.save()
        return record

    def select(self, cid):
        if cid not in self.records:
            raise ValueError("找不到这个话题")
        self.current_id = cid
        self.current["updated"] = time.time()
        self.save()

    def rename(self, title):
        if not isinstance(title, str) or not 1 <= len(title.strip()) <= 60:
            raise ValueError("话题名称需要 1–60 字")
        self.current.update(title=title.strip(), auto_title=False)
        self.save()

    def observe(self, event):
        cid = event.get("conversation_id")
        if cid not in self.records:
            return
        kind = event["type"]
        records = self.live.setdefault(cid, {})
        if kind == "user.message":
            c = self.records[cid]
            if c["auto_title"]:
                c.update(title=" ".join(event["text"].split())[:24], auto_title=False)
            c.update(preview=event["text"][:240], updated=time.time())
            records[event["turn_id"]] = {"id": event["seq"], "role": "user", "text": event["text"],
                                         "created": time.time(), "turn_id": event["turn_id"]}
        elif kind == "utterance.ready":
            records[event["utterance_id"]] = {"id": event["seq"], "role": "assistant",
                "utterance_id": event["utterance_id"], "speech_ja": event["speech_ja"], "display_zh": "",
                "status": "generated", "displayed": False, "turn_id": event["turn_id"], "created": time.time(),
                "generation_id": event["generation_id"]}
        elif kind == "generation.cancelled":
            for item in records.values():
                if item.get("generation_id") == event.get("cancelled_generation_id") and item.get("status") in {"generated", "playing"}:
                    item["status"] = "partial" if item["status"] == "playing" else "cancelled"
        elif (item := records.get(event.get("utterance_id"))):
            if kind == "subtitle.ready":
                item["display_zh"] = event["display_zh"]
            elif kind == "utterance.displayed":
                item["displayed"] = True
            elif kind in {"playback.started", "playback.progress", "playback.ended", "playback.cancelled"}:
                item.update(status={"playback.started": "playing", "playback.progress": "playing",
                                    "playback.ended": "played", "playback.cancelled": "partial"}[kind],
                            displayed=True, played_samples=event.get("played_samples", 0),
                            total_samples=event.get("total_samples", 0), sample_rate=event.get("sample_rate", 0))
        # Saved records are read from SQLite; keep only recent live receipts in RAM.
        if self.persist:
            while len(records) > 200:
                records.pop(next(iter(records)))

    def snapshot(self):
        return {"current": deepcopy(self.current), "conversations": deepcopy(sorted(
            self.records.values(), key=lambda c: c["updated"], reverse=True)), "persistent": self.persist}

    def history(self, cid, before=None):
        if cid not in self.records:
            raise ValueError("找不到这个话题")
        if self.persist:
            return self.store.conversation_history(cid, before)
        items = [item for item in self.live.get(cid, {}).values() if before is None or item["id"] < before]
        page = items[-100:]
        return {"items": deepcopy(page), "has_more": len(items) > 100, "before": page[0]["id"] if page else None}
