from pathlib import Path

from packages.protocol import validate_speech
from services.agent.avatars import AvatarCatalog


ROOT = Path(__file__).resolve().parents[1]


def test_every_catalog_expression_routes_in_its_outfit_and_pose():
    catalog = AvatarCatalog(ROOT, open_probability=1, min_open_gap=0, random_source=lambda: 0)
    originals = {key: value for key, value in catalog.mapping["assets"].items() if key.startswith("aya_")}
    assert len(originals) == 234
    assert len({item["source_expression"] for item in originals.values()}) == 26
    for key, item in originals.items():
        speech = validate_speech({"speech_ja": "ここにいるよ。", "expression": item["source_expression"], "pose": item["pose"]})
        assert catalog.route(speech, item["costume"]) == key


def test_model_cannot_change_outfit_or_route_arbitrary_paths():
    catalog = AvatarCatalog(ROOT)
    other = next(key for key, item in catalog.mapping["assets"].items() if item.get("costume") != "校服")
    for requested in (other, "../../secret", "unknown-expression"):
        speech = validate_speech({"speech_ja": "大丈夫だよ。", "expression": requested, "affect": "pleased", "intent": "encourage"})
        item = catalog.mapping["assets"][catalog.route(speech)]
        assert item["costume"] == "校服"
    assert catalog.mapping["assets"][catalog.route(speech)]["source_expression"] == "卖萌"


def test_pose_and_affect_route_even_at_low_intensity():
    catalog = AvatarCatalog(ROOT, open_probability=1, min_open_gap=0, random_source=lambda: 0)
    speech = validate_speech({"speech_ja": "大丈夫かな。", "affect": "concerned", "pose": "open", "intensity": .1})
    item = catalog.mapping["assets"][catalog.route(speech)]
    assert (item["source_expression"], item["pose"]) == ("担忧", "open")


def test_unspecified_pose_stays_crossed_even_for_explanations():
    catalog = AvatarCatalog(ROOT, random_source=lambda: 0)
    for _ in range(20):
        speech = validate_speech({"speech_ja": "一緒に見よう。", "intent": "explain"})
        assert catalog.mapping["assets"][catalog.route(speech)]["pose"] == "crossed"


def test_open_requests_are_gated_and_cannot_bypass_cooldown_using_ids():
    catalog = AvatarCatalog(ROOT, random_source=lambda: 0)
    speech = validate_speech({"speech_ja": "一緒に見よう。", "expression": "aya_z1a0010__a0001", "pose": "open"})
    poses = [catalog.mapping["assets"][catalog.route(speech)]["pose"] for _ in range(6)]
    assert poses == ["open", "crossed", "crossed", "crossed", "crossed", "open"]
    catalog = AvatarCatalog(ROOT, random_source=lambda: .5)
    assert catalog.mapping["assets"][catalog.route(speech)]["pose"] == "crossed"
