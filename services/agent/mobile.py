"""Persistent access token and session helpers for the mobile web client."""

from __future__ import annotations

import os
from pathlib import Path

COOKIE_NAME = "ayana_mobile"
COOKIE_MAX_AGE = 60 * 60 * 24 * 30


def token_path(data_root: Path) -> Path:
    return Path(data_root) / ".runtime" / "mobile-token"


def load_or_create_token(data_root: Path) -> str:
    configured = os.environ.get("AYANA_MOBILE_TOKEN", "").strip()
    if configured:
        if len(configured) < 24:
            raise ValueError("AYANA_MOBILE_TOKEN must contain at least 24 characters")
        return configured
    path = token_path(data_root)
    if path.is_file():
        token = path.read_text(encoding="ascii").strip()
        if len(token) >= 24:
            return token
    import secrets
    token = secrets.token_hex(32)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(token, encoding="ascii")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return token
