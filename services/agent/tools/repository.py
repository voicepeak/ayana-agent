from __future__ import annotations

from pathlib import Path
from .formats import SKIP, TEXT
from .policy import DirectoryPolicy
from .filesystem import FileBrowser, read_text


class RepositoryReader:
    def __init__(self, root: str):
        self.root = Path(root).expanduser().absolute()
        self.policy = DirectoryPolicy()
        self.policy.grant("repository", self.root)
        self.browser = FileBrowser(self.policy)
        if not self.root.is_dir():
            raise ValueError("Repository root must be a directory")

    def _path(self, relative: str) -> Path:
        return self.policy.path("repository", relative).resolve(strict=True)

    def list_files(self, limit=400) -> list[str]:
        return [entry["path"] for entry in self.browser.list("repository", limit=limit,
                recursive=True, text_only=True)["entries"]]

    def read_file(self, path: str, start_line=1, max_lines=160) -> dict:
        return read_text(self.policy, "repository", path, start_line, max_lines)

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
