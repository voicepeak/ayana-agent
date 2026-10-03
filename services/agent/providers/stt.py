"""Explicit hold-to-talk transcription with an isolated local CPU worker.

Configuration (all optional unless using the remote provider)::

    {"provider": "local", "model": "tiny", "language": "auto",
     "cpu_threads": 2, "max_seconds": 60, "max_bytes": 8388608,
     "startup_timeout": 180, "transcribe_timeout": 90,
     "local_files_only": false, "model_path": "", "model_root": ".runtime/models"}

Remote upload requires provider="openai", an explicit HTTPS/loopback base_url,
an explicit model, and AYANA_STT_API_KEY in the agent process environment.
There is no remote fallback when local recognition fails. Model downloads and
their cache defaults to this project's .runtime/models directory; a packaged
app supplies its writable user-data model_root and uses bundled weights first.
Install the optional faster-whisper dependency for local audio recognition.
"""
from __future__ import annotations

import asyncio
import base64
import binascii
import importlib.util
import io
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import time
from urllib.parse import urlparse
import wave

import httpx


PROJECT = Path(__file__).resolve().parents[3]
MIME_EXTENSIONS = {"audio/wav": ".wav", "audio/x-wav": ".wav", "audio/webm": ".webm",
                   "audio/ogg": ".ogg", "audio/mpeg": ".mp3", "audio/mp4": ".m4a"}


