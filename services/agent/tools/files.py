"""Bounded UTF-8 artifacts, reviewed edits and conflict-aware restoration."""
from __future__ import annotations

import contextlib
import difflib
import hashlib
import os
import tempfile
import threading
import time
import uuid
from pathlib import Path

from .policy import check_plain
from .registry import ToolError

LIMIT = 65536


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def replace_text(temp, target):
    if os.name != "nt":
        os.replace(temp, target)
        return
    import ctypes
    from ctypes import wintypes
    api = ctypes.WinDLL("kernel32", use_last_error=True)
    api.ReplaceFileW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.LPCWSTR,
                                wintypes.DWORD, ctypes.c_void_p, ctypes.c_void_p]
    api.ReplaceFileW.restype = wintypes.BOOL
    rollback = Path(str(temp) + ".rollback")
    if not api.ReplaceFileW(str(target), str(temp), str(rollback), 0, None, None):
        # Keep any rollback file: certain Windows error states already moved the old file.
        raise ToolError("replace_failed", "Windows 未能完成文件替换；已保存原始备份，请检查文件状态")
    rollback.unlink(missing_ok=True)


@contextlib.contextmanager
def protect_existing(path):
    """Windows deny-write handle held across validation and replacement."""
    handle = None
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes
        api = ctypes.WinDLL("kernel32", use_last_error=True)
        api.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
                                   wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        api.CreateFileW.restype = wintypes.HANDLE
        api.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = api.CreateFileW(str(path), 0x80000000, 1 | 4, None, 3, 0x00200000, None)
        if handle == ctypes.c_void_p(-1).value:
            raise ToolError("file_busy", "文件被占用，尚未修改")
    try:
        yield
    finally:
        if handle is not None:
            api.CloseHandle(handle)


