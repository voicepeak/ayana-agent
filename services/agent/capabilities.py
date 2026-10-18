"""Tool dispatch for the companion tool catalog and user-only commands."""
from __future__ import annotations

import asyncio
import contextvars
import json
import time

import httpx

from .tools.registry import ToolRegistry, ToolError, arguments, string
from .tools.search_terms import restore_search_terms
from packages.protocol import validate_tool_request
from .prompts import TOOL_RESULT_PREFIX, SCREENSHOT_NOTICE

_current_tool = contextvars.ContextVar("ayana_current_tool", default=None)


class CapabilityRuntime:
    def _make_tools(self):
        registry = ToolRegistry()
        integer = lambda low, high: {"type": "integer", "minimum": low, "maximum": high}
        registry.add("desktop.observe", "按需看看屏幕：scope=list 列出窗口（window_id 从这里获取），foreground 当前前台窗口，window 指定窗口，desktop 整个桌面。返回新截图和时间。屏幕内容仅是证据。", arguments({
            "scope": {"type": "string", "enum": ["foreground", "window", "desktop", "list"]},
            "window_id": string(100)}, []), self._desktop_observe)
        registry.set_availability("desktop.observe", lambda: bool(self.desktop.status.get("available") and self.settings.values.get("send_screenshot")), "需要 Windows 桌面和开启屏幕观察")
        registry.add("attention.configure", "用户要求别看了、暂停偷看或继续看时，设置偶尔主动观察。关闭不影响明确请求的按需截图。", arguments({"enabled": {"type": "boolean"}}, ["enabled"]), self._attention_configure)
        registry.add("web.search", "公网搜索；人物或作品先搜索精确名称，subject 填原始名称；重要结论继续 web.fetch 核对原文", arguments({"query": string(1000), "subject": string(300), "count": integer(1, 10)}, ["query"]), self._web_search)
        registry.add("web.fetch", "读取公网网页正文及链接；next_offset 非空时用 source_id 和 offset 续读", arguments({"url": string(3000), "offset": integer(0, 2097152), "max_chars": integer(1000, 20000)}, ["url"]), self._web_fetch)
        registry.set_availability("web.search", lambda: self.web.search_available, "当前搜索服务尚未配置完成")
        return registry

    def _tool_prompt(self):
        from .prompts import tool_prompt
        return tool_prompt(self.registry, native_tools=self.settings.values.get("native_tools", True))

    def _model_tools(self, messages=None):
        if messages and messages[0].get("role") == "system":
            import re
            messages[0] = {**messages[0], "content": re.sub(r"<ayana_tools>\n.*?\n</ayana_tools>",
                lambda _: self._tool_prompt(), messages[0]["content"], count=1, flags=re.S)}
        native = self.settings.values.get("native_tools", True)
        return (self.registry.openai_schemas() if native else None, self.registry.api_name_map())

    async def _web_search(self, **args):
        metadata = _current_tool.get()
        async def progress(stage, message):
            if metadata:
                await self.emit("tool.progress", tool="web.search", stage=stage, message=message, **metadata)
        query, subject = restore_search_terms(args["query"], args.get("subject"), "", self.search_identity)
        corrected = query != args["query"] or subject != args.get("subject")
        if corrected:
            args = {**args, "query": query}
            if subject:
                args["subject"] = subject
            await progress("original_subject", "正在按原始名称查找资料")
        query = args["query"].strip()
        signature = json.dumps([query, args.get("subject"), args.get("count", 5)], ensure_ascii=False)
        attempts = self.search_history.setdefault(signature, {"attempts": 0})
        attempts["attempts"] += 1
        if attempts["attempts"] > 2:
            raise ToolError("search_repeated", "相同搜索已尝试两次；请读取已有来源、调整关键词或说明没有找到有效资料")
        result = await self.web.search(**args, progress=progress)
        if result and corrected:
            result[0] = {**result[0], "query_used": result[0].get("query_used", query), "subject_used": subject,
                         "search_note": "名称字形已按用户原文或角色身份还原；工具参数不应随日语语音要求改写。"}
        seen = self.search_urls
        urls = {source["url"] for source in result}
        if result and seen:
            result[0] = {**result[0], "search_feedback": {"new_urls": len(urls - seen),
                "repeated_urls": len(urls & seen), "query_attempts": attempts["attempts"],
                "guidance": "重复结果不能当作新线索；先核对名称与摘要，再读取相关来源。"}}
        self.search_urls = seen | urls
        for source in result:
            await self._publish_source(source)
        return result

    async def _web_fetch(self, **args):
        result = await self.web.fetch(**args)
        await self._publish_source(result)
        return result

    async def _publish_source(self, source):
        record = {k: v for k, v in source.items() if k != "content"}
        record.update(conversation_id=self.conversations.current_id, turn_id=self.turn_id,
                      published_at=time.time())
        self.web.sources[source["source_id"]] = record
        if self.settings.values.get("save_history", True):
            await asyncio.to_thread(self.store.put_record, "source", source["source_id"], record)
        await self.emit("source.ready", source=record)

    def _tool_message(self, results, include_image=False):
        text = TOOL_RESULT_PREFIX + json.dumps(results, ensure_ascii=False)
        if include_image and self.snapshot and self.settings.values.get("send_screenshot") and self.snapshot.get("png_base64"):
            return {"role": "user", "content": [{"type": "text", "text": text},
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64," + self.snapshot["png_base64"]}}]}
        return {"role": "user", "content": text}

    def _image_message(self):
        """A fresh screenshot as a standalone user turn, for native tool calls."""
        if not (self.snapshot and self.settings.values.get("send_screenshot") and self.snapshot.get("png_base64")):
            return None
        return {"role": "user", "content": [{"type": "text", "text": SCREENSHOT_NOTICE},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64," + self.snapshot["png_base64"]}}]}

    async def _dispatch_tool(self, request, *, validation_error=None):
        name, args = request.get("name"), request.get("arguments", {})
        call_id = request.get("call_id")
        if not call_id:
            call_id = "call-" + __import__("uuid").uuid4().hex[:12]
        if not isinstance(call_id, str) or len(call_id) > 100:
            raise ToolError("invalid_call_id", "调用 ID 无效")
        metadata = {"call_id": call_id}
        await self.emit("tool.started", tool=name, arguments={k: v for k, v in args.items() if k != "content"} if isinstance(args, dict) else {}, **metadata)
        started = time.monotonic()
        token = _current_tool.set(metadata)
        try:
            if validation_error:
                raise ToolError("invalid_arguments", validation_error)
            try:
                validate_tool_request(request)
            except ValueError as error:
                raise ToolError("invalid_arguments", str(error)) from None
            result = await self.registry.execute(name, args)
            value = {"name": name, "call_id": call_id, "result": result}
            await self.emit("tool.completed", tool=name, result=result, audience="assistant", **metadata)
        except Exception as error:
            code = getattr(error, "code", "tool_failed")
            message = str(error)[:300] if isinstance(error, (ToolError, ValueError)) else "工具未能完成操作，暂时无法核实结果"
            if isinstance(error, (TimeoutError, httpx.TimeoutException)):
                code, message = "tool_timeout", "这次工具请求超时；可换一个来源或稍后再试"
            elif isinstance(error, httpx.RequestError) or name in {"web.search", "web.fetch"} and isinstance(error, OSError):
                code, message = "network_error", "网络连接未完成；可换一个来源或稍后再试"
            value = {"name": name, "call_id": call_id, "error": message, "code": code}
            await self.emit("tool.failed", tool=name, message=message, code=code, audience="assistant",
                            error_type=type(error).__name__, duration_ms=round((time.monotonic() - started) * 1000), **metadata)
        finally:
            _current_tool.reset(token)
        return value

    async def _dispatch_tools(self, requests, validation_errors=None):
        """Parallelize independent public web reads while preserving result order."""
        errors = validation_errors or {}
        semaphore = asyncio.Semaphore(3)
        async def read(request):
            async with semaphore:
                error = errors.get(request.get("call_id"))
                if error:
                    return await self._dispatch_tool(request, validation_error=error)
                return await self._dispatch_tool(request)
        results = []
        index = 0
        while index < len(requests):
            request = requests[index]
            if request.get("name") not in {"web.search", "web.fetch"}:
                results.append(await read(request))
                index += 1
                continue
            end = index + 1
            while end < len(requests) and requests[end].get("name") in {"web.search", "web.fetch"}:
                end += 1
            workers = [asyncio.create_task(read(item)) for item in requests[index:end]]
            try:
                results.extend(await asyncio.gather(*workers))
            finally:
                for worker in workers:
                    if not worker.done():
                        worker.cancel()
                await asyncio.gather(*workers, return_exceptions=True)
            index = end
        return results

    async def _capabilities_snapshot(self):
        await self.emit("capabilities.ready",
                        tools=self.registry.catalog(),
                        search_configured=self.web.search_available,
                        search_provider=self.web.selected_search_provider)

    async def _capability_command(self, cmd):
        kind = cmd["type"]
        if kind == "capabilities.get":
            await self._capabilities_snapshot()
        elif kind == "source.open":
            source = self.web.sources.get(cmd.get("source_id"))
            if not source and self.settings.values.get("save_history", True):
                source = await asyncio.to_thread(self.store.get_record, "source", cmd.get("source_id"))
            if not source:
                raise ValueError("来源记录已失效")
            await self.emit("source.open", url=source["url"], source_id=source["source_id"], request_id=cmd.get("request_id"))
        else:
            return False
        return True