class SttError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def decode_payload(audio_base64: str, mime_type: str, max_bytes: int) -> tuple[bytes, str]:
    if not isinstance(mime_type, str):
        raise SttError("invalid_audio", "Audio MIME type must be a string")
    mime = mime_type.partition(";")[0].strip().lower()
    if mime not in MIME_EXTENSIONS:
        raise SttError("unsupported_audio", "Supported microphone formats are WAV, WebM, Ogg, MP3 and MP4")
    if not isinstance(audio_base64, str) or not audio_base64:
        raise SttError("empty_audio", "Microphone recording is empty")
    if len(audio_base64) > 4*((max_bytes+2)//3):
        raise SttError("audio_too_large", "Microphone recording exceeds the size limit")
    try:
        raw = base64.b64decode(audio_base64, validate=True)
    except (ValueError, binascii.Error):
        raise SttError("invalid_audio", "Microphone recording is not valid base64")
    if not raw:
        raise SttError("empty_audio", "Microphone recording is empty")
    if len(raw) > max_bytes:
        raise SttError("audio_too_large", "Microphone recording exceeds the size limit")
    signature_ok = {
        ".wav": len(raw) >= 12 and raw[:4] == b"RIFF" and raw[8:12] == b"WAVE",
        ".webm": raw.startswith(b"\x1a\x45\xdf\xa3"),
        ".ogg": raw.startswith(b"OggS"),
        ".mp3": raw.startswith(b"ID3") or (len(raw) >= 2 and raw[0] == 255 and raw[1] & 0xE0 == 0xE0),
        ".m4a": len(raw) >= 12 and raw[4:8] == b"ftyp",
    }[MIME_EXTENSIONS[mime]]
    if not signature_ok:
        raise SttError("invalid_audio", "Recording contents do not match the declared audio format")
    return raw, mime


def validate_audio(raw: bytes, mime: str, max_seconds: float) -> float:
    """Decode bounded, in-memory input; do not trust container duration alone."""
    if MIME_EXTENSIONS[mime] == ".wav":
        try:
            with wave.open(io.BytesIO(raw), "rb") as source:
                channels, rate, width, frames = source.getnchannels(), source.getframerate(), source.getsampwidth(), source.getnframes()
                if channels not in (1, 2) or not 8000 <= rate <= 192000 or width not in (1, 2, 3, 4):
                    raise SttError("unsupported_audio", "WAV must contain ordinary mono or stereo PCM audio")
                duration = frames/rate
                if duration > max_seconds:
                    raise SttError("audio_too_long", "Microphone recording exceeds the duration limit")
                if len(source.readframes(frames)) != frames*channels*width:
                    raise SttError("invalid_audio", "WAV recording is truncated")
        except (wave.Error, EOFError, OSError):
            raise SttError("invalid_audio", "Cannot decode WAV recording")
    else:
        if not importlib.util.find_spec("av"):
            raise SttError("decoder_unavailable", "Install the speech extra (PyAV) to decode this microphone format")
        import av
        try:
            with av.open(io.BytesIO(raw), mode="r") as container:
                if not container.streams.audio:
                    raise SttError("invalid_audio", "Recording contains no audio stream")
                stream = container.streams.audio[0]
                if stream.duration and stream.time_base and float(stream.duration*stream.time_base) > max_seconds+1:
                    raise SttError("audio_too_long", "Microphone recording exceeds the duration limit")
                duration = 0.0
                for frame in container.decode(stream):
                    if frame.sample_rate <= 0:
                        raise SttError("invalid_audio", "Recording has an invalid sample rate")
                    duration += frame.samples/frame.sample_rate
                    if duration > max_seconds:
                        raise SttError("audio_too_long", "Microphone recording exceeds the duration limit")
        except SttError:
            raise
        except Exception:
            raise SttError("invalid_audio", "Cannot decode the microphone recording")
    if not math.isfinite(duration) or duration < .15:
        raise SttError("audio_too_short", "Hold the microphone button for at least 150 milliseconds")
    return duration


class SttService:
    def __init__(self, config: dict | None = None, *, client: httpx.AsyncClient | None = None):
        self.config = dict(config or {})
        self.provider = self.config.get("provider", "local")
        self._status = {"state": "stopped", "ready": False, "provider": self.provider,
                        "model": self.config.get("model", "tiny" if self.provider == "local" else ""), "detail": ""}
        self._process = None
        self._client = client
        self._owned_client = client is None
        self._start_lock, self._operation_lock = asyncio.Lock(), asyncio.Lock()
        self._closed = False
        self.max_bytes = max(1024, min(int(self.config.get("max_bytes", 8*1024*1024)), 20*1024*1024))
        self.max_seconds = max(.15, min(float(self.config.get("max_seconds", 60)), 120))
        self.timeout = max(1, min(float(self.config.get("transcribe_timeout", 90)), 300))

    @property
    def status(self):
        return dict(self._status)

    def _worker_config(self):
        model_root = Path(self.config.get("model_root") or PROJECT/".runtime"/"models").resolve()
        cache = model_root/"stt"
        cache.mkdir(parents=True, exist_ok=True)
        worker_cfg = {key: self.config[key] for key in ("model", "model_path", "local_files_only", "cpu_threads", "language") if key in self.config}
        name = str(self.config.get("model", "tiny"))
        # Source-local, pre-downloaded files are selected by the worker. An
        # installed package prefers its shipped read-only model directory.
        bundled = PROJECT/"models"/"stt"/name
        if not worker_cfg.get("model_path") and (bundled/"model.bin").is_file():
            worker_cfg["model_path"] = str(bundled)
        worker_cfg.update(cache_dir=str(cache), max_seconds=self.max_seconds)
        env = dict(os.environ)
        env["HF_HOME"] = str(model_root/"huggingface")
        env["HF_HUB_DISABLE_XET"] = "1"
        env["OMP_NUM_THREADS"] = str(max(1, min(int(self.config.get("cpu_threads", 2)), 8)))
        return worker_cfg, env

    async def start(self):
        async with self._start_lock:
            if self._closed or self._status["ready"]:
                return self.status
            self._status.update(state="loading", ready=False, detail="")
            try:
                if self.provider == "disabled":
                    raise SttError("disabled", "Voice input is disabled in settings")
                if self.provider == "openai":
                    parsed = urlparse(str(self.config.get("base_url", "")))
                    if not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
                        raise SttError("configuration", "Set an explicit STT API base URL without embedded credentials")
                    if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost", "::1"}):
                        raise SttError("configuration", "STT API requires HTTPS or a local loopback endpoint")
                    if not self.config.get("model") or not os.environ.get("AYANA_STT_API_KEY"):
                        raise SttError("configuration", "Set an STT model and AYANA_STT_API_KEY before remote voice input")
                    if self._client is None:
                        self._client = httpx.AsyncClient(timeout=httpx.Timeout(self.timeout, connect=12), trust_env=False)
                elif self.provider == "local":
                    if not importlib.util.find_spec("faster_whisper"):
                        raise SttError("dependency_unavailable", "Install the speech extra: pip install faster-whisper==1.2.1")
                    worker_cfg, env = self._worker_config()
                    options = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
                    flags = ["-I", "-X", "utf8"] if sys.flags.isolated else ["-X", "utf8"]
                    self._process = await asyncio.create_subprocess_exec(
                        sys.executable, *flags, "-m", "services.agent.providers.stt", "--worker",
                        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.DEVNULL, cwd=str(PROJECT), env=env,
                        limit=2*self.max_bytes, **options)
                    self._process.stdin.write((json.dumps(worker_cfg)+"\n").encode())
                    await self._process.stdin.drain()
                    ready = await asyncio.wait_for(self._read_worker(), timeout=float(self.config.get("startup_timeout", 180)))
                    if not ready.get("ready"):
                        raise SttError("model_unavailable", ready.get("error", "Local speech model could not load"))
                    self._status.update(model=ready["model"], device="cpu", compute_type="int8", cpu_threads=ready["cpu_threads"])
                else:
                    raise SttError("configuration", "STT provider must be local, openai or disabled")
                self._status.update(state="ready", ready=True)
            except asyncio.CancelledError:
                await self._stop_worker()
                self._status.update(state="stopped", ready=False)
                raise
            except Exception as exc:
                await self._stop_worker()
                self._status.update(state="unavailable", ready=False, detail=str(exc))
            return self.status

    async def _read_worker(self):
        if not self._process or not self._process.stdout:
            raise SttError("worker_unavailable", "Local transcription worker is unavailable")
        line = await self._process.stdout.readline()
        if not line:
            raise SttError("worker_exited", "Local transcription worker exited")
        try:
            return json.loads(line)
        except (json.JSONDecodeError, UnicodeError):
            raise SttError("worker_protocol", "Local transcription worker returned invalid data")

    async def transcribe(self, audio_base64: str, mime_type: str = "audio/webm") -> str:
        if self._closed:
            raise SttError("closed", "Voice input service is closed")
        raw, mime = decode_payload(audio_base64, mime_type, self.max_bytes)
        duration = await asyncio.to_thread(validate_audio, raw, mime, self.max_seconds)
        # A lock bounds the service to one recognition at a time. The runtime
        # owns generation IDs and discards results from cancelled generations.
        async with self._operation_lock:
            if self._closed:
                raise SttError("closed", "Voice input service is closed")
            if not self._status["ready"]:
                await self.start()
            if not self._status["ready"]:
                raise SttError("unavailable", self._status["detail"])
            started = time.monotonic()
            self._status.update(state="transcribing", ready=True)
            try:
                if self.provider == "openai":
                    fields = {"model": str(self.config["model"]), "response_format": "json"}
                    language = self.config.get("language", "auto")
                    if language != "auto": fields["language"] = str(language)
                    response = await self._client.post(
                        str(self.config["base_url"]).rstrip("/")+"/audio/transcriptions",
                        headers={"Authorization": f"Bearer {os.environ.get('AYANA_STT_API_KEY', '')}"},
                        data=fields, files={"file": ("microphone"+MIME_EXTENSIONS[mime], raw, mime)})
                    if response.status_code >= 400:
                        raise SttError("remote_failed", f"STT API returned HTTP {response.status_code}")
                    try:
                        text = response.json()["text"]
                    except (KeyError, ValueError, TypeError):
                        raise SttError("remote_protocol", "STT API returned no valid transcript")
                else:
                    self._process.stdin.write((json.dumps({"audio_base64": audio_base64})+"\n").encode())
                    await self._process.stdin.drain()
                    result = await asyncio.wait_for(self._read_worker(), timeout=self.timeout)
                    if result.get("error"):
                        raise SttError("transcription_failed", result["error"])
                    text = result.get("text")
                if not isinstance(text, str) or not text.strip():
                    raise SttError("no_speech", "No speech was recognized; try recording again")
                if len(text) > 12000:
                    raise SttError("transcript_too_long", "Recognized text exceeds the input limit")
                self._status.update(last_duration_s=duration, last_transcribe_s=time.monotonic()-started)
                return text.strip()
            except (asyncio.TimeoutError, asyncio.CancelledError):
                # Killing a stalled/cancelled local worker prevents its late
                # response from being mistaken for the next recording.
                await self._stop_worker()
                self._status.update(ready=False, state="stopped")
                raise
            finally:
                if self._status["ready"]:
                    self._status["state"] = "ready"

    async def _stop_worker(self):
        process, self._process = self._process, None
        if process and process.returncode is None:
            if process.stdin:
                process.stdin.close()
            try: await asyncio.wait_for(process.wait(), .5)
            except asyncio.TimeoutError:
                if os.name == "nt":
                    # sys.executable may be a venv launcher. Terminating only
                    # that parent leaves its inference interpreter orphaned.
                    def kill_tree():
                        try:
                            subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                           creationflags=subprocess.CREATE_NO_WINDOW, timeout=5, check=False)
                        except (OSError, subprocess.TimeoutExpired):
                            pass
                    await asyncio.to_thread(kill_tree)
                try: process.kill()
                except ProcessLookupError: pass
                await asyncio.wait_for(process.wait(), 3)

    async def close(self):
        self._closed = True
        await self._stop_worker()
        if self._client and self._owned_client:
            await self._client.aclose()
        self._status.update(state="closed", ready=False)


