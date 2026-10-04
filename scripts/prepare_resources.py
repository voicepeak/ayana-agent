"""Import user-selected character/voice resources into ignored local config."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from services.agent.config import Settings


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--avatar-root", type=Path)
    parser.add_argument("--voice-root", type=Path)
    args = parser.parse_args()
    settings = Settings()
    if args.avatar_root:
        from PIL import Image
        index = json.loads((args.avatar_root / "素材索引.json").read_text(encoding="utf-8"))
        mapping = json.loads((ROOT / "characters/ayana/avatar-map.json").read_text(encoding="utf-8"))
        destination = ROOT / "assets/ayana"
        destination.mkdir(parents=True, exist_ok=True)
        assets = {}
        import shutil
        for item in index["素材"]:
            filename = (args.avatar_root / item["标注后相对路径"]).resolve()
            if not filename.is_relative_to(args.avatar_root.resolve()):
                raise ValueError("Avatar path must remain inside the selected folder")
            if not filename.is_file():
                raise FileNotFoundError(f"Missing avatar expression: {filename.name}")
            with Image.open(filename) as img:
                if img.mode != "RGBA" or img.getextrema()[-1][0] != 0:
                    raise ValueError("Expected transparent RGBA avatar")
                asset_id = item["素材ID"]
                assets[asset_id] = {"file": asset_id + ".png", "source_expression": item["用户表情名称"],
                                    "pose": "open" if item["简短动作描述"] == "双手摊开" else "crossed",
                                    "costume": item["简短服装描述"], "width": img.width, "height": img.height}
            shutil.copy2(filename, destination / assets[asset_id]["file"])
        for alias, old in mapping["assets"].items():
            if alias.startswith("aya_"):
                continue
            original = next(value for value in assets.values() if value["costume"] == "校服" and value["pose"] == "crossed" and value["source_expression"] == old["source_expression"])
            assets[alias] = {**original, "file": alias + ".png"}
            shutil.copy2(destination / original["file"], destination / assets[alias]["file"])
        mapping["assets"] = assets
        mapping["transition"] = {"sentence_motion": "dip", "dip_px": 12, "duration_ms": 300}
        (ROOT / "characters/ayana/avatar-map.json").write_text(json.dumps(mapping, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        settings.values["avatar_root"] = "assets/ayana"
        print(f"Imported {len(index['素材'])} original transparent PNGs without resizing or re-encoding")
    if args.voice_root:
        v = args.voice_root.resolve()
        voice = {"voice_mode": "sovits", "python": str(v / "venv/Scripts/python.exe"),
                 "source_root": str(v / "publish/ayana_SoVITS"), "engine_root": str(v / "GPT-SoVITS"),
                 "model_gpt": str(v / "1_models/ayana-gpt-e14.ckpt"), "model_sovits": str(v / "1_models/ayana-sovits-e8.pth"),
                 "reference_audio": str(v / "publish/ayana_SoVITS/refs/ref0308.wav"),
                 "reference_text": "私を芸能界デビューさせたいという人がいるのでしょう", "cpu_threads": 8, "max_chars": 24, "pause_ms": 70}
        for key in ("python", "model_gpt", "model_sovits", "reference_audio"):
            if not Path(voice[key]).is_file():
                raise FileNotFoundError(f"Missing voice resource: {key}")
        settings.values["voice"] = voice
        print("Voice resources validated; paths saved only in ignored local configuration")
    settings.update({})


if __name__ == "__main__":
    main()
