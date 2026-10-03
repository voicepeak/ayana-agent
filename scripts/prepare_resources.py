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
        mapping = json.loads((ROOT / "characters/ayana/avatar-map.json").read_text(encoding="utf-8"))
        destination = ROOT / "assets/ayana"
        destination.mkdir(parents=True, exist_ok=True)
        source = args.avatar_root / "aya_z1a0000__校服_双手交叠"
        for item in mapping["assets"].values():
            filename = source / (item["source_expression"] + "_校服_双手交叠.png")
            if not filename.is_file():
                raise FileNotFoundError(f"Missing avatar expression: {item['source_expression']}")
            with Image.open(filename) as img:
                if img.mode != "RGBA":
                    raise ValueError("Expected transparent RGBA avatar")
                img.save(destination / item["file"], optimize=True)
        settings.values["avatar_root"] = "assets/ayana"
        print("Imported five normal school-uniform expressions, preserving pixels")
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
