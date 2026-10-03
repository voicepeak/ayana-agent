"""Optional installed Japanese Windows voice; never substitutes another language."""

from __future__ import annotations

import array
import base64
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import wave

from .sovits import SynthesisCancelled


class SystemEngine:
    name = "windows-japanese"

    def __init__(self, config: dict):
        self.config = config
        self.metadata = {"engine": self.name}

    def prepare(self):
        if os.name != "nt":
            raise RuntimeError("Installed Japanese system voice requires Windows")
        # Verify presence by producing the actual warmup in the worker.

    def synthesize(self, text: str, cancellation: threading.Event) -> dict:
        started = time.perf_counter()
        if cancellation.is_set():
            raise SynthesisCancelled("Generation cancelled")
        with tempfile.TemporaryDirectory(prefix="ayana-tts-") as directory:
            wav_path = Path(directory) / "speech.wav"
            env = dict(os.environ, AYANA_TTS_TEXT=text)
            process = subprocess.Popen([
                "powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                "-File", str(Path(__file__).with_suffix(".ps1")), "-WavPath", str(wav_path),
            ], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
               creationflags=subprocess.CREATE_NO_WINDOW)
            while process.poll() is None:
                if cancellation.wait(0.03):
                    process.terminate()
                    process.communicate(timeout=10)
                    raise SynthesisCancelled("Generation cancelled")
                if time.perf_counter() - started > 60:
                    process.kill()
                    process.communicate(timeout=10)
                    raise TimeoutError("Japanese system speech synthesis timed out")
            stdout, stderr = process.communicate()
            if process.returncode:
                raise RuntimeError(stderr.decode("utf-8", "replace")[-2500:])
            with wave.open(str(wav_path), "rb") as wav:
                rate, channels = wav.getframerate(), wav.getnchannels()
                if wav.getsampwidth() != 2:
                    raise ValueError("System voice must produce PCM16 WAV")
                values = array.array("h", wav.readframes(wav.getnframes()))
                if sys.byteorder != "little":
                    values.byteswap()
            samples = array.array("f", (
                sum(values[index:index + channels]) / (32768 * channels)
                for index in range(0, len(values), channels)))
            sample_count = len(samples)
            if not sample_count:
                raise ValueError("System voice returned empty audio")
            if sys.byteorder != "little":
                samples.byteswap()
            self.metadata.update({"voice": stdout.decode("utf-8", "replace").strip(), "sample_rate": rate})
            return {
                "sample_rate": rate, "channels": 1, "format": "pcm_f32le",
                "sample_count": sample_count,
                "pcm_base64": base64.b64encode(samples.tobytes()).decode("ascii"),
                "duration_ms": sample_count * 1000 / rate,
                "engine": self.name,
                "synthesis_ms": (time.perf_counter() - started) * 1000,
            }
