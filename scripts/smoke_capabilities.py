"""Small real-model smoke: fetch public evidence and save a verified text artifact."""
from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from services.agent.config import Settings
from services.agent.runtime import AgentRuntime


class SilentVoice:
    status = {"state": "ready", "engine": "silent"}
    async def start(self): pass
    async def close(self): pass
    async def cancel(self, gen): pass
    async def synthesize(self, text, generation):
        return {"duration_ms": 0, "engine": "silent", "pcm_base64": ""}


class EvidenceOnlyDesktop:
    status = {"available": False}
    def cancel(self): pass
    def close(self): pass


class Receipts:
    def __init__(self): self.events = []
    async def send_json(self, event): self.events.append(event)


async def main():
    output = ROOT / ".runtime/benchmarks/capabilities-live" / str(int(time.time()))
    settings = Settings(root=ROOT, data_root=output)
    configured = bool(settings.values.get("model") and settings.key())
    if not configured:
        print(json.dumps({"model_configured": False, "result": "needs_model_configuration"}))
        return 2
    settings.values.update(provider="openai", save_history=False, send_screenshot=False,
                           task_limits={"rounds": 6, "calls": 8, "seconds": 120})
    agent = AgentRuntime(settings, desktop=EvidenceOnlyDesktop(), tts=SilentVoice())
    receipt = Receipts()
    agent.clients.add(receipt)
    try:
        # Public page only; no user repository, desktop image or conversation history.
        await agent.handle({"type": "turn.start", "mode": "execute", "text":
            "请先用 web.fetch 读取 https://example.com 的真实正文，再用 files.create 在 root_id=output 创建 example-note.md，"
            "内容只需标题、一句中文总结和工具返回的真实来源 URL。保存后核对工具结果。日语回复最多两句。"})
        try:
            await agent.task
        except asyncio.CancelledError:
            pass
        await asyncio.sleep(.02)
        artifact = output / "artifacts/example-note.md"
        report = {"model_configured": True, "task": agent.active_task.public(), "source_count": len(agent.web.sources),
                  "file_exists": artifact.is_file(), "artifact_count": len(agent.store.records("artifact")),
                  "errors": [{"code": event.get("code"), "message": event.get("message")} for event in receipt.events if event["type"] in {"error", "tool.failed"}],
                  "output_directory": str(output)}
        if artifact.is_file():
            report["has_source_url"] = "https://example.com" in artifact.read_text(encoding="utf-8")
        success = report["task"]["state"] == "succeeded" and report["source_count"] and report["file_exists"] and report.get("has_source_url")
        report["passed"] = bool(success)
        output.mkdir(parents=True, exist_ok=True)
        (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0 if success else 1
    finally:
        await agent.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
