"""Authorized document reads with bounded parser lifetime and resumable units."""
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
from .cursors import context, decode, encode, version
from .registry import ToolError


class DocumentReader:
    def __init__(self, policy):
        self.policy = policy
        self.workers = {}
        self.lock = threading.RLock()
        self.generation = 0

    def read(self, root_id, path, start_unit=1, max_units=20, cursor=None):
        target = self.policy.resolve(root_id, path)
        if not target.is_file():
            raise ToolError("file_missing", "文档不存在")
        before, binding = version(target), {**context(self.policy, root_id, path), "reader": "document"}
        if before[2] > 32 * 1024 * 1024:
            raise ToolError("document_size", "文档超过 32 MiB，请拆分后读取")
        if type(start_unit) is not int or start_unit < 1 or type(max_units) is not int or not 1 <= max_units <= 50:
            raise ToolError("invalid_arguments", "文档起始位置需要正整数，每次最多读取 50 个单元")
        offset = 0
        if cursor:
            data = decode(self.policy, cursor, binding)
            if data["version"] != before:
                raise ToolError("file_conflict", "文档已改变，请重新读取")
            start_unit, offset = data["start_unit"], data["offset"]
        with self.lock:
            generation = self.generation
        process, job = None, None
        try:
            process = subprocess.Popen([sys.executable, "-m", "services.agent.tools.document_worker"],
                cwd=Path(__file__).resolve().parents[3], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                creationflags=0x08000000 if os.name == "nt" else 0,
                env={**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"})
            if os.name == "nt":
                from ..computer_use import WindowsJob
                job = WindowsJob(process.pid, memory_limit=768 * 1024 * 1024)
            with self.lock:
                if generation != self.generation:
                    raise ToolError("cancelled", "文档读取已取消")
                self.workers[process] = job
            request = json.dumps({"path": str(target), "start_unit": start_unit, "max_units": max_units, "offset": offset}).encode()
            try:
                stdout, _ = process.communicate(request, timeout=15)
            except subprocess.TimeoutExpired:
                raise ToolError("tool_timeout", "文档解析超时，已停止读取，请尝试更小的文档") from None
            if generation != self.generation:
                raise ToolError("cancelled", "文档读取已取消")
            if process.returncode != 0:
                raise ToolError("document_dependency", "文档读取组件无法启动，请检查运行环境")
            result = json.loads(stdout.decode("utf-8"))
            if "error" in result:
                raise ToolError(result["code"], result["error"])
            if version(target) != before:
                raise ToolError("file_conflict", "文档读取期间内容改变，请重新读取")
            position = result.pop("next_position")
            result["complete"] = result["complete"] and not cursor
            result.update(root_id=root_id, path=path, bytes=before[2], sha256=None, truncated=position is not None,
                          next_cursor=encode(self.policy, {"context": binding, "version": before, **position}) if position else None)
            return result
        finally:
            with self.lock:
                self.workers.pop(process, None)
            if job:
                job.close()
            if process:
                if process.poll() is None:
                    process.kill()
                process.wait(timeout=3)
                for stream in (process.stdin, process.stdout, process.stderr):
                    if stream:
                        stream.close()

    def close(self):
        with self.lock:
            self.generation += 1
            for process, job in self.workers.items():
                if job:
                    job.close()
                if process.poll() is None:
                    process.kill()
