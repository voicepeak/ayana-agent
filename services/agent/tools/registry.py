"""One validated definition for model-visible tools and their executors."""
from __future__ import annotations

import inspect
import json
from dataclasses import dataclass


class ToolError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


@dataclass
class Tool:
    name: str
    description: str
    parameters: dict
    handler: object
    effect: str = "read"


def validate(value, schema, path="arguments"):
    kind = schema.get("type")
    matches = {"object": isinstance(value, dict), "string": isinstance(value, str),
               "integer": type(value) is int, "boolean": type(value) is bool,
               "number": type(value) in {int, float}}
    if kind and not matches.get(kind, False):
        raise ToolError("invalid_arguments", f"{path}: expected {kind}")
    if "enum" in schema and value not in schema["enum"]:
        raise ToolError("invalid_arguments", f"{path}: unsupported value")
    if kind == "object":
        props = schema.get("properties", {})
        if set(value) - set(props) or set(schema.get("required", [])) - set(value):
            raise ToolError("invalid_arguments", f"{path}: unknown or missing fields")
        for key, item in value.items():
            validate(item, props[key], f"{path}.{key}")
    if kind == "string" and not schema.get("minLength", 0) <= len(value) <= schema.get("maxLength", 65536):
        raise ToolError("invalid_arguments", f"{path}: text length out of bounds")
    if kind in {"integer", "number"} and not schema.get("minimum", -1e100) <= value <= schema.get("maximum", 1e100):
        raise ToolError("invalid_arguments", f"{path}: value out of bounds")


def arguments(properties=None, required=()):
    return {"type": "object", "properties": properties or {}, "required": list(required), "additionalProperties": False}


def string(maximum=1000):
    return {"type": "string", "minLength": 1, "maxLength": maximum}


class ToolRegistry:
    def __init__(self, full_access=None):
        self.tools = {}
        self.availability = {}
        self.visibility = {}
        self.reasons = {}
        self.full_access = full_access or (lambda: False)

    def add(self, name, description, schema, handler, effect="read"):
        self.tools[name] = Tool(name, description, schema, handler, effect)

    def set_availability(self, name, predicate, reason="该工具当前缺少所需配置"):
        """Hide a registered tool from the model while its predicate is false."""
        self.availability[name] = predicate
        self.reasons[(name, "availability")] = reason

    def set_visibility(self, name, predicate, reason="当前任务上下文不适用"):
        """Filter model choices; executor authorization remains in the handler."""
        self.visibility[name] = predicate
        self.reasons[(name, "visibility")] = reason

    def description(self, tool):
        text = tool.description
        if self.full_access():
            text = text.replace("执行模式：", "Full access：").replace("授权目录", "本机目录").replace("授权范围", "可访问范围")
        return text

    def state(self, tool):
        for kind, predicates in (("availability", self.availability), ("visibility", self.visibility)):
            predicate = predicates.get(tool.name)
            try:
                enabled = predicate is None or bool(predicate())
            except Exception:
                enabled = False
            if not enabled:
                reason = self.reasons.get((tool.name, kind), "工具暂时不可用")
                try:
                    reason = reason() if callable(reason) else reason
                except Exception:
                    reason = "工具状态暂时无法确定"
                return {"name": tool.name, "available": False, "reason": reason}
        return {"name": tool.name, "available": True, "reason": None}

    def catalog(self):
        return [self.state(tool) for tool in self.tools.values()]

    def available(self, tool):
        predicate = self.availability.get(tool.name)
        if predicate is None:
            return True
        try:
            return bool(predicate())
        except Exception:
            return False

    def active_tools(self):
        return [tool for tool in self.tools.values() if self.state(tool)["available"]]

    async def execute(self, name, args):
        tool = self.tools.get(name)
        if not tool:
            raise ToolError("unknown_tool", "工具未注册")
        if not self.available(tool):
            raise ToolError("tool_unavailable", self.state(tool)["reason"])
        validate(args, tool.parameters)
        result = tool.handler(**args)
        return await result if inspect.isawaitable(result) else result

    def prompt(self):
        return "Registered tools (exact arguments; stop after requesting tools to receive results):\n" + json.dumps([
            {"name": t.name, "description": self.description(t), "arguments": t.parameters, "effect": t.effect}
            for t in self.active_tools()], ensure_ascii=False, sort_keys=True)

    @staticmethod
    def api_name(name):
        # OpenAI-compatible function names cannot contain dots.
        return name.replace(".", "__")

    def openai_schemas(self):
        """Native function-calling schema for providers that accept a tools array."""
        return [{"type": "function", "function": {
            "name": self.api_name(t.name), "description": self.description(t), "parameters": t.parameters,
        }} for t in self.active_tools()]

    def api_name_map(self):
        return {self.api_name(t.name): t.name for t in self.active_tools()}
