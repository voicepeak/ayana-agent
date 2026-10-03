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
