"""Provider variability must not replay speech or hide actual transport failure."""
import json

import httpx
import pytest

from services.gateway.server import Gateway, ReplyEvents


JA = "ここにいるよ。"
ZH = "我在这里。"
SPEECH = {"type": "speech", "key": "s1", "speech_ja": JA}
CAPTION = {"type": "translation", "key": "s1", "display_zh": ZH}


def sse(chunks, *, done=True, reason="stop"):
    packets = [{"choices": [{"delta": {"content": text}}]} for text in chunks]
    if reason:
        packets.append({"choices": [{"delta": {}, "finish_reason": reason}]})
    return "".join("data: " + json.dumps(p) + "\n\n" for p in packets) + ("data: [DONE]\n\n" if done else "")


def repair_response(pairs):
    return httpx.Response(200, json={"choices": [{"finish_reason": "stop", "message": {
        "content": json.dumps({"sentences": pairs}, ensure_ascii=False)}}]})


async def run(chunks, repairs=(), **kwargs):
    calls = []
    def respond(request):
        body = json.loads(request.content)
        calls.append(body)
        if len(calls) == 1:
            assert body["stream"] is True
            return httpx.Response(200, text=sse(chunks, **kwargs))
        assert len(calls) == 2, "Only one formatting request is allowed"
        assert body["stream"] is False and "tools" not in body
        return repair_response(repairs)
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        gateway = Gateway(None, {"api_key": "secret", "model": "test", "base_url": "https://provider.test"}, client)
        outputs = [e async for e in gateway.model([{"role": "user", "content": "hello"}])]
    return outputs, calls


@pytest.mark.asyncio
@pytest.mark.parametrize("style", ["ndjson", "array", "fence", "prefix"])
async def test_complete_events_survive_every_character_boundary(style):
    content = "\n".join(json.dumps(e, ensure_ascii=False) for e in [SPEECH, CAPTION])
    if style == "array":
        content = json.dumps([SPEECH, CAPTION], ensure_ascii=False)
    elif style == "fence":
        content = "```json\n" + content + "\n```"
    elif style == "prefix":
        content = "Here are the events:\n" + content
    outputs, calls = await run(list(content))
    assert len(calls) == 1
    assert [e["type"] for e in outputs] == ["speech", "translation"]
    assert outputs[0]["speech_ja"] == JA and outputs[1] == CAPTION


def test_duplicate_group_keys_and_misnumbered_captions_keep_unique_pairs():
    events = ReplyEvents()
    first = events.feed({**SPEECH, "speech_ja": "うん。ここにいるよ。"}, "auto1")
    captions = events.feed({**CAPTION, "key": "wrong", "display_zh": "嗯。我在这里。"}, "unused")
    second = events.feed(SPEECH, "auto2")
    last = events.feed(CAPTION, "unused")
    assert len({e["key"] for e in first + second}) == 3
    assert [e["key"] for e in first + second] == [e["key"] for e in captions + last]
    assert not events.feed(CAPTION, "unused"), "A duplicate caption must not rewrite a committed subtitle"


def test_inline_and_keyless_captions_are_not_lost():
    events = ReplyEvents()
    inline = events.feed({**SPEECH, "display_zh": ZH}, "auto1")
    assert [e["type"] for e in inline] == ["speech", "translation"]
    second = events.feed({"type": "speech", "speech_ja": JA}, "auto2")
    caption = events.feed({"display_zh": ZH}, "auto3")
    assert caption[0]["key"] == second[0]["key"]


def test_duplicate_keys_with_deferred_captions_pair_in_speech_order():
    events = ReplyEvents()
    first = events.feed(SPEECH, "a")
    second = events.feed({**SPEECH, "speech_ja": "また話そうね。"}, "b")
    first_caption = events.feed(CAPTION, "unused")
    second_caption = events.feed({**CAPTION, "display_zh": "再聊吧。"}, "unused")
    assert first_caption == [{**CAPTION, "key": first[0]["key"]}]
    assert second_caption == [{**CAPTION, "key": second[0]["key"], "display_zh": "再聊吧。"}]


