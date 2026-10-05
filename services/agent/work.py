"""Grounded, topic-local work state. Model reports never authorize operations."""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime
import json


def local_clock():
    now = datetime.now().astimezone()
    return {"local_iso": now.isoformat(timespec="seconds"), "timezone": str(now.tzinfo),
            "utc_offset": now.strftime("%z")}


def pointer(value, path):
    """Read an RFC 6901 pointer from a real tool result, without evaluating code."""
    if not isinstance(path, str) or not path.startswith("/") or len(path) > 500:
        raise ValueError("证据字段需要以 / 开头的 JSON pointer")
    for part in path[1:].split("/"):
        part = part.replace("~1", "/").replace("~0", "~")
        if isinstance(value, list):
            if not part.isdecimal():
                raise ValueError("无效的证据索引")
            value = value[int(part)]
        else:
            value = value[part]
    return value


def validate_report(event):
    if set(event) - {"type", "kind", "goal", "detail", "status", "reason", "checks", "continues_task_id"}:
        raise ValueError("任务报告包含未知字段")
    if event.get("status") not in {"running", "complete", "blocked", "needs_input"}:
        raise ValueError("无效的任务报告状态")
    if "kind" in event and event["kind"] not in {"chat", "answer", "action"}:
        raise ValueError("无效的任务类型")
    if "detail" in event and event["detail"] not in {"normal", "detailed"}:
        raise ValueError("无效的回答详略")
    if "continues_task_id" in event and (not isinstance(event["continues_task_id"], str)
                                        or not 1 <= len(event["continues_task_id"]) <= 100):
        raise ValueError("接续任务需要真实任务 ID")
    for key in ("goal", "reason"):
        if key in event and (not isinstance(event[key], str) or not 1 <= len(event[key].strip()) <= 4000):
            raise ValueError("任务目标与原因需要有效文本")
    if event["status"] in {"blocked", "needs_input"} and not event.get("reason", "").strip():
        raise ValueError("未完成任务需要说明具体原因")
    checks = event.get("checks", [])
    if not isinstance(checks, list) or len(checks) > 12:
        raise ValueError("完成条件需要最多 12 项")
    descriptions = set()
    for check in checks:
        if not isinstance(check, dict) or set(check) - {"description", "evidence"}:
            raise ValueError("无效的完成条件")
        description = check.get("description")
        if not isinstance(description, str) or not 1 <= len(description.strip()) <= 600 or description in descriptions:
            raise ValueError("完成条件需要不同的简短描述")
        descriptions.add(description)
        evidence = check.get("evidence", [])
        if not isinstance(evidence, list) or len(evidence) > 8:
            raise ValueError("每项条件需要最多 8 条证据")
        for fact in evidence:
            if not isinstance(fact, dict) or set(fact) != {"call_id", "pointer", "operator", "value"}:
                raise ValueError("证据需要 call_id、pointer、operator、value")
            if not isinstance(fact["call_id"], str) or not 1 <= len(fact["call_id"]) <= 100:
                raise ValueError("证据需要真实调用 ID")
            if not isinstance(fact["pointer"], str) or not fact["pointer"].startswith("/") or len(fact["pointer"]) > 500:
                raise ValueError("证据需要工具结果中的 JSON pointer")
            if fact["operator"] not in {"equals", "contains"}:
                raise ValueError("证据只支持 equals 或 contains")
            if len(json.dumps(fact["value"], ensure_ascii=False)) > 1000:
                raise ValueError("证据比较值过长")
    return deepcopy(event)


def usable_result(value):
    """A request receipt, failed command or unverified input cannot prove success."""
    if "error" in value:
        return False
    result = value.get("result")
    if isinstance(result, dict):
        if result.get("status") in {"open_requested", "input_sent", "needs_verification", "failed", "cancelled", "waiting_approval", "proposed"}:
            return False
        if "expected_result_verified" in result and result["expected_result_verified"] is not True:
            return False
        if result.get("timed_out") or ("exit_code" in result and result["exit_code"] != 0):
            return False
    return True


def check_evidence(check, results):
    if not check.get("evidence"):
        return False
    for fact in check["evidence"]:
        entry = results.get(fact["call_id"])
        if not entry or not usable_result(entry["value"]):
            return False
        try:
            actual = pointer(entry["value"].get("result"), fact["pointer"])
            expected = fact["value"]
            if fact["operator"] == "equals":
                matches = type(actual) is type(expected) and actual == expected
            else:
                matches = (isinstance(actual, str) and isinstance(expected, str) and bool(expected) and expected in actual
                           or isinstance(actual, list) and expected in actual)
            if not matches:
                return False
        except (KeyError, IndexError, TypeError, ValueError):
            return False
    return True


def remember_result(context, name, args, value):
    """Keep bounded references, not file contents, scripts, or screenshot blobs."""
    if "error" in value:
        context["last_error"] = {"tool": name, "code": value.get("code"), "message": value["error"]}
        return
    result = value.get("result")
    if isinstance(result, list):
        for item in result[-8:]:
            if isinstance(item, dict):
                remember_result(context, name, args, {**value, "result": item})
        return
    if not isinstance(result, dict):
        return
    for item in result.get("matches", [])[-8:] if isinstance(result.get("matches"), list) else []:
        if isinstance(item, dict):
            remember_result(context, name, args, {**value, "result": {"root_id": result.get("root_id", args.get("root_id")), **item}})
    keys = {"artifact_id", "root_id", "path", "absolute_path", "app_id", "name", "source_id", "url", "title", "target_id"}
    ref = {key: deepcopy(result[key]) for key in keys if key in result and isinstance(result[key], (str, int))}
    for key in ("root_id", "path", "app_id", "url"):
        if key not in ref and isinstance(args.get(key), str):
            ref[key] = args[key]
    if not any(ref.get(key) for key in ("path", "absolute_path", "app_id", "source_id", "target_id", "url")):
        return
    if "absolute_path" in ref and "path" not in ref:
        ref["path"] = ref["absolute_path"]
    ref.update(tool=name, call_id=value["call_id"], status=result.get("status", "observed"))
    if name == "files.create":
        ref["created_by"] = "assistant"
    objects = context.setdefault("objects", [])
    identity = lambda item: ("file", item.get("root_id"), item["path"]) if "path" in item else (
        "source", item["source_id"]) if "source_id" in item else ("app", item["app_id"]) if "app_id" in item else (
        "window", item["target_id"]) if "target_id" in item else ("url", item["url"])
    previous = next((item for item in objects if identity(item) == identity(ref)), {})
    objects[:] = [item for item in objects if identity(item) != identity(ref)]
    objects.append({**previous, **ref})
    context["objects"] = objects[-16:]
