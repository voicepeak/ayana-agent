"""Bundle character sources and resized portraits, without any running PC service."""
from __future__ import annotations

import json
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]


def main():
    registry = json.loads((ROOT / "characters/registry.json").read_text(encoding="utf-8"))
    characters = {}
    for character, entry in registry["characters"].items():
        mapping = json.loads((ROOT / entry["map"]).read_text(encoding="utf-8"))
        directory = ROOT / "apps/mobile/public/characters" / character
        directory.mkdir(parents=True, exist_ok=True)
        for asset in mapping["assets"].values():
            source = ROOT / entry["avatar_root"] / asset["file"]
            if not source.is_file():
                raise FileNotFoundError(source)
            target = directory / (source.stem + ".webp")
            if not target.exists() or target.stat().st_mtime < source.stat().st_mtime:
                with Image.open(source) as image:
                    image.thumbnail((1200, 1600), Image.Resampling.LANCZOS)
                    image.save(target, "WEBP", quality=88, method=4)
            asset["file"] = f"characters/{character}/{target.name}"
        folder = ROOT / "characters" / character
        guide = json.loads((folder / "expression-guide.json").read_text(encoding="utf-8"))
        persona = ROOT / "characters/ayana/persona.md"
        style = ROOT / "characters/ayana/speech-style.md"
        characters[character] = {"name": entry["name"], "mapping": mapping, "guide": guide,
            "persona": persona.read_text(encoding="utf-8"), "style": style.read_text(encoding="utf-8")}
    output = ROOT / "apps/mobile/src/generated/characters.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(characters, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print("Bundled mobile character catalogs and portraits:", ", ".join(characters))


if __name__ == "__main__":
    main()
