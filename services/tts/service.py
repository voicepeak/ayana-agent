"""Async agent-side TTS adapter; never imports torch or alters the agent cwd."""

from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path
import sys
from typing import Any

LOGGER = logging.getLogger(__name__)


class TtsService:
    def __init__(self, config: dict):
        self.config = dict(config)
        self.process: asyncio.subprocess.Process | None = None
        self._status: dict[str, Any] = {"state": "stopped", "engine": None}
        self._pending: dict[int, tuple[int, asyncio.Future]] = {}
        self._cancelled: set[int] = set()
        self._sequence = 0
        self._ready: asyncio.Future | None = None
        self._tasks: list[asyncio.Task] = []
        self._start_lock = asyncio.Lock()
        self._write_lock = asyncio.Lock()
        self._synth_lock = asyncio.Lock()
        self._closing = False

    @property
    def status(self) -> dict:
        return dict(self._status)

    async def start(self):
        async with self._start_lock:
            if self.process is not None and self.process.returncode is None:
                if self._ready is not None:
                    await asyncio.shield(self._ready)
                return
            self._closing = False
            self._status = {"state": "starting", "engine": None}
            self._ready = asyncio.get_running_loop().create_future()
            executable = self.config.get("python") or sys.executable
            env = dict(os.environ, PYTHONUNBUFFERED="1", PYTHONIOENCODING="utf-8")
            options = {"creationflags": 0x08000000} if os.name == "nt" else {}
            worker = Path(__file__).with_name("worker.py")
            try:
                self.process = await asyncio.create_subprocess_exec(
                    str(executable), "-u", str(worker), stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                    limit=32 * 1024 * 1024, env=env, **options)
                self._tasks = [asyncio.create_task(self._read()), asyncio.create_task(self._logs())]
                await self._send({"op": "start", "config": self.config})
                await asyncio.wait_for(asyncio.shield(self._ready),
                                       timeout=float(self.config.get("start_timeout_seconds", 180)))
            except BaseException as error:
                reason = "TTS warmup exceeded startup timeout" if isinstance(error, asyncio.TimeoutError) else str(error)
                self._status.update(state="failed", error=reason)
                await self.close()
                self._status.update(state="failed", error=reason)
                raise

    async def synthesize(self, text: str, generation_id: int) -> dict:
        if not isinstance(text, str) or not text.strip():
            raise ValueError("Speech text must be nonempty")
        if len(text) > 2000:
            raise ValueError("Utterance exceeds the 2000 character limit")
        if generation_id in self._cancelled:
            raise asyncio.CancelledError("Generation cancelled")
        if self.process is None or self.process.returncode is not None:
            await self.start()
        elif self._ready is not None:
            await asyncio.shield(self._ready)
        # Parent backpressure: only one request in flight, with no hidden text queue.
        async with self._synth_lock:
            if generation_id in self._cancelled:
                raise asyncio.CancelledError("Generation cancelled")
            self._sequence += 1
            identity = self._sequence
            future = asyncio.get_running_loop().create_future()
            self._pending[identity] = (generation_id, future)
            try:
                await self._send({"op": "synthesize", "id": identity,
                                  "generation_id": generation_id, "text": text})
                result = await asyncio.wait_for(future, timeout=float(
                    self.config.get("synthesis_timeout_seconds", 120)))
                if generation_id in self._cancelled:
                    raise asyncio.CancelledError("Generation cancelled")
                return result
            except asyncio.CancelledError:
                await self.cancel(generation_id)
                raise
            except asyncio.TimeoutError:
                await self.cancel(generation_id)
                self._status.update(state="failed", error="Speech synthesis timed out")
                raise
            finally:
                self._pending.pop(identity, None)

    async def cancel(self, generation_id: int):
        self._cancelled.add(generation_id)
        for generation, future in list(self._pending.values()):
            if generation == generation_id and not future.done():
                future.cancel()
        if self.process is not None and self.process.returncode is None and not self._closing:
            await self._send({"op": "cancel", "generation_id": generation_id})

    async def _send(self, request: dict):
        async with self._write_lock:
            if self.process is None or self.process.stdin is None or self.process.returncode is not None:
                raise RuntimeError("TTS worker is not running")
            self.process.stdin.write((json.dumps(request, ensure_ascii=False) + "\n").encode("utf-8"))
            await self.process.stdin.drain()

    async def _read(self):
        assert self.process is not None and self.process.stdout is not None
        try:
            while line := await self.process.stdout.readline():
                message = json.loads(line)
                kind = message.get("type")
                if kind == "state":
                    self._status.update({key: value for key, value in message.items() if key != "type"})
                    if message.get("state") == "ready" and self._ready is not None and not self._ready.done():
                        self._ready.set_result(self.status)
                    elif message.get("state") == "failed":
                        error = RuntimeError(message.get("error", "TTS loading failed"))
                        if self._ready is not None and not self._ready.done():
                            self._ready.set_exception(error)
                        self._fail_pending(error)
                elif kind in {"result", "cancelled", "error"}:
                    pending = self._pending.get(message.get("id"))
                    if pending is None:
                        continue
                    generation, future = pending
                    if future.done():
                        continue
                    if generation in self._cancelled or kind == "cancelled":
                        future.cancel()
                    elif kind == "error":
                        future.set_exception(RuntimeError(message.get("error", "TTS synthesis failed")))
                    elif message.get("generation_id") != generation:
                        future.set_exception(RuntimeError("TTS generation mismatch"))
                    else:
                        future.set_result({key: value for key, value in message.items() if key not in {"type", "id"}})
        except (ValueError, OSError) as error:
            self._status.update(state="failed", error=f"TTS protocol error: {error}")
            self._fail_pending(RuntimeError(self._status["error"]))
        finally:
            if not self._closing:
                error = RuntimeError(self._status.get("error") or "TTS worker exited unexpectedly")
                self._status.update(state="failed", error=str(error))
                if self._ready is not None and not self._ready.done():
                    self._ready.set_exception(error)
                self._fail_pending(error)

    def _fail_pending(self, error: Exception):
        for _, future in list(self._pending.values()):
            if not future.done():
                future.set_exception(error)

    async def _logs(self):
        assert self.process is not None and self.process.stderr is not None
        while line := await self.process.stderr.readline():
            LOGGER.debug("tts-worker: %s", line.decode("utf-8", "replace").rstrip()[:2000])

    async def close(self):
        self._closing = True
        for _, future in list(self._pending.values()):
            if not future.done():
                future.cancel()
        process = self.process
        if process is not None and process.returncode is None:
            try:
                await self._send({"op": "close"})
                await asyncio.wait_for(process.wait(), timeout=4)
            except (OSError, RuntimeError, asyncio.TimeoutError):
                if process.returncode is None:
                    process.kill()
                await process.wait()
        for task in self._tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()
        self._pending.clear()
        self.process = None
        self._status.update(state="stopped")
