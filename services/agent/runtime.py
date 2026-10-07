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
from .prompts import PromptAssembler, character_text, update_budget, completion_feedback, subtitle_language_instruction
from .prompts import TOOL_RESULT_PREFIX, INTERRUPTED_PREFIX, USER_MEMORY_PREFIX
from .prompts.trace import PromptTrace
from .storage import ConversationStore, without_media
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
from .memory import PersonalMemory, extract_memories
from .attention import AttentionRuntime


def identifier(prefix):
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


# Older tool evidence inside one in-flight turn is replaced by this notice so
# the project's own budget also constrains tool rounds, not just history.
COMPRESSED_TOOL_NOTICE = "Tool result omitted to stay within the context budget; re-read if still needed. "
BUDGET_FINAL_NOTICE = ("This is the final round of the turn: no further tool calls will run. "
                       "Answer with the evidence you already have — a short factual speech and a task report "
                       "with status complete/blocked/needs_input. Never claim unverified results as success.")


class AgentRuntime(AttentionRuntime, CapabilityRuntime, ConversationRuntime):
    def __init__(self, settings, desktop=None, tts=None, store=None):
        self.settings = settings
        from .avatars import AvatarCatalog
        self.avatars = AvatarCatalog(settings.root, character=settings.values.get("character"),
                                     avatar_root=settings.values.get("avatar_root"))
        self.prompts = PromptAssembler(settings.root, self.avatars)
        self.search_identity = character_text(settings.root, "persona.md").splitlines()[0].lstrip("# ").split("（")[0].strip()
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
        self.memory = PersonalMemory(self.store)
        self.memory_task = None
        self.context_job = None
        self.memory_retry_at = 0
        self.memory_state = 'ready'
        self.conversations = Conversations(self.store, settings.values.get("save_history", True))
        self.model_client = None
        self.session_id = identifier("session")
        self.turn_id = ""
        self.generation = 0
        self.seq = 0
        self.clients = set()
        self.target = None
        self.snapshot = None
        self.observation = None
        self._init_attention()
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
        self.last_reply_delivered = None
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
        self.subtitle_jobs = set()
        self.subtitle_pending = set()
        self.subtitle_lock = asyncio.Lock()
        for record in self.store.records("task"):
            if record["state"] in {"running", "waiting_approval", "paused"}:
                record["state"] = "interrupted"
                self.store.put_record("task", record["task_id"], record)
        # Keep the topic's task snapshot consistent with that single record.
        self._reconcile_restart_tasks()

    async def emit(self, event_type, **payload):
        if event_type in {"subtitle.ready", "subtitle.translated"} and (record := self.utterances.get(payload.get("utterance_id"))):
            record.update({key: payload[key] for key in ("display_zh", "display_en") if isinstance(payload.get(key), str)})
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
        self.attention_runner = asyncio.create_task(self._attention_loop())
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
        await self._memory_snapshot()

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
        except Exception as error:
            self.snapshot = None
            self.actions.clear()
            await self.emit("snapshot.invalidated", reason=getattr(error, "code", None), message=str(error)[:500])
            raise
        self.snapshot = snap
        await self.emit("snapshot.ready", **snap)
        if self.task is None or self.task.done():
            await self.emit("task.state", state="idle")
        self.observation = {"available": True}
        return snap

    async def _mark_unobserved(self, error):
        self.observation = {"available": False, "code": getattr(error, "code", "capture_failed"),
                            "message": "目标窗口当前无法截图。对话可以继续；查看或操作前请恢复窗口。"}
        await self.emit("observation.unavailable", target=self.target, **self.observation)

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
            # Opening the companion is not a request to watch a window.
            await self.cancel("summon")
            self.companion_visible = True
            self.target = None
            self.snapshot = None
            self.actions.clear()
            await self.emit("snapshot.invalidated")
            self.observation = None
            await self.emit("session.started", target=None, provider=self.settings.values["provider"])
        elif kind == "session.close":
            self.companion_visible = False
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
            if cmd.get("watch") and not self.settings.values.get("send_screenshot"):
                return
            try:
                await self.capture()
            except Exception as error:
                if cmd.get("watch"):
                    await self._mark_unobserved(error)
                else:
                    await self.emit("error", source="capture", message=str(error)[:500])
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
            # Immediate, literal attention controls also work without an online model.
            import re
            attention_text = re.sub(r"[，。！!？?\s]", "", text)
            if attention_text in {"别看了", "不要偷看", "暂停偷看", "停止偷看", "彩名别看了"}:
                await self._attention_configure(False)
            elif attention_text in {"继续看", "可以偷看", "恢复偷看", "彩名继续看"}:
                await self._attention_configure(True)
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
            validated = self.settings.validate(patch)
            # Presentation changes can be applied while a reply is playing.
            # Persist first: a failed write must not stop a task or voice.
            presentation = {"companion_ui", "avatar_costume", "volume", "subtitles", "sentence_motion", "hotkey", "cancel_hotkey", "ambient_attention", "remember_user"}
            interrupt = any(key not in presentation and value != self.settings.values.get(key)
                            for key, value in validated.items())
            previous_voice = self.settings.values.get("voice", {})
            previous_character = self.settings.values.get("character")
            previous_history = self.settings.values.get("save_history", True)
            self.settings.update(patch)
            if self.settings.values.get("character") != previous_character:
                from .avatars import AvatarCatalog
                self.avatars = AvatarCatalog(self.settings.root, character=self.settings.values.get("character"),
                                             avatar_root=self.settings.values.get("avatar_root"))
                self.prompts = PromptAssembler(self.settings.root, self.avatars)
            if 'remember_user' in patch or 'save_history' in patch:
                self.memory.revision += 1
                await self._memory_snapshot()
            if interrupt:
                await self.cancel("settings_changed")
            if self.settings.values.get("save_history", True) != previous_history:
                self.conversations = Conversations(self.store, self.settings.values.get("save_history", True))
                self.prompt_history = PromptHistory(self.store)
                self.repository = self.target = self.snapshot = None
                self.active_task = self.last_reply_turn = None
                self.last_reply_keys = {}
                self.last_reply_delivered = None
                await self.emit("repository.cleared")
                await self.emit("session.started", target=None, provider=self.settings.values["provider"])
                await self._conversation_snapshot(changed=True)
                await self._history_snapshot()
            if "stt" in patch and self.stt:
                await self.stt.close()
                self.stt = None
            if self.settings.values["voice"] != previous_voice:
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
        elif kind == "history.get":
            await self._history_snapshot(cmd.get("conversation_id"), cmd.get("before"))
        elif kind == "subtitles.translate":
            ids = cmd.get("utterance_ids")
            if cmd.get("language") != "en" or not isinstance(ids, list) or not 1 <= len(ids) <= 30 or any(not isinstance(uid, str) or len(uid) > 100 for uid in ids):
                raise ValueError("Invalid subtitle translation request")
            self._queue_subtitle_translation(self.conversations.current_id, ids)
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
        messages = None
        prefix_length = 0
        reserve = continuation.get("reserve", 0) if continuation else 0
        sealed = False
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
                self._cap_request(messages, prefix_length, reserve)
                streams = [provider.stream_reply(messages, tools=tool_schemas, tool_names=tool_names)]
            elif self.settings.values["provider"] == "local":
                await self.emit("service.state", service="model", state="ready", engine="local-evidence", message="本地文件教学模式，无视觉模型")
                streams = [LocalProvider().stream_reply(text, self.repository, self.target)]
                messages = None
            else:
                # Observations are requested through tools. Expire old images instead
                # of making an unrelated chat message trigger another capture.
                if self.snapshot and time.monotonic() * 1000 - self.snapshot.get("captured_at_monotonic_ms", time.monotonic() * 1000) > 30000:
                    self.snapshot = None
                    self.actions.clear()
                    self.observation = {"available": False, "code": "stale_snapshot", "message": "上一次观察已过期，需要时可以重新看看。"}
                    await self.emit("snapshot.invalidated")
                bundle = self.prompts.build(full_access=self.full_access,
                                            costume=self.settings.values.get("avatar_costume", "校服"),
                                            tools=self._tool_prompt())
                system = bundle.system + subtitle_language_instruction(self.settings.values)
                self.prompt_history.select(system, self.settings.values, conversation_id=self.conversations.current_id)
                # Keep one copy of repository evidence ahead of dialogue history.
                evidence_prefix = repository_message(self.repository)
                context = {"mode": "execute" if self._execution_enabled() else "teach", "full_access": self.full_access, "target": self.target,
                           "observation": self.observation or {"available": bool(self.snapshot)},
                           "ambient_attention": self.settings.values.get("ambient_attention", True),
                           "recent_observations": [item for item in self.recent_observations
                                                   if item["conversation_id"] == self.conversations.current_id],
                           "local_clock": local_clock(), "work_context": self._prompt_work_context(),
                           "speech_budget": self._speech_budget(audio_count),
                           "directories": self.policy.public(include_repository=True),
                           "avatar_context": self._avatar_context(),
                           "snapshot_id": self.snapshot.get("snapshot_id") if self.snapshot else None,
                           "previous_reply_reception": self.prompt_history.last_reception(self.utterances),
                           "previous_interrupted_reply": self._interrupted_reply(), "question": text}
                memories = self.memory.prompt() if self._memory_enabled() else []
                memory_prefix = [{'role': 'system', 'content': USER_MEMORY_PREFIX + json.dumps(memories,ensure_ascii=False)}] if memories else []
                content = [{"type": "text", "text": json.dumps(context, ensure_ascii=False)}]
                if self.snapshot and self.settings.values.get("send_screenshot"):
                    content.append({"type": "image_url", "image_url": {"url": "data:image/png;base64," + self.snapshot["png_base64"]}})
                reserve = len(system) + len(json.dumps(evidence_prefix, ensure_ascii=False)) + len(content[0]["text"]) + len(json.dumps(memory_prefix,ensure_ascii=False)) + 8800
                await self._compact_history(reserve, gen)
                previous = self.prompt_history.messages(reserve_chars=reserve)
                messages = [{"role": "system", "content": system}, *evidence_prefix, *previous, {"role": "user", "content": content}, *memory_prefix]
                prefix_length = 1 + len(evidence_prefix) + len(previous)
                if self.model_client is None:
                    self.model_client = httpx.AsyncClient(timeout=httpx.Timeout(75, connect=12), trust_env=False)
                provider = OpenAIProvider(self.settings, self.model_client)
                provider.request_observer = self._record_prompt
                streams = [provider.stream_reply(messages, tools=tool_schemas, tool_names=tool_names)]
            report_repair_requested = False
            report_only_round = False
            repair_allow_speech = False
            final_round = self.settings.values.get("task_limits", {}).get("rounds", 12)
            # One extra iteration after the tool rounds stays tools-free so the
            # model can summarize the results it already has instead of losing
            # them to a hard budget error.
            for tool_round in range(final_round + 1):
                wrap_up = tool_round >= final_round
                await self._checkpoint()
                if self.active_task:
                    if not wrap_up:
                        self.active_task.next_round()
                    await self._task_event()
                requests = []
                round_keys = {}
                async for event in streams[-1]:
                    if gen != self.generation:
                        return
                    kind = event.get("type")
                    if report_only_round and kind != "task" and not (repair_allow_speech and kind in {"speech", "translation"}):
                        provider.report_errors.append({"issue": "报告修复只能返回任务报告，不能重复语音或调用工具"})
                        continue
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
                            await self.emit("subtitle.ready", utterance_id=uid, display_zh=str(event["display_zh"])[:1200],
                                            **({"display_en": event["display_en"][:1200]} if isinstance(event.get("display_en"), str) else {}))
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
                        await self.emit("subtitle.ready", utterance_id=uid, display_zh=str(event.get("display_zh", ""))[:1200],
                                        **({"display_en": event["display_en"][:1200]} if isinstance(event.get("display_en"), str) else {}))
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
                            try:
                                if "continues_task_id" in event:
                                    context = self._work_context()
                                    known = [*context.get("pending_tasks", []), context.get("last_task", {})]
                                    if not any(item.get("task_id") == event["continues_task_id"] for item in known):
                                        raise ValueError("接续任务 ID 不属于当前话题的已知任务")
                                self.active_task.report(event)
                            except (ValueError, TypeError) as error:
                                provider.report_errors.append({"issue": str(error)[:300]})
                            else:
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
                report_feedback = None
                if messages is not None and provider.report_errors:
                    issues = [item["issue"] for item in provider.report_errors]
                    await self.emit("model.validation", issues=issues, phase="task_report")
                    self._record_prompt({"issues": provider.report_errors}, phase="task_report_validation")
                    report_feedback = {"role": "system", "content":
                        "Correct only the invalid task report. Already emitted speech and tool results are committed; "
                        "do not repeat speech, tools or operations. Preserve task kind, goal and agreed check descriptions. "
                        "Use only real current-task call_ids and factual result pointers; never invent completion evidence. "
                        + ("No speech was committed yet; also supply a brief factual speech and its translation. " if not (count or keys) else "") +
                        "Return one valid task NDJSON event (running/complete/blocked/needs_input; reason required for "
                        "blocked/needs_input). Report fields: type,kind,goal,detail,status,reason,checks,continues_task_id. "
                        "Each check: description,evidence. Each fact: call_id,pointer,operator,value. "
                        + json.dumps({"issues": issues, "current_task": self.active_task.public() if self.active_task else None}, ensure_ascii=False)}
                    if not requests:
                        if wrap_up:
                            # The final round cannot repair the report; keep the
                            # factual speech and let the turn end here.
                            break
                        if report_repair_requested:
                            if count or keys:
                                # Committed speech outranks report metadata: keep
                                # the reply and finish as needs_verification
                                # instead of dropping it on a second repair miss.
                                break
                            raise ToolError("invalid_task_report", "任务报告校验仍未通过，已有工具结果已保留；请重新发起这一步")
                        report_repair_requested = True
                        report_only_round = True
                        repair_allow_speech = not (count or keys)
                        messages.append(report_feedback)
                        self._cap_request(messages, prefix_length, reserve)
                        # A metadata correction cannot request tools or replay operations.
                        streams.append(provider.stream_reply(messages))
                        continue
                if not requests and messages is not None and self.active_task:
                    task = self.active_task
                    if (task.kind == "action" and task.outcome() == "needs_verification"
                            and not task.repair_requested and not self.approvals
                            and tool_round + 1 < self.settings.values.get("task_limits", {}).get("rounds", 12)):
                        task.repair_requested = True
                        report_only_round = False
                        messages.append({"role": "system", "content": completion_feedback(
                            task.completion_feedback(), self._speech_budget(audio_count)["remaining"])})
                        tool_schemas, tool_names = self._model_tools(messages)
                        self._cap_request(messages, prefix_length, reserve)
                        streams.append(provider.stream_reply(messages, tools=tool_schemas, tool_names=tool_names))
                        continue
                if not requests or messages is None:
                    break
                if wrap_up:
                    # No tools were offered in the wrap-up round, so a late NDJSON
                    # tool request is out of budget and is not executed.
                    break
                results = await self._dispatch_tools(requests, provider.tool_errors)
                # Keep native assistant tool calls adjacent to their results.
                update_budget(messages, self._speech_budget(audio_count))
                include_image = any(r.get("name") in {"desktop.observe", "desktop.step"} and "error" not in r for r in results)
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
                if report_feedback:
                    if report_repair_requested:
                        if count or keys:
                            break
                        raise ToolError("invalid_task_report", "任务报告校验仍未通过，已有工具结果已保留；请重新发起这一步")
                    report_repair_requested = True
                    report_only_round = True
                    repair_allow_speech = not (count or keys)
                    messages.append(report_feedback)
                    self._cap_request(messages, prefix_length, reserve)
                    streams.append(provider.stream_reply(messages))
                    continue
                if self.approvals:
                    break
                if tool_round + 1 >= final_round:
                    messages.append({"role": "system", "content": BUDGET_FINAL_NOTICE})
                    self._cap_request(messages, prefix_length, reserve)
                    streams.append(provider.stream_reply(messages))
                else:
                    tool_schemas, tool_names = self._model_tools(messages)
                    self._cap_request(messages, prefix_length, reserve)
                    streams.append(provider.stream_reply(messages, tools=tool_schemas, tool_names=tool_names))
            else:
                raise ToolError("round_budget", "任务工具往返已达到上限")
            await self._checkpoint()
            waiting = bool(self.approvals)
            if not count and not keys and not waiting:
                raise RuntimeError("模型没有返回可播放的完整日语语句")
            if waiting and messages is not None:
                self.continuation = {"messages": messages, "prefix_length": prefix_length, "keys": keys,
                                     "audio_count": audio_count, "reserve": reserve,
                                     "native_tool_ids": [call.get("call_id") for call in (provider.tool_calls or [])]
                                                         if provider.used_native_tools else []}
                sealed = True
            elif messages is not None:
                self.prompt_history.append(self.turn_id, messages[prefix_length:], keys,
                                           persist=self.settings.values.get("save_history", True))
                self.last_reply_delivered = self.turn_id
                sealed = True
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
            if not waiting and messages is not None:
                self._queue_maintenance(reserve)
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
                message = self._display_error(e)
                if self.active_task:
                    self.active_task.reason = message
                    self.active_task.transition("failed")
                    await self._task_event()
                await self.emit("error", source="turn", message=message)
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
            # Success seals in the try block; failure or cancellation must still
            # persist the confirmed exchange so tool evidence is not lost.
            if messages is not None and not sealed:
                self._seal_interrupted_turn(messages, prefix_length)

    @staticmethod
    def _display_error(error):
        """Map provider or transport failures to ordinary language for the note."""
        text = str(error)
        if text.startswith(("Model application events", "Model returned malformed",
                            "Model returned no application events", "No committed sentence",
                            "Model returned invalid Japanese speech", "Japanese sentence repair")):
            return "这次的回答格式不完整，已经说出的内容会保留；再说一次或换个说法就好。"
        if text.startswith("Model stream ended early"):
            return "模型的回答被截断了，请再试一次，或把事情拆小一点。"
        if text.startswith("Model stream disconnected"):
            return "模型连接中断了，请稍后再试。"
        if text.startswith("Model API returned HTTP"):
            return f"模型服务暂时不可用（{text.rsplit(' ', 1)[-1]}），请稍后再试。"
        if text.startswith("Model declined"):
            return "模型这次没有回答，换个说法试试。"
        return text[:500]

    def _seal_interrupted_turn(self, messages, prefix_length):
        if not self.turn_id:
            return
        if any(turn["turn_id"] == self.turn_id for turn in self.prompt_history.turns):
            return
        goal = self.active_task.goal if self.active_task else None
        items = self.conversations.history(self.conversations.current_id)["items"]
        evidence = {"state": "interrupted",
                    "reply": [item for item in items
                              if item.get("turn_id") == self.turn_id and item.get("role") == "assistant"],
                    "actual_tool_results": self.active_task.results if self.active_task else {}}
        factual = [message for message in messages[prefix_length:] if message.get("role") != "system"]
        # A cancelled batch may have returned only some calls. Native APIs require
        # a reply for every announced call before the next user turn. Preserve real
        # receipts and explicitly mark missing ones as unknown, never successful.
        completed = []
        index = 0
        while index < len(factual):
            message = factual[index]
            completed.append(message)
            index += 1
            if message.get("role") != "assistant" or not message.get("tool_calls"):
                continue
            replies = {}
            while index < len(factual) and factual[index].get("role") == "tool":
                replies[factual[index].get("tool_call_id")] = factual[index]
                index += 1
            for call in message["tool_calls"]:
                cid = call["id"]
                if cid in replies:
                    completed.append(replies[cid])
                    continue
                entry = self.active_task.results.get(cid) if self.active_task else None
                value = entry["value"] if entry else {"call_id": cid, "code": "interrupted",
                    "error": "本次调用未取得完成回执；不要自动重复操作，请先核实当前状态",
                    "receipt": {"execution": "uncertain", "verification": "unverified",
                                "scope": "completion_receipt_missing", "retryable": False}}
                completed.append({"role": "tool", "tool_call_id": cid,
                                  "content": json.dumps(value, ensure_ascii=False)})
        factual = completed
        if not factual and goal:
            factual = [{"role": "user", "content": goal}]
        sealed_messages = [*factual, {"role": "user", "content": INTERRUPTED_PREFIX + json.dumps(
            without_media(evidence), ensure_ascii=False)}]
        self.prompt_history.append(self.turn_id, sealed_messages, {},
                                   persist=self.settings.values.get("save_history", True))

    def _interrupted_reply(self):
        if not self.last_reply_turn or self.last_reply_delivered == self.last_reply_turn:
            return []
        return [{"key": key, "speech_ja": record["speech_ja"], "status": record.get("status", "generated"),
                 "displayed": record.get("displayed", False), "played_samples": record.get("played_samples", 0)}
                for key, uid in self.last_reply_keys.items() if (record := self.utterances.get(uid))]

    async def _read_tool(self, request):
        return await self._dispatch_tool(request)

    def _memory_enabled(self):
        return bool(self.settings.values.get('save_history', True) and self.settings.values.get('remember_user', True))

    async def _memory_snapshot(self, request_id=None):
        await self.emit('memory.ready',memories=self.memory.public(),enabled=self._memory_enabled(),state=self.memory_state,request_id=request_id)

    def _queue_maintenance(self, reserve):
        if self.closed or self.settings.values['provider'] == 'local':
            return
        if self._memory_enabled() and (not self.memory_task or self.memory_task.done()) and time.monotonic()>=self.memory_retry_at:
            sources = self.store.user_memory_sources(self.memory.watermark)
            if len(sources)>=4:
                self.memory_task = asyncio.create_task(self._learn_memories(sources))
        if (not self.settings.values.get('save_history',True) or self.context_job and not self.context_job.done()):
            return
        # Start before pressure reaches the hard ceiling, while the user reads
        # or hears the reply. Never change the visible conversation ID.
        budget = self.prompt_history.max_chars - reserve
        turns = self.prompt_history.turns
        size = sum(len(json.dumps(turn,ensure_ascii=False)) for turn in turns)+len(self.prompt_history.summary)
        if len(turns)>6 and size>max(8000,budget*.85):
            count = 0
            sizes = [len(json.dumps(turn,ensure_ascii=False)) for turn in turns]
            while count<len(turns)-6 and sum(sizes[count:])>budget*.65:
                count += 1
            if count:
                from copy import deepcopy
                self.context_job = asyncio.create_task(self._background_summary(
                    self.conversations.current_id,self.prompt_history.scope,deepcopy(turns[:count]),self.prompt_history.summary))

    async def _learn_memories(self, sources):
        revision = self.memory.revision
        self.memory_state = 'learning'
        model = self.settings.values['model']
        async def usage(value):
            await self.emit('maintenance.usage',phase='personal_memory',model=model,usage=value)
        try:
            await self._memory_snapshot()
            value = await extract_memories(self.settings,self.model_client,sources,self.memory.records(),
                                           request_observer=self._record_prompt,usage_observer=usage)
            async with self.command_lock:
                if self._memory_enabled() and self.conversations.persist:
                    self.memory.apply(value,sources,revision)
            self.memory_state = 'ready'
        except asyncio.CancelledError:
            self.memory_state = 'ready'
            raise
        except Exception:
            # Memory extraction must never fail or delay the user's turn.
            self.memory_state = 'failed'
            self.memory_retry_at = time.monotonic()+300
        finally:
            if not self.closed:
                await self._memory_snapshot()

    async def _background_summary(self, cid, scope, turns, previous):
        model = self.settings.values['model']
        def trace(body, *, phase):
            self.prompt_trace.record(body,phase=phase,conversation_id=cid)
        async def usage(value):
            await self.emit('maintenance.usage',phase='history_summary',model=model,usage=value)
        try:
            from .context import summarize_history, summary_batches
            for turn in turns:
                turn['reply_reception'] = self.store.reception(turn['turn_id'],turn['keys'])
            summary = previous
            async with asyncio.timeout(48):
                for batch in summary_batches(turns):
                    summary = await summarize_history(self.settings,self.model_client,summary,batch,
                                                       request_observer=trace,usage_observer=usage)
            async with self.command_lock:
                if not self.conversations.persist or cid not in self.conversations.records:
                    return
                active = self.prompt_history.scope == scope
                current = self.prompt_history.turns if active else self.store.model_turns(scope)
                if [turn['turn_id'] for turn in current[:len(turns)]] != [turn['turn_id'] for turn in turns]:
                    return
                remaining = current[len(turns):]
                if active:
                    self.prompt_history.compact(len(turns),summary)
                    await self._conversation_snapshot()
                else:
                    self.store.compact_context(scope,remaining,summary)
        except asyncio.CancelledError:
            raise
        except Exception:
            pass  # Keep the complete original history when background maintenance fails.

    def _cap_request(self, messages, prefix_length, reserve_chars):
        """Keep an in-flight request, including tool rounds, within budget.

        Only current-turn evidence after the latest user message is compressed;
        the fixed prefix and the live question are left untouched.
        """
        if messages is None:
            return messages
        # History assembly already reserved the fixed prefix. Subtracting it
        # again compresses tool results that still fit the request ceiling.
        budget = self.prompt_history.max_chars
        if budget <= 0:
            return messages
        def size():
            return len(json.dumps(messages, ensure_ascii=False))
        if size() <= budget:
            return messages
        for index in range(prefix_length + 1, len(messages)):
            if size() <= budget:
                break
            message = messages[index]
            content = message.get("content")
            if message.get("role") == "tool":
                message["content"] = COMPRESSED_TOOL_NOTICE + json.dumps(
                    {"call_id": message.get("tool_call_id")}, ensure_ascii=False)
            elif isinstance(content, str) and content.startswith(TOOL_RESULT_PREFIX):
                try:
                    value = json.loads(content[len(TOOL_RESULT_PREFIX):])
                except (ValueError, TypeError):
                    continue
                if isinstance(value, list):
                    for item in value:
                        if isinstance(item, dict):
                            item.pop("result", None)
                            item.pop("receipt", None)
                            item["compressed"] = True
                message["content"] = TOOL_RESULT_PREFIX + json.dumps(value, ensure_ascii=False)
            elif isinstance(content, list):
                stripped = [part for part in content if part.get("type") != "image_url"]
                if len(stripped) != len(content):
                    message["content"] = stripped
        return messages

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

    def _queue_subtitle_translation(self, conversation_id, ids):
        fresh = [uid for uid in dict.fromkeys(ids) if (conversation_id, uid) not in self.subtitle_pending]
        if not fresh or self.closed:
            return
        self.subtitle_pending.update((conversation_id, uid) for uid in fresh)
        task = asyncio.create_task(self._translate_subtitles(conversation_id, fresh))
        self.subtitle_jobs.add(task)
        task.add_done_callback(self.subtitle_jobs.discard)

    async def _translate_subtitles(self, conversation_id, ids):
        try:
            async with self.subtitle_lock:
                stored = await asyncio.to_thread(self.store.subtitle_sources, conversation_id, ids)
                records = {r["utterance_id"]: r for r in stored}
                for uid in ids:
                    record = self.utterances.get(uid)
                    if record and record.get("conversation_id") == conversation_id:
                        records[uid] = {"utterance_id": uid, **record}
                missing = [r for r in records.values() if not r.get("display_en")]
                if missing:
                    if self.settings.values["provider"] == "local":
                        translations = {r["utterance_id"]: LocalProvider.english(r["speech_ja"], r.get("display_zh", "")) for r in missing}
                        if any(not value for value in translations.values()):
                            raise ValueError("Local mode cannot translate arbitrary historical sentences")
                    else:
                        if self.model_client is None:
                            self.model_client = httpx.AsyncClient(timeout=httpx.Timeout(75, connect=12), trust_env=False)
                        provider = OpenAIProvider(self.settings, self.model_client)
                        provider.request_observer = self._record_prompt
                        translations = await provider.translate_subtitles(missing)
                    for uid, text in translations.items():
                        records[uid]["display_en"] = text
                for uid, record in records.items():
                    await self.emit("subtitle.translated", utterance_id=uid, display_en=record["display_en"],
                                    conversation_id=conversation_id, generation_id=record.get("generation_id", self.generation))
        except asyncio.CancelledError:
            raise
        except Exception:
            await self.emit("subtitle.translation-failed", utterance_ids=ids, conversation_id=conversation_id,
                            message="英文字幕暂不可用，请稍后重试。")
        finally:
            self.subtitle_pending.difference_update((conversation_id, uid) for uid in ids)

    async def close(self):
        async with self.close_lock:
            await self._close()

    async def _close(self):
        if self.closed:
            return
        await self.cancel("shutdown")
        if self.attention_runner:
            self.attention_runner.cancel()
            await asyncio.gather(self.attention_runner, return_exceptions=True)
        for job in (self.memory_task,self.context_job):
            if job and not job.done():
                job.cancel()
        await asyncio.gather(*(job for job in (self.memory_task,self.context_job) if job),return_exceptions=True)
        for job in tuple(self.subtitle_jobs):
            job.cancel()
        await asyncio.gather(*tuple(self.subtitle_jobs), return_exceptions=True)
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
