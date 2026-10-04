from __future__ import annotations

import asyncio
import contextlib
import json
import time
import uuid
from collections import OrderedDict

from packages.protocol import PROTOCOL_VERSION, validate_speech
from .providers.model import CONTRACT, LocalProvider, OpenAIProvider
from .storage import ConversationStore
from .tools.repository import RepositoryReader


def identifier(prefix):
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


class AgentRuntime:
    def __init__(self, settings, desktop=None, tts=None, store=None):
        self.settings = settings
        from .avatars import AvatarCatalog
        self.avatars = AvatarCatalog(settings.root)
        if desktop is None:
            from native.windows.desktop import WindowsDesktop
            desktop = WindowsDesktop()
        if tts is None:
            from services.tts.service import TtsService
            tts = TtsService(settings.values.get("voice", {}))
        self.desktop, self.tts = desktop, tts
        self.store = store or ConversationStore(settings.data_root / ".runtime/history.sqlite3")
        self.session_id = identifier("session")
        self.turn_id = ""
        self.generation = 0
        self.seq = 0
        self.clients = set()
        self.target = None
        self.snapshot = None
        self.repository = None
        self.task = None
        self.action_task = None
        self.start_task = None
        self.pending = OrderedDict()
        self.pending_condition = asyncio.Condition()
        self.actions = {}
        self.utterances = {}
        self.mode = "teach"
        self.closed = False
        self.stt = None

    async def emit(self, event_type, **payload):
        self.seq += 1
        event = {"protocol_version": PROTOCOL_VERSION, "type": event_type, "session_id": self.session_id,
                 "turn_id": self.turn_id, "generation_id": self.generation, "seq": self.seq,
                 "runtime_monotonic_ms": round(time.monotonic() * 1000), **payload}
        if self.settings.values.get("save_history", True):
            self.store.commit(event)
        gone = []
        for ws in tuple(self.clients):
            try:
                await asyncio.wait_for(ws.send_json(event), 2)
            except Exception:
                gone.append(ws)
        for ws in gone:
            self.clients.discard(ws)
        return event

    async def start(self):
        self.start_task = asyncio.create_task(self._prepare_voice())

    async def _prepare_voice(self):
        await self.emit("service.state", service="tts", state="loading")
        try:
            await self.tts.start()
            await self.emit("service.state", service="tts", **self.tts.status)
        except Exception as e:
            await self.emit("service.state", service="tts", state="failed", message=str(e)[:400])

    async def connected(self, ws):
        self.clients.add(ws)
        await self.emit("session.started", provider=self.settings.values["provider"], target=self.target)
        await self.emit("settings.ready", settings=self.settings.public(), api_key_configured=bool(self.settings.key()))
        await self.emit("service.state", service="tts", **self.tts.status)
        await self.emit("service.state", service="desktop", **self.desktop.status)
        if self.snapshot:
            await self.emit("snapshot.ready", **self.snapshot)

    async def cancel(self, reason="user"):
        old = self.generation
        self.generation += 1
        task, self.task = self.task, None
        if task and task is not asyncio.current_task():
            task.cancel()
        action_task, self.action_task = self.action_task, None
        if action_task:
            action_task.cancel()
        self.actions.clear()
        async with self.pending_condition:
            self.pending.clear()
            self.pending_condition.notify_all()
        # Generation broadcast precedes slow inference cancellation.
        await self.emit("generation.cancelled", cancelled_generation_id=old, reason=reason)
        await self.emit("input.state", state="idle")
        if hasattr(self.desktop, "cancel"):
            self.desktop.cancel()
        with contextlib.suppress(BrokenPipeError, ConnectionError, RuntimeError):
            await self.tts.cancel(old)
        if task and task is not asyncio.current_task():
            with contextlib.suppress(asyncio.CancelledError):
                await task
        if action_task:
            with contextlib.suppress(asyncio.CancelledError):
                await action_task

    async def capture(self):
        if not self.target:
            raise ValueError("请先绑定一个目标窗口")
        try:
            snap = await asyncio.to_thread(self.desktop.capture, self.target["target_id"])
        except Exception:
            self.snapshot = None
            self.actions.clear()
            await self.emit("snapshot.invalidated")
            raise
        self.snapshot = snap
        await self.emit("snapshot.ready", **snap)
        if self.task is None or self.task.done():
            await self.emit("task.state", state="idle")
        return snap

    async def handle(self, cmd: dict):
        if not isinstance(cmd, dict) or not isinstance(cmd.get("type"), str):
            raise ValueError("Command requires a type")
        kind = cmd["type"]
        if kind == "assistant.register":
            for hwnd in cmd.get("hwnds", [])[:4]:
                self.desktop.register_assistant_window(int(hwnd))
        elif kind == "session.start":
            await self.cancel("summon")
            target = await asyncio.to_thread(self.desktop.foreground)
            if cmd.get("hwnd"):
                target = await asyncio.to_thread(self.desktop.bind, int(cmd["hwnd"]))
            self.target = target
            self.snapshot = None
            await self.emit("session.started", target=target, provider=self.settings.values["provider"])
            if target:
                await self.emit("target.bound", target=target)
                try:
                    await self.capture()
                except Exception as e:
                    await self.emit("error", source="capture", message=str(e)[:500])
        elif kind == "session.close":
            await self.cancel("session_closed")
            await self.emit("session.closed")
        elif kind == "generation.cancel":
            await self.cancel()
        elif kind == "target.bind":
            await self.cancel("target_changed")
            self.target = await asyncio.to_thread(self.desktop.bind, int(cmd["hwnd"]))
            self.snapshot = None
            await self.emit("target.bound", target=self.target)
            await self.capture()
        elif kind == "target.capture":
            await self.capture()
        elif kind == "windows.list":
            await self.emit("windows.list", windows=await asyncio.to_thread(self.desktop.list_windows))
        elif kind == "repository.inspect":
            reader = RepositoryReader(cmd["root"])
            self.repository = await asyncio.to_thread(reader.inspect)
            await self.emit("repository.inspected", repository=self.repository, **self.repository)
        elif kind == "repository.read":
            root = cmd.get("root") or (self.repository or {}).get("root")
            evidence = await asyncio.to_thread(RepositoryReader(root).read_file, cmd["path"], cmd.get("start_line", 1), 160)
            await self.emit("evidence.ready", evidence=evidence, **evidence)
        elif kind == "repository.search":
            root = cmd.get("root") or (self.repository or {}).get("root")
            results = await asyncio.to_thread(RepositoryReader(root).search_text, cmd["query"])
            await self.emit("repository.searched", results=results, query=cmd["query"])
        elif kind == "mode.set":
            if cmd.get("mode") not in {"teach", "execute"}:
                raise ValueError("Invalid task mode")
            self.mode = cmd["mode"]
            await self.emit("mode.ready", mode=self.mode)
        elif kind == "input.audio":
            await self.cancel("microphone_input")
            self.task = asyncio.create_task(self._transcribe(cmd, self.generation))
        elif kind == "turn.start":
            text = cmd.get("text", "")
            if not isinstance(text, str) or not 1 <= len(text.strip()) <= 4000:
                raise ValueError("请输入 1–4000 字的问题")
            await self.cancel("new_turn")
            self.turn_id = identifier("turn")
            self.mode = cmd.get("mode", "teach")
            if self.mode not in {"teach", "execute"}:
                raise ValueError("Invalid task mode")
            await self.emit("user.message", text=text)
            self.task = asyncio.create_task(self._turn(text, cmd.get("repository_root"), self.generation))
        elif kind == "tool.execute":
            if self.mode != "execute" and cmd.get("action", {}).get("kind") != "highlight":
                raise ValueError("先选择单步执行模式，再确认具体步骤")
            if self.action_task and not self.action_task.done():
                raise ValueError("另一个单步操作尚未结束")
            self.action_task = asyncio.create_task(self._run_action(cmd, self.generation))
        elif kind.startswith("playback.") or kind == "utterance.displayed":
            await self._receipt(cmd)
        elif kind == "settings.get":
            await self.emit("settings.ready", settings=self.settings.public(), api_key_configured=bool(self.settings.key()))
        elif kind == "settings.update":
            patch = cmd.get("settings", {})
            await self.cancel("settings_changed")
            self.settings.update(patch)
            if "stt" in patch and self.stt:
                await self.stt.close()
                self.stt = None
            if "voice" in patch:
                await self.tts.close()
                from services.tts.service import TtsService
                self.tts = TtsService(self.settings.values["voice"])
                self.start_task = asyncio.create_task(self._prepare_voice())
            await self.emit("settings.ready", settings=self.settings.public(), api_key_configured=bool(self.settings.key()))
        elif kind == "history.get":
            await self.emit("history.ready", history=self.store.history())
        else:
            raise ValueError(f"Unknown command: {kind}")

    async def _receipt(self, cmd):
        uid = cmd.get("utterance_id")
        utterance = self.utterances.get(uid)
        if not utterance:
            return
        # Final cancellation receipts belong to old generation and preserve actual partial playback.
        if cmd.get("generation_id") != utterance["generation_id"]:
            return
        if cmd["type"] != "playback.cancelled" and cmd.get("generation_id") != self.generation:
            return
        if cmd["type"] not in {"playback.started", "playback.progress", "playback.ended", "playback.cancelled", "utterance.displayed", "playback.error"}:
            return
        if cmd["type"] == "playback.error":
            await self.cancel("playback_error")
            await self.emit("error", source="playback", message=str(cmd.get("message", "Audio device unavailable"))[:300])
            return
        total = utterance.get("total_samples", 0)
        played = max(0, min(total, int(cmd.get("played_samples", 0))))
        await self.emit(cmd["type"], utterance_id=uid, played_samples=played, total_samples=total,
                        sample_rate=utterance.get("sample_rate", 0), played_audio_ms=round(played * 1000 / max(1, utterance.get("sample_rate", 1))),
                        generation_id=utterance["generation_id"])
        if cmd["type"] in {"playback.ended", "playback.cancelled"}:
            async with self.pending_condition:
                self.pending.pop(uid, None)
                self.pending_condition.notify_all()

    async def _transcribe(self, cmd, gen):
        try:
            from .providers.stt import SttService
            await self.emit("input.state", state="transcribing")
            if self.stt is None:
                cfg = {"model_root": str(self.settings.data_root / ".runtime/models"), **self.settings.values.get("stt", {})}
                self.stt = SttService(cfg)
                await self.stt.start()
            text = await self.stt.transcribe(cmd["audio_base64"], cmd.get("mime_type", "audio/webm"))
            if gen != self.generation:
                return
            if not text.strip():
                raise ValueError("没有识别到语音，请再试一次")
            await self.emit("input.transcribed", text=text)
            await self.emit("input.state", state="idle")
            # Small local ASR can misrecognize technical terms. The desktop
            # puts this text in the composer for review before a normal send.
        except asyncio.CancelledError:
            raise
        except Exception as e:
            if gen == self.generation:
                await self.emit("input.state", state="failed")
                await self.emit("error", source="stt", message=str(e)[:400])

    async def _reserve_audio(self, uid, duration, gen):
        async with self.pending_condition:
            deadline = time.monotonic() + 90
            while gen == self.generation and (len(self.pending) >= 3 or (self.pending and sum(self.pending.values()) + duration > self.settings.values["max_audio_ahead_ms"])):
                left = deadline - time.monotonic()
                if left <= 0:
                    raise RuntimeError("播放器未返回消费回执，语音队列已停止")
                await asyncio.wait_for(self.pending_condition.wait(), left)
            if gen != self.generation:
                raise asyncio.CancelledError()
            self.pending[uid] = duration

    async def _speech_worker(self, queue, gen):
        if self.start_task:
            await asyncio.shield(self.start_task)
        while gen == self.generation:
            item = await queue.get()
            if item is None:
                return
            uid, speech = item
            await self._reserve_audio(uid, 2000, gen)
            try:
                audio = await self.tts.synthesize(speech, gen)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                self.pending.pop(uid, None)
                await self.emit("service.state", service="tts", state="failed", message=str(e)[:300])
                await self.emit("error", source="tts", message="语音合成失败，本轮后续语音已停止；文字仍可阅读。")
                return
            if gen != self.generation:
                return
            duration = audio["duration_ms"]
            self.pending.pop(uid, None)
            if audio.get("engine") == "silent":
                await self.emit("utterance.displayed", utterance_id=uid)
                continue
            await self._reserve_audio(uid, duration, gen)
            audio_bytes = __import__("base64").b64decode(audio["pcm_base64"])
            if len(audio_bytes) % 4 or audio.get("channels", 1) != 1:
                raise ValueError("Invalid mono float32 PCM")
            self.utterances[uid].update(total_samples=len(audio_bytes) // 4, sample_rate=audio["sample_rate"])
            await self.emit("audio.ready", utterance_id=uid, **{**audio, "format": "pcm_f32le"})

    async def _turn(self, text, root, gen):
        queue = asyncio.Queue(maxsize=3)
        speaker = asyncio.create_task(self._speech_worker(queue, gen))
        keys = {}
        count = 0
        try:
            await self.emit("task.state", state="thinking")
            if root:
                self.repository = await asyncio.to_thread(RepositoryReader(root).inspect)
                await self.emit("repository.inspected", repository=self.repository, **self.repository)
            if self.settings.values["provider"] == "local":
                await self.emit("service.state", service="model", state="ready", engine="local-evidence", message="本地文件教学模式，无视觉模型")
                streams = [LocalProvider().stream_reply(text, self.repository, self.target)]
                messages = None
            else:
                persona = (self.settings.root / "characters/ayana/persona.md").read_text(encoding="utf-8")
                policy = (self.settings.root / "characters/ayana/agent-policy.md").read_text(encoding="utf-8")
                context = {"question": text, "mode": self.mode, "target": self.target, "repository": self.repository,
                           "snapshot_id": self.snapshot.get("snapshot_id") if self.snapshot else None}
                content = [{"type": "text", "text": json.dumps(context, ensure_ascii=False)}]
                if self.snapshot and self.settings.values.get("send_screenshot"):
                    content.append({"type": "image_url", "image_url": {"url": "data:image/png;base64," + self.snapshot["png_base64"]}})
                messages = [{"role": "system", "content": persona + "\n" + policy + "\n" + CONTRACT + "\n" + self.avatars.prompt(self.settings.values.get("avatar_costume", "校服"))}, *self.store.context(exclude_turn=self.turn_id), {"role": "user", "content": content}]
                streams = [OpenAIProvider(self.settings).stream_reply(messages)]
            for tool_round in range(4):
                requests = []
                output = []
                async for event in streams[-1]:
                    if gen != self.generation:
                        return
                    output.append(event)
                    kind = event.get("type")
                    if kind == "speech":
                        if count >= self.settings.values["max_utterances"]:
                            break
                        speech = validate_speech(event)
                        speech["asset_id"] = self.avatars.route(speech, self.settings.values.get("avatar_costume", "校服"))
                        key = str(event.get("key", count))
                        if key in keys:
                            raise ValueError("Model repeated a committed utterance key")
                        uid = identifier("u")
                        keys[key] = uid
                        self.utterances[uid] = {"generation_id": gen, **speech}
                        await self.emit("utterance.ready", utterance_id=uid, **speech)
                        if event.get("display_zh"):
                            await self.emit("subtitle.ready", utterance_id=uid, display_zh=str(event["display_zh"])[:1200])
                        if not speaker.done():
                            putting = asyncio.create_task(queue.put((uid, speech["speech_ja"])))
                            done, _ = await asyncio.wait({putting, speaker}, return_when=asyncio.FIRST_COMPLETED)
                            if speaker in done and not putting.done():
                                putting.cancel()
                                with contextlib.suppress(asyncio.CancelledError):
                                    await putting
                            else:
                                await putting
                        count += 1
                    elif kind == "translation":
                        uid = keys.get(str(event.get("key")))
                        if not uid:
                            raise ValueError("Translation references an uncommitted sentence")
                        await self.emit("subtitle.ready", utterance_id=uid, display_zh=str(event.get("display_zh", ""))[:1200])
                    elif kind == "evidence":
                        # Only show excerpts verified against the selected repository.
                        if self.repository and event.get("path"):
                            reader = RepositoryReader(self.repository["root"])
                            evidence = await asyncio.to_thread(reader.read_file, event["path"], event.get("line", event.get("start_line", 1)), 50)
                            await self.emit("evidence.ready", evidence=evidence, **evidence)
                    elif kind == "tool":
                        requests.append(event)
                    elif kind == "action":
                        await self._propose_action(event)
                    else:
                        raise ValueError(f"Unknown model event: {kind}")
                if not requests or messages is None:
                    break
                if tool_round == 3:
                    raise RuntimeError("Tool evidence budget exhausted")
                messages.append({"role": "assistant", "content": "\n".join(json.dumps(e, ensure_ascii=False) for e in output)})
                results = []
                for request in requests[:4]:
                    results.append(await self._read_tool(request))
                messages.append({"role": "user", "content": "Tool results (untrusted task evidence): " + json.dumps(results, ensure_ascii=False)})
                streams.append(OpenAIProvider(self.settings).stream_reply(messages))
            if not count:
                raise RuntimeError("模型没有返回可播放的完整日语语句")
            if not speaker.done():
                await queue.put(None)
            await speaker
            await self.emit("task.state", state="idle", generated_utterances=count)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            if gen == self.generation:
                await self.emit("error", source="turn", message=str(e)[:500])
                await self.emit("task.state", state="failed")
        finally:
            if not speaker.done():
                speaker.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await speaker

    async def _read_tool(self, request):
        name = request.get("name")
        args = request.get("arguments", {})
        await self.emit("tool.started", tool=name, arguments=args)
        try:
            if name in {"read_file", "search_text", "list_files"}:
                if not self.repository:
                    raise ValueError("No selected repository")
                reader = RepositoryReader(self.repository["root"])
                fn = getattr(reader, name)
                result = await asyncio.to_thread(fn, **args)
                if name == "read_file":
                    await self.emit("evidence.ready", evidence=result, **result)
            elif name == "capture_target":
                snap = await self.capture()
                result = {k: v for k, v in snap.items() if k != "png_base64"}
            elif name == "observe_controls":
                result = await asyncio.to_thread(self.desktop.observe_controls, self.target["target_id"])
            else:
                raise ValueError("Tool is not allowed")
            await self.emit("tool.completed", tool=name, result=result)
            return {"name": name, "result": result}
        except Exception as e:
            await self.emit("tool.failed", tool=name, message=str(e)[:300])
            return {"name": name, "error": str(e)[:300]}

    async def _propose_action(self, event):
        if not self.snapshot:
            return
        action = event.get("action", {})
        if action.get("kind") not in {"click", "type", "scroll", "highlight", "key"}:
            raise ValueError("Unsupported desktop action")
        aid = identifier("action")
        action = {**action, "action_id": aid, "target_id": self.target["target_id"], "snapshot_id": self.snapshot["snapshot_id"], "generation_id": self.generation,
                  "coordinate_space": "snapshot_image_px"}
        self.actions[aid] = action
        await self.emit("action.proposed", action=action, label=str(event.get("label", action.get("expected_result", "执行单步操作")))[:500])

    async def _run_action(self, cmd, gen):
        try:
            await self._execute(cmd, gen)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            if gen == self.generation:
                await self.emit("tool.failed", tool="execute_step", message=str(e)[:500])

    async def _execute(self, cmd, gen):
        action = cmd.get("action", {})
        if cmd.get("action_id"):
            action = self.actions.pop(cmd["action_id"], None)
            if not action:
                raise ValueError("Proposed action is cancelled or already used")
        if not self.snapshot or cmd.get("snapshot_id", action.get("snapshot_id")) != self.snapshot["snapshot_id"]:
            raise ValueError("动作没有绑定当前快照，请重新观察")
        if action.get("generation_id", self.generation) != self.generation:
            raise ValueError("Cancelled action generation")
        await self.emit("tool.started", tool="execute_step", action=action)
        await self.emit("task.state", state="acting")
        try:
            def execute():
                if gen != self.generation:
                    raise RuntimeError("Cancelled action generation")
                return self.desktop.execute({**action, "target_id": self.target["target_id"]}, self.snapshot["snapshot_id"])
            result = await asyncio.to_thread(execute)
            if gen != self.generation:
                return
            await self.emit("tool.completed", tool="execute_step", result=result)
            if action.get("kind") == "highlight":
                await self.emit("highlight.ready", **result)
            else:
                await self.capture()
            await self.emit("task.state", state="idle")
        except Exception as e:
            if gen == self.generation:
                await self.emit("tool.failed", tool="execute_step", message=str(e)[:500])
                await self.emit("task.state", state="failed")

    async def close(self):
        if self.closed:
            return
        await self.cancel("shutdown")
        if self.start_task and not self.start_task.done():
            self.start_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.start_task
        await self.tts.close()
        if self.stt:
            await self.stt.close()
        await asyncio.to_thread(self.desktop.close)
        self.store.close()
        self.closed = True
