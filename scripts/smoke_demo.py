"""Real model + Ayana PCM + screenshot smoke, on a window owned by this script.

Playback receipts here exercise protocol only; actual device playback is tested
in the Electron app. No user application is typed into by this script.
"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import httpx
from websockets.asyncio.client import connect


async def main():
    token = secrets.token_urlsafe(32)
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    output = ROOT / ".runtime/benchmarks"
    output.mkdir(parents=True, exist_ok=True)
    state = output / "smoke-target.json"
    if state.exists():
        state.unlink()
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    env = dict(os.environ, AYANA_RUNTIME_TOKEN=token, PYTHONIOENCODING="utf-8", AYANA_DATA_DIR=str(output / "smoke-data"))
    logfile = (output / "smoke-server.log").open("w", encoding="utf-8")
    server = subprocess.Popen([sys.executable, "-m", "services.agent", "--port", str(port)], cwd=ROOT, env=env, stdout=logfile, stderr=logfile, creationflags=flags)
    target = subprocess.Popen([sys.executable, "-m", "native.windows.demo_target", "--state", str(state), "--auto-close", "180"], cwd=ROOT, env=env, creationflags=flags)
    report = {"audio_device_played": False, "model": "deepseek-flash", "events": [], "errors": []}
    try:
        async with httpx.AsyncClient(trust_env=False) as client:
            for _ in range(120):
                try:
                    response = await client.get(f"http://127.0.0.1:{port}/health", headers={"Authorization": "Bearer " + token}, timeout=2)
                    if response.status_code == 200 and state.exists():
                        break
                except httpx.HTTPError:
                    pass
                await asyncio.sleep(.5)
            else:
                raise RuntimeError("Demo services did not start")
            unauthorized = await client.get(f"http://127.0.0.1:{port}/health")
            report["unauthorized_status"] = unauthorized.status_code
        data = json.loads(state.read_text(encoding="utf-8"))
        async with connect(f"ws://127.0.0.1:{port}/ws", additional_headers={"Authorization": "Bearer " + token}, max_size=20 * 1024 * 1024) as ws:
            await ws.send(json.dumps({"type": "target.bind", "hwnd": data["hwnd"]}))
            while True:
                e = json.loads(await asyncio.wait_for(ws.recv(), 15))
                if e["type"] == "snapshot.ready":
                    report["snapshot"] = {k: v for k, v in e.items() if k not in {"png_base64"}}
                    break
                if e["type"] == "error":
                    raise RuntimeError(e["message"])
            await ws.send(json.dumps({"type": "turn.start", "text": "看这个窗口和仓库：界面里的输入框叫什么？这个项目如何启动？只回答两句很短的日语和中文翻译。", "repository_root": str(ROOT), "mode": "teach"}))
            started = time.perf_counter()
            audio_count = 0
            turn_generation = None
            while True:
                e = json.loads(await asyncio.wait_for(ws.recv(), 95))
                kind = e["type"]
                if kind == "user.message":
                    turn_generation = e["generation_id"]
                report["events"].append({"type": kind, "generation_id": e["generation_id"], "elapsed_ms": round((time.perf_counter() - started) * 1000),
                    **({"message": e.get("message"), "error": e.get("error"), "source": e.get("source"), "state": e.get("state")} if kind in {"service.state", "error", "tool.failed"} else {}),
                    **({"speech_ja": e["speech_ja"]} if kind == "utterance.ready" else {}),
                    **({"display_zh": e["display_zh"]} if kind == "subtitle.ready" else {})})
                if kind == "error":
                    report["errors"].append(e["message"])
                if kind == "audio.ready":
                    audio_count += 1
                    import base64
                    pcm = base64.b64decode(e["pcm_base64"])
                    samples = len(pcm) // 4
                    report.setdefault("audio", []).append({"utterance_id": e["utterance_id"], "engine": e["engine"], "duration_ms": e["duration_ms"], "sample_rate": e["sample_rate"], "samples": samples})
                    await ws.send(json.dumps({"type": "playback.ended", "utterance_id": e["utterance_id"], "generation_id": e["generation_id"], "played_samples": samples}))
                if kind == "task.state" and turn_generation is not None and e["generation_id"] == turn_generation and e["state"] in {"idle", "failed"}:
                    break
            if audio_count < 1 or report["errors"]:
                raise RuntimeError("End-to-end smoke failed: " + str(report["errors"]))
            await ws.send(json.dumps({"type": "generation.cancel"}))
            while True:
                e = json.loads(await asyncio.wait_for(ws.recv(), 5))
                if e["type"] == "generation.cancelled":
                    report["cancel_generation"] = e["generation_id"]
                    break
            report["passed"] = True
    finally:
        for p in (target, server):
            if p.poll() is None:
                p.terminate()
                try:
                    p.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    p.kill()
        logfile.close()
        (output / "demo-smoke.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items() if k != "snapshot"}, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
