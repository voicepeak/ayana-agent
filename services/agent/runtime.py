from __future__ import annotations

import asyncio
import contextlib
import json
import time
import uuid
import threading
from collections import OrderedDict

import httpx

from packages.protocol import PROTOCOL_VERSION, validate_speech
from .providers.model import LocalProvider, OpenAIProvider
from .prompts import PromptAssembler, update_budget, completion_feedback
from .prompts.trace import PromptTrace
from .storage import ConversationStore
from .context import PromptHistory, repository_message
from .tools.repository import RepositoryReader
from .tools.registry import ToolRegistry, ToolError, arguments, string
from .tools.policy import DirectoryPolicy
from .tools.files import FileTools
from .tools.web import WebTools
from .tools.system import SystemTools
from .tools.shell import ShellTools
from .tasks import TaskRunner
from .capabilities import CapabilityRuntime
from .computer_use import ComputerUse
from .conversations import Conversations
from .conversation_runtime import ConversationRuntime
from .work import local_clock


def identifier(prefix):
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


class AgentRuntime(CapabilityRuntime, ConversationRuntime):
    def __init__(self, settings, desktop=None, tts=None, store=None):
        self.settings = settings
        from .avatars import AvatarCatalog
        self.avatars = AvatarCatalog(settings.root)
        self.prompts = PromptAssembler(settings.root, self.avatars)
        self.prompt_trace = PromptTrace()
        if desktop is None:
            from native.windows.desktop import WindowsDesktop
            desktop = WindowsDesktop()
        if tts is None:
            from services.tts.service import TtsService
            tts = TtsService(settings.values.get("voice", {}))
        self.desktop, self.tts = desktop, tts
        self.store = store or ConversationStore(settings.data_root / ".runtime/history.sqlite3")
        self.prompt_history = PromptHistory(self.store)
        self.conversations = Conversations(self.store, settings.values.get("save_history", True))
        self.model_client = None
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
        self.last_reply_keys = {}
        self.last_reply_turn = None
        self.mode = "teach"
        self.closed = False
        self.stt = None
        self.command_lock = asyncio.Lock()
        self.close_lock = asyncio.Lock()
        self.active_task = None
        self.deadline_task = None
        self.task_gate = asyncio.Event()
        self.task_gate.set()
        self.continuation = None
        self.write_cancel = threading.Event()
        self.policy = DirectoryPolicy(settings.data_root / "artifacts", repository=lambda: (self.repository or {}).get("root"),
                                      full_access=lambda: self.full_access)
        self.shell = ShellTools(lambda: self.full_access)
        for grant in self.store.records("directory"):
            with contextlib.suppress(ValueError, OSError):
                self.policy.grant(grant["root_id"], grant["path"], grant["write"])
        self.files = FileTools(self.policy, settings.data_root, self.store)
        self.web = WebTools(lambda: settings.search_key(), search_proxy=lambda: settings.values.get("search_proxy", ""),
                            search_provider=lambda: settings.values.get("search_provider", "auto"))
        self.system = SystemTools(self.policy)
        self.window_choices = {}
        self.computer = ComputerUse(settings)
        if settings.values.get("save_history", True):
            self.web.sources.update({s["source_id"]: s for s in self.store.records("source")})
        self.registry = self._make_tools()
        self.approvals = {}
        self.client_queues = {}
        self.client_senders = {}
        self.persistence_lock = asyncio.Lock()
        for record in self.store.records("task"):
            if record["state"] in {"running", "waiting_approval", "paused"}:
                record["state"] = "interrupted"
                self.store.put_record("task", record["task_id"], record)

    async def emit(self, event_type, **payload):
        self.seq += 1
        event = {"protocol_version": PROTOCOL_VERSION, "type": event_type, "session_id": self.session_id,
                 "conversation_id": self.conversations.current_id,
                 "turn_id": self.turn_id, "generation_id": self.generation, "seq": self.seq,
                 "runtime_monotonic_ms": round(time.monotonic() * 1000), **payload}
        self.conversations.observe(event)
        if self.settings.values.get("save_history", True):
            async with self.persistence_lock:
                await asyncio.to_thread(self.store.commit, event)
                if event_type == "user.message":
                    await asyncio.to_thread(self.conversations.save)
        if event_type == "repository.inspected":
            self.conversations.current["repository_root"] = (self.repository or {}).get("root")
            await asyncio.to_thread(self.conversations.save)
        for ws in tuple(self.clients):
            if ws not in self.client_queues:
                queue = asyncio.Queue(maxsize=128)
                self.client_queues[ws] = queue
                self.client_senders[ws] = asyncio.create_task(self._send_events(ws, queue))
            try:
                self.client_queues[ws].put_nowait(event)
            except asyncio.QueueFull:
                self.clients.discard(ws)
                self.client_senders[ws].cancel()
        await asyncio.sleep(0)
        return event

    async def _send_events(self, ws, queue):
        try:
            while True:
                event = await queue.get()
                try:
                    async with asyncio.timeout(2):
                        await ws.send_json(event)
                finally:
                    queue.task_done()
        except (Exception, asyncio.CancelledError):
            self.clients.discard(ws)
        finally:
            self.client_queues.pop(ws, None)
            self.client_senders.pop(ws, None)
            if hasattr(ws, "close"):
                with contextlib.suppress(Exception):
                    async with asyncio.timeout(2):
                        await ws.close(code=1013)

    def _avatar_context(self):
        saved = self.store.recent_avatar_speeches(self.conversations.current_id) if self.settings.values.get("save_history", True) else []
        live = [{"utterance_id": uid, **speech} for uid, speech in self.utterances.items()
                if speech.get("conversation_id", self.conversations.current_id) == self.conversations.current_id]
        return self.avatars.recent_context([*saved, *live], self.settings.values.get("avatar_costume", "校服"))

    async def start(self):
        self.start_task = asyncio.create_task(self._prepare_voice())
        root = self.conversations.current.get("repository_root")
        if root:
            try:
                self.repository = await asyncio.to_thread(RepositoryReader(root).inspect)
                await self.emit("repository.inspected", repository=self.repository, **self.repository)
            except (OSError, ValueError):
                self.conversations.current["repository_root"] = None
                await asyncio.to_thread(self.conversations.save)

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
        await self._capabilities_snapshot()
        await self._conversation_snapshot()

    async def cancel(self, reason="user"):
        self.write_cancel.set()
        self.approvals.clear()
        self.files.proposals.clear()
        self.continuation = None
        if self.active_task and self.active_task.state in {"running", "paused", "waiting_approval"}:
            self.active_task.transition("cancelled")
            await self._task_event()
        old = self.generation
        self.generation += 1
        task, self.task = self.task, None
        if task and task is not asyncio.current_task():
            task.cancel()
        action_task, self.action_task = self.action_task, None
        if action_task:
            action_task.cancel()
        await self.computer.stop()
        await self.shell.stop()
        await self._stop_background(reason)
        self.actions.clear()
        for utterance in self.utterances.values():
            if utterance["generation_id"] == old and utterance.get("status", "generated") in {"generated", "playing"}:
                utterance["status"] = "partial" if utterance.get("status") == "playing" else "cancelled"
        # Keep recent cancelled records for late playback receipts.
        while len(self.utterances) > 128:
            self.utterances.pop(next(iter(self.utterances)))
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
        async with self.command_lock:
            if self.closed:
                raise RuntimeError("Runtime is closed")
            await self._handle(cmd)

    async def _handle(self, cmd: dict):
        if not isinstance(cmd, dict) or not isinstance(cmd.get("type"), str):
            raise ValueError("Command requires a type")
        kind = cmd["type"]
        if await self._conversation_command(cmd):
            return
        if await self._capability_command(cmd):
            return
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
            if self.repository and str(reader.root) != self.repository["root"]:
                await self.cancel("repository_changed")
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
            if cmd["mode"] != self.mode:
                await self.cancel("mode_changed")
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
            await self._conversation_snapshot()
            self.write_cancel = threading.Event()
            self.task_gate.set()
            self.active_task = TaskRunner(text, self.settings.values.get("task_limits", {}))
            await self._task_event()
            self.task = asyncio.create_task(self._turn(text, cmd.get("repository_root"), self.generation))
            if self.deadline_task:
                self.deadline_task.cancel()
            self.deadline_task = asyncio.create_task(self._watch_budget(self.active_task))
        elif kind == "tool.execute":
            if cmd.get("action_id") in self.approvals:
                await self._capability_command({"type": "approval.resolve", "approval_id": cmd["action_id"], "accept": True})
                return
            action = self.actions.get(cmd.get("action_id")) if cmd.get("action_id") else cmd.get("action", {})
            if not isinstance(action, dict):
                raise ValueError("Proposed action is cancelled or already used")
            if not self._execution_enabled() and action.get("kind") != "highlight":
                raise ValueError("先选择单步执行模式，再确认具体步骤")
            if self.action_task and not self.action_task.done():
                raise ValueError("另一个单步操作尚未结束")
            self.action_task = asyncio.create_task(self._run_action(cmd, self.generation))
        elif kind.startswith("playback.") or kind == "utterance.displayed":
            await self._receipt(cmd)
        elif kind == "settings.get":
            await self.emit("settings.ready", settings=self.settings.public(), api_key_configured=bool(self.settings.key()))
            await self.emit("service.state", service="tts", **self.tts.status)
            await self._capabilities_snapshot()
        elif kind == "settings.update":
            patch = cmd.get("settings", {})
            self.settings.validate(patch)
            await self.cancel("settings_changed")
            previous_costume = self.settings.values.get("avatar_costume", "校服")
            previous_voice = self.settings.values.get("voice", {})
            previous_history = self.settings.values.get("save_history", True)
            self.settings.update(patch)
            if self.settings.values.get("save_history", True) != previous_history:
                self.conversations = Conversations(self.store, self.settings.values.get("save_history", True))
                self.prompt_history = PromptHistory(self.store)
                self.repository = self.target = self.snapshot = None
                self.active_task = self.last_reply_turn = None
                self.last_reply_keys = {}
                await self.emit("repository.cleared")
                await self.emit("session.started", target=None, provider=self.settings.values["provider"])
                await self._conversation_snapshot(changed=True)
                await self._history_snapshot()
            if "stt" in patch and self.stt:
                await self.stt.close()
                self.stt = None
            if "voice" in patch and self.settings.values["voice"] != previous_voice:
                if self.start_task and not self.start_task.done():
                    self.start_task.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await self.start_task
                await self.tts.close()
                from services.tts.service import TtsService
                self.tts = TtsService(self.settings.values["voice"])
                self.start_task = asyncio.create_task(self._prepare_voice())
            await self.emit("settings.ready", settings=self.settings.public(), api_key_configured=bool(self.settings.key()), request_id=cmd.get("request_id"))
            if any(key in patch for key in ("full_access", "search_provider", "search_proxy")):
                await self._capabilities_snapshot()
            costume = self.settings.values.get("avatar_costume", "校服")
            if costume != previous_costume:
                # Commit a reply immediately; no model request or next user turn is needed.
                self.turn_id = identifier("appearance")
                speech = validate_speech({"speech_ja": "ふふ、着替えてみたけど、どうかな？", "intent": "playful",
                                          "affect": "pleased", "intensity": .4,
                                          "expression": "得意", "pose": "crossed"})
                speech.update(self.avatars.resolve(speech, costume))
                uid = identifier("u")
                self.utterances[uid] = {"generation_id": self.generation,
                                        "conversation_id": self.conversations.current_id, **speech}
                await self.emit("task.state", state="thinking")
                await self.emit("utterance.ready", utterance_id=uid, presentation="costume-change", **speech)
                await self.emit("subtitle.ready", utterance_id=uid, display_zh="我要换上新衣服啦。嘿嘿，怎么样？")
                self.task = asyncio.create_task(self._costume_voice(uid, speech["speech_ja"], self.generation))
        elif kind == "history.get":
            await self._history_snapshot(cmd.get("conversation_id"), cmd.get("before"))
        else:
            raise ValueError(f"Unknown command: {kind}")

    async def _costume_voice(self, uid, text, gen):
        queue = asyncio.Queue(maxsize=3)
        queue.put_nowait((uid, text))
        queue.put_nowait(None)
        try:
            await self._speech_worker(queue, gen)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            if gen == self.generation:
                await self.emit("service.state", service="tts", state="failed", message=str(e)[:300])
                await self.emit("error", source="tts", message="换装已保存，语音暂时不可用。")
        finally:
            if gen == self.generation:
                await self.emit("task.state", state="idle")

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
        status = {"playback.started": "playing", "playback.progress": "playing", "playback.ended": "played", "playback.cancelled": "partial"}.get(cmd["type"])
        if status:
            utterance.update(status=status, played_samples=played, displayed=True)
        elif cmd["type"] == "utterance.displayed":
            utterance["displayed"] = True
        await self.emit(cmd["type"], utterance_id=uid, played_samples=played, total_samples=total,
                        sample_rate=utterance.get("sample_rate", 0), played_audio_ms=round(played * 1000 / max(1, utterance.get("sample_rate", 1))),
                        generation_id=utterance["generation_id"],
                        conversation_id=utterance.get("conversation_id", self.conversations.current_id))
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
                self.utterances[uid]["displayed"] = True
                await self.emit("utterance.displayed", utterance_id=uid)
                continue
            await self._reserve_audio(uid, duration, gen)
            audio_bytes = __import__("base64").b64decode(audio["pcm_base64"])
            if len(audio_bytes) % 4 or audio.get("channels", 1) != 1:
                raise ValueError("Invalid mono float32 PCM")
            self.utterances[uid].update(total_samples=len(audio_bytes) // 4, sample_rate=audio["sample_rate"])
            await self.emit("audio.ready", utterance_id=uid, **{**audio, "format": "pcm_f32le"})

    async def _drain_speech(self, queue, speaker):
        if not speaker.done():
            ending = asyncio.create_task(queue.put(None))
            try:
                await asyncio.wait({ending, speaker}, return_when=asyncio.FIRST_COMPLETED)
            finally:
                if not ending.done():
                    ending.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await ending
        await speaker

    def _speech_budget(self, used=0):
        normal = self.settings.values["max_utterances"]
        detailed = max(normal, self.settings.values.get("detailed_max_utterances", 32))
        limit = detailed if self.active_task and self.active_task.detail == "detailed" else normal
        return {"normal": normal, "detailed": detailed, "used": used, "remaining": max(0, limit - used)}

    def _record_prompt(self, body, *, phase):
        self.prompt_trace.record(body, phase=phase, turn_id=self.turn_id,
                                 conversation_id=self.conversations.current_id)

    async def _turn(self, text, root, gen, continuation=None):
        queue = asyncio.Queue(maxsize=3)
        speaker = asyncio.create_task(self._speech_worker(queue, gen))
        keys = dict(continuation.get("keys", {})) if continuation else {}
        count = 0
        audio_count = continuation.get("audio_count", 0) if continuation else 0
        streams = []
        try:
            await self.emit("task.state", state="thinking")
            if root:
                self.repository = await asyncio.to_thread(RepositoryReader(root).inspect)
                await self.emit("repository.inspected", repository=self.repository, **self.repository)
            tool_schemas, tool_names = self._model_tools()
            if continuation:
                messages = continuation["messages"]
                tool_schemas, tool_names = self._model_tools(messages)
                prefix_length = continuation["prefix_length"]
                provider = OpenAIProvider(self.settings, self.model_client)
                provider.request_observer = self._record_prompt
                streams = [provider.stream_reply(messages, tools=tool_schemas, tool_names=tool_names)]
            elif self.settings.values["provider"] == "local":
                await self.emit("service.state", service="model", state="ready", engine="local-evidence", message="本地文件教学模式，无视觉模型")
                streams = [LocalProvider().stream_reply(text, self.repository, self.target)]
                messages = None
            else:
                if self.snapshot and self.target and time.monotonic() * 1000 - self.snapshot.get("captured_at_monotonic_ms", time.monotonic() * 1000) > 30000:
                    await self.capture()
                bundle = self.prompts.build(full_access=self.full_access,
                                            costume=self.settings.values.get("avatar_costume", "校服"),
                                            tools=self._tool_prompt())
                system = bundle.system
                self.prompt_history.select(system, self.settings.values, conversation_id=self.conversations.current_id)
                # Keep one copy of repository evidence ahead of dialogue history.
                evidence_prefix = repository_message(self.repository)
                context = {"mode": "execute" if self._execution_enabled() else "teach", "full_access": self.full_access, "target": self.target,
                           "local_clock": local_clock(), "work_context": self._work_context(),
                           "speech_budget": self._speech_budget(audio_count),
                           "directories": self.policy.public(include_repository=True),
                           "avatar_context": self._avatar_context(),
                           "snapshot_id": self.snapshot.get("snapshot_id") if self.snapshot else None,
                           "previous_reply_reception": self.prompt_history.last_reception(self.utterances),
                           "previous_interrupted_reply": self._interrupted_reply(), "question": text}
                content = [{"type": "text", "text": json.dumps(context, ensure_ascii=False)}]
                if self.snapshot and self.settings.values.get("send_screenshot"):
                    content.append({"type": "image_url", "image_url": {"url": "data:image/png;base64," + self.snapshot["png_base64"]}})
                reserve = len(system) + len(json.dumps(evidence_prefix, ensure_ascii=False)) + len(content[0]["text"]) + 8800
                await self._compact_history(reserve, gen)
                previous = self.prompt_history.messages(reserve_chars=reserve)
                messages = [{"role": "system", "content": system}, *evidence_prefix, *previous, {"role": "user", "content": content}]
                prefix_length = 1 + len(evidence_prefix) + len(previous)
                if self.model_client is None:
                    self.model_client = httpx.AsyncClient(timeout=httpx.Timeout(75, connect=12), trust_env=False)
                provider = OpenAIProvider(self.settings, self.model_client)
                provider.request_observer = self._record_prompt
                streams = [provider.stream_reply(messages, tools=tool_schemas, tool_names=tool_names)]
            for tool_round in range(self.settings.values.get("task_limits", {}).get("rounds", 12)):
                await self._checkpoint()
                if self.active_task:
                    self.active_task.next_round()
                    await self._task_event()
                requests = []
                round_keys = {}
                async for event in streams[-1]:
                    if gen != self.generation:
                        return
                    kind = event.get("type")
                    if kind == "speech":
                        speech = validate_speech(event)
                        # Narration limits must not abort tools, final reports or
                        # translations. Overflow sentences remain readable.
                        speech["audio_enabled"] = self._speech_budget(audio_count)["remaining"] > 0
                        speech.update(self.avatars.resolve(speech, self.settings.values.get("avatar_costume", "校服")))
                        issues = []
                        if speech["expression_source"].startswith("fallback_"):
                            issues.append("expression:" + speech["expression_source"])
                        if event.get("pose") not in {"crossed", "open"}:
                            issues.append("pose:missing_or_invalid")
                        if issues and messages is not None:
                            await self.emit("model.validation", issues=issues,
                                            key=str(event.get("key", count)),
                                            resolved_expression=speech["resolved_expression"],
                                            resolved_pose=speech["resolved_pose"])
                        key = str(event.get("key", count))
                        if key in round_keys:
                            raise ValueError("Model repeated a committed utterance key")
                        uid = identifier("u")
                        round_keys[key] = uid
                        # The same key may return in a later tool round or after
                        # an approval. Keep stored keys unique so both sentences
                        # and their receipts survive; a repeat inside one stream
                        # is still rejected above.
                        stored = key
                        suffix = 2
                        while stored in keys:
                            stored = f"{key}#{suffix}"
                            suffix += 1
                        keys[stored] = uid
                        self.last_reply_keys = keys
                        self.last_reply_turn = self.turn_id
                        self.utterances[uid] = {"generation_id": gen, "conversation_id": self.conversations.current_id, **speech}
                        await self.emit("utterance.ready", utterance_id=uid, **speech)
                        if event.get("display_zh"):
                            await self.emit("subtitle.ready", utterance_id=uid, display_zh=str(event["display_zh"])[:1200])
                        if speech["audio_enabled"] and not speaker.done():
                            putting = asyncio.create_task(queue.put((uid, speech["speech_ja"])))
                            done, _ = await asyncio.wait({putting, speaker}, return_when=asyncio.FIRST_COMPLETED)
                            if speaker in done and not putting.done():
                                putting.cancel()
                                with contextlib.suppress(asyncio.CancelledError):
                                    await putting
                            else:
                                await putting
                        if speech["audio_enabled"]:
                            audio_count += 1
                        count += 1
                    elif kind == "translation":
                        key = str(event.get("key"))
                        uid = round_keys.get(key) or keys.get(key)
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
                    elif kind == "task":
                        if self.active_task:
                            if "continues_task_id" in event:
                                context = self._work_context()
                                known = [*context.get("pending_tasks", []), context.get("last_task", {})]
                                if not any(item.get("task_id") == event["continues_task_id"] for item in known):
                                    raise ValueError("接续任务 ID 不属于当前话题的已知任务")
                            self.active_task.report(event)
                            await self._task_event()
                    elif kind == "action":
                        await self._checkpoint()
                        if self.full_access:
                            # Route legacy NDJSON actions through the same tool-result loop.
                            if not self.snapshot:
                                raise ToolError("no_snapshot", "请先观察目标窗口")
                            requests.append({"type": "tool", "name": "desktop.step", "arguments": {
                                **event.get("action", {}), "snapshot_id": self.snapshot["snapshot_id"]}})
                        else:
                            await self._propose_action(event)
                    else:
                        raise ValueError(f"Unknown model event: {kind}")
                if messages is not None:
                    if provider.usage is not None:
                        await self.emit("model.usage", model=self.settings.values["model"], tool_round=tool_round, **provider.usage)
                    # Preserve original content, event keys and JSON formatting.
                    # Playback receipts are sent only with the next user message.
                    messages = [*provider.request_messages, provider.assistant_message()]
                if not requests and messages is not None and self.active_task:
                    task = self.active_task
                    if (task.kind == "action" and task.outcome() == "needs_verification"
                            and not task.repair_requested and not self.approvals
                            and tool_round + 1 < self.settings.values.get("task_limits", {}).get("rounds", 12)):
                        task.repair_requested = True
                        messages.append({"role": "system", "content": completion_feedback(
                            task.completion_feedback(), self._speech_budget(audio_count)["remaining"])})
                        tool_schemas, tool_names = self._model_tools(messages)
                        streams.append(provider.stream_reply(messages, tools=tool_schemas, tool_names=tool_names))
                        continue
                if not requests or messages is None:
                    break
                results = []
                for request in requests:
                    results.append(await self._read_tool(request))
                # Keep native assistant tool calls adjacent to their results.
                update_budget(messages, self._speech_budget(audio_count))
                include_image = any(r.get("name") in {"capture_target", "windows.select", "desktop.step"} and "error" not in r for r in results)
                if provider.used_native_tools:
                    native_ids = {call["call_id"] for call in provider.tool_calls}
                    unhandled = []
                    for request, value in zip(requests, results):
                        call_id = request.get("call_id")
                        if call_id in native_ids:
                            messages.append({"role": "tool", "tool_call_id": call_id,
                                             "content": json.dumps(value, ensure_ascii=False)})
                        else:
                            unhandled.append(value)
                    if unhandled:
                        messages.append(self._tool_message(unhandled, include_image))
                    elif include_image:
                        image_message = self._image_message()
                        if image_message:
                            messages.append(image_message)
                else:
                    messages.append(self._tool_message(results, include_image))
                if self.approvals:
                    break
                tool_schemas, tool_names = self._model_tools(messages)
                streams.append(provider.stream_reply(messages, tools=tool_schemas, tool_names=tool_names))
            else:
                raise ToolError("round_budget", "任务工具往返已达到上限")
            await self._checkpoint()
            waiting = bool(self.approvals)
            if not count and not keys and not waiting:
                raise RuntimeError("模型没有返回可播放的完整日语语句")
            if waiting and messages is not None:
                self.continuation = {"messages": messages, "prefix_length": prefix_length, "keys": keys,
                                     "audio_count": audio_count}
            elif messages is not None:
                self.prompt_history.append(self.turn_id, messages[prefix_length:], keys,
                                           persist=self.settings.values.get("save_history", True))
            await self._conversation_snapshot()
            await self._history_snapshot()
            await self._drain_speech(queue, speaker)
            if self.active_task:
                if waiting:
                    self.active_task.transition("waiting_approval")
                else:
                    self.active_task.transition(self.active_task.outcome())
                await self._task_event()
            await self.emit("task.state", state="waiting_approval" if waiting else "idle", generated_utterances=count)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            if gen == self.generation:
                for approval_id in tuple(self.approvals):
                    await self.emit("approval.resolved", approval_id=approval_id, accepted=False)
                self.approvals.clear()
                self.files.proposals.clear()
                self.actions.clear()
                self.continuation = None
                if self.active_task:
                    self.active_task.reason = str(e)[:500]
                    self.active_task.transition("failed")
                    await self._task_event()
                await self.emit("error", source="turn", message=str(e)[:500])
                await self.emit("task.state", state="failed")
                # A later malformed model event must not cut off valid speech
                # already committed to the queue. A new turn/cancel still
                # interrupts this drain through the normal generation guard.
                with contextlib.suppress(Exception):
                    await self._drain_speech(queue, speaker)
        finally:
            for stream in streams:
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await stream.aclose()
            if not speaker.done():
                speaker.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await speaker

    def _interrupted_reply(self):
        if not self.last_reply_turn or (self.prompt_history.turns and self.prompt_history.turns[-1]["turn_id"] == self.last_reply_turn):
            return []
        return [{"key": key, "speech_ja": record["speech_ja"], "status": record.get("status", "generated"),
                 "displayed": record.get("displayed", False), "played_samples": record.get("played_samples", 0)}
                for key, uid in self.last_reply_keys.items() if (record := self.utterances.get(uid))]

    async def _read_tool(self, request):
        return await self._dispatch_tool(request)

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
        if self.full_access:
            self._write_allowed()
            self.active_task.next_call()
            result = await self._execute({"action_id": aid, "snapshot_id": action["snapshot_id"]}, self.generation)
            if result is None:
                raise ToolError("desktop_incomplete", "桌面操作未完成，请重新观察")
            if action["kind"] != "highlight":
                self.active_task.verification_pending = result.get("expected_result_verified") is not True
            return result
        await self.emit("action.proposed", action=action, label=str(event.get("label", action.get("expected_result", "执行单步操作")))[:500])
        if self.active_task and self.active_task.state == "running":
            if self.approvals:
                raise ValueError("一次只提出一个需要确认的步骤")
            await self._register_approval(action, "desktop")

    async def _run_action(self, cmd, gen):
        try:
            await self._execute(cmd, gen)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            if gen == self.generation:
                await self.emit("tool.failed", tool="execute_step", message=str(e)[:500])

    async def _execute(self, cmd, gen, *, raise_errors=False):
        action = cmd.get("action", {})
        if cmd.get("action_id"):
            action = self.actions.pop(cmd["action_id"], None)
            if not action:
                raise ValueError("Proposed action is cancelled or already used")
        if not self.snapshot or cmd.get("snapshot_id", action.get("snapshot_id")) != self.snapshot["snapshot_id"]:
            raise ValueError("动作没有绑定当前快照，请重新观察")
        if action.get("generation_id", self.generation) != self.generation:
            raise ValueError("Cancelled action generation")
        if not self._execution_enabled() and action.get("kind") != "highlight":
            raise ValueError("先选择单步执行模式，再确认具体步骤")
        target_id, snapshot_id = self.target["target_id"], self.snapshot["snapshot_id"]
        mode = self.mode
        await self.emit("tool.started", tool="execute_step", action=action)
        await self.emit("task.state", state="acting")
        try:
            def execute():
                if gen != self.generation:
                    raise RuntimeError("Cancelled action generation")
                if self.mode != mode:
                    raise RuntimeError("Task mode changed; confirm the action again")
                return self.desktop.execute({**action, "target_id": target_id}, snapshot_id)
            result = await asyncio.to_thread(execute)
            if gen != self.generation:
                return
            await self.emit("tool.completed", tool="execute_step", result=result)
            if action.get("kind") == "highlight":
                await self.emit("highlight.ready", **result)
            else:
                if result.get("result_snapshot"):
                    self.snapshot = result["result_snapshot"]
                    await self.emit("snapshot.ready", **self.snapshot)
                else:
                    await self.capture()
            await self.emit("task.state", state="idle")
            return {k: v for k, v in result.items() if k != "result_snapshot"}
        except Exception as e:
            if gen == self.generation:
                await self.emit("tool.failed", tool="execute_step", message=str(e)[:500])
                self.snapshot = None
                self.actions.clear()
                await self.emit("snapshot.invalidated")
                await self.emit("task.state", state="failed")
            if raise_errors:
                raise ToolError(getattr(e, "code", "desktop_incomplete"), str(e)[:500]) from None

    async def close(self):
        async with self.close_lock:
            await self._close()

    async def _close(self):
        if self.closed:
            return
        await self.cancel("shutdown")
        if self.deadline_task:
            self.deadline_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.deadline_task
        if self.start_task and not self.start_task.done():
            self.start_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.start_task
        await self.tts.close()
        await self.web.close()
        if self.model_client:
            await self.model_client.aclose()
        if self.stt:
            await self.stt.close()
        await asyncio.to_thread(self.desktop.close)
        for sender in tuple(self.client_senders.values()):
            sender.cancel()
        await asyncio.gather(*tuple(self.client_senders.values()), return_exceptions=True)
        self.store.close()
        self.closed = True
