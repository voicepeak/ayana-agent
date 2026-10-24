"""PCM conversions used by bandwidth-constrained clients."""

from __future__ import annotations

import base64
import math
import sys
from array import array


def f32le_base64_to_s16le_bytes(encoded: str) -> bytes:
    if not isinstance(encoded, str) or not encoded:
        return b""
    raw = base64.b64decode(encoded, validate=True)
    if len(raw) % 4:
        raise ValueError("PCM payload length must be a multiple of 4 bytes")
    try:
        import numpy as np
    except ImportError:
        samples = array("f")
        samples.frombytes(raw)
        if sys.byteorder != "little":
            samples.byteswap()
        pcm = array("h")
        for sample in samples:
            value = float(sample)
            if not math.isfinite(value):
                value = 0.0
            pcm.append(int(max(-1.0, min(1.0, value)) * 32767))
        if sys.byteorder != "little":
            pcm.byteswap()
        return pcm.tobytes()
    values = np.frombuffer(raw, dtype="<f4")
    values = np.nan_to_num(values, nan=0.0, posinf=1.0, neginf=-1.0)
    values = np.clip(values, -1.0, 1.0)
    return (values * 32767).astype("<i2").tobytes()


def f32le_base64_to_s16le_base64(encoded: str) -> str:
    return base64.b64encode(f32le_base64_to_s16le_bytes(encoded)).decode("ascii")
