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


def test_recognition_language_patch_preserves_provider_paths_and_model(tmp_path):
    settings = Settings(root=ROOT, data_root=tmp_path)
    settings.update({"stt": {"provider": "openai", "model": "custom", "base_url": "https://example.com/v1", "model_path": "local-model"}})
    settings.update({"stt": {"language": "zh"}, "task_limits": {"calls": 8}})
    loaded = Settings(root=ROOT, data_root=tmp_path)
    assert loaded.values["stt"] == {"provider": "openai", "model": "custom", "base_url": "https://example.com/v1", "model_path": "local-model", "language": "zh"}
    assert loaded.values["task_limits"] == {"rounds": 12, "calls": 8, "seconds": 180}


def test_public_settings_keeps_output_budget_but_redacts_nested_credentials(tmp_path):
    settings = Settings(root=ROOT, data_root=tmp_path)
    settings.update({"model_max_tokens": 4000})
    settings.values["voice"].update({"api_key": "secret-key", "access_token": "secret-token"})
    public = settings.public()
    assert public["model_max_tokens"] == 4000
    assert "api_key" not in public["voice"]
    assert "access_token" not in public["voice"]


def test_failed_settings_write_keeps_memory_and_disk_consistent(tmp_path, monkeypatch):
    settings = Settings(root=ROOT, data_root=tmp_path)
    settings.update({"volume": .5})
    previous = dict(settings.values)
    def fail_replace(*args, **kwargs):
        raise OSError("disk unavailable")
    monkeypatch.setattr(Path, "replace", fail_replace)
    with pytest.raises(OSError, match="disk unavailable"):
        settings.update({"volume": .9, "stt": {"language": "ja"}})
    assert settings.values == previous
    assert Settings(root=ROOT, data_root=tmp_path).values == previous


def test_removed_watch_shortcut_does_not_reserve_old_profile_key(tmp_path):
    config = tmp_path / "config/local.json"
    config.parent.mkdir()
    config.write_text('{"watch_hotkey":"Control+Alt+W"}', encoding="utf-8")
    settings = Settings(root=ROOT, data_root=tmp_path)
    assert "watch_hotkey" not in settings.public()
    settings.update({"hotkey": "Control+Alt+W"})
    assert "watch_hotkey" not in Settings(root=ROOT, data_root=tmp_path).values


@pytest.mark.parametrize("patch", [
    {"save_history": "false"}, {"subtitles": 1}, {"send_screenshot": None},
    {"voice": {"voice_mode": "missing"}}, {"stt": []}, {"stt": {"language": None}},
    {"task_limits": {"seconds": 601}}, {"max_utterances": 0},
    {"provider": "openai", "model": " "}, {"hotkey": " "},
    {"hotkey": "Control+A", "cancel_hotkey": "control+a"},
    {"watch_hotkey": "CommandOrControl+Alt+A"},
])
def test_invalid_preferences_do_not_mutate_memory_or_disk(tmp_path, patch):
    settings = Settings(root=ROOT, data_root=tmp_path)
    settings.update({"volume": .5})
    previous = settings.path.read_bytes()
    with pytest.raises(ValueError):
        settings.update(patch)
    assert settings.path.read_bytes() == previous
    assert settings.values == Settings(root=ROOT, data_root=tmp_path).values
