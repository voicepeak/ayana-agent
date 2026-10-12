"""Standalone, conservative Windows window capture.

Call blocking methods through asyncio.to_thread in the agent runtime. This
adapter only observes windows: it captures screenshots and never injects
keyboard or mouse input.
"""
from __future__ import annotations

import base64
import hashlib
import io
import math
import os
import queue
import threading
import time
import uuid


class DesktopError(RuntimeError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _identity_key(target):
    return target["hwnd"], target["process_id"], target["process_created"], target["class_name"]


def _same_geometry(first, second):
    return (first["bounds"] == second["bounds"] and first["dpi"] == second["dpi"]
            and first.get("client_bounds_image_px") == second.get("client_bounds_image_px"))


def _fit_capture(image, max_pixels=8_000_000, max_bytes=6 * 1024 * 1024):
    """Scale a capture into the observation budget instead of refusing it.

    The window may be larger than the budget on high-DPI displays. Shrinking the
    public snapshot keeps the model input bounded.
    """
    from PIL import Image
    scale = 1.0
    for _ in range(6):
        display = image if scale >= 1.0 else image.resize(
            (max(1, round(image.width * scale)), max(1, round(image.height * scale))), Image.LANCZOS)
        output = io.BytesIO()
        display.save(output, format="PNG")
        size = output.tell()
        if display.width * display.height <= max_pixels and size <= max_bytes:
            return display, output.getvalue()
        pixel_ratio = math.sqrt(max_pixels / (display.width * display.height))
        byte_ratio = math.sqrt(max_bytes / size) if size else 1.0
        shrink = min(pixel_ratio, byte_ratio)
        if not math.isfinite(shrink) or shrink >= 1.0:
            shrink = 0.8
        scale *= max(0.05, shrink * 0.98)
    raise DesktopError("capture_size", "Target image is too large to observe; reduce the window size")


class WindowsDesktop:
    def __init__(self, *, capture_timeout=3.0):
        self.available = os.name == "nt"
        self.capture_timeout = capture_timeout
        self._targets = {}
        self._assistant_windows = set()
        self._lock = threading.RLock()
        self._capture_slot = threading.Lock()
        self._closed = False
        self._api = None
        self._detail = "Windows desktop APIs are unavailable on this platform"
        if self.available:
            try:
                from .win32 import Win32
                self._api = Win32()
                self._detail = "Public Win32 window capture is available"
            except Exception as exc:
                self.available, self._detail = False, str(exc)

    @property
    def status(self):
        return {"available": self.available and not self._closed,
                "platform": "windows" if os.name == "nt" else os.name,
                "capture": "PrintWindow",
                "detail": self._detail}

    def _require(self):
        if not self.available or self._closed:
            raise DesktopError("unavailable", self._detail if not self._closed else "Desktop adapter is closed")

    def register_assistant_window(self, hwnd):
        self._require()
        hwnd = int(hwnd)
        # Register only windows that actually exist; never accept a broad PID
        # exemption that would hide unrelated applications.
        if hwnd and self._api.user.IsWindow(hwnd):
            self._assistant_windows.add(self._api.root(hwnd))

    def list_windows(self):
        self._require()
        return [target for target in self._api.enumerate() if target["hwnd"] not in self._assistant_windows]

    def foreground(self):
        self._require()
        hwnd = self._api.foreground()
        if not hwnd or hwnd in self._assistant_windows:
            return None
        try:
            return self.bind(hwnd)
        except (OSError, RuntimeError, PermissionError, DesktopError):
            return None

    def _inspect(self, hwnd):
        try:
            return self._api.identity(hwnd)
        except PermissionError as exc:
            raise DesktopError("inaccessible", str(exc)) from exc
        except (OSError, RuntimeError) as exc:
            raise DesktopError("window_closed", str(exc)) from exc

    @staticmethod
    def _supported(target):
        if target["window_state"] != "visible":
            raise DesktopError("window_unavailable", "Target must be visible and not minimized")
        if target["elevated"] is not False:
            raise DesktopError("elevated_target", "Administrator or inaccessible targets are not supported")

    def bind(self, hwnd: int):
        self._require()
        with self._lock:
            hwnd = int(hwnd)
            if hwnd in self._assistant_windows:
                raise DesktopError("assistant_target", "Ayana cannot bind its own interface as the target")
            target = self._inspect(hwnd)
            self._supported(target)
            for target_id, prior in self._targets.items():
                if _identity_key(prior) == _identity_key(target):
                    target["target_id"] = target_id
                    self._targets[target_id] = target
                    return dict(target)
            target_id = f"win-{uuid.uuid4().hex[:12]}"
            target["target_id"] = target_id
            self._targets[target_id] = target
            return dict(target)

    def _target(self, target_id):
        if target_id not in self._targets:
            raise DesktopError("unknown_target", "Select a target window first")
        prior = self._targets[target_id]
        target = self._inspect(prior["hwnd"])
        if _identity_key(prior) != _identity_key(target):
            raise DesktopError("identity_changed", "Window or process identity changed; bind a new target")
        self._supported(target)
        target["target_id"] = target_id
        return target

    def _image(self, target):
        if not self._capture_slot.acquire(blocking=False):
            raise DesktopError("capture_busy", "Previous capture is still waiting on the target application")
        reply = queue.Queue(maxsize=1)
        def worker():
            try:
                reply.put((True, self._api.image(target)))
            except Exception as exc:
                reply.put((False, exc))
            finally:
                self._capture_slot.release()
        threading.Thread(target=worker, name="ayana-window-capture", daemon=True).start()
        try:
            good, result = reply.get(timeout=self.capture_timeout)
        except queue.Empty:
            raise DesktopError("capture_timeout", "Target application did not respond to capture in time")
        if not good:
            raise DesktopError("capture_failed", str(result))
        after = self._inspect(target["hwnd"])
        if _identity_key(after) != _identity_key(target) or not _same_geometry(after, target):
            raise DesktopError("target_changed", "Target moved or changed during capture; observe again")
        return result

    def capture(self, target_id: str):
        self._require()
        with self._lock:
            target = self._target(target_id)
            captured = time.monotonic()
            image = self._image(target)
            display, png = _fit_capture(image)
            self._targets[target_id] = target
            return {"snapshot_id": f"snap-{uuid.uuid4().hex[:12]}", "target_id": target_id,
                    "captured_at_monotonic_ms": captured * 1000,
                    "image_size_px": {"width": display.width, "height": display.height},
                    "png_base64": base64.b64encode(png).decode("ascii"),
                    "content_sha256": hashlib.sha256(image.tobytes()).hexdigest(),
                    "target": target, "window_state": target["window_state"]}

    def capture_desktop(self):
        """Read the virtual desktop as a wide overview."""
        self._require()
        from PIL import ImageGrab
        self._api.dpi_context()
        captured = time.monotonic()
        picture = ImageGrab.grab(all_screens=True)
        display, png = _fit_capture(picture)
        origin_x = self._api.user.GetSystemMetrics(76)  # SM_XVIRTUALSCREEN
        origin_y = self._api.user.GetSystemMetrics(77)
        return {"snapshot_id": f"desk-{uuid.uuid4().hex[:12]}", "target": None,
                "scope": "desktop", "actionable": False,
                "captured_at_monotonic_ms": captured * 1000,
                "observed_at": time.time(),
                "image_size_px": {"width": display.width, "height": display.height},
                "png_base64": base64.b64encode(png).decode("ascii"),
                "content_sha256": hashlib.sha256(picture.tobytes()).hexdigest(),
                "origin": {"x": origin_x, "y": origin_y}}

    def close(self):
        self._closed = True
