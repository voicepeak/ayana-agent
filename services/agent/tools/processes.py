"""Owned background processes, capped incremental logs and stable logical IDs."""
import asyncio
import codecs
from collections import deque
from pathlib import Path
import time
import uuid
from .registry import ToolError
from .shell import ShellTools

LOG_LIMIT = 65536
MAX_RUNNING = 4
MAX_RECORDS = 24


class ProcessTools:
    def __init__(self, full_access):
        self.full_access = full_access
        self.entries = {}
        self.lock = asyncio.Lock()

    def _access(self):
        if not self.full_access():
            raise ToolError("full_access_required", "后台进程管理需要开启 Full access")

    async def start(self, command, cwd):
        self._access()
        async with self.lock:
            for item in self.entries.values():
                if item["command"] == command and item["cwd"] == str(Path(cwd)) and item["owner"].process:
                    return {**self._public(item), "reused": True}
            if sum(item["owner"].process is not None for item in self.entries.values()) >= MAX_RUNNING:
                raise ToolError("process_busy", "已有四个后台进程，请先停止不需要的进程")
            while len(self.entries) >= MAX_RECORDS:
                finished = next((key for key, item in self.entries.items() if item["done"].done()), None)
                if finished is None:
                    break
                del self.entries[finished]
            owner = ShellTools(self.full_access)
            try:
                await owner.launch(command, cwd)
                item = {"process_id": "process-" + uuid.uuid4().hex[:12], "owner": owner, "command": command,
                        "cwd": str(Path(cwd)), "pid": owner.process.pid, "process": owner.process, "started": time.time(), "stopped": False,
                        "logs": deque(), "log_size": 0, "sequence": 0, "exit_code": None}
                readers = [asyncio.create_task(self._capture(item, stream, label)) for stream, label in
                           ((owner.process.stdout, "stdout"), (owner.process.stderr, "stderr"))]
                item["done"] = asyncio.create_task(self._watch(item, readers))
                self.entries[item["process_id"]] = item
                return {**self._public(item), "reused": False}
            except BaseException:
                await owner.stop()
                raise

    async def _capture(self, item, stream, label):
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        while chunk := await stream.read(4096):
            self._log(item, label, decoder.decode(chunk))
        self._log(item, label, decoder.decode(b"", final=True))

    @staticmethod
    def _log(item, label, text):
        if not text:
            return
        item["sequence"] += 1
        item["logs"].append({"sequence": item["sequence"], "stream": label, "text": text})
        item["log_size"] += len(text)
        while item["log_size"] > LOG_LIMIT:
            item["log_size"] -= len(item["logs"].popleft()["text"])

    async def _watch(self, item, readers):
        owner = item["owner"]
        try:
            await item["process"].wait()
            await owner.stop()
            item["exit_code"] = owner._exit_code
        finally:
            await owner.stop()
            await asyncio.gather(*readers, return_exceptions=True)

    @staticmethod
    def _public(item):
        code = item["exit_code"] if item["exit_code"] is not None else item["process"].returncode
        status = "stopped" if item["stopped"] else "running" if item["owner"].process else "exited" if code == 0 else "failed"
        value = {"process_id": item["process_id"], "pid": item["pid"], "cwd": item["cwd"],
                 "status": status, "started": item["started"], "next_log_cursor": item["sequence"]}
        if code is not None:
            value["termination_exit_code" if item["stopped"] else "exit_code"] = code
        return value

    def status(self, process_id=None, log_cursor=0):
        self._access()
        if process_id is None:
            return {"processes": [self._public(item) for item in self.entries.values()]}
        item = self.entries.get(process_id)
        if not item:
            raise ToolError("unknown_process", "进程记录不存在或已被清理，请先查看 process.status")
        if type(log_cursor) is not int or log_cursor < 0 or log_cursor > item["sequence"]:
            raise ToolError("invalid_cursor", "日志游标无效，请使用上次返回的 next_log_cursor")
        logs, size = [], 0
        for entry in item["logs"]:
            if entry["sequence"] > log_cursor:
                if size + len(entry["text"]) > 16000 and logs:
                    break
                logs.append(entry)
                size += len(entry["text"])
        cursor = logs[-1]["sequence"] if logs else log_cursor
        return {**self._public(item), "logs": logs, "next_log_cursor": cursor,
                "logs_truncated": bool(item["logs"] and log_cursor < item["logs"][0]["sequence"] - 1),
                "has_more_logs": cursor < item["sequence"]}

    async def stop(self, process_id):
        self._access()
        item = self.entries.get(process_id)
        if not item:
            raise ToolError("unknown_process", "进程记录不存在或已被清理")
        item["stopped"] = True
        if item["owner"].process:
            await item["owner"].stop()
        await item["done"]
        return self.status(process_id)

    async def close(self):
        async with self.lock:
            for item in self.entries.values():
                if item["owner"].process:
                    item["stopped"] = True
                    await item["owner"].stop()
            await asyncio.gather(*(item["done"] for item in self.entries.values()), return_exceptions=True)
