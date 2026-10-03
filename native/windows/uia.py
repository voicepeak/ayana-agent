"""UIA observations on a dedicated, windowless COM MTA thread.

Only primitive dictionaries leave the worker. COM pointers are never cached
or shared with asyncio threads. Stalled providers cannot hold up the runtime.
"""
from __future__ import annotations

import ctypes
from ctypes import wintypes
import importlib.util
import queue
import sys
import threading


class UiaObserver:
    def __init__(self, timeout=2.0):
        self.timeout = timeout
        self.status = "starting"
        self.detail = ""
        self.jobs = queue.Queue(maxsize=4)
        self.closed = False
        self.timeouts = 0
        self.thread = None
        self._start()

    def _start(self):
        self.thread = threading.Thread(target=self._run, args=(self.jobs,), name="ayana-uia-mta", daemon=True)
        self.thread.start()

    def _run(self, jobs):
        ole = ctypes.OleDLL("ole32")
        ole.CoInitializeEx.argtypes = [ctypes.c_void_p, wintypes.DWORD]
        ole.CoInitializeEx.restype = ctypes.c_long
        initialized = False
        try:
            if ole.CoInitializeEx(None, 0) < 0:
                raise RuntimeError("Cannot initialize UIA COM MTA")
            initialized = True
            if not importlib.util.find_spec("comtypes"):
                raise RuntimeError("Install comtypes to enable UI Automation")
            # comtypes initializes COM on the importing thread as well. Use
            # MTA for that import and restore the caller's module preference.
            previous = getattr(sys, "coinit_flags", None)
            sys.coinit_flags = 0
            try:
                import comtypes.client
                module = comtypes.client.GetModule("UIAutomationCore.dll")
            finally:
                if previous is None:
                    del sys.coinit_flags
                else:
                    sys.coinit_flags = previous
            automation = comtypes.client.CreateObject(module.CUIAutomation, interface=module.IUIAutomation)
            self.status = "ready"
        except Exception as exc:
            self.status, self.detail = "unavailable", str(exc)
            automation = None
        try:
            while True:
                job = jobs.get()
                if job is None:
                    break
                hwnd, bounds, reply = job
                if automation is None:
                    reply.put((False, self.detail))
                    continue
                try:
                    root = automation.ElementFromHandle(hwnd)
                    walker = automation.ControlViewWalker
                    found, pending = [], [(root, 0)]
                    while pending and len(found) < 120:
                        element, depth = pending.pop()
                        rect = element.CurrentBoundingRectangle
                        patterns = []
                        for property_id, name in [(30031, "invoke"), (30043, "value"), (30034, "scroll")]:
                            try:
                                if element.GetCurrentPropertyValue(property_id):
                                    patterns.append(name)
                            except Exception:
                                pass
                        found.append({"control_id": element.CurrentAutomationId or f"control-{len(found)}",
                                      "name": (element.CurrentName or "")[:1000],
                                      "control_type": int(element.CurrentControlType),
                                      "class_name": element.CurrentClassName,
                                      "enabled": bool(element.CurrentIsEnabled),
                                      "focused": bool(element.CurrentHasKeyboardFocus),
                                      "offscreen": bool(element.CurrentIsOffscreen), "patterns": patterns,
                                      "bounds_screen_px": {"left": rect.left, "top": rect.top, "right": rect.right, "bottom": rect.bottom},
                                      "bounds_image_px": {"left": rect.left-bounds["left"], "top": rect.top-bounds["top"],
                                                          "right": rect.right-bounds["left"], "bottom": rect.bottom-bounds["top"]}})
                        if depth < 8:
                            child = walker.GetFirstChildElement(element)
                            while child and len(pending) + len(found) < 120:
                                pending.append((child, depth+1))
                                child = walker.GetNextSiblingElement(child)
                    reply.put((True, found))
                except Exception as exc:
                    reply.put((False, str(exc)))
                # Let every observation acquire a fresh root/child tree.
                root = None
        finally:
            automation = None
            if initialized:
                ole.CoUninitialize()

    def observe(self, hwnd, bounds):
        if self.closed or self.timeouts >= 2:
            return []
        reply = queue.Queue(maxsize=1)
        try:
            self.jobs.put_nowait((hwnd, bounds, reply))
            good, result = reply.get(timeout=self.timeout)
            if good:
                return result
            self.detail = str(result)
            return []
        except (queue.Empty, queue.Full):
            self.timeouts += 1
            self.status, self.detail = "timeout", "UIA provider timed out; stale COM objects discarded"
            # A hung COM call cannot be killed safely in-process. Abandon this
            # daemon and permit exactly one replacement, avoiding thread leaks.
            try:
                self.jobs.put_nowait(None)
            except queue.Full:
                pass
            if self.timeouts < 2:
                self.jobs = queue.Queue(maxsize=4)
                self._start()
            return []

    def close(self):
        self.closed = True
        try:
            self.jobs.put_nowait(None)
        except queue.Full:
            pass
        if self.thread:
            self.thread.join(timeout=.5)