class FileTools:
    def __init__(self, policy, data_root, store):
        self.policy, self.store = policy, store
        self.versions = Path(data_root) / ".runtime/artifact-versions"
        self.proposals = {}
        self.lock = threading.RLock()
        self.trim_versions()

    def trim_versions(self):
        if not self.versions.exists():
            return
        self.policy.check_root(self.versions.absolute())
        versions = sorted(self.versions.glob("proposal-*.txt"), key=lambda item: item.stat().st_mtime, reverse=True)
        for old in versions[200:]:
            check_plain(old)
            old.unlink(missing_ok=True)

    def read(self, root_id, path):
        target = self.policy.path(root_id, path)
        check_plain(target)
        if not target.is_file():
            raise ToolError("file_missing", "目标文本文件不存在")
        with target.open("rb") as source:
            raw = source.read(LIMIT + 1)
        if len(raw) > LIMIT or b"\0" in raw:
            raise ToolError("unsupported_file", "只支持不超过 64 KiB 的完整文本")
        try:
            content = raw.decode("utf-8")
        except UnicodeDecodeError:
            raise ToolError("unsupported_encoding", "文件不是 UTF-8，原文件保持不变") from None
        return {"root_id": root_id, "path": path, "content": content, "sha256": digest(raw), "bytes": len(raw)}

    @staticmethod
    def content_bytes(content):
        raw = content.encode("utf-8")
        if len(raw) > LIMIT or b"\0" in raw:
            raise ToolError("file_size", "生成文本超过 64 KiB 或包含无效字符")
        return raw

    def _record(self, root_id, path, raw, backup=None):
        aid = "artifact-" + uuid.uuid4().hex[:12]
        record = {"artifact_id": aid, "root_id": root_id, "path": path, "sha256": digest(raw),
                  "bytes": len(raw), "created": time.time(), "backup": backup}
        self.store.put_record("artifact", aid, record)
        self.trim_versions()
        return self.public(record)

    def public(self, record):
        result = {k: v for k, v in record.items() if k != "backup"}
        result["absolute_path"] = str(self.policy.path(record["root_id"], record["path"]))
        result["can_restore"] = bool(record.get("backup") and (self.versions / record["backup"]).is_file())
        return result

    def get(self, artifact_id):
        record = self.store.get_record("artifact", artifact_id)
        if not record:
            raise ToolError("unknown_artifact", "文件记录不存在")
        result = self.public(record)
        actual = self.read(record["root_id"], record["path"])
        result["changed"] = actual["sha256"] != record["sha256"]
        return result

    def inventory(self):
        result = []
        for record in self.store.records("artifact"):
            if record["root_id"] not in self.policy.roots:
                continue
            try:
                result.append(self.get(record["artifact_id"]))
            except (ToolError, OSError):
                result.append({k: v for k, v in record.items() if k != "backup"} | {"unavailable": True, "can_restore": False})
        return result

    def create(self, root_id, path, content, cancelled):
        with self.lock:
            target = self.policy.path(root_id, path, write=True)
            raw = self.content_bytes(content)
            if target.exists():
                raise ToolError("file_exists", "文件已存在，请读取后提出修改差异")
            target.parent.mkdir(parents=True, exist_ok=True)
            self.policy.path(root_id, path, write=True)
            temp = None
            try:
                with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as output:
                    temp = Path(output.name)
                    output.write(raw)
                    output.flush()
                    os.fsync(output.fileno())
                if cancelled.is_set():
                    raise ToolError("cancelled", "已取消，文件尚未创建")
                self.policy.path(root_id, path, write=True)
                # Atomic exclusive publication; an existing destination is never overwritten.
                try:
                    os.link(temp, target)
                except FileExistsError:
                    raise ToolError("file_exists", "目标文件已出现，未覆盖") from None
                verified = self.read(root_id, path)
                if verified["sha256"] != digest(raw):
                    raise ToolError("verification_failed", "文件创建后内容发生变化，请检查")
                return self._record(root_id, path, raw)
            finally:
                if temp:
                    temp.unlink(missing_ok=True)

    def propose(self, root_id, path, base_sha256, content, task_id, generation):
        with self.lock:
            self.policy.path(root_id, path, write=True)
            current = self.read(root_id, path)
            if current["sha256"] != base_sha256:
                raise ToolError("file_conflict", "文件已经改变，请重新读取")
            raw = self.content_bytes(content)
            pid = "proposal-" + uuid.uuid4().hex[:12]
            proposal = {"proposal_id": pid, "root_id": root_id, "path": path,
                        "base_sha256": base_sha256, "new_sha256": digest(raw), "content": content,
                        "task_id": task_id, "generation_id": generation, "expires": time.time() + 1800,
                        "diff": "".join(difflib.unified_diff(current["content"].splitlines(True), content.splitlines(True),
                                                            fromfile=path, tofile=path))}
            self.proposals[pid] = proposal
            return {k: v for k, v in proposal.items() if k != "content"}

    def apply(self, proposal_id, task_id, generation, cancelled):
        with self.lock:
            proposal = self.proposals.pop(proposal_id, None)
            if not proposal or proposal["task_id"] != task_id or proposal["generation_id"] != generation or proposal["expires"] < time.time():
                raise ToolError("expired_approval", "修改预览已过期或不属于当前任务")
            root_id, path = proposal["root_id"], proposal["path"]
            target = self.policy.path(root_id, path, write=True)
            temp = None
            with protect_existing(target):
                current = self.read(root_id, path)
                if current["sha256"] != proposal["base_sha256"]:
                    raise ToolError("file_conflict", "确认后文件已被修改，未覆盖新内容")
                raw = self.content_bytes(proposal["content"])
                self.versions.mkdir(parents=True, exist_ok=True)
                self.policy.check_root(self.versions.absolute())
                backup = proposal_id + ".txt"
                (self.versions / backup).write_bytes(current["content"].encode("utf-8"))
                identity = target.stat()
                try:
                    with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as output:
                        temp = Path(output.name)
                        output.write(raw)
                        output.flush()
                        os.fsync(output.fileno())
                    if cancelled.is_set():
                        raise ToolError("cancelled", "已取消，尚未应用修改")
                    self.policy.path(root_id, path, write=True)
                    after = target.stat()
                    if (identity.st_dev, identity.st_ino) != (after.st_dev, after.st_ino) or self.read(root_id, path)["sha256"] != current["sha256"]:
                        raise ToolError("file_conflict", "目标文件身份或内容改变，未应用修改")
                    replace_text(temp, target)
                    verified = self.read(root_id, path)
                    if verified["sha256"] != digest(raw):
                        raise ToolError("verification_failed", "修改后的内容发生变化，请检查")
                    return self._record(root_id, path, raw, backup)
                finally:
                    if temp:
                        temp.unlink(missing_ok=True)

    def restore(self, artifact_id, task_id, generation):
        record = self.store.get_record("artifact", artifact_id)
        if not record or not record.get("backup"):
            raise ToolError("no_backup", "这个文件记录没有可恢复版本")
        current = self.read(record["root_id"], record["path"])
        if current["sha256"] != record["sha256"]:
            raise ToolError("file_conflict", "文件已有后续修改，请先读取并复核")
        backup = self.versions / record["backup"]
        check_plain(backup)
        if not backup.is_file():
            raise ToolError("no_backup", "该恢复版本已超过保留范围")
        content = backup.read_bytes().decode("utf-8")
        return self.propose(record["root_id"], record["path"], current["sha256"], content, task_id, generation)
