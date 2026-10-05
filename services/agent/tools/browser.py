"""Managed browser pages, bounded DOM observations and server-owned identities."""
import asyncio
import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
from urllib.parse import urlsplit
import uuid
from .browser_dom import CAPTURE
from .registry import ToolError


class BrowserTools:
    def __init__(self, full_access, profile, headless=False, channel=None):
        self.full_access = full_access
        self.profile = Path(profile)
        self.headless, self.channel = headless, channel
        self.driver = self.context = None
        self.pages, self.frames, self.snapshots = {}, {}, {}
        self.lock = asyncio.Lock()
        self.active_page = None
        self.notes, self.pending = [], set()

    @property
    def status(self):
        installed = importlib.util.find_spec("playwright") is not None
        return {"available": installed, "running": self.context is not None,
                "detail": "可使用受管理浏览器" if installed else "当前环境缺少浏览器交互组件"}

    def _access(self):
        if not self.full_access():
            raise ToolError("full_access_required", "浏览器交互需要开启 Full access")

    async def _start(self):
        self._access()
        if self.context:
            return
        if not self.status["available"]:
            raise ToolError("browser_dependency", self.status["detail"])
        from playwright.async_api import async_playwright
        self.driver = await async_playwright().start()
        channel = self.channel
        if channel is None and os.name == "nt":
            candidates = [("msedge", Path(os.environ.get("ProgramFiles(x86)", "C:/Program Files (x86)")) / "Microsoft/Edge/Application/msedge.exe"),
                          ("chrome", Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Google/Chrome/Application/chrome.exe")]
            channel = next((name for name, file in candidates if file.is_file()), None)
        self.profile.mkdir(parents=True, exist_ok=True)
        try:
            self.context = await self.driver.chromium.launch_persistent_context(
                str(self.profile), channel=channel, headless=self.headless, accept_downloads=False,
                timeout=15000, viewport={"width": 1280, "height": 900})
            self.context.set_default_timeout(5000)
            self.context.set_default_navigation_timeout(12000)
            for page in self.context.pages:
                self._register(page)
            self.context.on("page", self._register)
        except BaseException as error:
            await self.close()
            if isinstance(error, asyncio.CancelledError):
                raise
            raise ToolError("browser_unavailable", "浏览器未能启动，请检查 Edge、Chrome 或 Chromium 是否可用") from None

    def _register(self, page):
        existing = next((key for key, value in self.pages.items() if value is page), None)
        if existing:
            return existing
        if sum(not item.is_closed() for item in self.pages.values()) >= 4:
            self._schedule(self._reject_page(page))
            return None
        for key in list(self.pages):
            if self.pages[key].is_closed() and len(self.pages) >= 16:
                self.pages.pop(key)
        page_id = "page-" + uuid.uuid4().hex[:12]
        self.pages[page_id] = page
        page.on("dialog", lambda dialog: self._schedule(self._dismiss_dialog(page_id, dialog)))
        return page_id

    def _schedule(self, coroutine):
        task = asyncio.create_task(coroutine)
        self.pending.add(task)
        task.add_done_callback(self.pending.discard)

    async def _reject_page(self, page):
        with contextlib.suppress(Exception):
            await page.close()
        self.notes.append({"kind": "page_limit", "message": "额外页面因数量上限被关闭"})
        self.notes = self.notes[-8:]

    async def _dismiss_dialog(self, page_id, dialog):
        self.notes.append({"kind": "dialog_dismissed", "page_id": page_id, "dialog_type": dialog.type, "message": dialog.message[:500]})
        self.notes = self.notes[-8:]
        with contextlib.suppress(Exception):
            await dialog.dismiss()

    def _pick(self, page_id=None):
        page_id = page_id or self.active_page
        page = self.pages.get(page_id)
        if not page or page.is_closed():
            raise ToolError("unknown_page", "浏览器页面不存在或已关闭，请重新打开或观察页面")
        return page_id, page

    def _frame(self, page, frame_id=None):
        self.frames = {key: value for key, value in self.frames.items() if not value.is_detached()}
        for frame in page.frames:
            if frame not in self.frames.values():
                self.frames["frame-" + uuid.uuid4().hex[:12]] = frame
        frame = self.frames.get(frame_id) if frame_id else page.main_frame
        if frame not in page.frames:
            raise ToolError("unknown_frame", "页面框架已失效，请重新观察页面")
        return next(key for key, value in self.frames.items() if value is frame), frame

    async def _capture(self, frame, options):
        bundle = await asyncio.wait_for(frame.evaluate_handle(CAPTURE, options), 8)
        data = nodes = None
        handles = []
        try:
            data, nodes = await bundle.get_property("data"), await bundle.get_property("nodes")
            raw = await data.json_value()
            props = await nodes.get_properties()
            handles = [props[key].as_element() for key in sorted(props, key=int)]
            fingerprint = hashlib.sha256(json.dumps(raw, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
            return raw, handles, fingerprint
        except BaseException:
            await self._dispose(handles)
            raise
        finally:
            for handle in (data, nodes, bundle):
                if handle:
                    with contextlib.suppress(Exception):
                        await handle.dispose()

    @staticmethod
    async def _dispose(handles):
        for handle in handles:
            if handle:
                with contextlib.suppress(Exception):
                    await handle.dispose()

    async def _observe(self, page_id, frame_id=None, text_offset=0, max_chars=12000, element_offset=0):
        page_id, page = self._pick(page_id)
        frame_id, frame = self._frame(page, frame_id)
        options = {"text_offset": text_offset, "max_chars": max_chars, "element_offset": element_offset}
        raw, handles, fingerprint = await self._capture(frame, options)
        previous = self.snapshots.pop(page_id, None)
        if previous:
            await self._dispose(previous["handles"].values())
        snapshot_id = "browser-snapshot-" + uuid.uuid4().hex[:12]
        elements = {"element-" + uuid.uuid4().hex[:12]: handle for handle in handles}
        controls = [{**metadata, "element_id": key} for key, metadata in zip(elements, raw["controls"])]
        self.snapshots[page_id] = {"snapshot_id": snapshot_id, "frame": frame, "frame_id": frame_id,
                                   "handles": elements, "fingerprint": fingerprint, "options": options}
        self.active_page = page_id
        return {"status": "observed", "page_id": page_id, "snapshot_id": snapshot_id, "frame_id": frame_id,
                "url": raw["url"], "title": raw["title"], "text": raw["text"], "elements": controls,
                "text_offset": text_offset, "next_text_offset": text_offset + len(raw["text"]) if text_offset + len(raw["text"]) < raw["text_length"] else None,
                "next_element_offset": element_offset + len(controls) if element_offset + len(controls) < raw["element_count"] else None,
                "frames": [{"frame_id": key, "url": value.url} for key, value in self.frames.items() if value in page.frames][:20],
                "pages": [{"page_id": key, "url": value.url} for key, value in self.pages.items() if not value.is_closed()][:16],
                "browser_notes": list(self.notes)}

    async def open(self, url, page_id=None):
        self._access()
        try:
            parsed = urlsplit(url)
            if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
                raise ValueError()
            _ = parsed.port
        except ValueError:
            raise ToolError("invalid_url", "浏览器只支持有效的 HTTP/HTTPS 网址") from None
        async with self.lock:
            await self._start()
            if page_id:
                page_id, page = self._pick(page_id)
            else:
                page = next((item for item in self.pages.values() if not item.is_closed() and item.url in {url, "about:blank"}), None)
                if page is None:
                    if sum(not item.is_closed() for item in self.pages.values()) >= 4:
                        raise ToolError("browser_busy", "已有四个浏览器页面，请复用页面或先关闭不需要的页面")
                    page = await self.context.new_page()
                page_id = self._register(page)
            try:
                response = await page.goto(url, wait_until="domcontentloaded") if page.url != url else None
                result = await self._observe(page_id)
                if response:
                    result["http_status"] = response.status
                return result
            except asyncio.CancelledError:
                raise
            except Exception:
                raise ToolError("browser_navigation", "页面未能正常打开，请检查网址、网络或服务是否已启动") from None

    async def observe(self, page_id=None, frame_id=None, text_offset=0, max_chars=12000, element_offset=0):
        self._access()
        if any(type(value) is not int or value < 0 for value in (text_offset, element_offset)) or type(max_chars) is not int or not 1 <= max_chars <= 20000:
            raise ToolError("invalid_arguments", "页面读取位置无效，每次最多读取 20000 字符")
        async with self.lock:
            try:
                return await self._observe(page_id, frame_id, text_offset, max_chars, element_offset)
            except (ToolError, asyncio.CancelledError):
                raise
            except Exception:
                raise ToolError("browser_observation", "页面暂时无法观察，请重新打开或稍后重试") from None

    async def act(self, page_id, snapshot_id, kind, element_id=None, text=None, checked=None, key=None):
        self._access()
        if kind not in {"click", "fill", "select", "check", "press", "close"}:
            raise ToolError("invalid_arguments", "不支持的浏览器动作")
        if kind in {"fill", "select"} and (not isinstance(text, str) or len(text) > 4000):
            raise ToolError("invalid_arguments", "填写或选择需要有效 text")
        if kind == "check" and type(checked) is not bool:
            raise ToolError("invalid_arguments", "勾选需要 checked=true 或 false")
        if kind == "press" and key not in {"Enter", "Tab", "Escape", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Backspace"}:
            raise ToolError("invalid_arguments", "不支持的按键")
        if (text is not None and kind not in {"fill", "select"} or checked is not None and kind != "check"
                or key is not None and kind != "press" or element_id is not None and kind == "close"):
            raise ToolError("invalid_arguments", "动作包含不适用的参数")
        async with self.lock:
            page_id, page = self._pick(page_id)
            snapshot = self.snapshots.get(page_id)
            if not snapshot or snapshot["snapshot_id"] != snapshot_id or snapshot["frame"].is_detached():
                raise ToolError("stale_snapshot", "浏览器快照已失效，请先重新观察页面")
            if kind == "close":
                self.snapshots.pop(page_id)
                await self._dispose(snapshot["handles"].values())
                await page.close()
                return {"status": "closed", "page_id": page_id, "expected_result_verified": page.is_closed()}
            element = snapshot["handles"].get(element_id)
            if element is None:
                raise ToolError("unknown_element", "元素 ID 不属于当前快照，请重新观察，不要猜测")
            try:
                raw, temporary, current = await self._capture(snapshot["frame"], snapshot["options"])
                await self._dispose(temporary)
                if current != snapshot["fingerprint"] or not await element.evaluate("element => element.isConnected"):
                    raise ToolError("stale_snapshot", "页面或目标元素已改变，请先重新观察")
                if not await element.is_visible() or not await element.is_enabled():
                    raise ToolError("element_unavailable", "目标元素当前不可操作，请重新观察页面")
            except (ToolError, asyncio.CancelledError):
                raise
            except Exception:
                raise ToolError("stale_snapshot", "页面已改变或无法核对，请先重新观察") from None
            # Consume before sending input: an uncertain timeout must never let
            # the same snapshot silently submit the same action a second time.
            self.snapshots.pop(page_id)
            try:
                if kind == "click":
                    await element.click()
                elif kind == "fill":
                    await element.fill(text)
                elif kind == "select":
                    await element.select_option(value=text)
                elif kind == "check":
                    await element.set_checked(checked)
                else:
                    await element.press(key)
                observation = await self._observe(page_id, snapshot["frame_id"] if not snapshot["frame"].is_detached() else None)
                return {"status": "observed", "action": {"kind": kind, "element_id": element_id, "status": "input_sent"},
                        "observation": observation, "verification": "observation_only"}
            except asyncio.CancelledError:
                raise
            except Exception:
                raise ToolError("browser_action_unconfirmed", "页面操作未能核实，输入可能已经发送；请先观察实际页面，再决定后续步骤，避免重复提交") from None
            finally:
                await self._dispose(snapshot["handles"].values())

    async def close(self):
        context, driver = self.context, self.driver
        self.context = self.driver = None
        self.pages.clear()
        self.frames.clear()
        self.snapshots.clear()
        self.active_page = None
        if context:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(context.close(), 5)
        if driver:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(driver.stop(), 5)
        if self.pending:
            await asyncio.gather(*tuple(self.pending), return_exceptions=True)
        self.notes.clear()
