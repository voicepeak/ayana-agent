"""Live LAN gateway -> DeepSeek -> resident SoVITS smoke test; never prints credentials."""
import asyncio
import base64
import json
from pathlib import Path
import sqlite3
import time
import uuid

import httpx
from websockets.asyncio.client import connect

from services.mobile_transport import read_audio_frame


async def main():
    root = Path(__file__).resolve().parents[1]
    encoded = (root / ".runtime/mobile-services/activation-code.txt").read_text().strip().split(".", 1)[1]
    activation = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
    # Keep the test loopback; the issued activation code still contains the LAN URL.
    async with httpx.AsyncClient(trust_env=False) as client:
        response = await client.post("http://127.0.0.1:17330/v1/activate", json={"key": activation["key"], "device_id": "gateway_smoke"})
        response.raise_for_status()
        session = response.json()
    turn = "smoke_" + uuid.uuid4().hex
    started = time.monotonic()
    speech, audio, idle, ready = 0, 0, False, False
    timings = []
    async with connect("ws://127.0.0.1:17330/v1/mobile", max_size=17 * 1024 * 1024) as socket:
        await socket.send(json.dumps({"access_token": session["access_token"]}))
        async with asyncio.timeout(180):
            while not ready:
                event = json.loads(await socket.recv())
                if event["type"] == "service.state":
                    assert event["state"] == "ready", "SoVITS worker is not ready: " + event["state"]
                    ready = True
            await socket.send(json.dumps({"type": "turn.start", "turn_id": turn, "conversation_id": "gateway_smoke",
                "generation_id": 101, "text": "请用两句简短日语向我问好，每句附中文翻译。", "messages": [
                    {"role": "system", "content": 'Return only newline-delimited JSON, exactly two short Japanese speech sentences and their translations. Each speech must contain Japanese kana, end with 。 and be 5-20 characters. Format: {"type":"speech","key":"s1","speech_ja":"こんにちは。"}\n{"type":"translation","key":"s1","display_zh":"你好。"}. Then s2. No markdown.'},
                    {"role": "user", "content": "请用两句简短日语向我问好，每句附中文翻译。"}]}))
            while not (idle and audio >= speech and speech >= 2):
                raw = await socket.recv()
                elapsed = round((time.monotonic() - started) * 1000)
                if isinstance(raw, bytes):
                    event, pcm = read_audio_frame(raw)
                    assert event["generation_id"] == 101 and len(pcm) > 100
                    audio += 1
                    timings.append({"sentence": audio, "arrived_ms": elapsed, "synthesis_ms": round(event.get("synthesis_ms", 0)), "audio_ms": round(event["duration_ms"])})
                    await socket.send(json.dumps({"type": "audio.consumed", "utterance_id": event["utterance_id"]}))
                else:
                    event = json.loads(raw)
                    assert event["type"] != "error", "Gateway error: " + event.get("code", "unknown")
                    if event["type"] == "utterance.ready":
                        speech += 1
                        assert "asset_id" not in event and event["audio_enabled"]
                    if event["type"] == "task.state":
                        idle = event["state"] == "idle"
    database = root / ".runtime/mobile-services/worker/dialogue.sqlite3"
    async with asyncio.timeout(10):
        while True:
            with sqlite3.connect(database) as db:
                kinds = dict(db.execute("SELECT type,COUNT(*) FROM events WHERE turn_id=? GROUP BY type", (turn,)))
            if kinds.get("turn.finished") and kinds.get("subtitle.ready", 0) == speech:
                break
            await asyncio.sleep(.25)
    assert kinds.get("user.message") == 1 and kinds.get("utterance.ready") == speech
    print(json.dumps({"passed": True, "speech_count": speech, "audio_count": audio, "timings": timings, "pc_log_counts": kinds}, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())
