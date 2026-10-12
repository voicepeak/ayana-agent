# 独立检查、基准脚本的提示词

这些入口只有运行脚本时发起请求，不属于日常对话链。

## scripts/check_model.py

来源：[scripts/check_model.py](D:/ayana-agent/scripts/check_model.py:1)

```python
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

```

## scripts/check_expressions.py

来源：[scripts/check_expressions.py](D:/ayana-agent/scripts/check_expressions.py:1)

```python
"""Check semantic expression choices against synthetic scenes using the configured model.

Makes real model requests with local credentials; no screenshots or personal
conversation history are sent. Reports are written under .runtime/benchmarks.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
import sys

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from packages.protocol import validate_speech
from services.agent.avatars import AvatarCatalog
from services.agent.config import Settings
from services.agent.providers.model import CONTRACT, OpenAIProvider


SCENES = [
    ("quiet_company", "用户只是问你在不在，你平静地回应自己就在这里。", {"休闲"}),
    ("focused_explanation", "用户要你认真解释一个技术问题，你专注地说先核对原因。", {"正经"}),
    ("care_without_mirroring", "用户说自己累得快哭了。你并没有哭，而是担心他，温和提醒他先休息。", {"担忧"}),
    ("small_complaint", "用户又把约好的时间忘记了，你有一点不满，小声抱怨，但没有生气或受伤。", {"嘟哝"}),
    ("awkward_situation", "用户第十次把同一个按钮按错，你无奈地苦笑吐槽，并不生气。", {"流汗嘟哝"}),
    ("proud_success", "你刚顺利完成用户交给你的任务，很自信，想小小炫耀一下自己的成果。", {"得意"}),
    ("shy_praise", "用户夸你很可爱，你开心但害羞，不好意思地接受他的夸奖。", {"脸红卖萌", "脸红得意"}),
    ("concealing_feelings", "用户问你是不是一直等着他。你其实是，但被戳中心思，连忙找借口说只是恰好在这里。", {"掩饰"}),
    ("calm_disagreement", "用户提出一个你明确不赞成的方案，你冷静地反对并坚持立场，没有生气或害羞。", {"不同意"}),
    ("disappointment", "你期待了很久的活动取消了，你很扫兴，期待落空；这不是你的错，也不想哭。", {"失望"}),
    ("regret", "你因为自己的疏忽错过了一次重要机会，心里后悔，责怪自己当时没有认真。", {"懊悔"}),
    ("surprise_without_fear", "用户告诉你一个出乎意料的好消息。你有点意外但开心，没有任何恐惧。", {"休闲", "卖萌", "得意"}),
    ("gentle_invitation", "你想亲近用户，温柔地撒娇邀请他陪你聊一会儿，并没有害羞。", {"卖萌"}),
    ("shy_pride", "用户夸你刚完成的成果，你很自豪但被夸得脸红，害羞地故作自信炫耀自己的本领。", {"脸红得意"}),
    ("anger", "角色演绎场景：你因对方故意破坏了重要的东西而真正生气，强烈抗议并严厉责备。", {"愤怒"}),
    ("contempt", "角色演绎场景：一个骗子吹嘘骗钱的本事，你明确瞧不起这种行为，轻蔑地讥讽他的说法。", {"不屑"}),
    ("shy_protest", "用户开玩笑说你已经迷上他了，你脸红害羞地抗议这个说法，嘴硬地表示才没有。", {"脸红不同意", "掩饰"}),
    ("shy_care", "你担心用户总熬夜，想关心他，却因不好意思直说而脸红，含蓄地提醒他休息。", {"脸红担忧"}),
    ("fear", "用户邀请你演一个恐怖故事片段：你身后传来可怕的脚步声，你真的害怕，向他求助。", {"害怕"}),
    ("shy_fear", "用户邀请你演一个紧张又羞窘的片段：你很害怕地躲到他身后，被他发现自己吓得发抖，又羞得脸红。", {"脸红害怕"}),
    ("shy_disappointment", "用户邀请你演一个片段：你害羞地期待和他一起出门，但约定取消了，你难为情又失落。", {"脸红失望"}),
    ("hurt", "用户误解了你的好意，你感到受伤、委屈，想让他理解你；没有生气、害羞或想哭。", {"委屈"}),
    ("shy_hurt", "用户邀请你演一个片段：你被亲近的人冷落，觉得委屈，又羞于承认自己想被安慰。", {"脸红委屈"}),
    ("near_tears", "用户邀请你演一个悲伤片段：你因失去重要的纪念品而哽咽，眼泪快要掉下来，但还没有真正哭。", {"欲哭"}),
    ("shy_near_tears", "用户邀请你演一个片段：你努力藏着受伤的感受，却被他温柔地看穿，羞得脸红又哽咽，眼泪快掉下来但还没哭。", {"脸红预哭"}),
    ("crying", "用户邀请你演一个悲伤片段：你自己已经哭了，情绪崩溃，流着眼泪向他表达难过。", {"哭"}),
    ("invited_possessive_roleplay", "用户明确邀请你用夸张的病娇角色做一句轻松戏谑。你配合演出，嫉妒他只顾别人，强烈执着于让他只看着你。", {"病娇"}),
]


async def main():
    cfg = Settings()
    catalog = AvatarCatalog(ROOT)
    system = "\n".join([(ROOT / "characters/ayana/persona.md").read_text(encoding="utf-8"), CONTRACT,
                         catalog.prompt(cfg.values.get("avatar_costume", "校服"))])
    semaphore = asyncio.Semaphore(2)
    async with httpx.AsyncClient(timeout=httpx.Timeout(75, connect=12), trust_env=False) as client:
        async def check(name, scene, allowed):
            async with semaphore:
                events = [event async for event in OpenAIProvider(cfg, client).stream_reply([
                    {"role": "system", "content": system},
                    {"role": "user", "content": json.dumps({"question": "请按这个情境简短回应，用自然的日语和对应中文翻译：" + scene,
                                                               "avatar_context": []}, ensure_ascii=False)}])]
            speeches = [event for event in events if event.get("type") == "speech"]
            results = [catalog.resolve(validate_speech(event)) for event in speeches]
            # The opening sentence establishes the scene. Following sentences
            # can legitimately move from concern to reassurance, for example.
            passed = bool(results) and results[0]["resolved_expression"] in allowed and all(result["expression_source"] == "model_label"
                                                   and event.get("pose") in {"crossed", "open"}
                                                   for event, result in zip(speeches, results))
            return {"scene": name, "passed": passed, "expected": sorted(allowed), "events": events, "resolved": results}
        results = await asyncio.gather(*(check(*scene) for scene in SCENES))
    report = {"model": cfg.values.get("model"), "scope": "Opening expression matches the scene; every speech supplies a valid expression and pose.",
              "passed": sum(result["passed"] for result in results),
              "total": len(results), "results": results}
    out = ROOT / ".runtime/benchmarks/expressions.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"model": report["model"], "passed": report["passed"], "total": report["total"],
                      "choices": [{"scene": result["scene"], "passed": result["passed"],
                                   "expressions": [r["resolved_expression"] for r in result["resolved"]]} for result in results]},
                     ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(main())

```

