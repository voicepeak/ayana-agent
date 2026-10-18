import json
import os
from pathlib import Path
import pytest

from services.agent.config import Settings


ROOT = Path(__file__).resolve().parents[1]


def test_deepseek_search_provider_round_trips(tmp_path):
    settings = Settings(root=ROOT, data_root=tmp_path)
    settings.update({'search_provider': 'deepseek'})
    assert Settings(root=ROOT, data_root=tmp_path).values['search_provider'] == 'deepseek'


def test_local_search_proxy_can_be_saved_and_disabled(tmp_path):
    settings = Settings(root=ROOT, data_root=tmp_path)
    settings.update({'search_proxy': 'http://127.0.0.1:7892'})
    assert Settings(root=ROOT, data_root=tmp_path).values['search_proxy'] == 'http://127.0.0.1:7892'
    settings.update({'search_proxy': ''})
    assert Settings(root=ROOT, data_root=tmp_path).values['search_proxy'] == ''


def test_desktop_profiles_cannot_keep_the_local_demo_provider(tmp_path, monkeypatch):
    monkeypatch.setenv('AYANA_DESKTOP', '1')
    settings = Settings(root=ROOT, data_root=tmp_path)
    assert settings.values['provider'] == 'openai'


@pytest.mark.skipif(os.name != 'nt', reason='DPAPI is Windows-only')
def test_model_api_key_is_encrypted_saved_and_clearable(tmp_path, monkeypatch):
    monkeypatch.delenv('AYANA_API_KEY', raising=False)
    monkeypatch.delenv('DEEPSEEK_API_KEY', raising=False)
    settings = Settings(root=ROOT, data_root=tmp_path)
    settings.save_key('sk-test-secret')
    path = tmp_path / '.runtime/credentials.dpapi'
    assert path.is_file()
    assert b'sk-test-secret' not in path.read_bytes()
    assert settings.key() == 'sk-test-secret'
    assert settings.clear_key()
    assert settings.key() == ''


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


def test_pending_voice_restart_clears_only_after_profile_load(tmp_path):
    config = tmp_path / "config/local.json"
    config.parent.mkdir()
    config.write_text(json.dumps({"voice": {"voice_mode": "sovits", "restart_pending": True,
                                            "engine_root": "pack/engine"}}), encoding="utf-8")
    settings = Settings(root=ROOT, data_root=tmp_path)
    assert settings.values["voice"]["voice_mode"] == "sovits"
    assert "restart_pending" not in settings.values["voice"]
    assert "restart_pending" not in json.loads(config.read_text(encoding="utf-8"))["voice"]


def test_recognition_language_patch_preserves_provider_paths_and_model(tmp_path):
    settings = Settings(root=ROOT, data_root=tmp_path)
    settings.update({"stt": {"provider": "openai", "model": "custom", "base_url": "https://example.com/v1", "model_path": "local-model"}})
    settings.update({"stt": {"language": "zh"}, "max_tool_rounds": 6})
    loaded = Settings(root=ROOT, data_root=tmp_path)
    assert loaded.values["stt"] == {"provider": "openai", "model": "custom", "base_url": "https://example.com/v1", "model_path": "local-model", "language": "zh"}
    assert loaded.values["max_tool_rounds"] == 6


def test_public_settings_keeps_output_budget_but_redacts_nested_credentials(tmp_path):
    settings = Settings(root=ROOT, data_root=tmp_path)
    settings.update({"model_max_tokens": 4000})
    settings.values["voice"].update({"api_key": "secret-key", "access_token": "secret-token"})
    public = settings.public()
    assert public["model_max_tokens"] == 4000
    assert "api_key" not in public["voice"]
    assert "access_token" not in public["voice"]


def test_ambient_speech_and_interval_round_trip(tmp_path):
    settings = Settings(root=ROOT, data_root=tmp_path)
    settings.update({"ambient_speech": False, "ambient_interval_min": 60, "ambient_interval_max": 120})
    loaded = Settings(root=ROOT, data_root=tmp_path)
    assert loaded.values["ambient_speech"] is False
    assert loaded.values["ambient_interval_min"] == 60
    assert loaded.values["ambient_interval_max"] == 120


def test_portrait_bounce_round_trips(tmp_path):
    settings = Settings(root=ROOT, data_root=tmp_path)
    assert settings.values["portrait_bounce"] is True
    settings.update({"portrait_bounce": False})
    assert Settings(root=ROOT, data_root=tmp_path).values["portrait_bounce"] is False


def test_temperature_and_history_budget_round_trip(tmp_path):
    settings = Settings(root=ROOT, data_root=tmp_path)
    assert settings.values["temperature"] == 1.0
    assert settings.values["history_budget_chars"] == 128000
    settings.update({"temperature": 1.3, "history_budget_chars": 200000})
    loaded = Settings(root=ROOT, data_root=tmp_path)
    assert loaded.values["temperature"] == 1.3
    assert loaded.values["history_budget_chars"] == 200000


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
    {"task_limits": {"seconds": 601}}, {"max_utterances": 0}, {"max_tool_rounds": 0}, {"max_tool_rounds": 25},
    {"ambient_speech": "no"}, {"portrait_bounce": "no"}, {"ambient_interval_min": 5}, {"ambient_interval_max": 601},
    {"ambient_interval_min": 120, "ambient_interval_max": 60},
    {"temperature": -0.1}, {"temperature": 2.5}, {"temperature": "warm"},
    {"history_budget_chars": 8000}, {"history_budget_chars": 600000}, {"history_budget_chars": True},
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
