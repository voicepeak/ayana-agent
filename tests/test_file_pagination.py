import pytest
from services.agent.tools.filesystem import FileBrowser, read_text
from services.agent.tools.policy import DirectoryPolicy
from services.agent.tools.registry import ToolError


def test_read_after_64k_and_resume_with_unicode_and_no_trailing_newline(tmp_path):
    text = "".join(f"第{i}行内容\r\n" for i in range(1, 12001)) + "最后一行"
    (tmp_path / "big.txt").write_bytes(text.encode())
    policy = DirectoryPolicy(tmp_path)
    page = read_text(policy, "output", "big.txt", 11999, 1)
    assert page["content"] == "第11999行内容" and page["bytes"] == len(text.encode())
    page = read_text(policy, "output", "big.txt", max_lines=3, cursor=page["next_cursor"])
    assert page["content"] == "第12000行内容\r\n最后一行"
    assert not page["next_cursor"] and page["line_count_is_complete"]
    assert page["sha256"] is None


def test_long_unicode_line_is_resumable_without_character_loss(tmp_path):
    text = "中文😀" * 30000
    (tmp_path / "long.txt").write_bytes(text.encode())
    policy = DirectoryPolicy(tmp_path)
    result = read_text(policy, "output", "long.txt")
    parts = [result["content"]]
    while result["next_cursor"]:
        assert len(result["content"].encode()) <= 65536
        result = read_text(policy, "output", "long.txt", cursor=result["next_cursor"])
        parts.append(result["content"])
    assert "".join(parts) == text


def test_file_cursor_rejects_changed_path_contents_and_forgery(tmp_path):
    target = tmp_path / "a.txt"
    target.write_text("line\n" * 30000)
    (tmp_path / "b.txt").write_text("other")
    policy = DirectoryPolicy(tmp_path)
    token = read_text(policy, "output", "a.txt", max_lines=1)["next_cursor"]
    for path, cursor in (("b.txt", token), ("a.txt", token[:-4] + "xxxx")):
        with pytest.raises(ToolError):
            read_text(policy, "output", path, cursor=cursor)
    target.write_text("changed\n" * 30000)
    with pytest.raises(ToolError, match="文件已改变"):
        read_text(policy, "output", "a.txt", cursor=token)


@pytest.mark.parametrize("operation", ["list", "find", "search"])
def test_all_pages_have_no_duplicates_or_omissions(tmp_path, operation):
    for i in range(13):
        (tmp_path / f"note{i}.txt").write_text("needle\nneedle")
    browser = FileBrowser(DirectoryPolicy(tmp_path))
    method = getattr(browser, operation)
    args = {"root_id": "output", "limit": 3}
    if operation != "list":
        args["query"] = "note" if operation == "find" else "needle"
    seen = []
    for _ in range(30):
        page = method(**args)
        seen.extend((entry["path"], entry.get("line")) for entry in page.get("entries", page.get("matches", [])))
        if not page["next_cursor"]:
            break
        args["cursor"] = page["next_cursor"]
    assert page["scan_complete"] and len(seen) == len(set(seen)) == (26 if operation == "search" else 13)
    assert not browser.sessions


def test_directory_cursor_rejects_new_entries_and_query_changes(tmp_path):
    for i in range(3):
        (tmp_path / f"a{i}.txt").write_text("needle")
    browser = FileBrowser(DirectoryPolicy(tmp_path))
    token = browser.list("output", limit=1)["next_cursor"]
    (tmp_path / "new.txt").write_text("needle")
    with pytest.raises(ToolError, match="已改变"):
        browser.list("output", limit=1, cursor=token)
    token = browser.search("output", "needle", limit=1)["next_cursor"]
    with pytest.raises(ToolError, match="参数或授权范围改变"):
        browser.search("output", "other", cursor=token)
    assert not browser.sessions


def test_search_budget_cursor_reaches_late_matches(tmp_path, monkeypatch):
    from services.agent.tools import traversal
    monkeypatch.setattr(traversal, "SCAN_LIMIT", 3)
    (tmp_path / "long.txt").write_text("无关\n" * 9 + "needle")
    browser = FileBrowser(DirectoryPolicy(tmp_path))
    page = browser.search("output", "needle")
    assert not page["matches"] and page["next_cursor"] and page["truncation_reason"] == "scan_budget"
    seen = []
    for _ in range(10):
        seen += page["matches"]
        if not page["next_cursor"]:
            break
        page = browser.search("output", "needle", cursor=page["next_cursor"])
    assert seen == [{"path": "long.txt", "line": 10, "text": "needle"}]
    assert page["scan_complete"]


def test_fragment_boundary_preserves_crlf_line_numbers_and_search_matches(tmp_path):
    (tmp_path / "a.txt").write_bytes(("x" * 15999 + "\r\nneedle\r\n" + "中" * 40000).encode())
    policy = DirectoryPolicy(tmp_path)
    assert read_text(policy, "output", "a.txt", 2, 1)["content"] == "needle"
    browser = FileBrowser(policy)
    assert browser.search("output", "needle")["matches"][0]["line"] == 2
    (tmp_path / "b.txt").write_text("x" * 15998 + "needle" + "x" * 20000)
    browser = FileBrowser(policy)
    matches = browser.search("output", "needle")["matches"]
    assert [(item["path"], item["line"]) for item in matches] == [("a.txt", 2), ("b.txt", 1)]
