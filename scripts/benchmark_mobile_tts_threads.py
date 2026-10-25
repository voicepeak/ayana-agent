"""Compare warmed CPU inference with fixed sentences/seeds; does not change live config."""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
from pathlib import Path
import random
import statistics
import sys
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=str(ROOT / ".runtime/mobile-services/worker.json"))
    parser.add_argument("--threads", nargs="+", type=int, default=[8, 4, 2])
    parser.add_argument("--affinity", nargs="+", type=int)
    parser.add_argument("--flush-denormal", action="store_true")
    parser.add_argument("--output", default=str(ROOT / ".runtime/benchmarks/mobile-tts-threads"))
    args = parser.parse_args()
    if args.affinity:
        import psutil
        psutil.Process().cpu_affinity(args.affinity)
    output = Path(args.output).resolve(); output.mkdir(parents=True, exist_ok=True)
    config = json.loads(Path(args.config).read_text(encoding="utf-8-sig"))
    config = config.get("voice", config)
    sentences = ["こんにちは、今日も会えて嬉しいよ。", "ゆっくり休んで、ここで一緒に話そう。"]
    records = []
    with (output / "engine.log").open("w", encoding="utf-8") as log, contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
        from services.tts.adapters.sovits import SovitsEngine
        from scripts.benchmark_tts import save_wav
        import numpy as np
        if args.flush_denormal:
            import torch
            assert torch.set_flush_denormal(True)
        engine = SovitsEngine(config); engine.prepare()
        assert engine.device_mode == "cpu", "Use this comparison only with the CPU engine"
        for threads in args.threads:
            engine.torch.set_num_threads(threads)
            for index, text in enumerate(["こんにちは。", *sentences, *sentences]):
                seed = 20261025 + max(0, index - 1) % len(sentences)
                random.seed(seed); np.random.seed(seed); engine.torch.manual_seed(seed)
                start = time.perf_counter()
                result = engine.synthesize(text, threading.Event())
                elapsed = (time.perf_counter() - start) * 1000
                if index == 0: continue
                save_wav(result, output / f"threads-{threads}-sample-{index}.wav")
                records.append({"threads": threads, "sample": index, "characters": len(text), "elapsed_ms": round(elapsed), "audio_ms": result["duration_ms"], "rtf": elapsed / result["duration_ms"], "pcm_hash": hashlib.sha256(result["pcm_base64"].encode()).hexdigest()})
    summary = [{"threads": threads, "median_ms": round(statistics.median(r["elapsed_ms"] for r in records if r["threads"] == threads)), "median_rtf": round(statistics.median(r["rtf"] for r in records if r["threads"] == threads), 3)} for threads in args.threads]
    (output / "report.json").write_text(json.dumps({"device": engine.device_mode, "precision": engine.precision, "affinity": args.affinity, "flush_denormal": args.flush_denormal, "samples": records, "summary": summary}, indent=2), encoding="utf-8")
    print(json.dumps(summary), flush=True)


if __name__ == "__main__": main()
