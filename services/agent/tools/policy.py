"""Server-owned directory grants; model input cannot create grants."""
from __future__ import annotations

import os
import stat
from pathlib import Path

from .registry import ToolError
from .repository import SKIP, TEXT


def check_plain(path):
    try:
        info = path.lstat()
    except FileNotFoundError:
        return
    if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
        raise ToolError("linked_path", "写入路径不能包含符号链接或 Windows 重解析点")


class DirectoryPolicy:
    def __init__(self, output):
        output = Path(output).absolute()
        output.mkdir(parents=True, exist_ok=True)
        self.roots = {"output": {"path": output, "write": True}}
        self.check_root(output)

    @staticmethod
    def check_root(root):
        for part in [*reversed(root.parents), root]:
            check_plain(part)

    def grant(self, root_id, path, write=False):
        root = Path(path).absolute()
        self.check_root(root)
        if not root.is_dir():
            raise ToolError("invalid_root", "请选择存在的目录")
        self.roots[root_id] = {"path": root, "write": bool(write)}
        return self.public()

    def public(self):
        return [{"root_id": key, "path": str(item["path"]), "write": item["write"]} for key, item in self.roots.items()]

    def path(self, root_id, relative, write=False):
        grant = self.roots.get(root_id)
        if not grant:
            raise ToolError("unknown_root", "目录没有授权")
        if write and not grant["write"]:
            raise ToolError("write_denied", "请在管理窗口授权该目录的文本修改")
        if not isinstance(relative, str) or not relative or len(relative) > 1000 or "\x00" in relative:
            raise ToolError("invalid_path", "文件路径无效")
        # Reject Windows drive/ADS/UNC syntax even on a non-Windows test host.
        relative = relative.replace("\\", "/")
        parts = relative.split("/")
        if relative.startswith("/") or ":" in relative or any(p in {"", ".", ".."} for p in parts):
            raise ToolError("path_escape", "只允许授权目录内的相对路径")
        if any(p.casefold() in SKIP or p.casefold().startswith(".env") or p.casefold() in
               {"local.json", "credentials.json", "id_rsa", "id_ed25519"} or p.casefold().endswith((".pem", ".key", ".dpapi")) for p in parts):
            raise ToolError("private_path", "私有或生成文件不在工具范围内")
        if Path(relative).suffix.lower() not in TEXT | {".csv"}:
            raise ToolError("unsupported_file", "首批只支持文本文件")
        root = grant["path"]
        self.check_root(root)
        path = root
        for part in parts:
            path = path / part
            check_plain(path)
        if not path.resolve().is_relative_to(root.resolve()):
            raise ToolError("path_escape", "文件超出了授权目录")
        return path
