import asyncio
import json
from pathlib import Path

import pytest

from services.agent.avatars import AvatarCatalog
from services.agent.characters import character_map_path, load_registry
from services.agent.config import Settings
from services.agent.runtime import AgentRuntime
from test_runtime import Desktop, Tts, Ws


ROOT = Path(__file__).resolve().parents[1]
SU_PROFILE = {"avatar_root": "assets/ayana-su", "avatar_costume": "白色校服",
              "voice": {"voice_mode": "silent", "source_root": "su"}}


def local(tmp_path, values=None):
    (tmp_path / "config").mkdir(exist_ok=True)
    (tmp_path / "config/local.json").write_text(json.dumps(values or {}), encoding="utf-8")
    return Settings(ROOT, data_root=tmp_path)


def test_registry_lists_both_characters_with_installed_maps():
    registry = load_registry(ROOT)
    assert list(registry["characters"]) == ["ayana", "ayana-su"]
    for character in registry["characters"]:
        assert character_map_path(ROOT, character).is_file()
    assert load_registry(ROOT)["default"] == "ayana"


def test_second_catalog_routes_its_own_expressions_and_hides_aliases():
    catalog = AvatarCatalog(ROOT, character="ayana-su", open_probability=1, min_open_gap=0, random_source=lambda: 0)
    assets = catalog.mapping["assets"]
    aliases = {key for key, item in assets.items() if item.get("alias")}
    assert aliases == {"neutral", "explain", "encourage", "caution", "playful", "blur"}
    originals = {key: item for key, item in assets.items() if not item.get("alias")}
    labels = {item["source_expression"] for item in originals.values()}
    assert set(catalog.guide) >= labels
    assert {item["costume"] for item in originals.values()} == {"白色校服"}
    for item in originals.values():
        speech = {"speech_ja": "ここにいるよ。", "expression": item["source_expression"],
                  "pose": item["pose"], "intent": "explain"}
        assert catalog.route(speech, item["costume"]) not in aliases
        resolved = catalog.resolve(speech, item["costume"])
        assert assets[resolved["asset_id"]]["source_expression"] == item["source_expression"]
        assert assets[resolved["asset_id"]]["pose"] == item["pose"]


def test_second_catalog_fallbacks_use_its_vocabulary():
    catalog = AvatarCatalog(ROOT, character="ayana-su")
    speech = {"speech_ja": "大丈夫だよ。", "expression": "不存在的表情", "affect": "pleased", "intent": "encourage"}
    resolved = catalog.resolve(speech, "白色校服")
    assert resolved["expression_source"] == "fallback_invalid"
    assert resolved["resolved_expression"] == "自然微笑"
    assert resolved["asset_id"] not in {key for key, item in catalog.mapping["assets"].items() if item.get("alias")}


def test_switch_character_swaps_avatar_and_voice_then_restores(tmp_path):
    settings = local(tmp_path, {
        "character": "ayana",
        "voice": {"voice_mode": "sovits", "engine_root": "D:/ayana-voice/GPT-SoVITS"},
        "avatar_costume": "校服",
        "character_profiles": {"ayana-su": SU_PROFILE},
    })
    public = settings.update({"character": "ayana-su"})
    assert public["character"] == "ayana-su"
    assert "character_profiles" not in public
    assert settings.values["avatar_root"] == "assets/ayana-su"
    assert settings.values["avatar_costume"] == "白色校服"
    assert settings.values["voice"] == SU_PROFILE["voice"]
    assert settings.values["character_profiles"]["ayana"]["voice"]["voice_mode"] == "sovits"
    reloaded = Settings(ROOT, data_root=tmp_path)
    assert reloaded.values["character"] == "ayana-su"
    assert reloaded.values["avatar_root"] == "assets/ayana-su"
    reloaded.update({"character": "ayana"})
    assert reloaded.values["avatar_root"] == "assets/ayana"
    assert reloaded.values["avatar_costume"] == "校服"
    assert reloaded.values["voice"]["engine_root"] == "D:/ayana-voice/GPT-SoVITS"
    assert [item["id"] for item in reloaded.public()["character_options"]] == ["ayana", "ayana-su"]


def test_switch_requires_imported_voice_and_keeps_disk_state(tmp_path):
    settings = local(tmp_path, {"character": "ayana", "voice": {"voice_mode": "silent"}})
    before = settings.path.read_bytes()
    with pytest.raises(ValueError, match="声音资源"):
        settings.update({"character": "ayana-su"})
    assert settings.path.read_bytes() == before
    assert settings.values["character"] == "ayana"


def test_costume_validation_follows_the_target_character(tmp_path):
    settings = local(tmp_path, {"character": "ayana", "character_profiles": {"ayana-su": SU_PROFILE}})
    with pytest.raises(ValueError, match="Unknown avatar costume"):
        settings.update({"avatar_costume": "白色校服"})
    with pytest.raises(ValueError, match="Unknown character|未知角色"):
        settings.update({"character": "missing"})
    with pytest.raises(ValueError, match="Unknown avatar costume"):
        settings.update({"character": "ayana-su", "avatar_costume": "校服"})


@pytest.mark.asyncio
async def test_runtime_switch_rebuilds_catalog_and_voice(tmp_path, monkeypatch):
    (tmp_path / "config").mkdir()
    (tmp_path / "config/local.json").write_text(json.dumps({
        "provider": "local", "character": "ayana", "voice": {"voice_mode": "silent"},
        "avatar_costume": "校服", "character_profiles": {"ayana-su": SU_PROFILE},
    }), encoding="utf-8")
    runtime = AgentRuntime(Settings(ROOT, data_root=tmp_path), desktop=Desktop(), tts=Tts())
    ws = Ws()
    runtime.clients.add(ws)
    created = []
    monkeypatch.setattr("services.tts.service.TtsService", lambda config: created.append(config) or Tts())
    try:
        assert runtime.avatars.character == "ayana"
        await runtime.handle({"type": "settings.update", "request_id": "character", "settings": {"character": "ayana-su"}})
        await asyncio.sleep(.02)
        assert runtime.avatars.character == "ayana-su"
        assert created and created[0]["voice_mode"] == "silent"
        assert runtime.settings.values["avatar_costume"] == "白色校服"
        assert any(e["type"] == "settings.ready" and e.get("request_id") == "character" for e in ws.events)
        # The prompt now describes the second catalog's vocabulary.
        text = runtime.avatars.prompt("白色校服")
        assert "自然微笑" in text and "卖萌" not in text
    finally:
        await runtime.close()
