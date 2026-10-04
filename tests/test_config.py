import json
from pathlib import Path

from services.agent.config import Settings


ROOT = Path(__file__).resolve().parents[1]


def test_explicit_unicode_profile_wins_over_inherited_profile(tmp_path, monkeypatch):
    profile = tmp_path / "纪的个人配置"
    (profile / "config").mkdir(parents=True)
    (profile / "config/local.json").write_text(json.dumps({"provider": "openai", "voice": {"voice_mode": "sovits", "engine_root": "user-engine"}}), encoding="utf-8")
    monkeypatch.setenv("AYANA_DATA_DIR", str(tmp_path / "wrong-profile"))
    settings = Settings(root=ROOT, data_root=profile)
    assert settings.path == profile / "config/local.json"
    assert settings.values["voice"]["voice_mode"] == "sovits"
    assert settings.values["provider"] == "openai"


def test_voice_mode_update_preserves_model_paths_and_survives_restart(tmp_path):
    settings = Settings(root=ROOT, data_root=tmp_path)
    settings.update({"voice": {"voice_mode": "sovits", "engine_root": "user-engine", "model_gpt": "user-gpt", "python": "user-python"}})
    settings.update({"voice": {"voice_mode": "auto"}, "sentence_motion": False})
    loaded = Settings(root=ROOT, data_root=tmp_path)
    expected = {"voice_mode": "auto", "engine_root": "user-engine", "model_gpt": "user-gpt", "python": "user-python"}
    assert {key: loaded.values["voice"][key] for key in expected} == expected
