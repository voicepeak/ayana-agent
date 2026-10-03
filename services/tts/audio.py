"""PCM normalization and boundary conditioning, independent from the UI player."""

from __future__ import annotations

import base64
import re


def split_sentences(text: str, max_chars: int = 24) -> list[str]:
    """Keep punctuation and every character; do not silently drop a failed chunk."""
    text = re.sub(r"\s+", "", text).strip()
    if not text:
        raise ValueError("Cannot synthesize empty text")
    if not 8 <= max_chars <= 120:
        raise ValueError("max_chars must be between 8 and 120")
    chunks: list[str] = []
    for sentence in re.split(r"(?<=[。！？!?；;])", text):
        buffer = ""
        for part in re.split(r"(?<=[、，,：:])", sentence):
            if not part:
                continue
            if buffer and len(buffer) + len(part) > max_chars:
                chunks.append(buffer)
                buffer = ""
            while len(part) > max_chars:
                if buffer:
                    chunks.append(buffer)
                    buffer = ""
                chunks.append(part[:max_chars])
                part = part[max_chars:]
            buffer += part
        if buffer:
            chunks.append(buffer)
    return chunks


def condition_pcm(audio, sample_rate: int, *, tail_padding_ms: float = 300,
                  pause_ms: float = 70, lowpass_hz: float = 15000):
    """Remove only the known engine padding; retain naturally generated pauses."""
    import numpy as np

    if not 8000 <= sample_rate <= 192000:
        raise ValueError("Unsupported sample rate")
    source = np.asarray(audio)
    if source.ndim == 2:
        source = source.mean(axis=1)
    if source.ndim != 1 or not source.size:
        raise ValueError("Engine returned empty or malformed audio")
    if source.dtype == np.int16:
        pcm = source.astype(np.float32) / 32768
    elif source.dtype == np.int32:
        pcm = source.astype(np.float32) / 2147483648
    else:
        pcm = source.astype(np.float32)
    if not np.isfinite(pcm).all():
        raise ValueError("Engine returned nonfinite samples")
    padding = int(sample_rate * tail_padding_ms / 1000)
    if padding > 0 and pcm.size > padding:
        # Padding belongs to the adapter, not silence inferred from voice energy.
        pcm = pcm[:-padding]
    if lowpass_hz and lowpass_hz < sample_rate / 2 and pcm.size > 64:
        from scipy.signal import butter, sosfiltfilt
        pcm = sosfiltfilt(butter(6, lowpass_hz, fs=sample_rate, output="sos"), pcm)
    peak = float(np.max(np.abs(pcm)))
    if peak > 1:
        pcm = pcm / peak
    # Small fades only at the waveform edges, not across phonemes.
    ramp_count = min(int(sample_rate * 0.004), pcm.size // 2)
    if ramp_count:
        ramp = np.linspace(0, 1, ramp_count, dtype=np.float32)
        pcm[:ramp_count] *= ramp
        pcm[-ramp_count:] *= ramp[::-1]
    pause_count = max(0, int(sample_rate * pause_ms / 1000))
    if pause_count:
        pcm = np.concatenate([pcm, np.zeros(pause_count, dtype=np.float32)])
    return np.clip(pcm, -1, 1).astype("<f4")


def encode_pcm(audio, sample_rate: int, engine: str) -> dict:
    import numpy as np

    pcm = np.asarray(audio, dtype="<f4")
    if pcm.ndim != 1 or not np.isfinite(pcm).all():
        raise ValueError("PCM must contain finite mono samples")
    return {
        "sample_rate": sample_rate,
        "channels": 1,
        "format": "pcm_f32le",
        "sample_count": int(pcm.size),
        "pcm_base64": base64.b64encode(pcm.tobytes()).decode("ascii"),
        "duration_ms": pcm.size * 1000 / sample_rate,
        "engine": engine,
    }
