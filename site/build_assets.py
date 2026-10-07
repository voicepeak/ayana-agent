"""Build the static site assets from local project materials.

Usage (from the repository root):
    .\\.venv\\Scripts\\python.exe site/build_assets.py

Inputs are local-only (git-ignored): assets/ayana, .runtime/benchmarks and
.runtime/appearance-fixes-qa screenshots. Outputs are committed under site/.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
ART = SITE / "art"
SHOTS = SITE / "shots"
DATA = SITE / "data"

PORTRAIT_HEIGHT = 900
SHOT_MAX_WIDTH = 1680
COSTUME = "校服"

SCREENSHOTS = [
    (".runtime/benchmarks/companion/companion.png", "companion-dark", True),
    (".runtime/appearance-fixes-qa/paper-theme.png", "companion-paper", True),
    (".runtime/appearance-fixes-qa/dialogue.png", "companion-scroll", True),
    (".runtime/benchmarks/dialogue-focus-1791291533759/new-reply.png", "companion-reply", True),
    (".runtime/benchmarks/conversation-switcher-1791332211325/switcher-780.png", "conversation-switcher", True),
    (".runtime/benchmarks/conversations/1791183093560/topic-picker.png", "topics", True),
    (".runtime/benchmarks/packaged-desktop/welcome.png", "workshop-welcome", False),
    (".runtime/benchmarks/packaged-desktop/speaking.png", "workshop-live", False),
    (".runtime/benchmarks/full-access/1791202048948/full-access-on.png", "access", False),
    (".runtime/benchmarks/capabilities-desktop/1791116330895/task-results.png", "tasks", False),
    (".runtime/benchmarks/settings-1791278303728/appearance.png", "settings-appearance", False),
]

FONT_CANDIDATES = [
    ("C:/Windows/Fonts/simsun.ttc", 0),
    ("C:/Windows/Fonts/msyh.ttc", 0),
    ("C:/Windows/Fonts/simhei.ttf", None),
]


def load_gallery() -> dict:
    avatar_map = json.loads((ROOT / "characters/ayana/avatar-map.json").read_text(encoding="utf-8"))
    guide = json.loads((ROOT / "characters/ayana/expression-guide.json").read_text(encoding="utf-8"))

    by_pose: dict[str, dict[str, str]] = {"crossed": {}, "open": {}}
    for asset_id, asset in avatar_map["assets"].items():
        if not asset_id.startswith("aya_"):
            continue
        if asset.get("costume") != COSTUME or asset.get("pose") not in by_pose:
            continue
        by_pose[asset["pose"]][asset["source_expression"]] = asset["file"]

    expressions = []
    missing = []
    for name, note in guide.items():
        entry = {"name": name, "note": note}
        for pose in ("crossed", "open"):
            filename = by_pose[pose].get(name)
            if not filename:
                missing.append(f"{pose}:{name}")
            entry[pose] = filename
        expressions.append(entry)
    if missing:
        raise SystemExit(f"missing uniform assets: {missing}")
    return {"costume": COSTUME, "expressions": expressions}


def export_portraits(gallery: dict) -> dict[str, dict[str, str]]:
    ART.mkdir(parents=True, exist_ok=True)
    files: dict[str, dict[str, str]] = {"crossed": {}, "open": {}}
    for entry in gallery["expressions"]:
        for pose in ("crossed", "open"):
            source = ROOT / "assets/ayana" / entry[pose]
            stem = entry[pose].removesuffix(".png").split("__")[-1]
            target = f"{pose}-{stem}.webp"
            image = Image.open(source).convert("RGBA")
            height = PORTRAIT_HEIGHT
            width = round(image.width * height / image.height)
            image = image.resize((width, height), Image.LANCZOS)
            image.save(ART / target, "WEBP", quality=88, method=6)
            files[pose][entry["name"]] = f"art/{target}"
    return files


def export_screenshots() -> None:
    SHOTS.mkdir(parents=True, exist_ok=True)
    for relative, name, keep_alpha in SCREENSHOTS:
        source = ROOT / relative
        if not source.is_file():
            print(f"skip (missing): {relative}")
            continue
        image = Image.open(source)
        if image.width > SHOT_MAX_WIDTH:
            height = round(image.height * SHOT_MAX_WIDTH / image.width)
            image = image.resize((SHOT_MAX_WIDTH, height), Image.LANCZOS)
        if keep_alpha:
            image = image.convert("RGBA")
            image.save(SHOTS / f"{name}.webp", "WEBP", quality=86, method=6)
        else:
            image.convert("RGB").save(SHOTS / f"{name}.webp", "WEBP", quality=86, method=6)
        print(f"shot: {name}.webp")


def write_gallery(files: dict[str, dict[str, str]], gallery: dict) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    payload = {
        "costume": gallery["costume"],
        "poses": [
            {"id": "crossed", "label": "双手交叠"},
            {"id": "open", "label": "手臂展开"},
        ],
        "expressions": [
            {
                "name": entry["name"],
                "note": entry["note"],
                "crossed": files["crossed"][entry["name"]],
                "open": files["open"][entry["name"]],
            }
            for entry in gallery["expressions"]
        ],
    }
    script = "window.AYANA_GALLERY = " + json.dumps(payload, ensure_ascii=False, indent=2) + ";\n"
    (DATA / "expressions.js").write_text(script, encoding="utf-8")


def load_font(size: int) -> ImageFont.FreeTypeFont:
    for path, index in FONT_CANDIDATES:
        if Path(path).is_file():
            return ImageFont.truetype(path, size, index=index)
    return ImageFont.load_default(size)


def export_og() -> None:
    width, height = 1200, 630
    canvas = Image.new("RGB", (width, height), (18, 16, 24))
    draw = ImageDraw.Draw(canvas)
    for y in range(height):
        blend = y / height
        draw.line(
            [(0, y), (width, y)],
            fill=(round(18 + 18 * blend), round(16 + 12 * blend), round(24 + 10 * blend)),
        )
    draw.ellipse((width - 560, -220, width + 240, 560), fill=(35, 32, 44))
    draw.ellipse((-260, height - 340, 420, height + 260), fill=(28, 34, 38))

    portrait_path = ART / "open-a0001.webp"
    if portrait_path.is_file():
        portrait = Image.open(portrait_path).convert("RGBA")
        target_height = 560
        target_width = round(portrait.width * target_height / portrait.height)
        portrait = portrait.resize((target_width, target_height), Image.LANCZOS)
        canvas.paste(portrait, (width - target_width - 80, height - target_height + 40), portrait)

    big = load_font(72)
    mid = load_font(34)
    small = load_font(22)
    draw.text((84, 96), "AYANA · PERSONAL AGENT", font=small, fill=(201, 163, 95))
    draw.text((80, 156), "音无彩名", font=big, fill=(240, 233, 222))
    draw.text((84, 264), "立绘、声音与电影感对白，", font=mid, fill=(214, 206, 196))
    draw.text((84, 316), "收在一张呼出即聊的便签里。", font=mid, fill=(214, 206, 196))
    draw.rounded_rectangle((84, 400, 560, 452), radius=12, fill=(48, 52, 61), outline=(201, 163, 95), width=2)
    draw.text((108, 411), "Ctrl + Alt + A  呼出 Ayana", font=small, fill=(232, 218, 196))
    draw.text((84, 546), "Windows 个性化 Agent · 本地优先 · 语音可打断", font=small, fill=(150, 143, 158))
    canvas.save(SITE / "og.png", "PNG")


def export_favicon() -> None:
    icon = ROOT / "apps/desktop/public/icon.png"
    if icon.is_file():
        image = Image.open(icon).convert("RGBA").resize((128, 128), Image.LANCZOS)
        image.save(SITE / "favicon.png", "PNG")
    else:
        print("skip (missing): apps/desktop/public/icon.png")


def main() -> int:
    gallery = load_gallery()
    files = export_portraits(gallery)
    export_screenshots()
    write_gallery(files, gallery)
    export_og()
    export_favicon()
    total = sum(f.stat().st_size for f in SITE.rglob("*") if f.is_file())
    print(f"site assets ready: {total / 1024 / 1024:.1f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
