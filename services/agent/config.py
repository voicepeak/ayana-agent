from __future__ import annotations

import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class Settings:
    def __init__(self, root: Path = ROOT):
        self.root = root
        self.data_root = Path(os.environ.get("AYANA_DATA_DIR", str(root))).resolve()
        self.path = self.data_root / "config/local.json"
        self.values = json.loads((root / "config/default.json").read_text(encoding="utf-8"))
        # First personal packaged launch can seed local resource paths. No credentials in settings.
        seed = root / "config/local.json"
        if self.data_root != root and not self.path.exists() and seed.exists():
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_bytes(seed.read_bytes())
        if self.path.exists():
            self.values.update(json.loads(self.path.read_text(encoding="utf-8")))

    def public(self):
        return {k: v for k, v in self.values.items() if not any(s in k.lower() for s in ("secret", "token", "api_key"))}

    def update(self, patch: dict):
        allowed = {"hotkey", "cancel_hotkey", "provider", "base_url", "model", "send_screenshot", "subtitles", "save_history", "voice", "stt", "max_audio_ahead_ms", "max_utterances", "avatar_costume", "sentence_motion", "volume"}
        if not isinstance(patch, dict) or set(patch) - allowed:
            raise ValueError("Unsupported settings field")
        if "provider" in patch and patch["provider"] not in {"local", "openai"}:
            raise ValueError("Provider must be local or openai")
        if "avatar_costume" in patch:
            mapping = json.loads((self.root / "characters/ayana/avatar-map.json").read_text(encoding="utf-8"))
            if patch["avatar_costume"] not in {item.get("costume", "校服") for item in mapping["assets"].values()}:
                raise ValueError("Unknown avatar costume")
        if "sentence_motion" in patch and type(patch["sentence_motion"]) is not bool:
            raise ValueError("sentence_motion must be boolean")
        if "volume" in patch and (type(patch["volume"]) not in {int, float} or not 0 <= patch["volume"] <= 1):
            raise ValueError("volume must be between 0 and 1")
        if "base_url" in patch:
            from urllib.parse import urlparse
            url = urlparse(patch["base_url"])
            if url.scheme not in {"http", "https"} or not url.netloc or url.username or url.password:
                raise ValueError("Invalid API base URL")
            if url.scheme == "http" and url.hostname not in {"127.0.0.1", "localhost", "::1"}:
                raise ValueError("Remote model endpoints require HTTPS")
        for key in ("hotkey", "cancel_hotkey", "model", "base_url"):
            if key in patch and (not isinstance(patch[key], str) or len(patch[key]) > 500):
                raise ValueError(f"Invalid {key}")
        for key, low, high in (("max_utterances", 1, 12), ("max_audio_ahead_ms", 2000, 15000)):
            if key in patch and (type(patch[key]) is not int or not low <= patch[key] <= high):
                raise ValueError(f"{key} out of range")
        self.values.update(patch)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temp = self.path.with_suffix(".tmp")
        temp.write_text(json.dumps(self.values, ensure_ascii=False, indent=2), encoding="utf-8")
        temp.replace(self.path)
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
