"""Route model expression choices to the installed character catalog."""
from __future__ import annotations

import json
import random
from pathlib import Path


class AvatarCatalog:
    def __init__(self, root: Path, *, open_probability: float = .12, min_open_gap: int = 4, random_source=None):
        file = root / "characters/ayana/avatar-map.json"
        if not file.is_file():
            file = Path(__file__).resolve().parents[2] / "characters/ayana/avatar-map.json"
        self.mapping = json.loads(file.read_text(encoding="utf-8"))
        self.open_probability = open_probability
        self.min_open_gap = min_open_gap
        self.random = random_source or random.random
        self.since_open = min_open_gap

    def route(self, speech: dict, costume: str = "校服") -> str:
        assets = self.mapping["assets"]
        requested = speech.get("expression", "")
        pose = speech.get("pose", "")
        # A model may choose a catalog ID, but cannot change the user's outfit.
        exact = assets.get(requested, {})
        if exact and exact.get("costume", "校服") == costume:
            pose = exact.get("pose", pose)
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
        if pose != "open" or self.since_open < self.min_open_gap or self.random() >= self.open_probability:
            pose = "crossed"
        matching = [(key, item) for key, item in candidates if item["source_expression"] == label]
        asset = next((key for key, item in matching if item["pose"] == pose), matching[0][0] if matching else candidates[0][0])
        self.since_open = 0 if assets[asset]["pose"] == "open" else self.since_open + 1
        return asset

    def prompt(self, costume: str = "校服") -> str:
        choices = {item["source_expression"] for item in self.mapping["assets"].values() if item.get("costume", "校服") == costume}
        return ('For each speech choose expression from these exact labels according to the sentence and conversation: '
                + ', '.join(sorted(choices))
                + '. Default pose is crossed (双手交叠). Request open (双手摊开) only occasionally for a clear invitation or emphatic explanation; avoid it in ordinary replies and consecutive sentences. Keep the user-selected outfit. '
                'Use subtle expressions for ordinary conversation; stronger expressions only when context warrants them.')