def _worker():
    """Only this child process imports inference libraries and holds a model."""
    def emit(value):
        print(json.dumps(value, ensure_ascii=True), flush=True)
    try:
        config = json.loads(sys.stdin.readline())
        from faster_whisper import WhisperModel
        name = config.get("model", "tiny")
        cache = Path(config["cache_dir"])
        local = config.get("model_path") or (str(cache/name) if (cache/name/"model.bin").exists() else name)
        cpu_threads = max(1, min(int(config.get("cpu_threads", 2)), 8))
        model = WhisperModel(local, device="cpu", compute_type="int8", cpu_threads=cpu_threads,
                             num_workers=1, download_root=str(cache), local_files_only=bool(config.get("local_files_only", False)))
        emit({"ready": True, "model": name, "cpu_threads": cpu_threads})
    except Exception:
        emit({"ready": False, "error": "Could not load local Whisper weights. Check the speech extra, model path, cache and download connection."})
        return
    for line in sys.stdin:
        try:
            message = json.loads(line)
            audio = io.BytesIO(base64.b64decode(message["audio_base64"], validate=True))
            language = config.get("language", "auto")
            if language == "auto": language = None
            segments, info = model.transcribe(audio, language=language, task="transcribe", beam_size=3,
                                              condition_on_previous_text=False, vad_filter=True,
                                              vad_parameters={"min_silence_duration_ms": 400})
            text = "".join(segment.text for segment in segments if segment.no_speech_prob < .85 and segment.avg_logprob > -1.5)
            emit({"text": text.strip(), "language": info.language})
        except Exception:
            emit({"error": "Local speech recognition failed for this recording"})


if __name__ == "__main__" and "--worker" in sys.argv:
    _worker()
