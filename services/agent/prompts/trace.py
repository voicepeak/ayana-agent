"""Bounded in-memory request snapshots; exported only through authenticated debug access."""
from collections import deque
from copy import deepcopy
from datetime import datetime
import hashlib


def export_body(body):
    def clean(value):
        if isinstance(value, dict):
            return {key: clean(item) for key, item in value.items()
                    if key.lower() not in {"authorization", "api_key", "api-key"}}
        if isinstance(value, list):
            return [clean(item) for item in value]
        if isinstance(value, str) and value.startswith("data:image/"):
            return {"omitted": "image data", "characters": len(value),
                    "sha256": hashlib.sha256(value.encode()).hexdigest()}
        return value
    return clean(deepcopy(body))


class PromptTrace:
    def __init__(self, limit=12):
        self.requests = deque(maxlen=limit)

    def record(self, body, *, phase, turn_id=None, conversation_id=None):
        self.requests.append({"at": datetime.now().astimezone().isoformat(timespec="seconds"),
                              "phase": phase, "turn_id": turn_id, "conversation_id": conversation_id,
                              "body": export_body(body)})

    def export(self):
        return {"format": "ayana.prompt-trace.v1", "images": "metadata only; image bytes omitted",
                "requests": deepcopy(list(self.requests))}

    def clear(self):
        self.requests.clear()
