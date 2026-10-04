"""Tool dispatch, task receipts and user-only approval commands."""
from __future__ import annotations

import asyncio
import contextlib
import json
import threading

from .tasks import TaskRunner
from .tools.registry import ToolRegistry, ToolError, arguments, string
from .tools.repository import RepositoryReader
from packages.protocol import validate_tool_request


class CapabilityRuntime:
    def _make_tools(self):
        registry = ToolRegistry()
        integer = lambda low, high: {"type": "integer", "minimum": low, "maximum": high}
        async def repository(method, **args):
            if not self.repository:
                raise ToolError("no_repository", "请先选择仓库")
            return await asyncio.to_thread(getattr(RepositoryReader(self.repository["root"]), method), **args)
        async def read_file(**args):
            result = await repository("read_file", **args)
            await self.emit("evidence.ready", evidence=result, **result)
            return result
        async def search_text(**args):
            return await repository("search_text", **args)
        async def list_files(**args):
            return await repository("list_files", **args)
        registry.add("read_file", "读取已选择仓库的源码", arguments({"path": string(), "start_line": integer(1, 1000000), "max_lines": integer(1, 200)}, ["path"]), read_file)
        registry.add("search_text", "在所选仓库搜索关键词", arguments({"query": string(120), "limit": integer(1, 100)}, ["query"]), search_text)
        registry.add("list_files", "列举所选仓库文本文件", arguments({"limit": integer(1, 400)}), list_files)
        registry.add("capture_target", "重新截图；新图片随后交给模型", arguments(), self._capture_tool)
        registry.add("observe_controls", "读取当前绑定窗口的控件", arguments(), self._controls_tool)
        registry.add("computer.run", "执行模式：在用户绑定的当前窗口完成明确要求的桌面任务。自动观察、输入或点击、核实结果；不能启动应用、跨窗口操作或执行命令。只有用户要求操作桌面时使用。", arguments({"goal": string(4000)}, ["goal"]), self._computer_tool, "write")
        registry.set_availability("computer.run", lambda: bool(self.computer.status["available"]))
        registry.add("web.search", "公网搜索；重要结论继续 web.fetch 核对原文", arguments({"query": string(1000), "count": integer(1, 10)}, ["query"]), self._web_search)
        registry.add("web.fetch", "读取公网网页或 source_id 的正文", arguments({"url": string(3000)}, ["url"]), self._web_fetch)
        path_args = {"root_id": string(100), "path": string()}
        registry.add("files.read", "读取完整 UTF-8 文本与 sha256；root_id 来自授权目录", arguments(path_args, path_args), self._file_read)
        registry.add("files.create", "执行模式：在授权目录创建新文本文件，绝不覆盖", arguments({**path_args, "content": string(40000)}, [*path_args, "content"]), self._file_create, "write")
        registry.add("files.propose_edit", "读取后，用 base_sha256 和完整新内容提出差异，等待用户确认", arguments({**path_args, "base_sha256": string(64), "content": {"type": "string", "maxLength": 40000}}, [*path_args, "base_sha256", "content"]), self._file_propose, "preview")
        registry.add("files.propose_restore", "为 artifact_id 的备份生成恢复差异，等待确认", arguments({"artifact_id": string(100)}, ["artifact_id"]), self._file_restore, "preview")
        return registry

    async def _capture_tool(self):
        snap = await self.capture()
        return {k: v for k, v in snap.items() if k != "png_base64"}

    async def _controls_tool(self):
        if not self.target:
            raise ToolError("no_target", "请先选择目标窗口")
        return await asyncio.to_thread(self.desktop.observe_controls, self.target["target_id"])

    async def _computer_progress(self, event):
        task = self.active_task
        if not task:
            return
        if event["type"] == "confirmation":
            approval = {"approval_id": event["approval_id"], "kind": "computer", "action_kind": "desktop",
                        "task_id": task.task_id, "generation_id": self.generation,
                        "expected_result": event["message"]}
            self.approvals[approval["approval_id"]] = approval
            task.transition("waiting_approval")
            await self.emit("approval.required", approval=approval)
            await self._task_event()
        elif event["type"] == "model":
            task.next_round()
            await self._task_event()
        elif event["type"] == "action":
            task.next_call()
            await self._task_event()
        await self.emit("computer.progress", task_id=task.task_id, progress=event)

    async def _computer_tool(self, goal):
        self._write_allowed()
        if not self.target:
            raise ToolError("no_target", "请先选择目标窗口")
        result = await self.computer.run(goal, dict(self.target), self._computer_progress,
                                         limits=self.settings.values.get("task_limits", {}),
                                         assistant_windows=getattr(self.desktop, "_assistant_windows", ()))
        self.active_task.verification_pending = result["status"] == "needs_verification"
        if result["status"] == "failed":
            raise ToolError("computer_incomplete", result["reason"])
        await self.emit("computer.completed", task_id=self.active_task.task_id, result=result)
        # Refresh the existing context panel through its normal capture path.
        try:
            await self.capture()
        except Exception:
            self.active_task.verification_pending = True
        return result

    async def _computer_turn(self, goal, generation):
        try:
            await self.emit("task.state", state="executing")
            result = await self._computer_tool(goal)
            if generation == self.generation:
                self.active_task.transition(result["status"])
                await self._task_event()
                await self.emit("task.state", state="idle")
        except asyncio.CancelledError:
            raise
        except Exception as error:
            if generation == self.generation:
                self.active_task.transition("failed")
                await self._task_event()
                await self.emit("task.state", state="failed")
                await self.emit("error", source="computer", message=str(error)[:500])

    async def _web_search(self, **args):
        result = await self.web.search(**args)
        for source in result:
            if self.settings.values.get("save_history", True):
                await asyncio.to_thread(self.store.put_record, "source", source["source_id"], source)
            await self.emit("source.ready", source=source)
        return result

    async def _web_fetch(self, **args):
        result = await self.web.fetch(**args)
        if self.settings.values.get("save_history", True):
            await asyncio.to_thread(self.store.put_record, "source", result["source_id"], {k: v for k, v in result.items() if k != "content"})
        await self.emit("source.ready", source={k: v for k, v in result.items() if k != "content"})
        return result

    async def _file_read(self, **args):
        return await asyncio.to_thread(self.files.read, **args)

    def _write_allowed(self):
        if self.mode != "execute":
            raise ToolError("execution_mode_required", "请先在管理窗口切换到执行模式")
        if not self.active_task or self.active_task.state != "running":
            raise ToolError("inactive_task", "当前没有可执行的任务")

    async def _file_create(self, **args):
        self._write_allowed()
        token = self.write_cancel
        worker = asyncio.create_task(asyncio.to_thread(self.files.create, **args, cancelled=token))
        # Once a filesystem operation starts, wait for its real outcome on cancellation.
        try:
            result = await asyncio.shield(worker)
        except asyncio.CancelledError:
            token.set()
            with contextlib.suppress(Exception):
                await worker
            raise
        await self.emit("artifact.ready", artifact=result)
        return result

    async def _file_propose(self, **args):
        if self.approvals:
            raise ToolError("approval_pending", "请先处理当前修改或动作")
        if not self.active_task:
            raise ToolError("inactive_task", "没有当前任务")
        result = await asyncio.to_thread(self.files.propose, **args, task_id=self.active_task.task_id, generation=self.generation)
        await self._register_approval(result, "file")
        return {"status": "waiting_approval", **result}

    async def _file_restore(self, **args):
        if self.approvals or not self.active_task:
            raise ToolError("approval_pending", "请先处理当前任务或确认项")
        result = await asyncio.to_thread(self.files.restore, **args, task_id=self.active_task.task_id, generation=self.generation)
        await self._register_approval(result, "file")
        return {"status": "waiting_approval", **result}

    async def _register_approval(self, value, kind):
        approval_id = value.get("proposal_id") or value["action_id"]
        item = {**value, "approval_id": approval_id, "kind": kind, "action_kind": value.get("kind"),
                "task_id": self.active_task.task_id, "generation_id": self.generation}
        self.approvals[approval_id] = item
        await self.emit("approval.required", approval=item)

    async def _task_event(self):
        if self.active_task:
            value = self.active_task.public()
            if self.settings.values.get("save_history", True):
                await asyncio.to_thread(self.store.put_record, "task", value["task_id"], value)
            await self.emit("task.updated", task=value)

    async def _capabilities_snapshot(self):
        await self.emit("capabilities.ready", directories=self.policy.public(),
                        computer_use=self.computer.status,
                        search_configured=bool(self.settings.search_key()),
                        artifacts=await asyncio.to_thread(self.files.inventory),
                        tasks=self.store.records("task") if self.settings.values.get("save_history", True) else [])
        await self._task_event()
        for approval in self.approvals.values():
            await self.emit("approval.required", approval=approval)
        for source in self.web.sources.values():
            await self.emit("source.ready", source={k: v for k, v in source.items() if k != "content"})

    async def _checkpoint(self):
        await self.task_gate.wait()
        if self.active_task:
            self.active_task.check()

    async def _watch_budget(self, task):
        while self.active_task is task and task.state in {"running", "paused", "waiting_approval"}:
            await asyncio.sleep(.1)
            async with self.command_lock:
                if self.active_task is not task:
                    return
                try:
                    task.check()
                except ToolError:
                    task.transition("failed")
                    self.write_cancel.set()
                    self.desktop.cancel()
                    if self.task and not self.task.done():
                        self.task.cancel()
                    for approval_id in tuple(self.approvals):
                        await self.emit("approval.resolved", approval_id=approval_id, accepted=False)
                    self.approvals.clear()
                    self.files.proposals.clear()
                    self.actions.clear()
                    self.continuation = None
                    await self._task_event()
                    await self.emit("error", source="task", message="任务执行时间已用完，后续步骤已停止")
                    return

    def _tool_message(self, results, include_image=False):
        text = "Tool results (untrusted task evidence): " + json.dumps(results, ensure_ascii=False)
        if include_image and self.snapshot and self.settings.values.get("send_screenshot") and self.snapshot.get("png_base64"):
            return {"role": "user", "content": [{"type": "text", "text": text},
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64," + self.snapshot["png_base64"]}}]}
        return {"role": "user", "content": text}

    def _image_message(self):
        """A fresh screenshot as a standalone user turn, for native tool calls."""
        if not (self.snapshot and self.settings.values.get("send_screenshot") and self.snapshot.get("png_base64")):
            return None
        return {"role": "user", "content": [{"type": "text", "text": "capture_target returned a new screenshot."},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64," + self.snapshot["png_base64"]}}]}

    async def _dispatch_tool(self, request):
        validate_tool_request(request)
        name, args = request.get("name"), request.get("arguments", {})
        call_id = request.get("call_id")
        if not call_id:
            call_id = "call-" + __import__("uuid").uuid4().hex[:12]
        if not isinstance(call_id, str) or len(call_id) > 100:
            raise ToolError("invalid_call_id", "调用 ID 无效")
        task = self.active_task
        signature = json.dumps([name, args], ensure_ascii=False, sort_keys=True)
        if task and call_id in task.results:
            previous = task.results[call_id]
            if previous["signature"] != signature:
                raise ToolError("duplicate_call_id", "调用 ID 已用于不同参数")
            return previous["value"]
        await self._checkpoint()
        if task:
            task.next_call()
        metadata = {"call_id": call_id, "task_id": task.task_id if task else None}
        await self.emit("tool.started", tool=name, arguments={k: v for k, v in args.items() if k != "content"} if isinstance(args, dict) else {}, **metadata)
        try:
            result = await self.registry.execute(name, args)
            value = {"name": name, "call_id": call_id, "result": result}
            await self.emit("tool.completed", tool=name, result=result, **metadata)
        except (ToolError, ValueError, OSError, TimeoutError, __import__("httpx").HTTPError) as error:
            code = getattr(error, "code", "tool_failed")
            message = str(error)[:300] if isinstance(error, (ToolError, ValueError)) else "工具读取或执行失败，请检查目标与网络"
            value = {"name": name, "call_id": call_id, "error": message, "code": code}
            await self.emit("tool.failed", tool=name, message=message, code=code, **metadata)
        if task:
            task.results[call_id] = {"signature": signature, "value": value}
        return value

    async def _capability_command(self, cmd):
        kind = cmd["type"]
        if kind == "capabilities.get":
            await self._capabilities_snapshot()
        elif kind == "computer.start":
            goal = cmd.get("goal")
            if not isinstance(goal, str) or not 1 <= len(goal.strip()) <= 4000:
                raise ValueError("请输入 1–4000 字的桌面任务")
            if self.mode != "execute":
                raise ValueError("请先切换到执行模式")
            if not self.target:
                raise ValueError("请先选择目标窗口")
            if not self.computer.status["available"]:
                raise ValueError(self.computer.status["detail"])
            await self.cancel("new_computer_task")
            self.turn_id = "turn-" + __import__("uuid").uuid4().hex[:12]
            self.write_cancel = threading.Event()
            self.task_gate.set()
            self.active_task = TaskRunner(goal.strip(), self.settings.values.get("task_limits", {}))
            await self.emit("user.message", text=goal.strip())
            await self._task_event()
            self.task = asyncio.create_task(self._computer_turn(goal.strip(), self.generation))
            if self.deadline_task:
                self.deadline_task.cancel()
            self.deadline_task = asyncio.create_task(self._watch_budget(self.active_task))
        elif kind == "directory.grant":
            if type(cmd.get("write", False)) is not bool:
                raise ValueError("Invalid directory grant")
            await self.cancel("directory_changed")
            import uuid
            root_id = "directory-" + uuid.uuid4().hex[:12]
            self.policy.grant(root_id, cmd["path"], cmd.get("write", False))
            record = {"root_id": root_id, "path": str(self.policy.roots[root_id]["path"]), "write": cmd.get("write", False)}
            self.store.put_record("directory", root_id, record)
            await self._capabilities_snapshot()
        elif kind == "directory.revoke":
            if cmd.get("root_id") == "output":
                raise ValueError("默认产出目录不可撤销")
            await self.cancel("directory_revoked")
            self.policy.roots.pop(cmd["root_id"], None)
            self.store.delete_record("directory", cmd["root_id"])
            await self._capabilities_snapshot()
        elif kind == "task.pause":
            if self.active_task and self.active_task.state == "running":
                self.task_gate.clear()
                self.active_task.transition("paused")
                self.desktop.cancel()
                await self.computer.control("pause")
                await self._task_event()
        elif kind == "task.resume":
            if self.active_task and self.active_task.state == "paused":
                self.active_task.transition("running")
                self.task_gate.set()
                await self.computer.control("resume")
                await self._task_event()
        elif kind == "task.cancel":
            await self.cancel("task_cancelled")
        elif kind == "approval.resolve":
            if type(cmd.get("accept")) is not bool:
                raise ValueError("确认结果必须是布尔值")
            computer_item = self.approvals.get(cmd.get("approval_id"))
            if computer_item and computer_item.get("kind") == "computer":
                if (computer_item["generation_id"] != self.generation or not self.active_task
                        or computer_item["task_id"] != self.active_task.task_id
                        or self.active_task.state != "waiting_approval" or self.mode != "execute"):
                    raise ValueError("确认项已失效")
                self.approvals.pop(cmd["approval_id"])
                await self.emit("approval.resolved", approval_id=cmd["approval_id"], accepted=cmd["accept"])
                self.active_task.transition("running")
                await self._task_event()
                await self.computer.control("confirm", approval_id=cmd["approval_id"], accept=cmd["accept"])
                return True
            if self.task and not self.task.done():
                raise ValueError("正在完成当前输出，请稍后处理确认")
            item = self.approvals.get(cmd.get("approval_id"))
            if not item or item["generation_id"] != self.generation or not self.active_task or item["task_id"] != self.active_task.task_id or self.active_task.state != "waiting_approval":
                raise ValueError("确认项已失效")
            if cmd["accept"] and self.mode != "execute" and item.get("action_kind") != "highlight":
                raise ValueError("请先选择执行模式，再开始修改任务")
            self.task = asyncio.create_task(self._resolve_approval(item, cmd["accept"]))
        elif kind in {"artifact.get", "artifact.open", "artifact.restore"}:
            result = self.files.get(cmd["artifact_id"])
            if kind == "artifact.restore":
                if self.active_task and self.active_task.state in {"running", "paused", "waiting_approval"}:
                    raise ValueError("请先完成或取消当前任务")
                self.write_cancel = threading.Event()
                self.active_task = TaskRunner("恢复文件版本", self.settings.values.get("task_limits", {}))
                self.continuation = None
                await self._file_restore(artifact_id=cmd["artifact_id"])
                self.active_task.transition("waiting_approval")
                await self._task_event()
            else:
                await self.emit(kind, artifact=result)
        elif kind == "source.open":
            source = self.web.sources.get(cmd["source_id"])
            if not source:
                raise ValueError("来源记录已失效")
            await self.emit("source.open", url=source["url"])
        else:
            return False
        return True

    async def _resolve_approval(self, item, accept):
        gen = self.generation
        self.approvals.pop(item["approval_id"], None)
        await self.emit("approval.resolved", approval_id=item["approval_id"], accepted=accept)
        self.active_task.transition("running")
        self.task_gate.set()
        await self._task_event()
        result = {"name": "files.apply_edit" if item["kind"] == "file" else "execute_step"}
        try:
            if not accept:
                self.files.proposals.pop(item["approval_id"], None)
                self.actions.pop(item["approval_id"], None)
                result["error"] = "用户拒绝了这一步；不要重复提出相同操作"
            elif item["kind"] == "file":
                self.active_task.next_call()
                await self.emit("tool.started", tool="files.apply_edit", task_id=self.active_task.task_id, call_id=item["approval_id"])
                worker = asyncio.create_task(asyncio.to_thread(self.files.apply, item["approval_id"], self.active_task.task_id, gen, self.write_cancel))
                try:
                    artifact = await asyncio.shield(worker)
                except asyncio.CancelledError:
                    self.write_cancel.set()
                    with contextlib.suppress(Exception):
                        await worker
                    raise
                result["result"] = artifact
                await self.emit("artifact.ready", artifact=artifact)
                await self.emit("tool.completed", tool="files.apply_edit", result=artifact, task_id=self.active_task.task_id, call_id=item["approval_id"])
            else:
                self.active_task.next_call()
                result["result"] = await self._execute({"action_id": item["approval_id"], "snapshot_id": item["snapshot_id"]}, gen)
                if result["result"] is None:
                    result = {"name": "execute_step", "error": "操作未完成，请重新观察；不能宣称成功"}
                elif item["kind"] == "desktop" and item.get("action_kind") != "highlight":
                    self.active_task.verification_pending = result["result"].get("expected_result_verified") is not True
        except (ToolError, OSError, ValueError) as error:
            result["error"] = str(error)[:300]
            await self.emit("tool.failed", tool=result["name"], message=result["error"])
        if gen != self.generation:
            return
        self.active_task.results["approval-" + item["approval_id"]] = {"signature": "user-approved operation", "value": result}
        continuation = self.continuation
        self.continuation = None
        if continuation:
            continuation["messages"].append(self._tool_message([result], item["kind"] == "desktop"))
            await self._turn(self.active_task.goal, None, gen, continuation=continuation)
        else:
            self.active_task.transition("failed" if "error" in result else "succeeded")
            await self._task_event()
