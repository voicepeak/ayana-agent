"""Verify real sentence endings, using optional local ASR as an additional check.

python scripts/verify_voice_tails.py --config config/local.json --asr-model <local Whisper model>
No ASR model is downloaded. WAVs and the local report remain in .runtime.
"""
import argparse
import asyncio
import base64
import json
from pathlib import Path
import sys
import time
import wave

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from services.tts.service import TtsService

CASES = [
    ("こんにちは。", ["こんにちは"]),
    ("今日は、どんなことを話したい？", ["話したい"]),
    ("うん、ここにいるよ。", ["いるよ"]),
    ("こんにちは。うん、ここにいるよ。今日は、どんなことを話したい？", ["いるよ", "話したい"]),
]


async def run(args):
    cfg = json.loads(Path(args.config).read_text(encoding="utf-8-sig"))
    service = TtsService(cfg.get("voice", cfg))
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    recognizer = None
    if args.asr_model:
        from faster_whisper import WhisperModel
        recognizer = WhisperModel(args.asr_model, device="cpu", compute_type="int8",
                                  cpu_threads=4, local_files_only=True)
    records = []
    failures = []
    generation = 0
    started = time.perf_counter()
    try:
        await service.start()
        assert service.status.get("semantic_tail_guard_frames") == 4
        assert service.status.get("semantic_tail_guard_long_frames") == 6
        for repetition in range(args.repeat):
            for index, (text, endings) in enumerate(CASES):
                generation += 1
                packet = await service.synthesize(text, generation)
                import numpy as np
                samples = np.frombuffer(base64.b64decode(packet["pcm_base64"]), dtype="<f4")
                assert samples.size == packet["sample_count"] and np.isfinite(samples).all()
                wav = output / f"sentence-{repetition + 1}-{index + 1}.wav"
                with wave.open(str(wav), "wb") as f:
                    f.setnchannels(1)
                    f.setsampwidth(2)
                    f.setframerate(packet["sample_rate"])
                    f.writeframes((samples.clip(-1, 1) * 32767).astype("<i2").tobytes())
                record = {"text": text, "wav": str(wav), "duration_ms": packet["duration_ms"],
                          "sample_count": packet["sample_count"], "chunk_count": packet["chunk_count"]}
                if recognizer:
                    segments, _ = recognizer.transcribe(str(wav), language="ja", beam_size=5,
                                                        vad_filter=False, condition_on_previous_text=False)
                    transcript = "".join(segment.text for segment in segments)
                    # Accept the equivalent kanji reading in this test phrase.
                    normalized = transcript.replace("居る", "いる")
                    missing = [ending for ending in endings if ending not in normalized]
                    record.update(transcript=transcript, missing_endings=missing)
                    if missing:
                        failures.append(record)
                records.append(record)
                print(json.dumps(record, ensure_ascii=True), flush=True)
        generation += 1
        cancelled = asyncio.create_task(service.synthesize(CASES[-1][0], generation))
        await asyncio.sleep(.1)
        await service.cancel(generation)
        try:
            await cancelled
            raise AssertionError("Cancelled synthesis returned playable audio")
        except asyncio.CancelledError:
            pass
        recovered = await service.synthesize(CASES[1][0], generation + 1)
        assert recovered["sample_count"] > 1000
        assert not failures, f"{len(failures)} samples need listening/review; see report"
    finally:
        await service.close()
        report = {"asr_verified": recognizer is not None, "samples": records,
                  "failed_endings": failures, "elapsed_ms": (time.perf_counter() - started) * 1000}
        (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--asr-model")
    parser.add_argument("--output", default=str(ROOT / ".runtime/benchmarks/voice-tails"))
    parser.add_argument("--repeat", type=int, default=3)
    asyncio.run(run(parser.parse_args()))
