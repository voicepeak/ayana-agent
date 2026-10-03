"""Validate closed model objects before they can reach speech or tools."""
from __future__ import annotations

import json
import math
import re

PROTOCOL_VERSION = 1
INTENTS = {"acknowledge", "explain", "encourage", "caution", "playful"}
AFFECTS = {"neutral", "pleased", "concerned", "surprised"}


def validate_speech(value: dict) -> dict:
    text = value.get("speech_ja")
    if not isinstance(text, str) or not text.strip() or len(text) > 240:
        raise ValueError("speech_ja must be a complete short Japanese sentence (1–240 characters)")
    text = text.strip()
    if not re.search(r"[\u3040-\u30ff]", text):
        raise ValueError("speech_ja must contain Japanese speech")
    if re.search(r"```|https?://|<[^>]+>|\{\s*\"|[A-Za-z]:[\\/]", text):
        raise ValueError("Code, paths, URLs and tags belong in evidence, not speech")
    if text[-1] not in "。！？!?…」』":
        raise ValueError("Only complete sentences may be committed")
    intensity = value.get("intensity", 0.25)
    if isinstance(intensity, bool) or not isinstance(intensity, (int, float)) or not math.isfinite(intensity):
        intensity = 0.25
    return {"speech_ja": text, "intent": value.get("intent") if value.get("intent") in INTENTS else "explain",
            "affect": value.get("affect") if value.get("affect") in AFFECTS else "neutral",
            "intensity": max(0, min(1, intensity))}


class SpeechParser:
    """Incremental JSON decoder, handling arrays and NDJSON without regex slicing."""
    def __init__(self):
        self.buffer = ""
        self.decoder = json.JSONDecoder()
        self.array_open = False
        self.finished = False

    def feed(self, chunk: str) -> list[dict]:
        if self.finished and chunk.strip():
            raise ValueError("Content after the event array")
        self.buffer += chunk
        if len(self.buffer) > 65536:
            raise ValueError("Model event exceeds size budget")
        out = []
        while True:
            self.buffer = self.buffer.lstrip()
            if not self.buffer:
                break
            if self.buffer.startswith("[") and not self.array_open:
                self.array_open = True
                self.buffer = self.buffer[1:]
                continue
            if self.array_open and self.buffer.startswith(","):
                self.buffer = self.buffer[1:]
                continue
            if self.array_open and self.buffer.startswith("]"):
                self.buffer = self.buffer[1:]
                self.finished = True
                if self.buffer.strip():
                    raise ValueError("Content after event array")
                break
            try:
                obj, end = self.decoder.raw_decode(self.buffer)
            except json.JSONDecodeError:
                break
            if not isinstance(obj, dict):
                raise ValueError("Model events must be JSON objects")
            out.append(obj)
            self.buffer = self.buffer[end:]
        return out

    def finish(self):
        if self.buffer.strip() or (self.array_open and not self.finished):
            raise ValueError("Model output was truncated or malformed; no partial speech committed")
