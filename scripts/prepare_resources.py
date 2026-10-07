"""Import user-selected character/voice resources into ignored local config."""
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from services.agent.config import Settings

SU_CHARACTER = "ayana-su"
SU_COSTUME = "白色校服"
SU_FALLBACKS = {
    "affect": {"pleased": "自然微笑", "concerned": "担忧"},
    "intent": {"explain": "平静", "encourage": "自然微笑", "caution": "担忧", "playful": "得意"},
    "default": "平静",
}
SU_ALIASES = {"neutral": "ay0000a", "explain": "ay0000a", "encourage": "ay0001a",
              "caution": "ay0006a", "playful": "ay0002a"}


def import_ayana_avatar(source: Path) -> None:
    from PIL import Image
    index = json.loads((source / "素材索引.json").read_text(encoding="utf-8"))
    mapping = json.loads((ROOT / "characters/ayana/avatar-map.json").read_text(encoding="utf-8"))
    destination = ROOT / "assets/ayana"
    destination.mkdir(parents=True, exist_ok=True)
    assets = {}
    for item in index["素材"]:
        filename = (source / item["标注后相对路径"]).resolve()
        if not filename.is_relative_to(source.resolve()):
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
        assets[alias] = {**original, "file": alias + ".png", "alias": True}
        shutil.copy2(destination / original["file"], destination / assets[alias]["file"])
    mapping["assets"] = assets
    mapping["transition"] = {"sentence_motion": "dip", "dip_px": 12, "duration_ms": 300}
    (ROOT / "characters/ayana/avatar-map.json").write_text(json.dumps(mapping, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Imported {len(index['素材'])} original transparent PNGs without resizing or re-encoding")


def su_label(item: dict) -> str | None:
    """The white-uniform set has its own emotion vocabulary."""
    action = item["动作与视角"]
    if action == "模糊背影":
        return None
    if action == "背身垂手":
        return "背影"
    emotion = item["情绪"]
    if item["脸红"] == "明显" and emotion not in {"病娇", "病娇惊讶"}:
        return "脸红" + emotion
    return emotion


def su_pose(item: dict) -> str:
    return "open" if item["动作与视角"] == "侧身垂手" else "crossed"


def import_su_avatar(source: Path) -> None:
    from PIL import Image
    index = json.loads((source / "素材索引.json").read_text(encoding="utf-8"))
    destination = ROOT / "assets/ayana-su"
    destination.mkdir(parents=True, exist_ok=True)
    assets: dict[str, dict] = {}
    by_code: dict[str, dict] = {}
    for item in index["素材"]:
        filename = (source / item["输出相对路径"]).resolve()
        if not filename.is_relative_to(source.resolve()):
            raise ValueError("Avatar path must remain inside the selected folder")
        if not filename.is_file():
            raise FileNotFoundError(f"Missing avatar expression: {filename.name}")
        with Image.open(filename) as img:
            if img.mode != "RGBA" or img.getextrema()[-1][0] != 0:
                raise ValueError("Expected transparent RGBA avatar")
            code = item["原编号"]
            label = su_label(item)
            if label is None:
                blur = {"file": "blur.png", "source_expression": "背影", "pose": "crossed",
                        "costume": SU_COSTUME, "width": img.width, "height": img.height, "alias": True}
                assets["blur"] = blur
                by_code[code] = blur
                shutil.copy2(filename, destination / blur["file"])
                continue
            asset_id = f"su_{code}"
            record = {"file": asset_id + ".png", "source_expression": label, "pose": su_pose(item),
                      "costume": SU_COSTUME, "width": img.width, "height": img.height}
            assets[asset_id] = record
            by_code[code] = record
        shutil.copy2(filename, destination / record["file"])
    for alias, code in SU_ALIASES.items():
        original = by_code.get(code)
        if original is None:
            raise FileNotFoundError(f"Missing alias source expression: {code}")
        assets[alias] = {**original, "alias": True}
    mapping = {
        "default_asset_id": "neutral",
        "intent_defaults": {"acknowledge": "neutral", "explain": "explain", "encourage": "encourage",
                            "caution": "caution", "playful": "playful"},
        "assets": assets,
        "fallbacks": SU_FALLBACKS,
        "transition": {"sentence_motion": "dip", "dip_px": 12, "duration_ms": 300},
    }
    (ROOT / "characters/ayana-su/avatar-map.json").write_text(json.dumps(mapping, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Imported {len(index['素材'])} white-uniform PNGs; expressions: "
          f"{json.dumps(sorted({item['source_expression'] for item in assets.values()}), ensure_ascii=False)}")


def su_voice(base_root: Path, voice_root: Path) -> dict:
    base, root = base_root.resolve(), voice_root.resolve()
    reference = root / "refs/ref_ayana2.wav"
    text_file = root / "refs/ref_ayana2.txt"
    voice = {"voice_mode": "sovits", "python": str(base / "venv/Scripts/python.exe"),
             "source_root": str(root), "engine_root": str(base / "GPT-SoVITS"),
             "model_gpt": str(root / "1_model/ayana2-gpt-e14.ckpt"),
             "model_sovits": str(root / "1_model/ayana2-sovits-e8.pth"),
             "reference_audio": str(reference),
             "reference_text": text_file.read_text(encoding="utf-8-sig").strip(),
             "device": "cpu", "cpu_threads": 8, "max_chars": 24, "pause_ms": 70}
    for key in ("python", "model_gpt", "model_sovits", "reference_audio"):
        if not Path(voice[key]).is_file():
            raise FileNotFoundError(f"Missing voice resource: {key}")
    return voice


def save_profile(settings: Settings, character: str, *, avatar_root: str | None = None,
                 avatar_costume: str | None = None, voice: dict | None = None) -> None:
    profiles = settings.values.setdefault("character_profiles", {})
    profile = profiles.setdefault(character, {})
    if avatar_root:
        profile["avatar_root"] = avatar_root
    if avatar_costume:
        profile["avatar_costume"] = avatar_costume
    if voice:
        profile["voice"] = voice
    if settings.values.get("character", "ayana") == character:
        if avatar_root:
            settings.values["avatar_root"] = avatar_root
        if avatar_costume:
            settings.values["avatar_costume"] = avatar_costume
        if voice:
            settings.values["voice"] = voice


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--avatar-root", type=Path)
    parser.add_argument("--voice-root", type=Path)
    parser.add_argument("--su-avatar-root", type=Path, help="Second character sprite folder with 素材索引.json")
    parser.add_argument("--su-voice-root", type=Path, help="Second character voice folder (ayana2 weights and refs)")
    parser.add_argument("--base-voice-root", type=Path, help="First voice folder that owns the shared Python and GPT-SoVITS engine")
    args = parser.parse_args()
    settings = Settings()
    if args.avatar_root:
        import_ayana_avatar(args.avatar_root)
        settings.values["avatar_root"] = "assets/ayana"
        settings.update({})
        print("Ayana avatar resources imported; paths saved only in ignored local configuration")
    if args.su_avatar_root:
        import_su_avatar(args.su_avatar_root)
        save_profile(settings, SU_CHARACTER, avatar_root="assets/ayana-su", avatar_costume=SU_COSTUME)
        settings.update({})
        print("Second character avatar resources imported; select it in 设置 → 外观与声音")
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
        settings.update({})
        print("Voice resources validated; paths saved only in ignored local configuration")
    if args.su_voice_root:
        if not args.base_voice_root:
            parser.error("--su-voice-root requires --base-voice-root (the first voice folder with venv and GPT-SoVITS)")
        voice = su_voice(args.base_voice_root, args.su_voice_root)
        save_profile(settings, SU_CHARACTER, voice=voice)
        settings.update({})
        print("Second character voice resources validated; paths saved only in ignored local configuration")


if __name__ == "__main__":
    main()