@pytest.mark.asyncio
@pytest.mark.parametrize("content", ["ここにいるよ。", '{"type":"speech","speech_ja":"ここに',
    json.dumps({"type": "speech", "speech_ja": "ここにいるよ"}),
    json.dumps({"type": "speech", "speech_ja": "きょうはとても楽しい気分なので、あなたといっしょにいろいろなお話をしながらゆっくりと過ごしたいと思っているよ。"})])
async def test_invalid_first_output_gets_one_format_repair_without_reasking_user(content):
    outputs, calls = await run(list(content), [{"speech_ja": JA, "display_zh": ZH}])
    assert [e["type"] for e in outputs] == ["model.repaired", "speech", "translation"]
    assert len(calls) == 2
    assert calls[1]["messages"][-1]["content"] == content
    assert outputs[-1]["key"] == outputs[-2]["key"]


@pytest.mark.asyncio
async def test_repair_collects_all_uncommitted_tail_without_replaying_prefix():
    long_event = {**SPEECH, "key": "s2", "speech_ja": "ここにいるよ"}
    trailing = {**SPEECH, "key": "s3", "speech_ja": "また話そうね。"}
    chunks = [json.dumps(SPEECH), json.dumps(CAPTION), json.dumps(long_event), json.dumps(trailing)]
    outputs, calls = await run(chunks, [{"speech_ja": JA, "display_zh": ZH},
                                      {"speech_ja": trailing["speech_ja"], "display_zh": "再聊吧。"}])
    assert json.dumps(trailing, ensure_ascii=False) in calls[1]["messages"][-1]["content"] or json.dumps(trailing) in calls[1]["messages"][-1]["content"]
    assert len([e for e in outputs if e["type"] == "speech"]) == 3
    assert outputs[0]["key"] == "s1"
    assert len({e["key"] for e in outputs if e["type"] == "speech"}) == 3


@pytest.mark.asyncio
async def test_missing_subtitle_repairs_only_exact_committed_japanese():
    outputs, calls = await run([json.dumps(SPEECH)], [{"speech_ja": JA, "display_zh": ZH}])
    assert [e["type"] for e in outputs] == ["speech", "model.repaired", "translation"]
    assert outputs[0]["key"] == outputs[-1]["key"]
    assert json.loads(calls[1]["messages"][-1]["content"])[0]["speech_ja"] == JA


@pytest.mark.asyncio
async def test_missing_prefix_caption_and_invalid_tail_share_one_repair():
    broken = {**SPEECH, "key": "s2", "speech_ja": "また話そうね"}
    outputs, calls = await run([json.dumps(SPEECH), json.dumps(broken)], [
        {"speech_ja": JA, "display_zh": ZH}, {"speech_ja": "また話そうね。", "display_zh": "再聊吧。"}])
    assert len(calls) == 2
    data = json.loads(calls[-1]["messages"][-1]["content"])
    assert data["committed"][0]["speech_ja"] == JA
    assert json.loads(data["uncommitted"])["key"] == "s2"
    assert [e["speech_ja"] for e in outputs if e["type"] == "speech"] == [JA, "また話そうね。"]
    assert len([e for e in outputs if e["type"] == "translation"]) == 2


def test_invalid_inline_caption_does_not_commit_hidden_speech():
    events = ReplyEvents()
    with pytest.raises(ValueError, match="invalid_translation"):
        events.feed({**SPEECH, "display_zh": []}, "auto")
    assert not events.speeches and not events.groups


@pytest.mark.asyncio
async def test_subtitle_repair_cannot_rewrite_committed_speech():
    with pytest.raises(ValueError, match="subtitle_repair_mismatch"):
        await run([json.dumps(SPEECH)], [{"speech_ja": "また話そうね。", "display_zh": ZH}])


