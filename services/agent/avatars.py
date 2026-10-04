"""Route model expression choices to the installed character catalog."""
from __future__ import annotations

import json
import random
from pathlib import Path


class AvatarCatalog:
    def __init__(self, root: Path, *, open_probability: float = .12, min_open_gap: int = 4, random_source=None):
        file = root / "characters/ayana/avatar-map.json"
        if not file.is_file():
            file = Path(__file__).resolve().parents[2] / "characters/ayana/avatar-map.json"
        self.mapping = json.loads(file.read_text(encoding="utf-8"))
        self.guide = json.loads((file.parent / "expression-guide.json").read_text(encoding="utf-8"))
        self.open_probability = open_probability
        self.min_open_gap = min_open_gap
        self.random = random_source or random.random
        self.since_open = min_open_gap

    def route(self, speech: dict, costume: str = "校服") -> str:
        return self.resolve(speech, costume)["asset_id"]

    def resolve(self, speech: dict, costume: str = "校服") -> dict:
        """Keep the model choice and actual rendered expression independently observable."""
        assets = self.mapping["assets"]
        requested = speech.get("expression", "")
        pose = speech.get("pose", "")
        # A model may choose a catalog ID, but cannot change the user's outfit.
        exact = assets.get(requested, {})
        if exact and exact.get("costume", "校服") == costume:
            pose = exact.get("pose", pose)
        label = exact.get("source_expression", requested)
        candidates = [(key, item) for key, item in assets.items() if item.get("costume", "校服") == costume and key.startswith("aya_")]
        if not candidates:
            asset = self.mapping["intent_defaults"].get(speech["intent"], "neutral")
            return {"asset_id": asset, "resolved_expression": assets[asset]["source_expression"],
                    "resolved_pose": assets[asset]["pose"], "expression_source": "fallback_costume"}
        labels = {item["source_expression"] for _, item in candidates}
        source = "model_asset" if exact else "model_label"
        if label not in labels:
            source = "fallback_missing" if not requested else "fallback_invalid"
            affect = speech.get("affect")
            # Surprise alone does not justify fear. Explicit expression choices
            # can still select either fear variant when the context warrants it.
            label = {"pleased": "卖萌", "concerned": "担忧"}.get(affect)
            if not label:
                label = {"explain": "正经", "encourage": "卖萌", "caution": "担忧", "playful": "得意"}.get(speech["intent"], "休闲")
        if pose != "open" or self.since_open < self.min_open_gap or self.random() >= self.open_probability:
            pose = "crossed"
        matching = [(key, item) for key, item in candidates if item["source_expression"] == label]
        asset = next((key for key, item in matching if item["pose"] == pose), matching[0][0] if matching else candidates[0][0])
        self.since_open = 0 if assets[asset]["pose"] == "open" else self.since_open + 1
        return {"asset_id": asset, "resolved_expression": assets[asset]["source_expression"],
                "resolved_pose": assets[asset]["pose"], "expression_source": source}

    def prompt(self, costume: str = "校服") -> str:
        choices = {item["source_expression"] for item in self.mapping["assets"].values() if item.get("costume", "校服") == costume}
        descriptions = "\n".join(f"- {label}: {self.guide[label]}" for label in self.guide if label in choices)
        return ("每个 speech 事件必须填写 expression 和 pose。expression 必须是以下目录中的一个完整中文名称，"
                "不要输出类别名、英文意图名、图片 ID 或自行编造名称。\n"
                "表情体现 Ayana 说这一句时的情绪、态度和潜台词，不是机械复制用户的情绪，也不是仅按话题关键词匹配。"
                "结合用户最新消息、当前句子的具体内容、回复前一句和 avatar_context 中实际展示过的表情选择。"
                "情绪连贯时可以保持同一表情；从担心转向安慰、自信转向害羞等真实变化时随句切换。"
                "没有频率配额，不随机换脸，不为用齐目录强行制造情绪。普通聊天也可以自然地得意、抱怨、害羞或掩饰。"
                "脸红变体需要明确的害羞、心动或羞窘依据；强烈表情需要相应情绪依据。"
                "affect 的少量类别只是辅助字段，不限制这份完整表情目录。intensity 表示情绪强弱，不代替 expression。"
                "无需解释选择过程。\n全部可用表情及区别：\n" + descriptions
                + '\npose 默认 crossed（双手交叠）；只有明确邀请或强调说明时偶尔选 open（双手摊开），避免连续摊手。服装由用户决定。'
                '\n以下是独立场景中的输出格式示例，实际回复按当前语境选择，不照搬台词：\n'
                '{"type":"speech","key":"s1","speech_ja":"うん、ここにいるよ。","intent":"acknowledge","affect":"neutral","intensity":0.15,"expression":"休闲","pose":"crossed"}\n'
                '{"type":"speech","key":"s1","speech_ja":"まず、原因を一緒に確かめよう。","intent":"explain","affect":"neutral","intensity":0.3,"expression":"正经","pose":"crossed"}\n'
                '{"type":"speech","key":"s1","speech_ja":"そんなに無理してない？","intent":"caution","affect":"concerned","intensity":0.4,"expression":"担忧","pose":"crossed"}\n'
                '{"type":"speech","key":"s1","speech_ja":"もう、また夜更かししたの？","intent":"playful","affect":"concerned","intensity":0.3,"expression":"嘟哝","pose":"crossed"}\n'
                '{"type":"speech","key":"s1","speech_ja":"ふふ、うまくできたでしょ？","intent":"playful","affect":"pleased","intensity":0.4,"expression":"得意","pose":"crossed"}\n'
                '{"type":"speech","key":"s1","speech_ja":"そんなに褒められると、照れちゃうよ。","intent":"acknowledge","affect":"pleased","intensity":0.4,"expression":"脸红卖萌","pose":"crossed"}\n'
                '{"type":"speech","key":"s1","speech_ja":"べ、別に寂しかったわけじゃないよ。","intent":"playful","affect":"neutral","intensity":0.35,"expression":"掩饰","pose":"crossed"}\n'
                '{"type":"speech","key":"s1","speech_ja":"その案には賛成できないよ。","intent":"caution","affect":"neutral","intensity":0.4,"expression":"不同意","pose":"crossed"}\n'
                '每句 speech 后仍按协议发出对应的 translation 事件。')

    def recent_context(self, speeches: list[dict], costume: str = "校服") -> list[dict]:
        """Only faces that were actually presented can anchor the next reply."""
        result, seen = [], set()
        for speech in reversed(speeches):
            uid = speech.get("utterance_id")
            if uid in seen:
                continue
            seen.add(uid)
            if not speech.get("displayed"):
                continue
            if speech.get("status") == "partial" and not speech.get("played_samples", 0):
                continue
            item = self.mapping["assets"].get(speech.get("asset_id"), {})
            if item.get("costume") != costume:
                continue
            result.append({"expression": item["source_expression"], "pose": item["pose"]})
            if len(result) == 3:
                break
        return list(reversed(result))
