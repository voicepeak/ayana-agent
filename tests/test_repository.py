from pathlib import Path
import pytest
from services.agent.tools.repository import RepositoryReader
from services.agent.tools.registry import ToolError


def test_real_evidence_paths_and_line_numbers(tmp_path):
    (tmp_path / "README.md").write_text("# Test\nstart here\n", encoding="utf-8")
    (tmp_path / "main.py").write_text("def start():\n    return 42\n", encoding="utf-8")
    reader = RepositoryReader(str(tmp_path))
    assert reader.inspect()["evidence"][0]["content"].startswith("# Test")
    assert reader.search_text("return") == [{"path": "main.py", "line": 2, "text": "    return 42"}]


def test_traversal_and_secret_files_denied(tmp_path):
    (tmp_path / ".env").write_text("KEY=private")
    (tmp_path / "config").mkdir()
    (tmp_path / "config/local.json").write_text("{}")
    reader = RepositoryReader(str(tmp_path))
    assert reader.list_files() == []
    for file in (".env", "config/local.json"):
        with pytest.raises(ToolError) as failure:
            reader.read_file(file)
        assert failure.value.code == "private_path"
    outside = tmp_path.parent / "outside.py"
    outside.write_text("secret")
    with pytest.raises(ToolError) as failure:
        reader.read_file("../outside.py")
    assert failure.value.code == "path_escape"


def test_search_finds_source_beyond_display_preview(tmp_path):
    (tmp_path / "runtime.py").write_text(
        "\n".join(["# earlier source"] * 249 + ["def native_execute():", "    return True"]), encoding="utf-8")
    reader = RepositoryReader(str(tmp_path))
    assert "native_execute" not in reader.read_file("runtime.py", max_lines=200)["content"]
    assert reader.search_text("NATIVE_EXECUTE") == [
        {"path": "runtime.py", "line": 250, "text": "def native_execute():"}]


def test_search_excludes_electron_build_and_binary_files(tmp_path):
    generated = tmp_path / "apps/desktop/dist-electron"
    generated.mkdir(parents=True)
    (generated / "main.js").write_text("generated_needle", encoding="utf-8")
    (tmp_path / "binary.py").write_bytes(b"generated_needle\0hidden")
    reader = RepositoryReader(str(tmp_path))
    assert "apps/desktop/dist-electron/main.js" not in reader.list_files()
    assert reader.search_text("generated_needle") == []
    with pytest.raises(ToolError) as failure:
        reader.read_file("apps/desktop/dist-electron/main.js")
    assert failure.value.code == "private_path"


def test_search_retains_byte_and_result_budgets(tmp_path):
    (tmp_path / "large.py").write_bytes(b"x" * 65535 + b"\nbeyond_budget_needle")
    (tmp_path / "matches.py").write_text("\n".join(["match_needle"] * 100), encoding="utf-8")
    reader = RepositoryReader(str(tmp_path))
    assert reader.search_text("beyond_budget_needle") == [{"path": "large.py", "line": 2, "text": "beyond_budget_needle"}]
    assert len(reader.search_text("match_needle")) == 40


def test_case_variants_cannot_bypass_private_and_generated_exclusions(tmp_path):
    (tmp_path / ".ENV.production.json").write_text('{"secret":"private"}')
    generated = tmp_path / "NODE_MODULES"
    generated.mkdir()
    (generated / "private.py").write_text("private")
    reader = RepositoryReader(str(tmp_path))
    assert reader.list_files() == []
    for name in (".ENV.production.json", "NODE_MODULES/private.py"):
        with pytest.raises(ToolError) as failure:
            reader.read_file(name)
        assert failure.value.code == "private_path"
