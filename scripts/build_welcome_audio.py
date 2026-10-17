"""Render the bundled welcome narration with the configured Ayana voice.

Run with the repository Python; the voice's own Python/model paths stay local.
No model API calls or audio playback are performed.
"""
from __future__ import annotations

import argparse
import array
import asyncio
import base64
import json
import hashlib
from pathlib import Path
import sys
import wave

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from services.tts.service import TtsService


async def main(config_path: Path, force: bool, only: list[str] | None = None):
    settings = json.loads(config_path.read_text(encoding="utf-8-sig"))
    voice = dict(settings.get("voice", settings))
    if not voice.get("engine_root"):
        raise ValueError("需要已配置的 Ayana 本地音色。")
    voice["voice_mode"] = "sovits"
    script = json.loads((ROOT / "config/welcome-script.json").read_text(encoding="utf-8"))
    output = ROOT / "apps/desktop/public/welcome"
    output.mkdir(parents=True, exist_ok=True)
    timeline_path = ROOT / "config/welcome-timeline.json"
    timeline = json.loads(timeline_path.read_text(encoding="utf-8")) if timeline_path.exists() else {}
    service = TtsService(voice)
    try:
        await service.start()
        if service.status.get("engine") != "gpt-sovits-ayana":
            raise RuntimeError(f"Ayana voice unavailable: {service.status}")
        for index, (key, line) in enumerate(script.items(), 1):
            if only and key not in only:
                continue
            target = output / f"{key}.wav"
            fingerprint = hashlib.sha256(json.dumps(line, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
            if target.exists() and not force and timeline.get(key, {}).get("fingerprint") == fingerprint:
                continue
            combined = bytearray()
            segments = []
            rate = None
            for part in line.get("segments", [line]):
                result = await service.synthesize(part["ja"], index)
                if rate is not None and rate != result["sample_rate"]:
                    raise ValueError("Narration sample rate changed")
                rate = result["sample_rate"]
                samples = array.array("f", base64.b64decode(result["pcm_base64"]))
                if sys.byteorder != "little":
                    samples.byteswap()
                pcm = array.array("h", (max(-32768, min(32767, round(value * 32767))) for value in samples))
                if sys.byteorder != "little":
                    pcm.byteswap()
                start = len(combined) / 2 / rate
                combined.extend(pcm.tobytes())
                end = len(combined) / 2 / rate
                combined.extend(bytes(round(rate * part.get("hold_ms", 600) / 1000) * 2))
                segments.append({"start": start, "end": end, "until": len(combined) / 2 / rate,
                                 "zh": part["zh"], "ja": part["ja"], "from": part.get("from_", 0), "to": part.get("to", 1)})
            temporary = target.with_suffix(".tmp.wav")
            with wave.open(str(temporary), "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(rate)
                wav.writeframes(combined)
            temporary.replace(target)
            timeline[key] = {"duration": len(combined) / 2 / rate, "fingerprint": fingerprint, "segments": segments}
            timeline_path.write_text(json.dumps(timeline, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            print(f"{key}: {len(combined) / 2 / rate:.2f} s, {len(segments)} aligned segments", flush=True)
    finally:
        await service.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=ROOT / "config/local.json")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--only", nargs="+", choices=["arrival", "name", "greeting", "chat", "voice", "search", "observe", "style", "ready"])
    args = parser.parse_args()
    asyncio.run(main(args.config, args.force, args.only))
