"""One resident inference thread with a responsive JSON-line control channel."""

from __future__ import annotations

import json
import faulthandler
from pathlib import Path
import queue
import sys
import threading
import time
import traceback

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from services.tts.adapters.sovits import SovitsEngine, SynthesisCancelled

PROTOCOL = sys.stdout
# The upstream prints, progress bars and warnings must not pollute JSON stdout.
sys.stdout = sys.stderr
OUTPUT_LOCK = threading.Lock()


def emit(message: dict):
    with OUTPUT_LOCK:
        PROTOCOL.write(json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n")
        PROTOCOL.flush()


class SilentEngine:
    name = "silent"
    metadata = {"engine": "silent", "enabled": False, "reason": "Voice explicitly disabled"}

    def prepare(self):
        pass

    def synthesize(self, text, cancellation):
        if cancellation.is_set():
            raise SynthesisCancelled("Generation cancelled")
        return {"sample_rate": 32000, "channels": 1, "format": "pcm_f32le",
                "sample_count": 0, "pcm_base64": "", "duration_ms": 0,
                "engine": "silent", "synthesis_ms": 0}


class Worker:
    def __init__(self, config: dict):
        self.config = config
        self.requests = queue.Queue(maxsize=max(1, int(config.get("queue_limit", 3))))
        self.lock = threading.Lock()
        self.tokens: dict[int, threading.Event] = {}
        self.closing = threading.Event()
        self.engine = None

    def token(self, generation: int):
        with self.lock:
            return self.tokens.setdefault(generation, threading.Event())

    def state(self, state: str, **extra):
        metadata = self.engine.metadata if self.engine is not None else {}
        emit({"type": "state", "state": state, **metadata, **extra})

    def run(self):
        started = time.perf_counter()
        try:
            self.state("loading")
            mode = self.config.get("voice_mode", "auto")
            if mode not in {"auto", "sovits", "system", "silent"}:
                raise ValueError(f"Unknown voice_mode: {mode}")
            if mode == "silent":
                self.engine = SilentEngine()
            elif mode == "sovits" or (mode == "auto" and self.config.get("engine_root")):
                self.engine = SovitsEngine(self.config)
            else:
                from services.tts.adapters.system import SystemEngine
                self.engine = SystemEngine(self.config)
            self.engine.prepare()
            self.state("warming")
            warmup_started = time.perf_counter()
            warmup = self.engine.synthesize(
                self.config.get("warmup_text", "こんにちは。"), self.closing)
            self.state("ready", cold_start_ms=(time.perf_counter() - started) * 1000,
                       warmup_ms=(time.perf_counter() - warmup_started) * 1000,
                       warmup_duration_ms=warmup["duration_ms"])
        except Exception as error:
            traceback.print_exc(file=sys.stderr)
            self.state("failed", error=str(error))
            return
        # Start stdin reads only after native libraries finish initialization:
        # a concurrent CRT stdin read blocks NumPy's DLL initialization here.
        controller = threading.Thread(target=self.read_commands, name="ayana-control", daemon=True)
        controller.start()
        while not self.closing.is_set():
            try:
                request = self.requests.get(timeout=0.1)
            except queue.Empty:
                continue
            identity, generation = request["id"], request["generation_id"]
            token = self.token(generation)
            try:
                if token.is_set():
                    raise SynthesisCancelled("Generation cancelled")
                self.state("synthesizing", generation_id=generation)
                result = self.engine.synthesize(request["text"], token)
                if token.is_set() or self.closing.is_set():
                    raise SynthesisCancelled("Generation cancelled")
                emit({"type": "result", "id": identity, "generation_id": generation, **result})
            except SynthesisCancelled:
                emit({"type": "cancelled", "id": identity, "generation_id": generation})
            except Exception as error:
                traceback.print_exc(file=sys.stderr)
                emit({"type": "error", "id": identity, "generation_id": generation, "error": str(error)})
            finally:
                self.requests.task_done()
                if not self.closing.is_set():
                    self.state("ready")

    def serve(self):
        # Import/initialize NumPy and Torch on the main thread. Their Windows
        # native DLL initialization can deadlock when first imported by a
        # background inference thread while the main thread waits on stdin.
        self.run()
        self.closing.set()

    def read_commands(self):
        for line in sys.stdin:
            request = {}
            try:
                request = json.loads(line)
                operation = request.get("op")
                if operation == "close":
                    break
                if operation == "cancel":
                    self.token(int(request["generation_id"])).set()
                    emit({"type": "cancel_ack", "generation_id": request["generation_id"]})
                elif operation == "synthesize":
                    if not isinstance(request.get("text"), str) or not request["text"].strip():
                        raise ValueError("Speech text must be nonempty")
                    if len(request["text"]) > 2000:
                        raise ValueError("Utterance exceeds the 2000 character limit")
                    request["generation_id"] = int(request["generation_id"])
                    self.token(request["generation_id"])
                    self.requests.put_nowait(request)
                else:
                    raise ValueError("Unknown TTS operation")
            except Exception as error:
                emit({"type": "error", "id": request.get("id"), "error": str(error)})
        self.closing.set()
        with self.lock:
            for token in self.tokens.values():
                token.set()


def main():
    try:
        request = json.loads(sys.stdin.readline())
        if request.get("op") != "start" or not isinstance(request.get("config"), dict):
            raise ValueError("First request must provide a start configuration")
        if request["config"].get("diagnostic_tracebacks"):
            faulthandler.dump_traceback_later(25, repeat=True, file=sys.stderr)
        Worker(request["config"]).serve()
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        emit({"type": "state", "state": "failed", "error": str(error)})


if __name__ == "__main__":
    main()
