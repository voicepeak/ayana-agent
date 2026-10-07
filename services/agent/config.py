from __future__ import annotations

import json
import re
import os
from pathlib import Path

from .characters import DEFAULT_CHARACTER, character_costumes, character_entry, character_map_path, load_registry

ROOT = Path(__file__).resolve().parents[2]


class Settings:
    def __init__(self, root: Path = ROOT, data_root: Path | None = None):
        self.root = root
        self.data_root = Path(data_root or os.environ.get("AYANA_DATA_DIR", str(root))).resolve()
        self.path = self.data_root / "config/local.json"
        self.values = json.loads((root / "config/default.json").read_text(encoding="utf-8"))
        # First personal packaged launch can seed local resource paths. No credentials in settings.
        seed = root / "config/local.json"
        if self.data_root != root and not self.path.exists() and seed.exists():
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_bytes(seed.read_bytes())
        if self.path.exists():
            self.values.update(json.loads(self.path.read_text(encoding="utf-8")))
        # The removed watch shortcut must not reserve a key in old profiles.
        self.values.pop("watch_hotkey", None)
        self.values.setdefault("character", DEFAULT_CHARACTER)
        self.values.setdefault("character_profiles", {})

    def public(self):
        def clean(value):
            if isinstance(value, dict):
                return {k: clean(v) for k, v in value.items()
                        if (k == "model_max_tokens" and type(v) is int)
                        or not any(s in k.lower() for s in ("secret", "token", "api_key"))}
            if isinstance(value, list):
                return [clean(v) for v in value]
            return value
        result = clean(self.values)
        result.pop("character_profiles", None)
        result["character_options"] = self.character_options()
        return result

    def character_options(self):
        registry = load_registry(self.root)
        active = self.values.get("character", DEFAULT_CHARACTER)
        profiles = self.values.get("character_profiles", {})
        options = []
        for character, entry in registry["characters"].items():
            if character == active:
                ready = character_map_path(self.root, character).is_file()
            else:
                profile = profiles.get(character) or {}
                ready = bool(profile.get("voice")) and character_map_path(self.root, character).is_file()
            options.append({"id": character, "name": entry["name"], "ready": ready})
        return options

    def validate(self, patch: dict):
        allowed = {"hotkey", "cancel_hotkey", "provider", "base_url", "model", "send_screenshot", "subtitles", "save_history", "remember_user", "ambient_attention", "voice", "stt", "max_audio_ahead_ms", "max_utterances", "detailed_max_utterances", "character", "avatar_costume", "sentence_motion", "volume", "task_limits", "model_max_tokens", "native_tools", "full_access", "search_proxy", "search_provider", "companion_ui"}
        if not isinstance(patch, dict) or set(patch) - allowed:
            raise ValueError("Unsupported settings field")
        for key in ("send_screenshot", "subtitles", "save_history", "remember_user", "ambient_attention"):
            if key in patch and type(patch[key]) is not bool:
                raise ValueError(f"{key} must be boolean")
        if "native_tools" in patch and type(patch["native_tools"]) is not bool:
            raise ValueError("native_tools must be boolean")
        if "full_access" in patch and type(patch["full_access"]) is not bool:
            raise ValueError("full_access must be boolean")
        if "search_provider" in patch and (not isinstance(patch["search_provider"], str) or patch["search_provider"] not in {"auto", "bing", "brave"}):
            raise ValueError("search_provider must be auto, bing or brave")
        if "search_proxy" in patch:
            from urllib.parse import urlparse
            value = patch["search_proxy"]
            if not isinstance(value, str) or len(value) > 500:
                raise ValueError("Invalid search_proxy")
            if value:
                proxy = urlparse(value)
                if (proxy.scheme not in {"http", "https"} or proxy.hostname not in {"127.0.0.1", "localhost", "::1"}
                        or proxy.username or proxy.password or proxy.path not in {"", "/"}
                        or proxy.query or proxy.fragment or not proxy.port):
                    raise ValueError("代理需使用带端口的本机 HTTP/HTTPS 地址，例如 http://127.0.0.1:7892。")
        if "provider" in patch and patch["provider"] not in {"local", "openai"}:
            raise ValueError("Provider must be local or openai")
        if "character" in patch:
            registry = load_registry(self.root)
            if not isinstance(patch["character"], str) or patch["character"] not in registry["characters"]:
                raise ValueError("未知角色")
        if "avatar_costume" in patch:
            character = patch.get("character", self.values.get("character", DEFAULT_CHARACTER))
            if patch["avatar_costume"] not in character_costumes(self.root, character):
                raise ValueError("Unknown avatar costume")
        if "sentence_motion" in patch and type(patch["sentence_motion"]) is not bool:
            raise ValueError("sentence_motion must be boolean")
        if "volume" in patch and (type(patch["volume"]) not in {int, float} or not 0 <= patch["volume"] <= 1):
            raise ValueError("volume must be between 0 and 1")
        if "companion_ui" in patch:
            design = patch["companion_ui"]
            bounds = {"portrait_size": (160, 640), "frame_width": (380, 900), "frame_height": (320, 720), "font_size": (14, 40), "opacity": (0, 100), "portrait_x": (-4096, 4096), "portrait_y": (-4096, 4096), "background_x": (0, 100), "background_y": (0, 100), "background_zoom": (100, 300)}
            if not isinstance(design, dict) or set(design) - {*bounds, "portrait_range", "show_subtitles", "show_japanese", "show_bubbles", "background_mode", "background_color", "bubble_color", "portrait_side", "primary_language", "translation_language", "background_image", "theme"}:
                raise ValueError("Invalid companion design")
            for key, (low, high) in bounds.items():
                if key in design and (type(design[key]) is not int or not low <= design[key] <= high):
                    raise ValueError(f"{key} out of range")
            if "portrait_range" in design and (not isinstance(design["portrait_range"], str) or design["portrait_range"] not in {"half", "full"}):
                raise ValueError("Invalid portrait range")
            if "background_mode" in design and (not isinstance(design["background_mode"], str) or design["background_mode"] not in {"transparent", "frosted", "image", "minimal", "solid"}):
                raise ValueError("Invalid note background")
            if "theme" in design and (not isinstance(design["theme"], str) or design["theme"] not in {"ink", "paper", "forest", "sea", "custom"}):
                raise ValueError("Invalid note theme")
            for key in ("background_color", "bubble_color"):
                if key in design:
                    if not isinstance(design[key], str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", design[key]):
                        raise ValueError(f"Invalid {key}")
            if "portrait_side" in design and design["portrait_side"] not in ("left", "right"):
                raise ValueError("Invalid portrait side")
            for key, choices in (("primary_language", {"ja", "zh", "en"}), ("translation_language", {"none", "ja", "zh", "en"})):
                if key in design and (not isinstance(design[key], str) or design[key] not in choices):
                    raise ValueError(f"Invalid {key}")
            if "background_image" in design and (not isinstance(design["background_image"], str) or not re.fullmatch(r"(?:[0-9a-f]{64})?", design["background_image"])):
                raise ValueError("Invalid background_image")
            for key in ("show_subtitles", "show_japanese", "show_bubbles"):
                if key in design and type(design[key]) is not bool:
                    raise ValueError(f"{key} must be boolean")
            patch = {**patch, "companion_ui": {**self.values.get("companion_ui", {}), **design}}
        if "base_url" in patch:
            from urllib.parse import urlparse
            if not isinstance(patch["base_url"], str):
                raise ValueError("Invalid API base URL")
            url = urlparse(patch["base_url"])
            if url.scheme not in {"http", "https"} or not url.netloc or url.username or url.password:
                raise ValueError("Invalid API base URL")
            if url.scheme == "http" and url.hostname not in {"127.0.0.1", "localhost", "::1"}:
                raise ValueError("Remote model endpoints require HTTPS")
        for key in ("hotkey", "cancel_hotkey", "model", "base_url"):
            if key in patch and (not isinstance(patch[key], str) or len(patch[key]) > 500):
                raise ValueError(f"Invalid {key}")
        for key in ("hotkey", "cancel_hotkey"):
            if key in patch and not patch[key].strip():
                raise ValueError(f"{key} must not be empty")
        candidate = {**self.values, **patch}
        if candidate.get("provider") == "openai" and any(key in patch for key in ("provider", "model")) and not candidate.get("model", "").strip():
            raise ValueError("在线模型需要填写模型名称")
        shortcuts = [candidate.get(key, "").strip().casefold() for key in ("hotkey", "cancel_hotkey")]
        if any(key in patch for key in ("hotkey", "cancel_hotkey")) and len(set(shortcuts)) < len(shortcuts):
            raise ValueError("呼出和打断快捷键不能相同")
        for key, low, high in (("max_utterances", 1, 12), ("detailed_max_utterances", 12, 64), ("max_audio_ahead_ms", 2000, 15000)):
            if key in patch and (type(patch[key]) is not int or not low <= patch[key] <= high):
                raise ValueError(f"{key} out of range")
        if "model_max_tokens" in patch and (type(patch["model_max_tokens"]) is not int or not 1000 <= patch["model_max_tokens"] <= 12000):
            raise ValueError("model_max_tokens out of range")
        if "task_limits" in patch:
            limits = patch["task_limits"]
            if not isinstance(limits, dict) or set(limits) - {"rounds", "calls", "seconds"}:
                raise ValueError("Invalid task_limits")
            for key, value in limits.items():
                if type(value) is not int or not 1 <= value <= {"rounds": 24, "calls": 64, "seconds": 600}[key]:
                    raise ValueError("Invalid task budget")
            patch = {**patch, "task_limits": {**self.values.get("task_limits", {}), **limits}}
        if "voice" in patch:
            if not isinstance(patch["voice"], dict):
                raise ValueError("voice must be an object")
            if "voice_mode" in patch["voice"] and patch["voice"]["voice_mode"] not in ("auto", "sovits", "system", "silent"):
                raise ValueError("Invalid voice mode")
            patch = {**patch, "voice": {**self.values.get("voice", {}), **patch["voice"]}}
        if "stt" in patch:
            if not isinstance(patch["stt"], dict):
                raise ValueError("stt must be an object")
            language = patch["stt"].get("language")
            if "language" in patch["stt"] and (not isinstance(language, str) or not language or len(language) > 16):
                raise ValueError("Invalid recognition language")
            patch = {**patch, "stt": {**self.values.get("stt", {}), **patch["stt"]}}
        return patch

    def _switch_character(self, target: str, preferred_costume=None) -> dict:
        """Swap the active avatar/voice set while keeping both profiles in local config."""
        entry = character_entry(self.root, target)
        if not character_map_path(self.root, target).is_file():
            raise ValueError(f"尚未导入「{entry['name']}」的立绘素材；请先运行 scripts/prepare_resources.py")
        profiles = dict(self.values.get("character_profiles", {}))
        profile = profiles.get(target)
        if not profile or not profile.get("voice"):
            raise ValueError(f"还没有配置「{entry['name']}」的声音资源；请先运行 scripts/prepare_resources.py 导入")
        current = self.values.get("character", DEFAULT_CHARACTER)
        profiles[current] = {"avatar_root": self.values.get("avatar_root"), "voice": self.values.get("voice", {}),
                             "avatar_costume": self.values.get("avatar_costume")}
        costumes = character_costumes(self.root, target)
        costume = preferred_costume if preferred_costume in costumes else profile.get("avatar_costume")
        if costume not in costumes:
            costume = costumes[0]
        return {"character": target, "character_profiles": profiles,
                "avatar_root": profile.get("avatar_root", entry.get("avatar_root", f"assets/{target}")),
                "avatar_costume": costume, "voice": profile["voice"]}

    def update(self, patch: dict):
        validated = self.validate(patch)
        current = self.values.get("character", DEFAULT_CHARACTER)
        if validated.get("character", current) != current:
            candidate = {**self.values, **validated,
                         **self._switch_character(validated["character"], validated.get("avatar_costume"))}
        else:
            candidate = {**self.values, **validated}
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temp = self.path.with_suffix(".tmp")
        temp.write_text(json.dumps(candidate, ensure_ascii=False, indent=2), encoding="utf-8")
        temp.replace(self.path)
        self.values = candidate
        return self.public()

    def key(self):
        value = os.environ.get(self.values.get("api_key_env", "AYANA_API_KEY")) or os.environ.get("DEEPSEEK_API_KEY")
        if value:
            return value
        from .credentials import load_key
        path = self.data_root / ".runtime/credentials.dpapi"
        seed = self.root / ".runtime/credentials.dpapi"
        if not path.exists() and self.data_root != self.root and seed.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(seed.read_bytes())
        return load_key(path)

    def search_key(self):
        from .credentials import load_key
        return os.environ.get("AYANA_SEARCH_API_KEY", "") or load_key(self.data_root / ".runtime/search-credentials.dpapi")
