"""Build the saved-setting voice and optional original-game completion clip.

Use --game-recording with the local 000ayana15th pure-voice WAV to extract
the original line at 00:10:26.320–00:10:29.320. The completion line is never TTS.
"""
from __future__ import annotations

import argparse
import array
import asyncio
import base64
import json
import math
from pathlib import Path
import sys
import wave

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from services.tts.service import TtsService

OUTPUT = ROOT / "apps/desktop/public/welcome/snippets"


def write_clip(name: str, samples: list[float], rate: int):
    peak = max(abs(value) for value in samples)
    rms = math.sqrt(sum(value * value for value in samples) / len(samples))
    gain = min(3, .16 / max(.001, rms), .9 / max(.001, peak))
    fade = max(1, round(rate * .012))
    pcm = array.array("h", (round(max(-1, min(1, value * gain)) * 30000 *
          min(1, i / fade, (len(samples) - 1 - i) / fade)) for i, value in enumerate(samples)))
    if sys.byteorder != "little":
        pcm.byteswap()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with wave.open(str(OUTPUT / f"{name}.wav"), "wb") as clip:
        clip.setnchannels(1)
        clip.setsampwidth(2)
        clip.setframerate(rate)
        clip.writeframes(pcm.tobytes())
    print(f"{name}: {len(samples) / rate:.2f}s", flush=True)


async def main(args):
    if args.game_recording:
        with wave.open(str(args.game_recording), "rb") as source:
            if source.getsampwidth() != 2:
                raise ValueError("Expected the original PCM16 recording")
            rate, channels = source.getframerate(), source.getnchannels()
            source.setpos(round(626.32 * rate))
            raw = array.array("h", source.readframes(round(3 * rate)))
        if sys.byteorder != "little":
            raw.byteswap()
        write_clip("champion", [sum(raw[i:i + channels]) / channels / 32768 for i in range(0, len(raw), channels)], rate)
    if args.skip_setting:
        return
    settings = json.loads(args.config.read_text(encoding="utf-8-sig"))
    service = TtsService(dict(settings.get("voice", settings), voice_mode="sovits"))
    try:
        await service.start()
        if service.status.get("engine") != "gpt-sovits-ayana":
            raise RuntimeError("Configured Ayana voice is unavailable")
        result = await service.synthesize("設定完了。", 1)
        samples = array.array("f", base64.b64decode(result["pcm_base64"]))
        if sys.byteorder != "little":
            samples.byteswap()
        write_clip("setting", list(samples), result["sample_rate"])
    finally:
        await service.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=ROOT / "config/local.json")
    parser.add_argument("--game-recording", type=Path)
    parser.add_argument("--skip-setting", action="store_true")
    asyncio.run(main(parser.parse_args()))
