"""Character registry: maps a character id to its avatar map and default asset root."""
from __future__ import annotations

import json
from pathlib import Path

DEFAULT_CHARACTER = "ayana"
REGISTRY = "characters/registry.json"


def _path(root: Path, relative: str) -> Path:
    path = Path(root) / relative
    if not path.is_file():
        path = Path(__file__).resolve().parents[2] / relative
    return path


def load_registry(root: Path) -> dict:
    return json.loads(_path(root, REGISTRY).read_text(encoding="utf-8"))


def character_entry(root: Path, character: str) -> dict:
    entries = load_registry(root)["characters"]
    if character not in entries:
        raise ValueError("未知角色")
    return entries[character]


def character_map_path(root: Path, character: str | None) -> Path:
    registry = load_registry(root)
    name = character or registry.get("default", DEFAULT_CHARACTER)
    entry = registry["characters"].get(name)
    if entry is None:
        raise ValueError("未知角色")
    return _path(root, entry["map"])


def character_costumes(root: Path, character: str | None) -> list[str]:
    mapping = json.loads(character_map_path(root, character).read_text(encoding="utf-8"))
    return list(dict.fromkeys(item.get("costume", "校服") for item in mapping["assets"].values()))
