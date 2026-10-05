"""Resumable directory/name/content scanning with bounded session ownership."""
import os
from pathlib import Path
import threading
import time
import uuid
from .cursors import context, version
from .formats import is_openable, is_text
from .registry import ToolError
from .text_reader import FRAGMENT_CHARS, read_piece

SCAN_LIMIT = 5000
SCAN_SECONDS = 3


class FileBrowser:
    def __init__(self, policy):
        self.policy = policy
        self.sessions = {}
        self.lock = threading.RLock()

    @staticmethod
    def _entry(relative, target, directory):
        return {"path": relative, "kind": "directory" if directory else "file",
                "openable": directory or is_openable(target)}

    def _walk(self, root_id, path, recursive, state):
        root = self.policy.resolve(root_id, path, allow_root=True)
        if not root.is_dir():
            raise ToolError("not_directory", "目标不是目录")
        base = self.policy.root(root_id)["path"]
        stack = [(root, 0)]
        while stack:
            directory, depth = stack.pop()
            state["versions"][str(directory)] = version(directory)
            try:
                with os.scandir(directory) as entries:
                    for entry in entries:
                        relative = Path(entry.path).as_posix() if self.policy.full_access else Path(entry.path).relative_to(base).as_posix()
                        try:
                            target = self.policy.resolve(root_id, relative)
                            directory_entry = target.is_dir()
                            if not directory_entry and not target.is_file():
                                yield None
                                continue
                            if directory_entry and recursive:
                                if depth < 12:
                                    stack.append((target, depth + 1))
                                else:
                                    state["incomplete"] = "depth_limit"
                            yield relative, target, directory_entry
                        except (ToolError, OSError):
                            yield None
            except OSError:
                state["incomplete"] = "unreadable_directory"
                yield None

    def _units(self, operation, root_id, path, query, recursive, text_only, state):
        for candidate in self._walk(root_id, path, recursive, state):
            if candidate is None:
                yield None
                continue
            relative, target, directory = candidate
            state["scanned_entries"] += 1
            if operation == "list":
                yield self._entry(relative, target, directory) if not text_only or not directory and is_text(target) else None
            elif operation == "find":
                yield self._entry(relative, target, directory) if query.casefold() in target.name.casefold() else None
            elif directory or not is_text(target):
                yield None
            else:
                state["scanned_files"] += 1
                state["versions"][str(target)] = version(target)
                try:
                    with target.open("r", encoding="utf-8", errors="replace", newline="") as source:
                        line, tail, matched = 1, "", False
                        while piece := read_piece(source, FRAGMENT_CHARS):
                            if "\0" in piece:
                                break
                            text = tail + piece.rstrip("\r\n")
                            position = text.casefold().find(query.casefold())
                            if not matched and position >= 0:
                                matched = True
                                yield {"path": relative, "line": line, "text": text[max(0, position - 100):position + 300]}
                            else:
                                yield None
                            if piece.endswith(("\r", "\n")):
                                line, tail, matched = line + 1, "", False
                            else:
                                tail = text[-max(1, len(query)):]
                except OSError:
                    state["incomplete"] = "unreadable_file"
                    yield None
                yield None

    def _page(self, operation, root_id, path, limit, query="", recursive=False, text_only=False, cursor=None):
        if type(limit) is not int or not 1 <= limit <= 400:
            raise ToolError("invalid_arguments", "每页数量需要在 1–400 之间")
        binding = {**context(self.policy, root_id, path), "operation": operation, "query": query,
                   "recursive": recursive, "text_only": text_only}
        with self.lock:
            now = time.monotonic()
            for token, old in list(self.sessions.items()):
                if old["expires"] < now:
                    old["iterator"].close()
                    del self.sessions[token]
            if cursor:
                state = self.sessions.pop(cursor, None)
                if not state or state["context"] != binding:
                    if state:
                        state["iterator"].close()
                    raise ToolError("stale_cursor", "扫描续读已过期、参数或授权范围改变，请重新开始")
            else:
                state = {"context": binding, "versions": {}, "scanned_entries": 0, "scanned_files": 0,
                         "incomplete": None, "pending": [], "expires": now + 300}
                state["iterator"] = self._units(operation, root_id, path, query, recursive, text_only, state)
            try:
                self._check_versions(state)
                deadline = time.monotonic() + SCAN_SECONDS
                results, work, exhausted = [], 0, False
                while work < SCAN_LIMIT and time.monotonic() < deadline:
                    try:
                        unit = state["pending"].pop() if state["pending"] else next(state["iterator"])
                    except StopIteration:
                        exhausted = True
                        break
                    work += 1
                    if len(results) == limit:
                        state["pending"].append(unit)
                        break
                    if unit is not None:
                        results.append(unit)
                self._check_versions(state)
            except BaseException:
                state["iterator"].close()
                raise
            next_cursor = None
            if not exhausted:
                while len(self.sessions) >= 32:
                    oldest_token = next(iter(self.sessions))
                    self.sessions.pop(oldest_token)["iterator"].close()
                next_cursor = "scan-" + uuid.uuid4().hex
                state["expires"] = time.monotonic() + 300
                self.sessions[next_cursor] = state
            result = {"root_id": root_id, "path": path, "next_cursor": next_cursor,
                      "truncated": bool(next_cursor or state["incomplete"]),
                      "truncation_reason": "page_limit" if next_cursor and len(results) == limit else "scan_budget" if next_cursor else state["incomplete"],
                      "scanned_entries": state["scanned_entries"], "scanned_files": state["scanned_files"],
                      "scan_complete": exhausted and not state["incomplete"]}
            result["entries" if operation == "list" else "matches"] = sorted(results, key=lambda item: (item.get("kind") != "directory", item["path"].casefold(), item.get("line", 0)))
            return result

    @staticmethod
    def _check_versions(state):
        for name, expected in state["versions"].items():
            try:
                unchanged = version(Path(name)) == expected
            except OSError:
                unchanged = False
            if not unchanged:
                raise ToolError("scope_changed", "扫描范围中的文件或目录已改变，请重新开始")

    def list(self, root_id, path="", limit=100, recursive=False, text_only=False, cursor=None):
        return self._page("list", root_id, path, limit, recursive=recursive, text_only=text_only, cursor=cursor)

    def find(self, root_id, query, path="", limit=30, cursor=None):
        return self._page("find", root_id, path, limit, query, True, cursor=cursor)

    def search(self, root_id, query, path="", limit=40, cursor=None):
        if not isinstance(query, str) or not 1 <= len(query) <= 200:
            raise ToolError("invalid_arguments", "搜索内容长度必须为 1–200 字符")
        return self._page("search", root_id, path, limit, query, True, cursor=cursor)

    def close(self):
        with self.lock:
            for state in self.sessions.values():
                state["iterator"].close()
            self.sessions.clear()
