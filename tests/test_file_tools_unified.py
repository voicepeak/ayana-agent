import hashlib
from pathlib import Path
import threading

import pytest

from services.agent.config import Settings
from services.agent.runtime import AgentRuntime
from services.agent.tools.filesystem import FileBrowser, read_text
from services.agent.tools.policy import DirectoryPolicy
from services.agent.tools.registry import ToolError
from services.agent.tools.repository import RepositoryReader


def test_ranged_read_preserves_whole_file_hash_and_original_full_text(tmp_path):
    raw = "第一行\r\n  second\n末尾\n".encode()
    (tmp_path / "notes.md").write_bytes(raw)
    policy = DirectoryPolicy(tmp_path)
    excerpt = read_text(policy, "output", "notes.md", 2, 1)
    assert excerpt["content"] == "  second"
    assert excerpt["sha256"] == hashlib.sha256(raw).hexdigest()
    assert not excerpt["complete"] and excerpt["truncated"]
    full = read_text(policy, "output", "notes.md")
    assert full["content"].encode() == raw
    assert full["complete"] and not full["truncated"]


def test_large_or_replacement_decoded_excerpt_cannot_supply_edit_hash(tmp_path):
    (tmp_path / "large.txt").write_bytes(b"line\n" * 20000)
    (tmp_path / "legacy.txt").write_bytes(b"\xffold encoding")
    policy = DirectoryPolicy(tmp_path)
    for name in ("large.txt", "legacy.txt"):
        with pytest.raises(ToolError):
            read_text(policy, "output", name)
        result = read_text(policy, "output", name, 1, 3)
        assert result["sha256"] is None and not result["complete"]
    assert not read_text(policy, "output", "large.txt", 1, 3)["line_count_is_complete"]


def test_repository_and_grants_share_recursive_listing_and_private_path_rules(tmp_path):
    (tmp_path / "src").mkdir()
    (tmp_path / "src/main.py").write_text("print('ready')")
    (tmp_path / "LICENSE").write_text("Example license")
    (tmp_path / "manual.pdf").write_bytes(b"pdf")
    (tmp_path / ".ENV.local.json").write_text("secret")
    (tmp_path / "NODE_MODULES").mkdir()
    (tmp_path / "NODE_MODULES/hidden.py").write_text("secret")
    policy = DirectoryPolicy(tmp_path)
    listing = FileBrowser(policy).list("output", recursive=True, text_only=True)
    assert [entry["path"] for entry in listing["entries"]] == ["LICENSE", "src/main.py"]
    reader = RepositoryReader(str(tmp_path))
    assert reader.list_files() == [entry["path"] for entry in listing["entries"]]
    assert reader.read_file("LICENSE")["content"] == "Example license"
    for scope in ("output", "repository"):
        used_policy = policy if scope == "output" else reader.policy
        with pytest.raises(ToolError) as failure:
            read_text(used_policy, scope, ".ENV.local.json")
        assert failure.value.code == "private_path"


@pytest.mark.asyncio
async def test_selected_repository_is_live_readonly_scope_and_default_can_be_overridden(tmp_path):
    root = Path(__file__).resolve().parents[1]
    runtime = AgentRuntime(Settings(root, data_root=tmp_path / "data"), desktop=object(), tts=object())
    first, second = tmp_path / "first", tmp_path / "second"
    first.mkdir(); second.mkdir()
    (first / "a.py").write_text("old")
    (second / "a.py").write_text("new")
    runtime.repository = {"root": str(first)}
    result = await runtime.registry.execute("files.read", {"path": "a.py"})
    assert result["content"] == "old" and result["root_id"] == "repository"
    with pytest.raises(ToolError) as failure:
        runtime.files.create("repository", "new.py", "code", threading.Event())
    assert failure.value.code == "write_denied"
    runtime.repository = {"root": str(second)}
    assert (await runtime.registry.execute("files.read", {"path": "a.py"}))["content"] == "new"
    runtime.repository = None
    with pytest.raises(ToolError):
        await runtime.registry.execute("files.read", {"root_id": "repository", "path": "a.py"})
    assert (await runtime.registry.execute("files.list", {}))["root_id"] == "output"
    assert "read_file" not in runtime.registry.tools and "list_files" not in runtime.registry.tools
    assert len(runtime.registry.tools) == 18
    runtime.store.close()


def test_name_search_and_content_search_have_distinct_results_and_shared_budgets(tmp_path):
    (tmp_path / "needle.txt").write_text("unrelated content")
    (tmp_path / "other.txt").write_text("\n".join(["earlier"] * 220 + ["NEEDLE in content"]))
    (tmp_path / "large.py").write_bytes(b"x" * 65535 + b"\nneedle beyond budget")
    (tmp_path / ".env.txt").write_text("needle secret")
    browser = FileBrowser(DirectoryPolicy(tmp_path))
    assert [item["path"] for item in browser.find("output", "needle")["matches"]] == ["needle.txt"]
    result = browser.search("output", "needle")
    assert result["matches"] == [{"path": "other.txt", "line": 221, "text": "NEEDLE in content"}]
    assert result["truncated"]  # Large files are bounded excerpts, not exhaustive searches.
    (tmp_path / "many.txt").write_text("needle\n" * 15)
    limited = browser.search("output", "needle", limit=3)
    assert len(limited["matches"]) == 3 and limited["truncated"]


@pytest.mark.asyncio
async def test_search_works_in_selected_repository_and_explicit_readonly_grant(tmp_path):
    runtime = AgentRuntime(Settings(Path(__file__).resolve().parents[1], data_root=tmp_path / "data"), desktop=object(), tts=object())
    docs = tmp_path / "docs"
    docs.mkdir()
    (docs / "a.md").write_text("confirmed fact")
    runtime.repository = {"root": str(docs)}
    repository_result = await runtime.registry.execute("files.search", {"query": "fact"})
    runtime.policy.grant("docs", docs)
    grant_result = await runtime.registry.execute("files.search", {"root_id": "docs", "query": "fact"})
    assert repository_result["matches"] == grant_result["matches"] == [{"path": "a.md", "line": 1, "text": "confirmed fact"}]
    assert "search_text" not in runtime.registry.tools
    assert len(runtime.registry.tools) == 18
    runtime.store.close()
