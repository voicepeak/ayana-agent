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
from services.agent.providers.model import OpenAIProvider
from services.agent.prompts import PromptAssembler, tool_prompt
from services.agent.tools.registry import ToolRegistry


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
    system = PromptAssembler(ROOT, catalog).build(
        full_access=cfg.values.get("full_access", False), costume=cfg.values.get("avatar_costume", "校服"),
        tools=tool_prompt(ToolRegistry(), native_tools=cfg.values.get("native_tools", True),
                          full_access=cfg.values.get("full_access", False))).system
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
