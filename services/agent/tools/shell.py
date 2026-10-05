"""Full-access commands with bounded receipts and an owned process tree."""
from __future__ import annotations

import asyncio
import base64
import contextlib
import os
from pathlib import Path
import signal
import time

from .registry import ToolError

OUTPUT_LIMIT = 65536


class ShellTools:
    def __init__(self, full_access):
        self.full_access = full_access
        self.process = None
        self.job = None

    async def launch(self, command, cwd):
        """Start an owned command; callers own readers and its lifetime."""
        if not self.full_access():
            raise ToolError("full_access_required", "请先开启 Full access")
        if self.process:
            raise ToolError("shell_busy", "另一个命令尚未结束")
        directory = Path(cwd)
        if not directory.is_absolute() or not directory.is_dir():
            raise ToolError("invalid_cwd", "命令工作目录必须是存在的绝对路径")
        if os.name == "nt":
            executable = Path(os.environ.get("SystemRoot", "C:/Windows")) / "System32/WindowsPowerShell/v1.0/powershell.exe"
            # Wait until a kill-on-close Job owns this shell before executing code.
            script = ("$ayanaCommand = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::ReadLine())); "
                      "$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new(); "
                      "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; "
                      "& ([ScriptBlock]::Create($ayanaCommand)); if ($LASTEXITCODE) { exit $LASTEXITCODE }")
            argv = [str(executable), "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script]
            options = {"creationflags": 0x08000000}
        else:
            argv = ["/bin/sh", "-c", command]
            options = {"start_new_session": True}
        try:
            self.process = await asyncio.create_subprocess_exec(
                *argv, cwd=str(directory), stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                env={**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}, **options)
            if os.name == "nt":
                from ..computer_use import WindowsJob
                self.job = WindowsJob(self.process.pid)
                # Code arrives over stdin after ownership; argv stays small even for long scripts.
                self.process.stdin.write(base64.b64encode(command.encode("utf-8")) + b"\n")
                await self.process.stdin.drain()
            self.process.stdin.close()
        except BaseException:
            await self.stop()
            raise

    async def run(self, command, cwd, timeout_seconds=60):
        started = time.monotonic()
        readers = []
        try:
            await self.launch(command, cwd)
            async def capture(stream):
                data, truncated = bytearray(), False
                while chunk := await stream.read(8192):
                    space = OUTPUT_LIMIT - len(data)
                    data.extend(chunk[:space])
                    truncated |= len(chunk) > space
                return data.decode("utf-8", errors="replace"), truncated
            readers = [asyncio.create_task(capture(stream)) for stream in (self.process.stdout, self.process.stderr)]
            timed_out = False
            try:
                await asyncio.wait_for(self.process.wait(), timeout_seconds)
            except asyncio.TimeoutError:
                timed_out = True
            # Descendants are owned by this invocation, including those holding pipes.
            await self.stop()
            stdout, stderr = await asyncio.gather(*readers)
            return {"exit_code": self._exit_code, "stdout": stdout[0], "stderr": stderr[0],
                    "truncated": stdout[1] or stderr[1], "timed_out": timed_out,
                    "cwd": str(Path(cwd)), "duration_ms": round((time.monotonic() - started) * 1000)}
        finally:
            await self.stop()
            for reader in readers:
                if not reader.done():
                    reader.cancel()
            if readers:
                await asyncio.gather(*readers, return_exceptions=True)

    async def stop(self):
        process = self.process
        if self.job:
            self.job.close()
            self.job = None
        if process:
            if os.name != "nt":
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(process.pid, signal.SIGKILL)
            elif process.returncode is None:
                with contextlib.suppress(ProcessLookupError):
                    process.kill()
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(process.wait(), 3)
            self._exit_code = process.returncode
        self.process = None
