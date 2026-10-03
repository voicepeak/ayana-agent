"""Measure full subprocess cold start, warmed Japanese synthesis and cancellation.

Usage: python scripts/benchmark_tts.py --config config/voice.local.json
Outputs contain the actual model paths for local diagnosis; keep them untracked.
"""

from __future__ import annotations

import argparse
import array
import asyncio
import base64
import json
import logging
from pathlib import Path
import platform
import sys
import time
import wave

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from services.tts.service import TtsService

SENTENCES = [
    "まず、入口のファイルから一緒に見ていこう。",
    "小さな例で、順番に確かめよう。",
    "この操作は、まだ実行していないよ。",
    "READMEとmain.pyを、順に確認しよう。",
    "画面のYour messageと、123を確認するね。",
]


def save_wav(result: dict, path: Path):
    samples = array.array("f", base64.b64decode(result["pcm_base64"]))
    if sys.byteorder != "little":
        samples.byteswap()
    integer = array.array("h", (max(-32768, min(32767, round(value * 32767))) for value in samples))
    if sys.byteorder != "little":
        integer.byteswap()
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(result["sample_rate"])
        wav.writeframes(integer.tobytes())


async def run(args):
    config = json.loads(Path(args.config).read_text(encoding="utf-8-sig"))
    # app.local.json can embed this same TTS configuration under voice/tts.
    config = config.get("voice", config.get("tts", config))
    service = TtsService(config)
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    report = {"platform": platform.platform(), "python": sys.version.split()[0],
              "measurement": "request to received PCM; excludes audio device latency",
              "samples": [], "played": bool(args.play)}
    try:
        await service.start()
        report["cold_start_ms"] = (time.perf_counter() - started) * 1000
        report["status"] = service.status
        print(json.dumps({"cold_start_ms": report["cold_start_ms"], "status": service.status}, ensure_ascii=False), flush=True)
        for index, text in enumerate(SENTENCES, 1):
            started = time.perf_counter()
            audio = await service.synthesize(text, index)
            elapsed = (time.perf_counter() - started) * 1000
            wav_path = output / f"sample-{index}.wav"
            save_wav(audio, wav_path)
            record = {"text": text, "latency_ms": elapsed,
                      **{key: value for key, value in audio.items() if key != "pcm_base64"},
                      "rtf": elapsed / audio["duration_ms"] if audio["duration_ms"] else None,
                      "wav": str(wav_path)}
            report["samples"].append(record)
            print(json.dumps(record, ensure_ascii=False), flush=True)
            if args.play:
                import winsound
                await asyncio.to_thread(winsound.PlaySound, str(wav_path), winsound.SND_FILENAME)
        task = asyncio.create_task(service.synthesize("これは取り消す文章です。後の音声は再生しないでね。", 100))
        await asyncio.sleep(0.15)
        started = time.perf_counter()
        await service.cancel(100)
        try:
            await task
            cancelled = False
        except asyncio.CancelledError:
            cancelled = True
        report["cancel_return_ms"] = (time.perf_counter() - started) * 1000
        report["cancelled_result_discarded"] = cancelled
        started = time.perf_counter()
        resumed = await service.synthesize("続けよう。", 101)
        report["cancel_to_new_pcm_ms"] = (time.perf_counter() - started) * 1000
        save_wav(resumed, output / "after-cancel.wav")
        print(json.dumps({key: value for key, value in report.items() if key not in {"samples", "status"}}, ensure_ascii=False), flush=True)
    finally:
        await service.close()
        (output / "tts-benchmark.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--output", default=".runtime/benchmarks/tts")
    parser.add_argument("--play", action="store_true")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.WARNING)
    asyncio.run(run(args))
