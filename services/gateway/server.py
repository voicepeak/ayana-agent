"""Mobile gateway: provider transport, framed audio relay and durable log outbox.

No desktop runtime, avatar rendering, conversation history or Torch is loaded.
"""
from __future__ import annotations

import asyncio
from collections import defaultdict, deque
from contextlib import asynccontextmanager, suppress
import hmac
import json
from pathlib import Path
import re
import time
import uuid

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import httpx

from packages.protocol import SpeechParser, validate_speech
from services.mobile_transport import audio_frame, read_audio_frame
from .store import Store

ID = re.compile(r"^[a-zA-Z0-9_-]{1,100}$")


def identity(value):
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise ValueError("invalid_identifier")
    return value


def model_events(event, fallback_key):
    """Adapt the closed history shape emitted by mobile 0.2.0, never tool calls."""
    if event.get("type") is not None:
        return [event]
    legacy_fields = {"key", "speech_ja", "display_zh", "displayed", "status",
                     "played_samples", "total_samples", "intent", "affect", "intensity",
                     "expression", "pose"}
    if not event.get("speech_ja") or set(event) - legacy_fields:
        raise ValueError("unsupported_model_event")
    speech = validate_speech(event)
    translation = event.get("display_zh")
    if translation is not None and (not isinstance(translation, str) or not 1 <= len(translation) <= 1200):
        raise ValueError("invalid_translation")
    key = str(event.get("key") or fallback_key)
    result = [{"type": "speech", "key": key, **speech}]
    if translation is not None:
        result.append({"type": "translation", "key": key, "display_zh": translation})
    return result


class Gateway:
    def __init__(self, store, config, model_client=None):
        self.store, self.config = store, config
        self.model_client = model_client
        self.worker = None
        self.worker_queue = None
        self.worker_state = "offline"
        self.phones = set()
        self.jobs = {}
        self.active_users = set()
        self.generation = 0
        self.closed = False

    async def log(self, event):
        await asyncio.to_thread(self.store.log, {"event_id": uuid.uuid4().hex,
                                               "timestamp": time.time(), **event})

    def status(self):
        return {"type": "service.state", "protocol_version": 1, "service": "tts",
                "state": self.worker_state if self.worker_state in {"ready", "loading", "warming"} else "failed"}

    def publish_status(self):
        for phone in tuple(self.phones):
            phone.emit(self.status())

    def worker_send(self, event):
        if self.worker_queue is None:
            raise ValueError("tts_offline")
        try:
            self.worker_queue.put_nowait(event)
        except asyncio.QueueFull:
            raise ValueError("tts_busy") from None

    async def model(self, messages):
        if not self.config.get("api_key"):
            raise ValueError("model_not_configured")
        parser = SpeechParser()
        body = {"model": self.config["model"], "messages": messages, "stream": True,
                "max_tokens": 6000, "thinking": {"type": "disabled"}, "temperature": 1.0}
        client = self.model_client
        async with client.stream("POST", self.config["base_url"].rstrip("/") + "/chat/completions",
                                 json=body, headers={"Authorization": "Bearer " + self.config["api_key"]}) as response:
            if response.status_code != 200:
                raise ValueError("model_http_" + str(response.status_code))
            completed, size, event_serial = False, 0, 0
            async for line in response.aiter_lines():
                if not line.startswith("data:"):
                    continue
                raw = line[5:].strip()
                if raw == "[DONE]":
                    completed = True
                    break
                if len(raw) > 131072:
                    raise ValueError("model_chunk_too_large")
                chunk = json.loads(raw)
                if chunk.get("usage"):
                    yield {"type": "usage", "usage": {k: v for k, v in chunk["usage"].items()
                                                       if k in {"prompt_tokens", "completion_tokens", "total_tokens"}}}
                for choice in chunk.get("choices", []):
                    reason = choice.get("finish_reason")
                    if reason and reason != "stop":
                        raise ValueError("model_incomplete")
                    content = choice.get("delta", {}).get("content") or ""
                    size += len(content)
                    if size > 100000:
                        raise ValueError("model_output_too_large")
                    for event in parser.feed(content):
                        event_serial += 1
                        for normalized in model_events(event, f"legacy_s{event_serial}"):
                            yield normalized
            if not completed:
                raise ValueError("model_disconnected")
            parser.finish()