@pytest.mark.asyncio
async def test_all_repair_pairs_validate_before_any_repaired_speech_commits():
    with pytest.raises(ValueError, match="invalid_model_repair"):
        await run(["plain response"], [{"speech_ja": JA, "display_zh": ZH},
                                        {"speech_ja": "https://example.test。", "display_zh": "网址。"}])


@pytest.mark.asyncio
async def test_han_only_name_does_not_discard_the_following_valid_reply():
    name = {"type": "speech", "key": "name", "speech_ja": "青葉。"}
    content = [json.dumps(name), json.dumps({"type": "translation", "key": "name", "display_zh": "青葉。"}),
               json.dumps(SPEECH), json.dumps(CAPTION)]
    outputs, calls = await run(content)
    assert len(calls) == 1
    assert [e["type"] for e in outputs] == ["speech", "translation", "speech", "translation"]
    assert [e["speech_ja"] for e in outputs if e["type"] == "speech"] == ["青葉。", JA]
    assert [e["display_zh"] for e in outputs if e["type"] == "translation"] == ["青葉。", ZH]


@pytest.mark.asyncio
async def test_name_and_following_sentence_group_stream_without_a_repair_request():
    content = [json.dumps({"type": "speech", "key": "name", "speech_ja": "青葉……。", "display_zh": "青葉……。"}),
               json.dumps({**SPEECH, "speech_ja": "ここにいるよ。どうしたの？"}),
               json.dumps({**CAPTION, "display_zh": "我在这里。怎么了？"})]
    outputs, calls = await run(content)
    assert len(calls) == 1
    assert [e["speech_ja"] for e in outputs if e["type"] == "speech"] == ["青葉……。", "ここにいるよ。", "どうしたの？"]
    assert [e["display_zh"] for e in outputs if e["type"] == "translation"] == ["青葉……。", "我在这里。", "怎么了？"]


@pytest.mark.asyncio
async def test_name_only_reply_retains_the_original_spelling():
    outputs, calls = await run([json.dumps({**SPEECH, "speech_ja": "青葉……。"}),
                                json.dumps({**CAPTION, "display_zh": "青葉……。"})])
    assert len(calls) == 1
    assert [e["speech_ja"] for e in outputs if e["type"] == "speech"] == ["青葉……。"]


@pytest.mark.asyncio
async def test_address_normalization_does_not_allow_incomplete_or_non_japanese_repair():
    for tail in ["まだ話の途中", "hello.", "https://example.test。"]:
        with pytest.raises(ValueError, match="invalid_model_repair"):
            await run(["plain response"], [{"speech_ja": "青葉。", "display_zh": "青葉。"},
                                            {"speech_ja": tail, "display_zh": ZH}])


@pytest.mark.asyncio
async def test_name_after_committed_sentence_does_not_replay_the_prefix():
    name = {"type": "speech", "key": "name", "speech_ja": "青葉。"}
    outputs, calls = await run([json.dumps(SPEECH), json.dumps(CAPTION), json.dumps(name),
                                json.dumps({**CAPTION, "key": "name", "display_zh": "青葉。"})])
    assert len(calls) == 1
    assert [e["speech_ja"] for e in outputs if e["type"] == "speech"] == [JA, "青葉。"]


@pytest.mark.asyncio
@pytest.mark.parametrize("kwargs,code", [({"done": False}, "model_disconnected"),
                                          ({"reason": "length"}, "model_incomplete")])
async def test_transport_or_token_limit_failure_is_not_reported_as_repaired_success(kwargs, code):
    with pytest.raises(ValueError, match=code):
        await run([json.dumps(SPEECH), json.dumps(CAPTION)], **kwargs)


@pytest.mark.asyncio
async def test_unknown_tools_are_rejected_without_repair_or_execution():
    with pytest.raises(ValueError, match="unsupported_model_event"):
        await run([json.dumps({"type": "tool", "name": "shell", "arguments": {}})])
