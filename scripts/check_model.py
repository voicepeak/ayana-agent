"""Live compatibility probe with existing locally stored credentials."""
import asyncio
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from services.agent.config import Settings
from services.agent.providers.model import CONTRACT, OpenAIProvider
from packages.protocol import validate_speech


async def main():
    cfg = Settings()
    started = time.perf_counter()
    events = []
    first = None
    messages = [{"role": "system", "content": CONTRACT}, {"role": "user", "content": "请用两句日语简短介绍如何从README开始学习仓库，并提供对应中文翻译。"}]
    async for event in OpenAIProvider(cfg).stream_reply(messages):
        if event.get("type") == "speech":
            validate_speech(event)
            if first is None:
                first = round((time.perf_counter() - started) * 1000)
        events.append(event)
    report = {"provider": cfg.values["base_url"], "model": cfg.values["model"], "first_speech_ms": first,
              "total_ms": round((time.perf_counter() - started) * 1000), "events": events}
    path = ROOT / ".runtime/benchmarks/model.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