class Phone:
    def __init__(self, gateway, socket, session):
        self.gateway, self.socket, self.session = gateway, socket, session
        self.queue = asyncio.Queue(maxsize=128)
        self.turn = None
        self.pending = {}
        self.task = None
        self.speech_task = None
        self.speeches = None
        self.slots = asyncio.Semaphore(3)
        self.generation = 0
        self.local_generation = 0
        self.conversation_id = ""
        self.turn_id = ""
        self.closing = False

    def emit(self, event):
        if self.closing:
            return
        if isinstance(event, dict):
            event = {"protocol_version": 1, **event}
        try:
            self.queue.put_nowait(event)
        except asyncio.QueueFull:
            self.closing = True
            asyncio.create_task(self.socket.close(code=1013))

    def event(self, kind, **extra):
        return {"type": kind, "generation_id": self.local_generation, "conversation_id": self.conversation_id,
                "turn_id": self.turn_id, **extra}

    async def send_loop(self):
        try:
            while True:
                event = await self.queue.get()
                try:
                    async with asyncio.timeout(15):
                        if isinstance(event, bytes):
                            await self.socket.send_bytes(event)
                        else:
                            await self.socket.send_json(event)
                finally:
                    self.queue.task_done()
        except Exception:
            with suppress(Exception):
                await self.socket.close(code=1013)
            raise

    async def cancel(self):
        old = self.generation
        tasks = [t for t in (self.task, self.speech_task) if t and not t.done()]
        for task in tasks:
            task.cancel()
        if self.gateway.worker_queue is not None and old:
            with suppress(ValueError):
                self.gateway.worker_send({"type": "tts.cancel", "generation_id": old})
        for job in list(self.pending):
            self.gateway.jobs.pop(job, None)
        self.pending.clear()
        await asyncio.gather(*tasks, return_exceptions=True)
        self.task = self.speech_task = None
        self.slots = asyncio.Semaphore(3)
        if old:
            self.emit(self.event("generation.cancelled", cancelled_generation_id=self.local_generation))

    def release(self, job):
        if job in self.pending:
            self.pending.pop(job)
            self.gateway.jobs.pop(job, None)
            self.slots.release()

    async def syntheses(self, queue, generation):
        while True:
            item = await queue.get()
            if item is None:
                return
            try:
                await asyncio.wait_for(self.slots.acquire(), 60)
                if generation != self.generation:
                    return
                job = item["utterance_id"]
                self.pending[job] = {**item, "expires": time.monotonic() + 180, "audio_sent": False}
                self.gateway.jobs[job] = self
                self.gateway.worker_send({"type": "tts.synthesize", "request_id": job,
                    "generation_id": generation, "text": item["speech_ja"],
                    "voice_id": self.gateway.config.get("voice_id", "ayana"),
                    "user_id": self.session["user_id"], "turn_id": self.turn_id})
            except (ValueError, asyncio.TimeoutError):
                self.release(item["utterance_id"])
                self.emit(self.event("service.state", service="tts", state="failed"))
            finally:
                queue.task_done()

    async def start(self, command):
        text = command.get("text")
        if not isinstance(text, str) or not 1 <= len(text.strip()) <= 4000:
            raise ValueError("invalid_message")
        messages = command.get("messages")
        if not isinstance(messages, list) or not 1 <= len(messages) <= 100:
            raise ValueError("invalid_context")
        for message in messages:
            if (not isinstance(message, dict) or set(message) != {"role", "content"}
                    or message["role"] not in {"user", "assistant", "system"}
                    or not isinstance(message["content"], str)):
                raise ValueError("invalid_context")
        if sum(len(m["content"]) for m in messages) > 128000:
            raise ValueError("context_budget")
        if messages[-1]["role"] != "user":
            raise ValueError("invalid_context")
        turn_id = identity(command.get("turn_id"))
        conversation = identity(command.get("conversation_id"))
        if type(command.get("generation_id")) is not int or command["generation_id"] < 1:
            raise ValueError("invalid_generation")
        await self.cancel()
        gw = self.gateway
        user = self.session["user_id"]
        if user in gw.active_users or len(gw.active_users) >= 4:
            raise ValueError("model_busy")
        accepted = await asyncio.to_thread(gw.store.accept_turn, user, turn_id,
            {"event_id": user + ":" + turn_id, "type": "user.message", "user_id": user,
             "device_id": self.session["device"], "turn_id": turn_id, "conversation_id": conversation,
             "text": text.strip(), "timestamp": time.time()})
        if not accepted:
            raise ValueError("duplicate_turn")
        gw.generation += 1
        # Internal IDs are server-global; local client generation is remapped on output.
        self.generation = gw.generation
        self.local_generation = command["generation_id"]
        self.conversation_id, self.turn_id = conversation, turn_id
        self.speeches = asyncio.Queue(maxsize=64)
        self.speech_task = asyncio.create_task(self.syntheses(self.speeches, self.generation))
        gw.active_users.add(user)
        self.task = asyncio.create_task(self.run_model(messages))

    async def run_model(self, messages):
        gw, user = self.gateway, self.session["user_id"]
        keys, count, state = {}, 0, "complete"
        self.emit(self.event("task.state", state="thinking"))
        try:
            async for event in gw.model(messages):
                kind = event.get("type")
                if kind == "speech":
                    speech = validate_speech(event)
                    key = str(event.get("key") or f"s{count + 1}")
                    if key in keys or count >= 64:
                        raise ValueError("invalid_speech_sequence")
                    count += 1
                    uid = uuid.uuid4().hex
                    keys[key] = uid
                    audio_enabled = gw.worker_state == "ready"
                    outgoing = self.event("utterance.ready", utterance_id=uid, key=key,
                                          audio_enabled=audio_enabled, **speech)
                    await gw.log({**outgoing, "user_id": user})
                    self.emit(outgoing)
                    if audio_enabled:
                        self.speeches.put_nowait(outgoing)
                elif kind == "translation":
                    uid = keys.get(str(event.get("key", "")))
                    zh = event.get("display_zh")
                    if not uid or not isinstance(zh, str) or not 1 <= len(zh) <= 1200:
                        raise ValueError("invalid_translation")
                    outgoing = self.event("subtitle.ready", utterance_id=uid, display_zh=zh)
                    await gw.log({**outgoing, "user_id": user})
                    self.emit(outgoing)
                elif kind == "usage":
                    await gw.log(self.event("model.usage", user_id=user, usage=event["usage"]))
                elif kind != "silence":
                    raise ValueError("unsupported_model_event")
            if not count:
                raise ValueError("empty_reply")
        except asyncio.CancelledError:
            state = "cancelled"
            raise
        except Exception as error:
            state = "failed"
            code = str(error) if isinstance(error, ValueError) and ID.fullmatch(str(error)) else "model_stream_failed"
            with suppress(ValueError):
                await gw.log(self.event("model.failed", user_id=user, code=code))
            self.emit(self.event("error", source="turn", code=code, message="模型回复中断：" + code))
        finally:
            gw.active_users.discard(user)
            with suppress(ValueError):
                await gw.log(self.event("turn.finished", user_id=user, state=state))
            self.emit(self.event("task.state", state="failed" if state == "failed" else "idle"))
            if state != "cancelled" and self.speech_task and not self.speech_task.done():
                await self.speeches.put(None)


