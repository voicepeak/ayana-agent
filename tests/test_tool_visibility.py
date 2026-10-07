from pathlib import Path
import threading

import pytest

from services.agent.config import Settings
from services.agent.runtime import AgentRuntime
from services.agent.tools.registry import ToolError


def agent(tmp_path):
    cfg = Settings(Path(__file__).resolve().parents[1], data_root=tmp_path)
    cfg.search_key = lambda: ""
    cfg.values['search_provider'] = 'brave'
    cfg.values["send_screenshot"] = True
    return AgentRuntime(cfg, desktop=object(), tts=object())


def names(runtime):
    return {tool.name for tool in runtime.registry.active_tools()}


def test_keyless_default_search_is_visible_and_explicit_brave_requires_key(tmp_path):
    runtime = agent(tmp_path)
    runtime.settings.values['search_provider'] = 'auto'
    assert 'web.search' in names(runtime)
    assert runtime.web.selected_search_provider == 'bing'
    runtime.settings.values['search_provider'] = 'brave'
    assert 'web.search' not in names(runtime)
    runtime.settings.search_key = lambda: 'fixture-key'
    assert 'web.search' in names(runtime)
    assert runtime.web.selected_search_provider == 'brave'
    runtime.store.close()


def test_missing_search_target_execute_mode_and_backup_filter_model_choices(tmp_path):
    runtime = agent(tmp_path)
    hidden = {"web.search", "computer.run", "files.create", "open", "files.propose_restore"}
    assert not names(runtime) & hidden
    assert {"files.read", "files.find", "files.search", "web.fetch"} <= names(runtime)
    runtime.mode = "execute"
    runtime.target = {"target_id": "selected"}
    runtime.settings.search_key = lambda: "test-key"
    runtime.computer = type("Computer", (), {"status": {"available": True}})()
    assert {"web.search", "computer.run", "files.create", "open"} <= names(runtime)
    runtime.settings.values["send_screenshot"] = False
    runtime.target = None
    assert "computer.run" not in names(runtime)
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
                {"role": "user", "content": "open the editor"}]
    assert '"name": "open"' not in messages[0]["content"]
    runtime.mode = "execute"
    schemas, mapping = runtime._model_tools(messages)
    assert schemas is None and "open" in mapping
    assert '"name": "open"' in messages[0]["content"]
    assert len(messages) == 2 and messages[0]["content"].startswith("policy\n")
    runtime.mode = "teach"
    runtime._model_tools(messages)
    assert '"name": "open"' not in messages[0]["content"]
    runtime.store.close()
