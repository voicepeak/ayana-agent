"""Route model expression choices to the installed character catalog."""
from __future__ import annotations

import json
from pathlib import Path


class AvatarCatalog:
    def __init__(self, root: Path):
        file = root / "characters/ayana/avatar-map.json"
        if not file.is_file():
            file = Path(__file__).resolve().parents[2] / "characters/ayana/avatar-map.json"
        self.mapping = json.loads(file.read_text(encoding="utf-8"))

    def route(self, speech: dict, costume: str = "校服") -> str:
        assets = self.mapping["assets"]
        requested = speech.get("expression", "")
        pose = speech.get("pose", "")
        # A model may choose a catalog ID, but cannot change the user's outfit.
        exact = assets.get(requested, {})
        if exact and exact.get("costume", "校服") == costume:
            return requested
        label = exact.get("source_expression", requested)
        candidates = [(key, item) for key, item in assets.items() if item.get("costume", "校服") == costume and key.startswith("aya_")]
        if not candidates:
            return self.mapping["intent_defaults"].get(speech["intent"], "neutral")
        labels = {item["source_expression"] for _, item in candidates}
        if label not in labels:
            affect = speech.get("affect")
            label = {"pleased": "卖萌", "concerned": "担忧", "surprised": "害怕"}.get(affect)
            if not label:
                label = {"explain": "正经", "encourage": "卖萌", "caution": "担忧", "playful": "得意"}.get(speech["intent"], "休闲")
        if not pose:
            pose = "open" if speech["intent"] in {"explain", "encourage"} else "crossed"
        matching = [(key, item) for key, item in candidates if item["source_expression"] == label]
        asset = next((key for key, item in matching if item["pose"] == pose), matching[0][0] if matching else candidates[0][0])
        return asset

    def prompt(self, costume: str = "校服") -> str:
        choices = {item["source_expression"] for item in self.mapping["assets"].values() if item.get("costume", "校服") == costume}
        return ('For each speech choose expression from these exact labels according to the sentence and conversation: '
                + ', '.join(sorted(choices))
                + '. Choose pose crossed (双手交叠) or open (双手摊开) according to the sentence. Keep the user-selected outfit. '
                'Use subtle expressions for ordinary conversation; stronger expressions only when context warrants them.')
