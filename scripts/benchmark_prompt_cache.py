"""Compare old rebuilt history with immutable model turns using real API usage.

Sends six short synthetic questions plus this repository's public README/source
evidence by default. Never reads conversation history or modifies personal config.
"""
from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
import sys
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import httpx
from packages.protocol import validate_speech
from services.agent.avatars import AvatarCatalog
from services.agent.config import Settings
from services.agent.context import PromptHistory, repository_message
from services.agent.providers.model import OpenAIProvider
from services.agent.prompts import PromptAssembler, tool_prompt
from services.agent.tools.registry import ToolRegistry
from services.agent.storage import ConversationStore
from services.agent.tools.repository import RepositoryReader

QUESTIONS = ["从 README 怎么开始理解这个项目？只说一句简短日语，附中文翻译，不要调用工具。",
             "这个项目的 Python 服务负责什么？只说一句简短日语，附中文翻译，不要调用工具。",
             "桌面界面和语音服务如何配合？只说一句简短日语，附中文翻译，不要调用工具。"]


async def run(cfg, rounds):
    system = PromptAssembler(ROOT, AvatarCatalog(ROOT)).build(
        full_access=cfg.values.get("full_access", False), costume=cfg.values.get("avatar_costume", "校服"),
        tools=tool_prompt(ToolRegistry(), native_tools=cfg.values.get("native_tools", True),
                          full_access=cfg.values.get("full_access", False))).system
    repo = RepositoryReader(str(ROOT)).inspect()
    report = {"model": cfg.values["model"], "rounds": rounds, "screenshots": False,
              "notes": "Small sequential sample; provider cache is asynchronous/best-effort. Shared system prefixes may already be warm.",
              "cases": []}
    async with httpx.AsyncClient(timeout=httpx.Timeout(75, connect=12), trust_env=False) as client:
        for mode in ("rebuilt_history", "immutable_turns"):
            with tempfile.TemporaryDirectory(prefix="ayana-cache-probe-") as temp:
                store = ConversationStore(Path(temp) / "history.sqlite3")
                history = PromptHistory(store)
                history.select(system, cfg.values, repo["root"])
                previous_messages = None
                try:
                    for index in range(rounds):
                        question = QUESTIONS[index % len(QUESTIONS)]
                        turn_id = "turn-" + str(index)
                        context = {"question": question, "mode": "teach", "target": None,
                                   "repository": repo, "snapshot_id": None} if mode == "rebuilt_history" else {
                                   "mode": "teach", "target": None, "snapshot_id": None,
                                   "previous_reply_reception": history.last_reception(), "previous_interrupted_reply": [], "question": question}
                        content = [{"type": "text", "text": json.dumps(context, ensure_ascii=False)}]
                        evidence_prefix = [] if mode == "rebuilt_history" else repository_message(repo)
                        prefix = store.context() if mode == "rebuilt_history" else history.messages(
                            reserve_chars=len(system) + len(json.dumps(evidence_prefix, ensure_ascii=False)) + len(content[0]["text"]) + 8800)
                        messages = [{"role": "system", "content": system}, *evidence_prefix, *prefix, {"role": "user", "content": content}]
                        base = 1 + len(evidence_prefix) + len(prefix)
                        started = time.monotonic()
                        first_speech_ms = None
                        provider = OpenAIProvider(cfg, client)
                        events = []
                        async for event in provider.stream_reply(messages):
                            if event.get("type") == "speech" and first_speech_ms is None:
                                first_speech_ms = round((time.monotonic() - started) * 1000)
                            events.append(event)
                        # The total includes network/model generation; usage is authoritative.
                        if not any(event.get("type") == "speech" for event in events):
                            raise RuntimeError("Probe returned no speech")
                        uid_keys = {}
                        store.commit({"type": "user.message", "session_id": mode, "turn_id": turn_id,
                                      "generation_id": index, "text": question})
                        for event in events:
                            if event["type"] == "speech":
                                validate_speech(event)
                                uid = "u-" + uuid.uuid4().hex[:12]
                                uid_keys[str(event["key"])] = uid
                                store.commit({**event, "type": "utterance.ready", "utterance_id": uid,
                                              "session_id": mode, "turn_id": turn_id, "generation_id": index})
                                # This probe models text display; it does not claim device playback.
                                store.commit({"type": "utterance.displayed", "utterance_id": uid})
                            elif event["type"] == "translation":
                                store.commit({"type": "subtitle.ready", "utterance_id": uid_keys[str(event["key"])],
                                              "display_zh": event["display_zh"]})
                            else:
                                raise RuntimeError("Probe unexpectedly requested tools/actions")
                        unchanged_prefix = bool(previous_messages and messages[:len(previous_messages)] == previous_messages)
                        if mode == "immutable_turns":
                            history.append(turn_id, [*provider.request_messages[base:],
                                           {"role": "assistant", "content": provider.response_text}], uid_keys, True)
                        case = {"mode": mode, "round": index + 1, "previous_request_preserved": unchanged_prefix,
                                "first_speech_ms": first_speech_ms,
                                "total_ms": round((time.monotonic() - started) * 1000), "usage": provider.usage}
                        report["cases"].append(case)
                        print(json.dumps(case, ensure_ascii=True), flush=True)
                        previous_messages = messages
                        await asyncio.sleep(2)
                finally:
                    store.close()
    report["totals"] = {}
    for mode in ("rebuilt_history", "immutable_turns"):
        cases = [case for case in report["cases"] if case["mode"] == mode]
        total = sum((case["usage"] or {}).get("prompt_tokens", 0) for case in cases)
        hit = sum((case["usage"] or {}).get("prompt_cache_hit_tokens", 0) for case in cases)
        report["totals"][mode] = {"prompt_tokens": total, "cached_tokens": hit,
                                  "weighted_hit_ratio": hit / total if total else None}
        warm = [case for case in cases if case["round"] > 1]
        warm_total = sum((case["usage"] or {}).get("prompt_tokens", 0) for case in warm)
        warm_hit = sum((case["usage"] or {}).get("prompt_cache_hit_tokens", 0) for case in warm)
        warm_miss = sum((case["usage"] or {}).get("prompt_cache_miss_tokens", 0) for case in warm)
        report["totals"][mode]["followup_rounds"] = {
            "prompt_tokens": warm_total, "cached_tokens": warm_hit, "uncached_tokens": warm_miss,
            "weighted_hit_ratio": warm_hit / warm_total if warm_total else None}
    output = ROOT / ".runtime/benchmarks/prompt-cache.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"report": str(output), "totals": report["totals"]}, ensure_ascii=True), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rounds", type=int, choices=range(2, 7), default=3)
    args = parser.parse_args()
    asyncio.run(run(Settings(), args.rounds))
