from pathlib import Path
import threading

import pytest

from services.agent.config import Settings
from services.agent.runtime import AgentRuntime
from services.agent.tools.registry import ToolError


def agent(tmp_path):
    cfg = Settings(Path(__file__).resolve().parents[1], data_root=tmp_path)
    cfg.search_key = lambda: ""
    cfg.values["send_screenshot"] = True
    return AgentRuntime(cfg, desktop=object(), tts=object())


def names(runtime):
    return {tool.name for tool in runtime.registry.active_tools()}


def test_missing_search_target_execute_mode_and_backup_filter_model_choices(tmp_path):
    runtime = agent(tmp_path)
    hidden = {"web.search", "capture_target", "observe_controls", "computer.run", "files.create",
              "apps.open", "files.open", "web.open", "windows.select", "files.propose_restore"}
    assert not names(runtime) & hidden
    assert {"files.read", "files.list", "files.find", "files.search", "web.fetch"} <= names(runtime)
    runtime.mode = "execute"
    runtime.target = {"target_id": "selected"}
    runtime.settings.search_key = lambda: "test-key"
    runtime.computer = type("Computer", (), {"status": {"available": True}})()
    assert {"web.search", "capture_target", "observe_controls", "computer.run", "files.create"} <= names(runtime)
    runtime.settings.values["send_screenshot"] = False
    assert "capture_target" not in names(runtime)
    runtime.target = None
    assert "observe_controls" not in names(runtime) and "computer.run" not in names(runtime)
    runtime.store.close()


@pytest.mark.asyncio
async def test_hidden_write_still_checks_executor_mode_and_never_creates_file(tmp_path):
    runtime = agent(tmp_path)
    with pytest.raises(ToolError) as failure:
        await runtime.registry.execute("files.create", {"root_id": "output", "path": "blocked.txt", "content": "x"})
    assert failure.value.code == "execution_mode_required"
    assert not (tmp_path / "artifacts/blocked.txt").exists()
    runtime.store.close()


def test_restore_choice_requires_a_real_backup_and_current_write_grant(tmp_path):
    runtime = agent(tmp_path)
    token = threading.Event()
    runtime.files.create("output", "note.txt", "old", token)
    assert "files.propose_restore" not in names(runtime)
    current = runtime.files.read("output", "note.txt")
    proposal = runtime.files.propose("output", "note.txt", current["sha256"], "new", "task", 0)
    runtime.files.apply(proposal["proposal_id"], "task", 0, token)
    assert "files.propose_restore" in names(runtime)
    runtime.policy.roots["output"]["write"] = False
    assert "files.propose_restore" not in names(runtime)
    runtime.store.close()


def test_ndjson_catalog_refreshes_in_place_without_persisting_extra_system_turns(tmp_path):
    runtime = agent(tmp_path)
    runtime.settings.values["native_tools"] = False
    messages = [{"role": "system", "content": "policy\n" + runtime._tool_prompt()},
                {"role": "user", "content": "look at the selected window"}]
    assert '"name": "capture_target"' not in messages[0]["content"]
    runtime.target = {"target_id": "selected"}
    schemas, mapping = runtime._model_tools(messages)
    assert schemas is None and "capture_target" in mapping
    assert '"name": "capture_target"' in messages[0]["content"]
    assert len(messages) == 2 and messages[0]["content"].startswith("policy\n")
    runtime.target = None
    runtime._model_tools(messages)
    assert '"name": "capture_target"' not in messages[0]["content"]
    runtime.store.close()
