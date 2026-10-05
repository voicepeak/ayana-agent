import json
from pathlib import Path
import pytest

from services.agent.config import Settings


ROOT = Path(__file__).resolve().parents[1]


def test_local_search_proxy_can_be_saved_and_disabled(tmp_path):
    settings = Settings(root=ROOT, data_root=tmp_path)
    settings.update({'search_proxy': 'http://127.0.0.1:7892'})
    assert Settings(root=ROOT, data_root=tmp_path).values['search_proxy'] == 'http://127.0.0.1:7892'
    settings.update({'search_proxy': ''})
    assert Settings(root=ROOT, data_root=tmp_path).values['search_proxy'] == ''


@pytest.mark.parametrize('value', [None, True, 'socks5://127.0.0.1:7892', 'http://proxy.example:7892',
                                  'http://user:password@127.0.0.1:7892', 'http://127.0.0.1',
                                  'http://127.0.0.1:7892/path', 'http://127.0.0.1:7892?key=x',
                                  'http://127.0.0.1:99999'])
def test_invalid_search_proxy_does_not_change_settings(tmp_path, value):
    settings = Settings(root=ROOT, data_root=tmp_path)
    previous = dict(settings.values)
    with pytest.raises(ValueError):
        settings.update({'search_proxy': value})
    assert settings.values == previous


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
