"""Immutable model turns, independent of mutable playback and UI events."""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json
import httpx
from .prompts import SUMMARY_INSTRUCTION, is_transient, REPOSITORY_PREFIX, HISTORY_PREFIX

# A summary request gets its own input ceiling, independent of the main model
# request, so a huge retained turn cannot wedge compaction forever.
SUMMARY_INPUT_BUDGET = 40000


def text_messages(messages):
    """Do not retain screenshots in history or on disk."""
    result = deepcopy([message for message in messages if not is_transient(message)])
    for message in result:
        if isinstance(message.get("content"), list):
            message["content"] = [part for part in message["content"] if part.get("type") == "text"]
            # Personal memory is a current snapshot, never another historical
            # statement. Editing or forgetting it must affect the next request.
            if message.get('role') == 'user':
                for part in message['content']:
                    try:
                        payload = json.loads(part.get('text', ''))
                    except (ValueError, TypeError):
                        continue
                    if isinstance(payload, dict) and 'user_memory' in payload:
                        payload.pop('user_memory')
                        part['text'] = json.dumps(payload, ensure_ascii=False)
    return result


def repository_message(repository):
    if not repository:
        return []
    return [{"role": "user", "content": REPOSITORY_PREFIX + json.dumps(repository, ensure_ascii=False, sort_keys=True)}]


class PromptHistory:
    def __init__(self, store, max_chars=64000):
        self.store = store
        self.max_chars = max_chars
        self.scope = None
        self.turns = []
        self.summary = ""
        self.conversation_id = None
        self.persist = True
        self.temporary = {}

    def select(self, system, settings, repository_root=None, exclude_turn=None, conversation_id=None):
        # Logical topics remain stable across model changes. Keep the legacy
        # configuration partition only for callers without a conversation ID.
        scope = "conversation:" + conversation_id if conversation_id else hashlib.sha256(json.dumps(
            [system, settings.get("base_url"), settings.get("model"), repository_root], ensure_ascii=False).encode()).hexdigest()
        self.conversation_id = conversation_id
        previous_persist = self.persist
        self.persist = settings.get("save_history", True)
        if scope != self.scope or previous_persist != self.persist:
            if self.scope and not previous_persist:
                self.temporary[self.scope] = (self.turns, self.summary)
            self.scope = scope
            self.turns = self.store.model_turns(scope) if settings.get("save_history", True) else []
            self.summary = self.store.context_summary(scope) if self.persist else ""
            if not self.persist and scope in self.temporary:
                self.turns, self.summary = self.temporary[scope]
            # Upgrade old installations once. Freeze their former context at
            # this boundary; later receipts must never rebuild that prefix.
            if not conversation_id and settings.get("save_history", True) and not self.turns and not self.store.has_model_turns():
                legacy = self.store.context(exclude_turn=exclude_turn)
                if legacy:
                    self.turns = [{"turn_id": "legacy-import", "messages": legacy, "keys": {}}]

    def messages(self, reserve_chars=0):
        budget = max(0, self.max_chars - reserve_chars)
        size = sum(len(json.dumps(turn, ensure_ascii=False)) for turn in self.turns)
        if size > budget and not self.conversation_id:
            # Evict complete turns in batches, leaving room for several appends.
            while self.turns and size > budget // 2:
                size -= len(json.dumps(self.turns.pop(0), ensure_ascii=False))
        prefix = [{"role": "user", "content": HISTORY_PREFIX + self.summary}] if self.summary else []
        return text_messages([*prefix, *[message for turn in self.turns for message in turn["messages"]]])

    def compaction_count(self, reserve_chars=0):
        budget = self.max_chars - reserve_chars
        if budget <= 0:
            # The fixed material alone already exceeds the ceiling. Returning
            # zero here would send an oversized request, so fail loudly instead.
            raise ValueError("当前材料过大，请解除部分材料或开始新话题")
        sizes = [len(json.dumps(turn, ensure_ascii=False)) for turn in self.turns]
        size = sum(sizes) + len(self.summary)
        if size <= budget:
            return 0
        if budget < 5000:
            raise ValueError("当前材料过大，请解除部分材料或开始新话题")
        # Move a batch into the summary, retaining whole tool exchanges.
        target = max(0, budget * .55 - 4000)
        count = 0
        while count < len(sizes) and sum(sizes[count:]) > target:
            count += 1
        return count

    def compact(self, count, summary):
        remaining = self.turns[count:]
        if self.persist:
            self.store.compact_context(self.scope, remaining, summary)
        self.turns, self.summary = remaining, summary

    def append(self, turn_id, messages, keys, persist):
        turn = {"turn_id": turn_id, "messages": text_messages(messages), "keys": dict(keys)}
        self.turns.append(turn)
        self.messages()
        if persist:
            self.store.replace_model_turns(self.scope, self.turns)

    def last_reception(self, utterances=None):
        if not self.turns:
            return []
        turn = self.turns[-1]
        saved = {item["key"]: item for item in self.store.reception(turn["turn_id"], turn["keys"])}
        result = []
        for key, uid in turn["keys"].items():
            live = (utterances or {}).get(uid)
            if live:
                result.append({"key": key, "status": live.get("status", "generated"),
                               "displayed": live.get("displayed", False), "played_samples": live.get("played_samples", 0),
                               "total_samples": live.get("total_samples", 0)})
            elif key in saved:
                result.append(saved[key])
        return result


