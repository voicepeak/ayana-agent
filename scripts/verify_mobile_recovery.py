"""Public WSS -> real provider format repair -> real SoVITS acceptance.

Uses a temporary, revoked-on-exit user. Never prints credentials or chat content.
The intentionally malformed source is synthetic test data, not user conversation.
"""
import asyncio
from array import array
import base64
import json
from pathlib import Path
import sqlite3
import sys
import time
import uuid

import httpx
from websockets.asyncio.client import connect

from services.gateway.store import Store
from services.mobile_transport import read_audio_frame


async def main():
    root = Path(__file__).resolve().parents[1]
    folder = root / ".runtime/mobile-services"
    code = (folder / "activation-code.txt").read_text().strip().split(".", 1)[1]
    activation = json.loads(base64.urlsafe_b64decode(code + "=" * (-len(code) % 4)))
    base = activation["url"].rstrip("/")
    store = Store(folder / "gateway/gateway.sqlite3")
    user = "acceptance_" + uuid.uuid4().hex[:12]
    key = store.add_user(user)
    report = []
    try:
        async with httpx.AsyncClient(trust_env=False) as client:
            response = await client.post(base + "/v1/activate", json={"key": key, "device_id": "recovery_acceptance"})
            response.raise_for_status()
            session = response.json()
        speech = {"type": "speech", "key": "s1", "speech_ja": "ここにいるよ。", "display_zh": "我在这里。"}
        long_speech = {**speech, "speech_ja": "きょうはとても楽しい気分なので、あなたといっしょにいろいろなお話をしながらゆっくりと過ごしたいと思っているよ。"}
        cases = {
            "plain_japanese": "ここにいるよ。",
            "duplicate_inline_groups": "\n".join(json.dumps(e, ensure_ascii=False) for e in [speech,
                {**speech, "speech_ja": "ゆっくり話そうね。", "display_zh": "慢慢聊吧。"}]),
            "duplicate_deferred_captions": "\n".join(json.dumps(e, ensure_ascii=False) for e in [
                {k: v for k, v in speech.items() if k != "display_zh"},
                {"type": "speech", "key": "s1", "speech_ja": "また話そうね。"},
                {"type": "translation", "key": "s1", "display_zh": "我在这里。"},
                {"type": "translation", "key": "s1", "display_zh": "再聊吧。"}]),
            "long_single_sentence": json.dumps(long_speech, ensure_ascii=False),
            "missing_caption_before_invalid_tail": json.dumps({k: v for k, v in speech.items() if k != "display_zh"}, ensure_ascii=False)
                + "\n" + json.dumps({**long_speech, "key": "s2"}, ensure_ascii=False),
        }
        url = base.replace("https://", "wss://").replace("http://", "ws://")
        async with connect(url + "/v1/mobile", max_size=17 * 1024 * 1024, proxy=None) as socket:
            await socket.send(json.dumps({"access_token": session["access_token"]}))
            async with asyncio.timeout(30):
                while True:
                    event = json.loads(await socket.recv())
                    if event["type"] == "service.state" and event["state"] == "ready":
                        break
            for generation, (name, source) in enumerate(cases.items(), 1):
                turn = user + "_" + str(generation)
                started = time.monotonic()
                await socket.send(json.dumps({"type": "turn.start", "turn_id": turn,
                    "conversation_id": "synthetic_recovery", "generation_id": generation,
                    "text": "synthetic protocol acceptance", "messages": [
                        {"role": "system", "content": "This is a literal transcription task. Return ONLY the following exact text, without modification, commentary, code fences or added fields:\n" + source},
                        {"role": "user", "content": "Copy the supplied text exactly."}]}))
                speeches, captions, audio = set(), set(), set()
                idle = False
                arrivals = []
                async with asyncio.timeout(180):
                    while not (idle and speeches and speeches <= captions and speeches <= audio):
                        raw = await socket.recv()
                        if isinstance(raw, bytes):
                            event, pcm = read_audio_frame(raw)
                            assert event["generation_id"] == generation and len(pcm) > 100
                            samples = array("h", pcm)
                            if sys.byteorder != "little":
                                samples.byteswap()
                            assert max(abs(sample) for sample in samples) > 100, "Silent PCM returned"
                            audio.add(event["utterance_id"])
                            arrivals.append(round((time.monotonic() - started) * 1000))
                            await socket.send(json.dumps({"type": "audio.consumed", "utterance_id": event["utterance_id"]}))
                        else:
                            event = json.loads(raw)
                            assert event["type"] != "error", name + ": " + event.get("code", "unknown")
                            if event.get("turn_id") != turn:
                                continue
                            if event["type"] == "utterance.ready":
                                assert event["utterance_id"] not in speeches
                                speeches.add(event["utterance_id"])
                            elif event["type"] == "subtitle.ready":
                                captions.add(event["utterance_id"])
                            elif event["type"] == "task.state":
                                idle = event["state"] == "idle"
                report.append({"case": name, "turn_id": turn, "speech": len(speeches), "caption": len(captions),
                               "audio": len(audio), "arrival_ms": arrivals})
                print(json.dumps({"passed": name, "speech": len(speeches), "audio": len(audio)}), flush=True)
        async with asyncio.timeout(15):
            while True:
                with sqlite3.connect(folder / "worker/dialogue.sqlite3") as db:
                    logs = [json.loads(r[0]) for r in db.execute("SELECT body FROM events WHERE user_id=?", (user,))]
                if sum(e["type"] == "turn.finished" for e in logs) == len(cases):
                    break
                await asyncio.sleep(.25)
        assert all(e["state"] == "complete" for e in logs if e["type"] == "turn.finished")
        repairs = [e for e in logs if e["type"] == "model.repaired"]
        assert len(repairs) >= 2, "Live model did not exercise the repair path"
        result = {"passed": True, "cases": report, "format_repairs": len(repairs)}
        (root / ".runtime/benchmarks/mobile-recovery.json").write_text(json.dumps(result), encoding="utf-8")
        print(json.dumps({"passed": True, "cases": len(cases), "format_repairs": len(repairs)}))
    finally:
        store.revoke_user(user)
        store.close()


if __name__ == "__main__":
    asyncio.run(main())
