"""One bounded reader and directory walker for repositories and user grants."""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import time

from .formats import is_openable, is_text
from .registry import ToolError

READ_LIMIT = 65536


def read_text(policy, root_id, path, start_line=None, max_lines=None):
    target = policy.path(root_id, path)
    if not target.is_file():
        raise ToolError("file_missing", "目标文本文件不存在")
    with target.open("rb") as source:
        raw = source.read(READ_LIMIT + 1)
    if b"\0" in raw:
        raise ToolError("unsupported_file", "目标不是文本文件")
    ranged = start_line is not None or max_lines is not None
    if not ranged and len(raw) > READ_LIMIT:
        raise ToolError("unsupported_file", "完整读取只支持不超过 64 KiB 的文本；请按行读取")
    valid_utf8 = True
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        valid_utf8 = False
        if not ranged:
            raise ToolError("unsupported_encoding", "文件不是 UTF-8，原文件保持不变") from None
        text = raw[:READ_LIMIT].decode("utf-8", errors="replace")
    within_limit = len(raw) <= READ_LIMIT
    if not within_limit:
        text = raw[:READ_LIMIT].decode("utf-8", errors="replace")
    lines = text.splitlines()
    result = {"root_id": root_id, "path": path, "bytes": len(raw),
              "sha256": hashlib.sha256(raw).hexdigest() if within_limit and valid_utf8 else None,
              "line_count": len(lines), "line_count_is_complete": within_limit}
    if ranged:
        start_line = 1 if start_line is None else start_line
        max_lines = 160 if max_lines is None else max_lines
        if type(start_line) is not int or start_line < 1 or type(max_lines) is not int or not 1 <= max_lines <= 200:
            raise ToolError("invalid_arguments", "读取行号必须为正整数，最多读取 200 行")
        complete = within_limit and valid_utf8 and start_line == 1 and max_lines >= len(lines)
        result.update(content="\n".join(lines[start_line - 1:start_line - 1 + max_lines]),
                      start_line=start_line, complete=complete,
                      truncated=not within_limit or len(lines) > start_line - 1 + max_lines)
    else:
        result.update(content=text, complete=True, truncated=False)
    return result


class FileBrowser:
    def __init__(self, policy):
        self.policy = policy

    def _walk(self, root_id, path, recursive, state):
        root = self.policy.resolve(root_id, path, allow_root=True)
        if not root.is_dir():
            raise ToolError("not_directory", "目标不是目录")
        base = self.policy.root(root_id)["path"]
        stack, visited = [(root, 0)], 0
        deadline = time.monotonic() + 3
        while stack:
            directory, depth = stack.pop()
            try:
                with os.scandir(directory) as entries:
                    for entry in entries:
                        visited += 1
                        if visited > 5000 or time.monotonic() > deadline:
                            state["truncated"] = True
                            return
                        relative = Path(entry.path).relative_to(base).as_posix()
                        try:
                            target = self.policy.resolve(root_id, relative)
                            is_directory = target.is_dir()
                            if not is_directory and not target.is_file():
                                continue
                            if is_directory and recursive:
                                if depth < 12:
                                    stack.append((target, depth + 1))
                                else:
                                    state["truncated"] = True
                            yield relative, target, is_directory
                        except (ToolError, OSError):
                            continue
            except OSError:
                if directory == root:
                    raise
                state["truncated"] = True

    @staticmethod
    def _entry(relative, target, is_directory):
        return {"path": relative, "kind": "directory" if is_directory else "file",
                "openable": is_directory or is_openable(target)}

    def list(self, root_id, path="", limit=100, recursive=False, text_only=False):
        state, results = {"truncated": False}, []
        for relative, target, is_directory in self._walk(root_id, path, recursive, state):
            if text_only and (is_directory or not is_text(target)):
                continue
            results.append(self._entry(relative, target, is_directory))
            if len(results) > limit:
                state["truncated"] = True
                break
        return {"root_id": root_id, "path": path, "entries": sorted(results[:limit],
                key=lambda item: (item["kind"] != "directory", item["path"].casefold())), **state}

    def find(self, root_id, query, path="", limit=30):
        state, results = {"truncated": False}, []
        for relative, target, is_directory in self._walk(root_id, path, True, state):
            if query.casefold() not in target.name.casefold():
                continue
            results.append(self._entry(relative, target, is_directory))
            if len(results) > limit:
                state["truncated"] = True
                break
        return {"root_id": root_id, "matches": results[:limit], **state}

    def search(self, root_id, query, path="", limit=40):
        if not isinstance(query, str) or not 1 <= len(query) <= 200:
            raise ToolError("invalid_arguments", "搜索内容长度必须为 1–200 字符")
        state, results, read_files = {"truncated": False}, [], 0
        for relative, target, is_directory in self._walk(root_id, path, True, state):
            if is_directory or not is_text(target):
                continue
            if read_files == 400:
                state["truncated"] = True
                break
            read_files += 1
            try:
                with target.open("rb") as source:
                    oversized = os.fstat(source.fileno()).st_size > READ_LIMIT
                    raw = source.read(READ_LIMIT)
                if b"\0" in raw:
                    continue
                lines = raw.decode("utf-8", errors="replace").splitlines()
            except OSError:
                state["truncated"] = True
                continue
            if oversized:
                state["truncated"] = True
            for index, line in enumerate(lines, 1):
                if query.casefold() in line.casefold():
                    results.append({"path": relative, "line": index, "text": line[:400]})
                    if len(results) > limit:
                        state["truncated"] = True
                        return {"root_id": root_id, "matches": results[:limit], **state}
        return {"root_id": root_id, "matches": results, **state}