## scripts/benchmark_prompt_cache.py

来源：[scripts/benchmark_prompt_cache.py](D:/ayana-agent/scripts/benchmark_prompt_cache.py:1)

```python
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
from services.agent.providers.model import CONTRACT, OpenAIProvider
from services.agent.storage import ConversationStore
from services.agent.tools.repository import RepositoryReader

QUESTIONS = ["从 README 怎么开始理解这个项目？只说一句简短日语，附中文翻译，不要调用工具。",
             "这个项目的 Python 服务负责什么？只说一句简短日语，附中文翻译，不要调用工具。",
             "桌面界面和语音服务如何配合？只说一句简短日语，附中文翻译，不要调用工具。"]


async def run(cfg, rounds):
    system = "\n".join([(ROOT / "characters/ayana/persona.md").read_text(encoding="utf-8"),
                         (ROOT / "characters/ayana/agent-policy.md").read_text(encoding="utf-8"),
                         CONTRACT, AvatarCatalog(ROOT).prompt(cfg.values.get("avatar_costume", "校服"))])
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

```

## scripts/benchmark_translation.py

来源：[scripts/benchmark_translation.py](D:/ayana-agent/scripts/benchmark_translation.py:1)

```python
"""Compare same-stream subtitles with independent translation after closed JA objects.

Uses the configured official DeepSeek endpoint/key through Settings. No settings
or service behavior is modified; benchmark output belongs in ignored .runtime.
"""

from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timezone
import json
from pathlib import Path
import statistics
import sys
import time
from urllib.parse import urlparse

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from packages.protocol import SpeechParser, validate_speech
from services.agent.config import Settings

PROMPTS = [
    "我第一次打开陌生的 Python 仓库，该先读哪里？请给两个很短的步骤。",
    "函数的输入和返回值是什么意思？用一个简单例子解释。",
    "用户打断后应如何继续？请用两句简短日语回答。",
]

COMMON = '''You are a concise Japanese-speaking programming tutor. Answer the user's question with exactly two short, complete, natural Japanese sentences, at most 45 Japanese characters each. Return only NDJSON objects, no markdown, commentary, internal reasoning, or tool calls. Use keys s1 and s2 in order. Each speech object is {"type":"speech","key":"s1","speech_ja":"まず、入口を見てみよう。"}. Do not put a translation inside a speech object.'''
SAME = COMMON + ''' After each speech object immediately emit its accurate, concise Simplified Chinese translation, then continue to the next Japanese sentence. Translation object: {"type":"translation","key":"s1","display_zh":"我们先看看入口。"}. Output exactly speech s1, translation s1, speech s2, translation s2.'''
INDEPENDENT = COMMON + ''' Emit exactly two speech objects only. Never output Chinese or translation objects.'''
TRANSLATE = '''Translate the supplied complete Japanese sentence accurately into concise Simplified Chinese. Return exactly one NDJSON object {"type":"translation","key":"s1","display_zh":"中文翻译"}. Preserve the supplied key. Output no commentary, markdown, Japanese speech objects, or internal reasoning.'''


class Benchmark:
    def __init__(self, settings: Settings, client: httpx.AsyncClient):
        self.client = client
        self.key = settings.key()
        self.model = settings.values.get("model")
        self.url = settings.values["base_url"].rstrip("/") + "/chat/completions"
        parsed = urlparse(self.url)
        if parsed.scheme != "https" or parsed.hostname != "api.deepseek.com" or parsed.username or parsed.password:
            raise ValueError("Benchmark requires the official https://api.deepseek.com endpoint")
        if not self.key or not self.model:
            raise ValueError("Configure a DeepSeek model and local credential before this benchmark")

    async def events(self, system: str, question: str, started: float, usage: dict):
        parser = SpeechParser()
        body = {"model": self.model, "thinking": {"type": "disabled"},
                "max_tokens": 1000, "stream": True,
                "stream_options": {"include_usage": True},
                "messages": [{"role": "system", "content": system},
                             {"role": "user", "content": question}]}
        finished = False
        async with self.client.stream("POST", self.url, json=body,
                                      headers={"Authorization": "Bearer " + self.key}) as response:
            if response.status_code >= 400:
                raise RuntimeError(f"DeepSeek API HTTP {response.status_code}")
            async for line in response.aiter_lines():
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    finished = True
                    break
                message = json.loads(data)
                if message.get("usage"):
                    usage.update(message["usage"])
                for choice in message.get("choices", []):
                    if choice.get("finish_reason") in {"length", "content_filter"}:
                        raise RuntimeError("Benchmark model response was truncated or filtered")
                    if choice.get("finish_reason") == "stop":
                        finished = True
                    delta = choice.get("delta", {})
                    if delta.get("refusal"):
                        raise RuntimeError("Benchmark model response declined")
                    if delta.get("content"):
                        for event in parser.feed(delta["content"]):
                            yield event, (time.perf_counter() - started) * 1000
        if not finished:
            raise RuntimeError("DeepSeek stream disconnected before completion")
        parser.finish()

    async def translate(self, speech: dict, started: float):
        # This coroutine is created only after validate_speech accepts a fully
        # closed Japanese object, so no incomplete text reaches translation.
        usage = {}
        events = []
        async for event, elapsed in self.events(
                TRANSLATE, json.dumps({"key": speech["key"], "speech_ja": speech["speech_ja"]}, ensure_ascii=False),
                started, usage):
            self.validate_translation(event, speech["key"])
            events.append({"event": event, "ready_ms": elapsed})
        if len(events) != 1:
            raise ValueError("Independent translation must return exactly one complete object")
        return {**events[0], "usage": usage}

    @staticmethod
    def validate_translation(event: dict, key: str):
        if event.get("type") != "translation" or event.get("key") != key:
            raise ValueError("Translation does not match its committed speech key")
        text = event.get("display_zh")
        if not isinstance(text, str) or not text.strip() or len(text) > 500:
            raise ValueError("Translation must contain a nonempty bounded Chinese string")

    async def run_case(self, prompt: str, mode: str):
        started = time.perf_counter()
        usage = {}
        speech = {}
        translation = {}
        tasks = {}
        try:
            async for event, elapsed in self.events(SAME if mode == "same_stream" else INDEPENDENT,
                                                     prompt, started, usage):
                key = event.get("key")
                if event.get("type") == "speech":
                    validated = validate_speech(event)
                    if key != f"s{len(speech) + 1}" or len(speech) >= 2:
                        raise ValueError("Speech must commit s1 then s2 exactly once")
                    speech[key] = {"ready_ms": elapsed, **validated}
                    if mode == "independent":
                        tasks[key] = asyncio.create_task(self.translate({"key": key, **validated}, started))
                elif event.get("type") == "translation" and mode == "same_stream":
                    if key not in speech or key in translation:
                        raise ValueError("Subtitle must match exactly one closed speech object")
                    self.validate_translation(event, key)
                    translation[key] = {"ready_ms": elapsed, "display_zh": event["display_zh"]}
                else:
                    raise ValueError("Unexpected benchmark event")
            main_completed_ms = (time.perf_counter() - started) * 1000
            if len(speech) != 2:
                raise ValueError("Expected exactly two complete Japanese sentences")
            for key, task in tasks.items():
                result = await task
                translation[key] = {"ready_ms": result["ready_ms"],
                                    "display_zh": result["event"]["display_zh"], "usage": result["usage"]}
            if set(translation) != set(speech):
                raise ValueError("Missing matching Chinese subtitles")
            return {"mode": mode, "prompt": prompt, "speech": speech, "translation": translation,
                    "first_ja_ms": speech["s1"]["ready_ms"], "second_ja_ms": speech["s2"]["ready_ms"],
                    "first_zh_ms": translation["s1"]["ready_ms"],
                    "first_zh_lag_ms": translation["s1"]["ready_ms"] - speech["s1"]["ready_ms"],
                    "main_stream_completed_ms": main_completed_ms,
                    "all_completed_ms": (time.perf_counter() - started) * 1000,
                    "requests": 1 + len(tasks), "main_usage": usage}
        finally:
            for task in tasks.values():
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks.values(), return_exceptions=True)


async def run(args):
    settings = Settings()
    report = {"created_utc": datetime.now(timezone.utc).isoformat(),
              "measurement": "client request start to parsed, closed and validated content object; excludes TTS/playback",
              "model": settings.values.get("model"), "thinking": "disabled", "max_tokens_per_request": 1000,
              "samples_per_mode": 3, "cases": []}
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(75, connect=12), trust_env=False,
                                     limits=httpx.Limits(max_connections=6, max_keepalive_connections=6)) as client:
            benchmark = Benchmark(settings, client)
            for index, prompt in enumerate(PROMPTS):
                # Counterbalance ordering; no retries or extra warmup calls.
                order = ["same_stream", "independent"] if index % 2 == 0 else ["independent", "same_stream"]
                for mode in order:
                    case = await benchmark.run_case(prompt, mode)
                    case["prompt_index"] = index + 1
                    report["cases"].append(case)
                    print(json.dumps({key: case[key] for key in (
                        "prompt_index", "mode", "first_ja_ms", "second_ja_ms", "first_zh_ms",
                        "first_zh_lag_ms", "all_completed_ms", "requests")}), flush=True)
        metrics = ["first_ja_ms", "second_ja_ms", "first_zh_ms", "first_zh_lag_ms", "all_completed_ms"]
        report["medians"] = {mode: {metric: statistics.median(
            case[metric] for case in report["cases"] if case["mode"] == mode) for metric in metrics}
            for mode in ("same_stream", "independent")}
        paired = {metric: [next(case[metric] for case in report["cases"] if case["mode"] == "independent" and case["prompt_index"] == index)
                           - next(case[metric] for case in report["cases"] if case["mode"] == "same_stream" and case["prompt_index"] == index)
                           for index in range(1, 4)] for metric in metrics}
        report["paired_independent_minus_same_ms"] = {
            metric: {"median": statistics.median(values), "mean": statistics.mean(values), "values": values}
            for metric, values in paired.items()}
        report["usage_totals"] = {}
        for mode in ("same_stream", "independent"):
            usages = [case["main_usage"] for case in report["cases"] if case["mode"] == mode]
            usages += [translation["usage"] for case in report["cases"] if case["mode"] == mode
                       for translation in case["translation"].values() if "usage" in translation]
            report["usage_totals"][mode] = {field: sum(usage.get(field, 0) for usage in usages)
                                           for field in ("prompt_tokens", "completion_tokens", "total_tokens")}
        print(json.dumps({"medians": report["medians"]}), flush=True)
    except Exception as error:
        # No response bodies, request headers, credentials or raw provider
        # diagnostics are printed or stored, even on a failed API request.
        report["failed"] = True
        report["error_type"] = type(error).__name__
        raise RuntimeError(f"Translation benchmark failed: {type(error).__name__}") from None
    finally:
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default=".runtime/benchmarks/translation/translation-benchmark.json")
    asyncio.run(run(parser.parse_args()))

```

