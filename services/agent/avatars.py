"""Route model expression choices to the installed character catalog."""
from __future__ import annotations

import json
import random
from pathlib import Path

from .characters import DEFAULT_CHARACTER, character_entry, character_map_path


class AvatarCatalog:
    def __init__(self, root: Path, *, character: str | None = None, avatar_root: str | None = None,
                 open_probability: float = .12, min_open_gap: int = 4, random_source=None):
        self.character = character or DEFAULT_CHARACTER
        file = character_map_path(root, self.character)
        self.character_root = file.parent
        entry = character_entry(root, self.character)
        self.avatar_root = avatar_root or entry.get("avatar_root") or f"assets/{self.character}"
        self.mapping = json.loads(file.read_text(encoding="utf-8"))
        self.guide = json.loads((file.parent / "expression-guide.json").read_text(encoding="utf-8"))
        self.open_probability = open_probability
        self.min_open_gap = min_open_gap
        self.random = random_source or random.random
        self.since_open = min_open_gap

    def asset_file(self, root: Path, asset_id: str) -> Path | None:
        """Resolve one asset inside this character's own root, with a bounded fallback."""
        base = (Path(root) / self.avatar_root).resolve()
        item = self.mapping["assets"].get(asset_id)
        if not item:
            return None
        file = (base / item["file"]).resolve()
        if not file.is_relative_to(base):
            return None
        if not file.exists():
            fallback = self.mapping["assets"].get(self.mapping.get("default_asset_id", "neutral"))
            file = (base / fallback["file"]).resolve() if fallback else file
        return file if file.is_relative_to(base) and file.exists() else None

    def route(self, speech: dict, costume: str = "校服") -> str:
        return self.resolve(speech, costume)["asset_id"]

    def resolve(self, speech: dict, costume: str = "校服") -> dict:
        """Keep the model choice and actual rendered expression independently observable."""
        assets = self.mapping["assets"]
        requested = speech.get("expression", "")
        pose = speech.get("pose", "")
        # A model may choose a catalog ID, but cannot change the user's outfit.
        exact = assets.get(requested, {})
        if exact and exact.get("costume", "校服") == costume:
            pose = exact.get("pose", pose)
        label = exact.get("source_expression", requested)
        candidates = [(key, item) for key, item in assets.items()
                      if item.get("costume", "校服") == costume and not item.get("alias")]
        if not candidates:
            asset = self.mapping["intent_defaults"].get(speech["intent"], self.mapping.get("default_asset_id", "neutral"))
            asset = asset if asset in assets else self.mapping.get("default_asset_id", "neutral")
            return {"asset_id": asset, "resolved_expression": assets[asset]["source_expression"],
                    "resolved_pose": assets[asset]["pose"], "expression_source": "fallback_costume"}
        labels = {item["source_expression"] for _, item in candidates}
        source = "model_asset" if exact else "model_label"
        if label not in labels:
            source = "fallback_missing" if not requested else "fallback_invalid"
            affect = speech.get("affect")
            fallbacks = self.mapping.get("fallbacks", {})
            # Surprise alone does not justify fear. Explicit expression choices
            # can still select either fear variant when the context warrants it.
            label = fallbacks.get("affect", {"pleased": "卖萌", "concerned": "担忧"}).get(affect)
            if not label:
                label = fallbacks.get("intent", {"explain": "正经", "encourage": "卖萌", "caution": "担忧", "playful": "得意"}).get(
                    speech["intent"], fallbacks.get("default", "休闲"))
        if pose != "open" or self.since_open < self.min_open_gap or self.random() >= self.open_probability:
            pose = "crossed"
        matching = [(key, item) for key, item in candidates if item["source_expression"] == label]
        asset = next((key for key, item in matching if item["pose"] == pose), matching[0][0] if matching else candidates[0][0])
        self.since_open = 0 if assets[asset]["pose"] == "open" else self.since_open + 1
        return {"asset_id": asset, "resolved_expression": assets[asset]["source_expression"],
                "resolved_pose": assets[asset]["pose"], "expression_source": source}

    def prompt(self, costume: str = "校服") -> str:
        from .prompts import expression_prompt
        return expression_prompt(self, costume)

    def recent_context(self, speeches: list[dict], costume: str = "校服") -> list[dict]:
        """Only faces that were actually presented can anchor the next reply."""
        result, seen = [], set()
        for speech in reversed(speeches):
            uid = speech.get("utterance_id")
            if uid in seen:
                continue
            seen.add(uid)
            if not speech.get("displayed"):
                continue
            if speech.get("status") == "partial" and not speech.get("played_samples", 0):
                continue
            item = self.mapping["assets"].get(speech.get("asset_id"), {})
            if not item.get("source_expression"):
                continue
            result.append({"expression": item["source_expression"], "pose": item["pose"]})
            if len(result) == 3:
                break
        return list(reversed(result))