def create_app(config, *, store=None, model_client=None):
    store = store or Store(Path(config["data_dir"]) / "gateway.sqlite3")
    gw = Gateway(store, config, model_client)

    @asynccontextmanager
    async def lifespan(app):
        owned = gw.model_client is None
        if owned:
            gw.model_client = httpx.AsyncClient(timeout=httpx.Timeout(90, connect=15), trust_env=False)
        yield
        gw.closed = True
        for phone in tuple(gw.phones):
            await phone.cancel()
            with suppress(Exception):
                await phone.socket.close(code=1001)
        if gw.worker:
            with suppress(Exception):
                await gw.worker.close(code=1001)
        if owned:
            await gw.model_client.aclose()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None)
    app.state.gateway = gw
    app.add_middleware(CORSMiddleware, allow_origins=["capacitor://localhost", "http://localhost",
        "https://localhost", *config.get("origins", [])], allow_methods=["POST", "GET"],
        allow_headers=["Content-Type", "Authorization"])
    attempts = defaultdict(deque)

    async def body(request):
        raw = await request.body()
        if len(raw) > 8192:
            raise HTTPException(413)
        try:
            value = json.loads(raw)
            if not isinstance(value, dict):
                raise ValueError()
            return value
        except (ValueError, UnicodeError):
            raise HTTPException(400, "invalid_json") from None

    def configuration():
        return {"protocol_version": 1, "model": config["model"], "voice_id": config.get("voice_id", "ayana"),
                "capabilities": {"tts": gw.worker_state == "ready", "stt": False, "search": False},
                "version": "0.2.0"}

    @app.get("/v1/health")
    async def health():
        return {"ok": True, "protocol_version": 1}

    @app.post("/v1/activate")
    async def activate(request: Request):
        host = request.client.host if request.client else "unknown"
        now, recent = time.monotonic(), attempts[host]
        while recent and recent[0] < now - 60:
            recent.popleft()
        if len(recent) >= 10:
            raise HTTPException(429, "activation_rate_limit")
        recent.append(now)
        value = await body(request)
        key = value.get("key")
        if not isinstance(key, str) or not 24 <= len(key) <= 256:
            raise HTTPException(401, "invalid_key")
        try:
            device = identity(value.get("device_id"))
            session = await asyncio.to_thread(store.activate, key, device)
        except ValueError as error:
            raise HTTPException(400, str(error)) from None
        if not session:
            raise HTTPException(401, "invalid_key")
        return {**session, "config": configuration()}

    @app.post("/v1/refresh")
    async def refresh(request: Request):
        value = await body(request)
        token = value.get("refresh_token")
        if not isinstance(token, str) or not 24 <= len(token) <= 256:
            raise HTTPException(401)
        session = await asyncio.to_thread(store.refresh, token)
        if not session:
            raise HTTPException(401)
        return {**session, "config": configuration()}

    @app.post("/v1/logout")
    async def logout(request: Request):
        token = request.headers.get("authorization", "").removeprefix("Bearer ")
        await asyncio.to_thread(store.logout, token)
        return {"ok": True}

    @app.websocket("/v1/mobile")
    async def mobile(ws: WebSocket):
        await ws.accept()
        phone = sender = None
        try:
            async with asyncio.timeout(10):
                auth = await ws.receive_text()
                if len(auth) > 1024:
                    raise ValueError("auth_size")
                authentication = json.loads(auth)
                token = authentication.get("access_token") if isinstance(authentication, dict) else None
                if not isinstance(token, str) or not 24 <= len(token) <= 256:
                    raise ValueError("invalid_authentication")
                session = store.authenticate(token)
            if not session:
                await ws.close(code=4401)
                return
            phone = Phone(gw, ws, session)
            gw.phones.add(phone)
            sender = asyncio.create_task(phone.send_loop())
            phone.emit({"type": "gateway.ready", "config": configuration()})
            phone.emit(gw.status())
            while True:
                raw = await ws.receive_text()
                if len(raw) > 600000:
                    await ws.close(code=1009)
                    break
                if not store.authenticate(token):
                    await ws.close(code=4401)
                    break
                try:
                    cmd = json.loads(raw)
                    if not isinstance(cmd, dict):
                        raise ValueError("invalid_command")
                    kind = cmd.get("type")
                    if kind == "turn.start":
                        await phone.start(cmd)
                    elif kind == "generation.cancel":
                        await phone.cancel()
                    elif kind == "audio.consumed":
                        job = cmd.get("utterance_id")
                        if job in phone.pending and phone.pending[job]["audio_sent"]:
                            phone.release(job)
                    elif kind == "ping":
                        for job, item in list(phone.pending.items()):
                            if item["expires"] < time.monotonic():
                                phone.release(job)
                        phone.emit({"type": "pong"})
                    else:
                        raise ValueError("unsupported_command")
                except (ValueError, TypeError):
                    phone.emit(phone.event("error", source="turn", message="请求被拒绝，请检查配置或稍后重试。"))
                    phone.emit(phone.event("task.state", state="failed"))
        except (WebSocketDisconnect, RuntimeError, ValueError, TimeoutError):
            with suppress(Exception):
                await ws.close(code=4400)
        finally:
            if phone:
                await phone.cancel()
                gw.phones.discard(phone)
            if sender:
                sender.cancel()
                await asyncio.gather(sender, return_exceptions=True)

    @app.websocket("/v1/worker")
    async def worker(ws: WebSocket):
        expected = config.get("worker_token", "")
        if len(expected) < 24 or not hmac.compare_digest(ws.headers.get("authorization", ""), "Bearer " + expected):
            await ws.close(code=4401)
            return
        if gw.worker is not None:
            await ws.close(code=4409)
            return
        await ws.accept()
        gw.worker, gw.worker_queue = ws, asyncio.Queue(maxsize=32)
        gw.worker_state = "loading"
        gw.publish_status()

        async def send_jobs():
            while True:
                item = await gw.worker_queue.get()
                try:
                    async with asyncio.timeout(15):
                        await ws.send_json(item)
                finally:
                    gw.worker_queue.task_done()

        # Serialize all sends, including the diagnostic outbox.
        async def enqueue_logs():
            while True:
                for log in await asyncio.to_thread(store.next_logs):
                    await gw.worker_queue.put({"type": "log.append", "event": log})
                await asyncio.sleep(2)

        tasks = [asyncio.create_task(send_jobs()), asyncio.create_task(enqueue_logs())]
        try:
            while True:
                message = await ws.receive()
                if message["type"] == "websocket.disconnect":
                    break
                if message.get("bytes") is not None:
                    frame = message["bytes"]
                    metadata, pcm = read_audio_frame(frame)
                    job = metadata.get("utterance_id")
                    phone = gw.jobs.get(job)
                    if phone and job in phone.pending and not phone.pending[job]["audio_sent"]:
                        if metadata.get("generation_id") != phone.generation:
                            raise ValueError("wrong_audio_generation")
                        phone.pending[job]["audio_sent"] = True
                        phone.emit(audio_frame({**metadata, "generation_id": phone.local_generation,
                            "turn_id": phone.turn_id, "conversation_id": phone.conversation_id}, pcm))
                else:
                    raw = message.get("text", "")
                    if len(raw) > 10000:
                        raise ValueError("worker_message_size")
                    event = json.loads(raw)
                    if not isinstance(event, dict):
                        raise ValueError("invalid_worker_command")
                    kind = event.get("type")
                    if kind == "worker.state":
                        gw.worker_state = event.get("state", "failed")
                        gw.publish_status()
                    elif kind == "log.ack" and type(event.get("delivery_id")) is int:
                        await asyncio.to_thread(store.ack, event["delivery_id"])
                    elif kind == "tts.error":
                        phone = gw.jobs.get(event.get("request_id"))
                        if phone:
                            job = event["request_id"]
                            phone.release(job)
                            phone.emit(phone.event("service.state", service="tts", state="failed"))
        except (WebSocketDisconnect, RuntimeError, ValueError, TimeoutError):
            pass
        finally:
            gw.worker = gw.worker_queue = None
            gw.worker_state = "offline"
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            for phone in tuple(gw.phones):
                for job in list(phone.pending):
                    phone.release(job)
            gw.publish_status()

    root = Path(config.get("mobile_root", "apps/mobile/dist"))
    if root.is_dir():
        app.mount("/", StaticFiles(directory=root, html=True), name="mobile")
    return app
