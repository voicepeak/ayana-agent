import pytest
from packages.protocol import SpeechParser, validate_speech


def test_incremental_nested_json_and_escaped_braces():
    parser = SpeechParser()
    events = []
    source = '[{"type":"speech","speech_ja":"一緒に見よう。","nested":{"literal":"}\\\""}}, {"type":"translation","display_zh":"一起看"}]'
    for char in source:
        events += parser.feed(char)
    parser.finish()
    assert len(events) == 2
    assert events[0]["nested"]["literal"] == '}"'


def test_no_partial_sentence_from_truncated_stream():
    parser = SpeechParser()
    assert parser.feed('{"type":"speech","speech_ja":"途中') == []
    with pytest.raises(ValueError, match="truncated"):
        parser.finish()


@pytest.mark.parametrize("speech", ["hello.", "説明の途中", "このコード```を見よう。", "https://example.com を見よう。", "<think>考えよう。</think>"])
def test_unsafe_or_partial_speech_cannot_enter_tts(speech):
    with pytest.raises(ValueError):
        validate_speech({"speech_ja": speech})


def test_unknown_expression_falls_back_and_intensity_clamps():
    result = validate_speech({"speech_ja": "一緒に見よう。", "intent": "../../asset", "affect": "arbitrary", "intensity": 8})
    assert result["intent"] == "explain"
    assert result["affect"] == "neutral"
    assert result["intensity"] == 1
