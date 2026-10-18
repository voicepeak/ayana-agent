"""Extract short Ayana interjections from the existing aligned welcome recordings.

Uses only bundled recordings; no model calls, device playback, or voice re-training.
"""
from pathlib import Path
import array
import json
import math
import sys
import wave

ROOT = Path(__file__).resolve().parents[1]
CLIPS = {"remember": ("greeting", 0)}


def main():
    source_root = ROOT / "apps/desktop/public/welcome"
    output = source_root / "snippets"
    output.mkdir(exist_ok=True)
    timeline = json.loads((ROOT / "config/welcome-timeline.json").read_text(encoding="utf-8"))
    for name, (source, index) in CLIPS.items():
        segment = timeline[source]["segments"][index]
        with wave.open(str(source_root / f"{source}.wav"), "rb") as recording:
            if recording.getsampwidth() != 2 or recording.getnchannels() != 1:
                raise ValueError("Expected the bundled mono PCM16 recording")
            rate = recording.getframerate()
            recording.setpos(round(segment["start"] * rate))
            samples = array.array("h", recording.readframes(round((segment["end"] - segment["start"]) * rate)))
        if sys.byteorder != "little":
            samples.byteswap()
        rms = math.sqrt(sum(value * value for value in samples) / max(1, len(samples)))
        gain = min(3, 5000 / max(1, rms), 30000 / max(1, max(abs(value) for value in samples)))
        fade = max(1, round(rate * .015))
        for i in range(len(samples)):
            envelope = min(1, i / fade, (len(samples) - 1 - i) / fade)
            samples[i] = round(samples[i] * gain * envelope)
        if sys.byteorder != "little":
            samples.byteswap()
        with wave.open(str(output / f"{name}.wav"), "wb") as clip:
            clip.setnchannels(1)
            clip.setsampwidth(2)
            clip.setframerate(rate)
            clip.writeframes(samples.tobytes())
        print(f"{name}: {len(samples) / rate:.2f}s")


if __name__ == "__main__":
    main()
