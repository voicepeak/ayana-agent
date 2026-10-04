from __future__ import annotations

import json
import os
from pathlib import Path

SKIP = {".git", ".venv", "venv", "node_modules", "dist", "dist-electron", "build", "release", ".runtime", "__pycache__", ".next", "assets"}
TEXT = {".py", ".ts", ".tsx", ".js", ".jsx", ".vue", ".rs", ".md", ".txt", ".toml", ".json", ".yaml", ".yml", ".css", ".html", ".cs", ".go", ".java", ".c", ".cpp", ".h", ".sql"}


class RepositoryReader:
    def __init__(self, root: str):
        self.root = Path(root).expanduser().resolve(strict=True)
        if not self.root.is_dir():
            raise ValueError("Repository root must be a directory")

    def _path(self, relative: str) -> Path:
        if not isinstance(relative, str) or len(relative) > 1000:
            raise ValueError("Invalid repository path")
        path = (self.root / relative).resolve(strict=True)
        if not path.is_relative_to(self.root):
            raise ValueError("Path leaves selected repository")
        parts = path.relative_to(self.root).parts
        if any(p.casefold() in SKIP or p.casefold().startswith(".env") or p.casefold() in {"credentials.json", "local.json", "id_rsa", "id_ed25519"} or p.casefold().endswith((".pem", ".key", ".dpapi")) for p in parts):
            raise ValueError("Private or generated files are excluded")
        if path.suffix.lower() not in TEXT and path.name not in {"Dockerfile", "Makefile", "LICENSE"}:
            raise ValueError("Only text source files are readable")
        return path

    def list_files(self, limit=400) -> list[str]:
        out = []
        for directory, dirs, files in os.walk(self.root, followlinks=False):
            dirs[:] = sorted(d for d in dirs if d.casefold() not in SKIP and not Path(directory, d).is_symlink())
            for name in sorted(files):
                p = Path(directory, name)
                if p.suffix.lower() in TEXT or name in {"Dockerfile", "Makefile", "LICENSE"}:
                    try:
                        self._path(str(p.relative_to(self.root)))
                    except (ValueError, FileNotFoundError):
                        continue
                    out.append(p.relative_to(self.root).as_posix())
                    if len(out) >= limit:
                        return out
        return out

    def read_file(self, path: str, start_line=1, max_lines=160) -> dict:
        p = self._path(path)
        start_line, max_lines = int(start_line), min(int(max_lines), 200)
        if start_line < 1 or max_lines < 1:
            raise ValueError("Line bounds must be positive")
        with p.open("rb") as f:
            raw = f.read(65537)
        if b"\0" in raw:
            raise ValueError("Binary file")
        lines = raw[:65536].decode("utf-8", errors="replace").splitlines()
        selected = lines[start_line - 1:start_line - 1 + max_lines]
        return {"path": p.relative_to(self.root).as_posix(), "start_line": start_line,
                "content": "\n".join(selected), "line_count": len(lines),
                "truncated": len(raw) > 65536 or len(lines) > start_line - 1 + max_lines}

    def search_text(self, query: str, limit=40) -> list[dict]:
        if not isinstance(query, str) or not 1 <= len(query) <= 120:
            raise ValueError("Search query length must be 1–120")
        out = []
        folded_query = query.casefold()
        for name in self.list_files():
            try:
                # Search the entire byte-bounded excerpt. The display preview
                # has a 200-line cap, which must not hide later entry points.
                path = self._path(name)
                with path.open("rb") as source:
                    raw = source.read(65536)
                if b"\0" in raw:
                    continue
                lines = raw.decode("utf-8", errors="replace").splitlines()
            except (OSError, ValueError):
                continue
            for i, line in enumerate(lines, 1):
                if folded_query in line.casefold():
                    out.append({"path": name, "line": i, "text": line[:400]})
                    if len(out) >= limit:
                        return out
        return out

    def inspect(self) -> dict:
        files = self.list_files()
        candidates = [p for p in files if p.lower() in {"readme.md", "package.json", "pyproject.toml", "cargo.toml", "go.mod"}]
        candidates += [p for p in files if p.endswith(("main.py", "app.py", "main.ts", "App.tsx", "main.rs", "index.ts"))][:4]
        evidence = [self.read_file(p, max_lines=70) for p in dict.fromkeys(candidates)][:6]
        return {"root": str(self.root), "name": self.root.name, "files": files, "evidence": evidence,
                "file_limit": 400, "note": "bounded text evidence; generated and private files excluded"}
