"""Isolated UFO desktop tasks, with an owned process tree and live controls."""
from __future__ import annotations

import asyncio
import contextlib
import json
import os
from pathlib import Path
import shutil
import sys
import time
import uuid

from .tools.registry import ToolError

UFO_COMMIT = "a795552d976c4c019d7c2f778a0effb5cef7de6b"
EVENT_PREFIX = b"AYANA_COMPUTER "


class WindowsJob:
    """Closing this handle stops the worker and every descendant it owns."""
    def __init__(self, pid, memory_limit=None):
        import ctypes as C
        from ctypes import wintypes as W
        class Limits(C.Structure):
            _fields_ = [("process_time", C.c_int64), ("job_time", C.c_int64),
                        ("flags", W.DWORD), ("min_working_set", C.c_size_t),
                        ("max_working_set", C.c_size_t), ("active_processes", W.DWORD),
                        ("affinity", C.c_size_t), ("priority", W.DWORD), ("scheduling", W.DWORD)]
        class IO(C.Structure):
            _fields_ = [(name, C.c_uint64) for name in ("read_ops", "write_ops", "other_ops", "read_bytes", "write_bytes", "other_bytes")]
        class Extended(C.Structure):
            _fields_ = [("basic", Limits), ("io", IO), ("process_memory", C.c_size_t),
                        ("job_memory", C.c_size_t), ("peak_process", C.c_size_t), ("peak_job", C.c_size_t)]
        self.api = C.WinDLL("kernel32", use_last_error=True)
        for name, result, arguments in (
            ("CreateJobObjectW", W.HANDLE, [W.LPVOID, W.LPCWSTR]),
            ("SetInformationJobObject", W.BOOL, [W.HANDLE, C.c_int, W.LPVOID, W.DWORD]),
            ("OpenProcess", W.HANDLE, [W.DWORD, W.BOOL, W.DWORD]),
            ("AssignProcessToJobObject", W.BOOL, [W.HANDLE, W.HANDLE]),
            ("CloseHandle", W.BOOL, [W.HANDLE]),
        ):
            function = getattr(self.api, name)
            function.restype, function.argtypes = result, arguments
        self.handle = self.api.CreateJobObjectW(None, None)
        if not self.handle:
            raise OSError(C.get_last_error(), "Cannot own computer-use process")
        limits = Extended()
        limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if memory_limit is not None:
            limits.basic.flags |= 0x100  # JOB_OBJECT_LIMIT_PROCESS_MEMORY
            limits.process_memory = memory_limit
        process = self.api.OpenProcess(0x0100 | 0x0001, False, pid)
        try:
            if not process or not self.api.SetInformationJobObject(self.handle, 9, C.byref(limits), C.sizeof(limits)) or not self.api.AssignProcessToJobObject(self.handle, process):
                raise OSError(C.get_last_error(), "Cannot contain computer-use process")
        except BaseException:
            self.close()
            raise
        finally:
            if process:
                self.api.CloseHandle(process)

    def close(self):
        if self.handle:
            self.api.CloseHandle(self.handle)
            self.handle = None


