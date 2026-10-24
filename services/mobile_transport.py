"""Versioned, self-describing audio frames; no desktop runtime imports."""
from __future__ import annotations

import json
import struct

MAX_AUDIO_BYTES = 16 * 1024 * 1024


def audio_frame(metadata: dict, pcm: bytes) -> bytes:
    header = json.dumps({**metadata, "protocol_version": 1, "byte_length": len(pcm)},
                        ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(header) > 8192 or len(pcm) > MAX_AUDIO_BYTES:
        raise ValueError("Audio frame exceeds budget")
    return struct.pack("<I", len(header)) + header + pcm


def read_audio_frame(frame: bytes) -> tuple[dict, bytes]:
    if len(frame) < 4 or len(frame) > MAX_AUDIO_BYTES + 8196:
        raise ValueError("Invalid audio frame size")
    size, = struct.unpack("<I", frame[:4])
    if not 1 <= size <= 8192 or len(frame) < size + 4:
        raise ValueError("Invalid audio header")
    metadata = json.loads(frame[4:4 + size])
    pcm = frame[4 + size:]
    if (not isinstance(metadata, dict) or metadata.get("protocol_version") != 1
            or metadata.get("byte_length") != len(pcm)
            or metadata.get("format") != "pcm_s16le" or len(pcm) % 2
            or metadata.get("sample_count") != len(pcm) // 2
            or metadata.get("channels") != 1
            or type(metadata.get("sample_rate")) is not int
            or not 8000 <= metadata["sample_rate"] <= 192000):
        raise ValueError("Invalid audio metadata")
    return metadata, pcm