def _truncate_turn(turn, budget):
    """Bound one oversized turn so it can still be summarized at all."""
    messages = turn["messages"]
    per_message = max(400, budget // max(1, len(messages)))
    trimmed = []
    for message in messages:
        content = message.get("content")
        if isinstance(content, str) and len(content) > per_message:
            content = content[:per_message] + "…[truncated for summary]"
        trimmed.append({**message, "content": content})
    return {**turn, "messages": trimmed, "truncated": True}


def summary_batches(turns, budget=SUMMARY_INPUT_BUDGET):
    """Split retained turns into batches sized for the summary endpoint.

    An individual turn larger than the whole budget is truncated first; it is
    never handed to the endpoint whole, which is what let compaction wedge.
    """
    prepared = [{"turn_id": turn["turn_id"], "keys": turn.get("keys", {}),
                 "messages": text_messages(turn["messages"])} for turn in turns]
    batches, current, size = [], [], 2
    for turn in prepared:
        encoded = len(json.dumps(turn, ensure_ascii=False))
        if encoded > budget:
            turn, encoded = _truncate_turn(turn, budget), None
            encoded = len(json.dumps(turn, ensure_ascii=False))
        if current and size + encoded > budget:
            batches.append(current)
            current, size = [], 2
        current.append(turn)
        size += encoded
    if current:
        batches.append(current)
    return batches


async def summarize_history(settings, client, previous, turns, request_observer=None, usage_observer=None):
    """An occasional plain-text request, separate from speech and tool execution."""
    turns = [{**turn, "messages": text_messages(turn["messages"])} for turn in turns]
    content = json.dumps({"previous_summary": previous, "older_turns": turns}, ensure_ascii=False)
    cfg = settings.values
    body = {"model": cfg["model"], "stream": False, "max_tokens": 2200,
            "messages": [{"role": "system", "content": SUMMARY_INSTRUCTION},
                         {"role": "user", "content": content}]}
    from urllib.parse import urlparse
    url = cfg["base_url"].rstrip("/") + "/chat/completions"
    if urlparse(url).hostname == "api.deepseek.com":
        body["thinking"] = {"type": "disabled"}
    if request_observer:
        request_observer(body, phase="history_summary")
    response = await client.post(url, json=body, headers={"Authorization": "Bearer " + settings.key()},
                                 timeout=httpx.Timeout(45, connect=12))
    if response.status_code >= 400:
        raise RuntimeError("摘要服务暂时不可用，原始上下文已保留。请稍后重试。")
    value = response.json()
    if usage_observer and isinstance(value.get('usage'),dict):
        await usage_observer(value['usage'])
    choices = value.get("choices") or []
    summary = (choices[0].get("message") or {}).get("content") if choices else None
    if not isinstance(summary, str) or not summary.strip() or len(summary) > 4000:
        raise ValueError("摘要结果无效，原始上下文已保留。请稍后重试。")
    return summary.strip()