class ComputerUse:
    def __init__(self, settings):
        self.settings = settings
        self.process = None
        self.job = None
        self.paused = False
        self.busy = False
        self.write_lock = asyncio.Lock()

    def installation(self):
        candidates = [self.settings.data_root / ".runtime/computer-use/ufo2",
                      self.settings.root / ".runtime/computer-use/ufo2",
                      self.settings.root.parent / "computer-use/ufo2"]
        for home in candidates:
            try:
                manifest = json.loads((home / "runtime.json").read_text(encoding="utf-8"))
                if (manifest.get("commit") == UFO_COMMIT and manifest.get("python_minor") == list(sys.version_info[:2])
                        and (home / "upstream/ufo/module/sessions/session.py").is_file()
                        and (home / "site-packages/fastmcp/__init__.py").is_file()):
                    return home
            except (OSError, ValueError):
                pass
        return None

    @property
    def status(self):
        installed = os.name == "nt" and self.installation() is not None
        configured = self.settings.values.get("provider") == "openai" and bool(self.settings.key())
        enabled = self.settings.values.get("send_screenshot", False)
        detail = ("可以在绑定窗口中执行桌面任务" if installed and configured and enabled else
                  "请运行 scripts/setup_computer_use.py 安装桌面执行组件" if not installed else
                  "请配置在线模型及凭据" if not configured else "请开启目标窗口截图")
        return {"available": bool(installed and configured and enabled), "installed": installed,
                "engine": "ufo2", "detail": detail, "running": self.busy, "paused": self.paused}

    async def control(self, command, **fields):
        async with self.write_lock:
            process = self.process
            if process and process.returncode is None and process.stdin:
                try:
                    process.stdin.write((json.dumps({"command": command, **fields}) + "\n").encode())
                    await process.stdin.drain()
                except (BrokenPipeError, ConnectionError):
                    pass
        if command in {"pause", "resume", "confirm"}:
            self.paused = command == "pause"

    async def run(self, goal, target, progress, *, limits=None, assistant_windows=()):
        if self.busy:
            raise ToolError("computer_busy", "另一个桌面任务正在执行")
        status = self.status
        if not status["available"]:
            raise ToolError("computer_unavailable", status["detail"])
        if not target or not all(key in target for key in ("hwnd", "process_id", "process_created")):
            raise ToolError("no_target", "请先选择目标窗口")
        if not isinstance(goal, str) or not 1 <= len(goal.strip()) <= 4000:
            raise ToolError("invalid_goal", "请输入 1–4000 字的桌面任务")
        home = self.installation()
        limits = limits or self.settings.values.get("task_limits", {})
        seconds = max(1, min(600, limits.get("seconds", 180)))
        run_id = "computer-" + uuid.uuid4().hex[:12]
        work = self.settings.data_root / ".runtime/computer-use/runs" / run_id
        work.mkdir(parents=True)
        self.busy, self.paused = True, False
        result = None
        try:
            worker = Path(__file__).with_name("computer_worker.py")
            self.process = await asyncio.create_subprocess_exec(
                sys.executable, "-I", "-u", str(worker), str(home), str(work),
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL, limit=2 * 1024 * 1024,
                creationflags=0x08000000 if os.name == "nt" else 0)
            hello = await asyncio.wait_for(self.process.stdout.readline(), 10)
            if not hello.startswith(EVENT_PREFIX):
                raise ToolError("computer_start_failed", "桌面执行进程启动失败")
            identity = json.loads(hello[len(EVENT_PREFIX):])
            if identity.get("type") != "hello" or type(identity.get("pid")) is not int:
                raise ToolError("computer_start_failed", "桌面执行进程握手失败")
            # The worker waits for this request before loading UFO or sending input.
            self.job = WindowsJob(identity["pid"])
            await self.control("start", goal=goal.strip(), target=target,
                               repository_root=str(self.settings.root), run_id=run_id,
                               assistant_windows=list(assistant_windows),
                               model={"base_url": self.settings.values["base_url"],
                                      "name": self.settings.values["model"], "key": self.settings.key()},
                               max_steps=max(1, min(48, limits.get("rounds", 12))),
                               max_actions=max(1, min(64, limits.get("calls", 24))))
            elapsed, previous = 0.0, time.monotonic()
            while True:
                try:
                    line = await asyncio.wait_for(self.process.stdout.readline(), .5)
                except asyncio.TimeoutError:
                    line = None
                now = time.monotonic()
                if not self.paused:
                    elapsed += now - previous
                previous = now
                if elapsed >= seconds:
                    raise ToolError("computer_timeout", "桌面任务超时，已停止后续操作")
                if line == b"":
                    break
                if not line or not line.startswith(EVENT_PREFIX):
                    continue
                event = json.loads(line[len(EVENT_PREFIX):])
                if event.get("type") == "fatal":
                    raise ToolError(event.get("code", "computer_failed"), event.get("message", "桌面任务未完成")[:500])
                if event.get("type") == "result":
                    result = event["result"]
                    break
                if event.get("type") == "confirmation":
                    self.paused = True
                await progress(event)
            if result is None:
                raise ToolError("computer_crashed", "桌面执行进程意外退出，结果未核实")
            result.update(run_id=run_id, duration_ms=round(elapsed * 1000))
            if self.settings.values.get("save_history", True):
                result["report_path"] = str(work / "report.json")
                (work / "report.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
            return result
        finally:
            await self.stop()
            self.busy = False
            if not self.settings.values.get("save_history", True):
                # An exact, newly-created run directory; never remove the installation.
                if work.resolve().parent == (self.settings.data_root / ".runtime/computer-use/runs").resolve() and work.name == run_id:
                    await asyncio.to_thread(shutil.rmtree, work, True)

    async def stop(self):
        process = self.process
        if self.job:
            self.job.close()
            self.job = None
        if process:
            if process.returncode is None:
                with contextlib.suppress(ProcessLookupError):
                    process.terminate()
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(process.wait(), 3)
            if process.stdin:
                process.stdin.close()
        self.process = None
        self.paused = False
