from pathlib import Path
import pytest
from services.agent.tools.repository import RepositoryReader


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
        with pytest.raises(ValueError, match="Private"):
            reader.read_file(file)
    outside = tmp_path.parent / "outside.py"
    outside.write_text("secret")
    with pytest.raises(ValueError, match="leaves"):
        reader.read_file("../outside.py")
