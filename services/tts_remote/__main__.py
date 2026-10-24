from __future__ import annotations

import argparse
import asyncio
from contextlib import suppress
import json
from pathlib import Path
import sqlite3
import time
import threading
import uuid
from urllib.parse import urlsplit, urlunsplit

from websockets.asyncio.client import connect

from services.mobile_transport import audio_frame
from services.agent.audio_codec import f32le_base64_to_s16le_bytes
from services.tts.service import TtsService


class DiagnosticLog:
    def __init__(self, path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,user_id TEXT,turn_id TEXT,type TEXT,created REAL,body TEXT)")
        self.db.execute("CREATE INDEX IF NOT EXISTS event_turn ON events(user_id,turn_id,created)")
        self.db.commit()
        self.lock = threading.RLock()
        self.closed = False

    def append(self, event):
        event = {k: v for k, v in event.items() if k != "delivery_id"}
        with self.lock:
            if self.closed:
                return
            with self.db:
                self.db.execute("INSERT OR IGNORE INTO events VALUES(?,?,?,?,?,?)", (
                    event.get("event_id", uuid.uuid4().hex), event.get("user_id", ""), event.get("turn_id", ""),
                    event.get("type", "unknown"), event.get("timestamp", time.time()), json.dumps(event, ensure_ascii=False)))

    def close(self):
        # Cancelled to_thread awaits can leave an SQLite write finishing in a thread.
        with self.lock:
            self.closed = True
            self.db.close()


class RemoteWorker:
    def __init__(self, config, tts=None):
        self.config = config
        self.tts = tts or TtsService(config["voice"])
        self.logs = DiagnosticLog(Path(config["data_dir"]) / "dialogue.sqlite3")
        self.sequence = 0

    async def session(self, ws):
        send_queue = asyncio.Queue(maxsize=16)
        jobs = asyncio.Queue(maxsize=12)
        logs = asyncio.Queue(maxsize=64)
        generations = {}
        cancelled = set()
        stopping = asyncio.Event()

        async def send(item):
            async with asyncio.timeout(15):
                await send_queue.put(item)

        async def sender():
            try:
                while True:
                    item = await send_queue.get()
                    try:
                        async with asyncio.timeout(15):
                            await ws.send(item if isinstance(item, bytes) else json.dumps(item))
                    finally:
                        send_queue.task_done()
            except Exception:
                await ws.close()
                raise

        async def diagnostics():
            while True:
                event = await logs.get()
                try:
                    await asyncio.to_thread(self.logs.append, event)
                    await send({"type": "log.ack", "delivery_id": event["delivery_id"]})
                except (OSError, sqlite3.Error):
                    # Leave delivery unacknowledged for durable gateway retry.
                    pass
                finally:
                    logs.task_done()

        async def synthesize():
            while not stopping.is_set():
                job = await jobs.get()
                generation = job["generation_id"]
                internal = generations[generation]
                try:
                    if generation in cancelled:
                        continue
                    started = time.monotonic()
                    result = await self.tts.synthesize(job["text"], internal)
                    if generation in cancelled:
                        continue
                    pcm = f32le_base64_to_s16le_bytes(result["pcm_base64"])
                    metadata = {"type": "audio.ready", "utterance_id": job["request_id"],
                        "generation_id": generation, "sample_rate": result["sample_rate"], "channels": 1,
                        "format": "pcm_s16le", "sample_count": len(pcm) // 2,
                        "duration_ms": result["duration_ms"], "chunk_index": 0,
                        "synthesis_ms": result.get("synthesis_ms", (time.monotonic() - started) * 1000)}
                    await asyncio.to_thread(self.logs.append, {
                        "type": "tts.completed", "user_id": job.get("user_id", ""),
                        "turn_id": job.get("turn_id", ""), "utterance_id": job["request_id"],
                        "synthesis_ms": metadata["synthesis_ms"], "duration_ms": metadata["duration_ms"],
                        "timestamp": time.time()})
                    # Queuing the completed audio does not wait for network transmission.
                    await send(audio_frame(metadata, pcm))
                    await send({"type": "worker.state", "state": "ready"})
                except asyncio.CancelledError:
                    if stopping.is_set() or asyncio.current_task().cancelling() or generation not in cancelled:
                        raise
                except Exception as error:
                    with suppress(OSError, sqlite3.Error):
                        await asyncio.to_thread(self.logs.append, {
                            "type": "tts.failed", "user_id": job.get("user_id", ""),
                            "turn_id": job.get("turn_id", ""), "utterance_id": job["request_id"],
                            "error_type": type(error).__name__, "timestamp": time.time()})
                    await send({"type": "tts.error", "request_id": job["request_id"], "code": "synthesis_failed"})
                finally:
                    jobs.task_done()

        tasks = [asyncio.create_task(sender()), asyncio.create_task(diagnostics()), asyncio.create_task(synthesize())]
        try:
            await send({"type": "worker.state", "state": "ready"})
            async for raw in ws:
                if not isinstance(raw, str) or len(raw) > 100000:
                    raise ValueError("Invalid worker control message")
                event = json.loads(raw)
                kind = event.get("type")
                if kind == "log.append":
                    try:
                        logs.put_nowait(event["event"])
                    except asyncio.QueueFull:
                        pass  # no ACK; gateway retries independently of inference
                elif kind == "tts.cancel":
                    generation = event.get("generation_id")
                    cancelled.add(generation)
                    if generation in generations:
                        await self.tts.cancel(generations[generation])
                elif kind == "tts.synthesize":
                    generation = event.get("generation_id")
                    if (type(generation) is not int or not isinstance(event.get("text"), str)
                            or not 1 <= len(event["text"]) <= 2000
                            or event.get("voice_id") != self.config.get("voice_id", "ayana")):
                        raise ValueError("Invalid inference request")
                    if generation in cancelled:
                        continue
                    if generation not in generations:
                        self.sequence += 1
                        generations[generation] = self.sequence
                    try:
                        jobs.put_nowait(event)
                    except asyncio.QueueFull:
                        await send({"type": "tts.error", "request_id": event["request_id"], "code": "queue_full"})
        finally:
            stopping.set()
            for generation in generations.values():
                with suppress(Exception):
                    await self.tts.cancel(generation)
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    async def run(self):
        await self.tts.start()
        url = urlsplit(self.config["gateway"])
        endpoint = urlunsplit(("wss" if url.scheme == "https" else "ws", url.netloc, "/v1/worker", "", ""))
        try:
            while True:
                try:
                    async with connect(endpoint, additional_headers={"Authorization": "Bearer " + self.config["worker_token"]},
                                       max_size=17 * 1024 * 1024, open_timeout=15) as ws:
                        await self.session(ws)
                except (OSError, ValueError, TimeoutError) as error:
                    print("TTS gateway connection interrupted: " + type(error).__name__, flush=True)
                except Exception as error:
                    print("TTS gateway retry: " + type(error).__name__, flush=True)
                await asyncio.sleep(3)
        finally:
            await self.tts.close()
            self.logs.close()


def main():
    parser = argparse.ArgumentParser(description="SoVITS inference + diagnostic logs, outbound gateway connection only")
    parser.add_argument("--config", type=Path, default=Path(".runtime/mobile-services/worker.json"))
    args = parser.parse_args()
    asyncio.run(RemoteWorker(json.loads(args.config.read_text(encoding="utf-8"))).run())


if __name__ == "__main__":
    main()
