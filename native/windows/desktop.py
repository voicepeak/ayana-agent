"""A standalone, conservative single-step Windows desktop executor.

Call blocking methods through asyncio.to_thread in the agent runtime. Every
action must reference a fresh snapshot; this adapter never runs an action on
its own and never elevates the process or restores a minimized window.
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
from dataclasses import dataclass


class DesktopError(RuntimeError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def image_point_to_screen(point, image_size, transform):
    """Map snapshot image pixels into physical screen pixels, including negatives."""
    if not isinstance(point, dict):
        raise DesktopError("invalid_action", "Action point is missing")
    try:
        x, y = float(point["x"]), float(point["y"])
    except (KeyError, TypeError, ValueError):
        raise DesktopError("invalid_action", "Action coordinates must be finite numbers")
    if not math.isfinite(x) or not math.isfinite(y) or not 0 <= x < image_size["width"] or not 0 <= y < image_size["height"]:
        raise DesktopError("out_of_bounds", "Action point is outside the referenced screenshot")
    return round(transform["origin_x"] + x * transform["scale_x"]), round(transform["origin_y"] + y * transform["scale_y"])


def _identity_key(target):
    return target["hwnd"], target["process_id"], target["process_created"], target["class_name"]


def _same_geometry(first, second):
    return first["bounds"] == second["bounds"] and first["dpi"] == second["dpi"]


def _same_content(first, second):
    """Ignore frame activation and only a narrow blinking insertion caret.

    Everything else, including very small button text changes, invalidates
    the old action. This intentionally requires re-observation for animation.
    """
    from PIL import ImageChops
    if first.size != second.size:
        return False
    width, height = first.size
    crop = (min(8, width//10), min(36, height//5), max(width-8, width//2), max(height-8, height//2))
    difference = ImageChops.difference(first.crop(crop), second.crop(crop))
    # Small compositor rounding differences should not trigger re-observation.
    mask = difference.convert("L").point(lambda value: 255 if value > 2 else 0)
    bounds = mask.getbbox()
    if bounds is None:
        return True
    left, top, right, bottom = bounds
    return right-left <= 2 and bottom-top <= 32  # insertion caret only


@dataclass
class _Snapshot:
    public: dict
    image: object
    input_epoch: int
    captured: float
    focused_hwnd: int | None


class WindowsDesktop:
    def __init__(self, *, max_snapshot_age=30.0, capture_timeout=3.0, uia_timeout=2.0):
        self.available = os.name == "nt"
        self.max_snapshot_age = max_snapshot_age
        self.capture_timeout = capture_timeout
        self._targets, self._snapshots = {}, {}
        self._assistant_windows = set()
        self._lock = threading.RLock()
        self._capture_slot = threading.Lock()
        self._closed = False
        self._cancel_epoch = 0
        self._active_cancel_epoch = None
        self._api, self._monitor, self._uia = None, None, None
        self._detail = "Windows desktop APIs are unavailable on this platform"
        if self.available:
            try:
                from .win32 import Win32, InputMonitor
                from .uia import UiaObserver
                self._api = Win32()
                self._monitor = InputMonitor(self._api, self._assistant_windows)
                self._uia = UiaObserver(timeout=uia_timeout)
                self._detail = "Public Win32 capture and explicit single-step input are available"
            except Exception as exc:
                self.available, self._detail = False, str(exc)

    @property
    def status(self):
        return {"available": self.available and not self._closed,
                "platform": "windows" if os.name == "nt" else os.name,
                "capture": "PrintWindow",
                "detail": self._detail,
                "execution": "single_step" if self.available and self._monitor and not self._monitor.failed and self._monitor.ready.is_set() else "unavailable",
                "uia": self._uia.status if self._uia else "unavailable",
                "uia_detail": self._uia.detail if self._uia else ""}

    def _require(self):
        if not self.available or self._closed:
            raise DesktopError("unavailable", self._detail if not self._closed else "Desktop adapter is closed")

    def register_assistant_window(self, hwnd):
        self._require()
        hwnd = int(hwnd)
        # Register only windows that actually exist; never accept a broad PID
        # exemption that would hide user input in unrelated applications.
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
            epoch = self._monitor.epoch
            image = self._image(target)
            output = io.BytesIO()
            image.save(output, format="PNG")
            snapshot_id = f"snap-{uuid.uuid4().hex[:12]}"
            b = target["bounds"]
            transform = {"transform_id": f"transform-{snapshot_id}",
                         "coordinate_space": "snapshot_image_px", "screen_space": "physical_screen_px",
                         "origin_x": b["left"], "origin_y": b["top"], "scale_x": 1.0, "scale_y": 1.0,
                         "dpi": target["dpi"], "electron_dip_scale": target["dpi"]/96,
                         "matrix": [1, 0, b["left"], 0, 1, b["top"], 0, 0, 1]}
            public = {"snapshot_id": snapshot_id, "target_id": target_id,
                      "captured_at_monotonic_ms": captured * 1000,
                      "image_size_px": {"width": image.width, "height": image.height},
                      "png_base64": base64.b64encode(output.getvalue()).decode("ascii"),
                      "content_sha256": hashlib.sha256(image.tobytes()).hexdigest(),
                      "target": target, "transform": transform,
                      "coordinate_space": "snapshot_image_px", "window_state": target["window_state"]}
            focused_hwnd = self._api.focused_window(target["hwnd"]) if hasattr(self._api, "focused_window") else None
            self._snapshots[snapshot_id] = _Snapshot(public, image, epoch, captured, focused_hwnd)
            self._targets[target_id] = target
            # Memory remains bounded even if observations happen continuously.
            while len(self._snapshots) > 12:
                del self._snapshots[next(iter(self._snapshots))]
            return public

    def observe_controls(self, target_id: str):
        self._require()
        target = self._target(target_id)
        return self._uia.observe(target["hwnd"], target["bounds"])

    def _validate(self, action, snapshot_id):
        if action.get("cancelled"):
            raise DesktopError("cancelled", "Action was cancelled")
        if snapshot_id not in self._snapshots:
            raise DesktopError("unknown_snapshot", "Referenced screenshot no longer exists; observe again")
        snapshot = self._snapshots[snapshot_id]
        if time.monotonic()-snapshot.captured > self.max_snapshot_age:
            raise DesktopError("stale_snapshot", "Screenshot is too old; observe again before acting")
        target_id = action.get("target_id", snapshot.public["target_id"])
        if target_id != snapshot.public["target_id"]:
            raise DesktopError("target_mismatch", "Action target does not match its screenshot")
        if action.get("snapshot_id", snapshot_id) != snapshot_id:
            raise DesktopError("snapshot_mismatch", "Action snapshot does not match the supplied screenshot")
        if action.get("coordinate_space", "snapshot_image_px") != "snapshot_image_px":
            raise DesktopError("coordinate_space", "Actions must use screenshot image pixels")
        target = self._target(target_id)
        if not _same_geometry(snapshot.public["target"], target):
            raise DesktopError("geometry_changed", "Target moved, resized or changed DPI; observe again")
        kind = action.get("kind")
        if kind not in {"click", "type", "scroll", "key", "highlight"}:
            raise DesktopError("invalid_action", "Only click, type, scroll, key and highlight are supported")
        if kind != "highlight" and self._monitor.epoch != snapshot.input_epoch:
            raise DesktopError("user_takeover", "User input changed after observation; observe again before acting")
        if kind in {"type", "key"} and action.get("point") is None and snapshot.focused_hwnd is not None:
            if self._api.focused_window(target["hwnd"]) != snapshot.focused_hwnd:
                raise DesktopError("focused_control_changed", "Focused control changed; observe again before typing")
        current = self._image(target)
        if not _same_content(snapshot.image, current):
            raise DesktopError("content_changed", "Target contents changed; refresh the screenshot and action preview")
        return snapshot, target, kind

    def _guard(self, target, epoch):
        if self._active_cancel_epoch is not None and self._cancel_epoch != self._active_cancel_epoch:
            raise DesktopError("cancelled", "Action was cancelled; remaining input was stopped")
        if self._monitor.epoch != epoch:
            raise DesktopError("user_takeover", "User took control; remaining input was stopped")
        if self._api.foreground() != target["hwnd"]:
            raise DesktopError("focus_changed", "Target lost focus; remaining input was stopped")
        current = self._target(target["target_id"])
        if not _same_geometry(current, target):
            raise DesktopError("geometry_changed", "Target moved during action; remaining input was stopped")

    def execute(self, action: dict, snapshot_id: str):
        self._require()
        if not isinstance(action, dict):
            raise DesktopError("invalid_action", "Action must be an object")
        with self._lock:
            self._active_cancel_epoch = self._cancel_epoch
            snapshot, target, kind = self._validate(action, snapshot_id)
            public = snapshot.public
            if kind == "highlight":
                rect = action.get("rect")
                if rect is None:
                    point = action.get("point", {"x": public["image_size_px"]["width"]//2, "y": public["image_size_px"]["height"]//2})
                    rect = {"x": max(0, float(point["x"])-35), "y": max(0, float(point["y"])-20), "width": 70, "height": 40}
                x, y = image_point_to_screen(rect, public["image_size_px"], public["transform"])
                try:
                    width, height = float(rect["width"]), float(rect["height"])
                except (KeyError, ValueError, TypeError):
                    raise DesktopError("invalid_action", "Highlight rectangle dimensions are missing")
                if not math.isfinite(width) or not math.isfinite(height) or min(width, height) <= 0:
                    raise DesktopError("invalid_action", "Highlight dimensions must be finite positive numbers")
                width = min(width, public["image_size_px"]["width"]-float(rect["x"]))
                height = min(height, public["image_size_px"]["height"]-float(rect["y"]))
                return {"kind": kind, "status": "highlighted", "target_id": target["target_id"], "snapshot_id": snapshot_id,
                        "screen_rect": {"x": x, "y": y, "width": round(width), "height": round(height)}, "label": str(action.get("label", "下一步"))[:120]}
            if self._monitor.failed or not self._monitor.ready.is_set():
                raise DesktopError("input_observer_unavailable", self._monitor.failed or "Input observer has not initialized")
            foreground = self._api.foreground()
            if foreground != target["hwnd"] and foreground not in self._assistant_windows:
                raise DesktopError("user_takeover", "Another application has focus; return to the target and observe again")
            if any(self._api.user.GetAsyncKeyState(vk) & 0x8000 for vk in (1, 2, 4, 16, 17, 18, 91, 92)):
                raise DesktopError("input_busy", "Release mouse buttons and modifier keys before executing")
            epoch = self._monitor.epoch
            if foreground != target["hwnd"] and not self._api.focus(target["hwnd"]):
                raise DesktopError("focus_failed", "Windows refused target focus recovery; no input was sent")
            # Revalidate content after focus recovery; focused controls can reflow.
            if not _same_content(snapshot.image, self._image(target)):
                raise DesktopError("content_changed", "Target changed after focus recovery; observe again")
            self._guard(target, epoch)
            point = None
            if kind in {"click", "scroll"} or action.get("point") is not None:
                point = image_point_to_screen(action.get("point"), public["image_size_px"], public["transform"])
                if self._api.point_root(*point) != target["hwnd"]:
                    raise DesktopError("target_occluded", "Action point is obscured by another window; no input was sent")
            # Validate all parameters before injecting any input.
            text = None
            if kind == "type":
                text = action.get("text")
                if not isinstance(text, str) or not text or len(text) > 4000:
                    raise DesktopError("invalid_action", "Type requires 1–4000 characters")
                if any(ord(char) < 32 and char not in "\n\t" for char in text):
                    raise DesktopError("invalid_action", "Unsupported control characters in typed text")
            delta = None
            if kind == "scroll":
                try:
                    delta = int(action.get("delta", action.get("amount", -3)))
                except (ValueError, TypeError):
                    raise DesktopError("invalid_action", "Scroll amount must be an integer")
                if not -20 <= delta <= 20 or delta == 0:
                    raise DesktopError("invalid_action", "Scroll amount must be between -20 and 20 nonzero notches")
            keys = None
            if kind == "key":
                allowed = {"enter": 13, "tab": 9, "escape": 27, "backspace": 8,
                           "left": 37, "up": 38, "right": 39, "down": 40,
                           "home": 36, "end": 35, "pageup": 33, "pagedown": 34}
                key = str(action.get("key", "")).lower()
                if key not in allowed:
                    raise DesktopError("invalid_action", "Only navigation and editing single keys are supported")
                keys = [self._api.key(allowed[key]), self._api.key(allowed[key], flags=2)]
            self._monitor.active = True
            try:
                self._guard(target, epoch)
                if kind == "click":
                    if action.get("button", "left") != "left":
                        raise DesktopError("invalid_action", "Only a single left click is supported")
                    self._api.send([self._api.move_input(*point), self._api.mouse(flags=2), self._api.mouse(flags=4)])
                elif kind == "type":
                    if point:
                        self._api.send([self._api.move_input(*point), self._api.mouse(flags=2), self._api.mouse(flags=4)])
                        time.sleep(.03)
                    units = text.encode("utf-16-le", errors="strict")
                    # Small batches keep takeover checks responsive. Every UTF16
                    # unit's down/up pair is included together, including emoji.
                    for index in range(0, len(units), 32):
                        self._guard(target, epoch)
                        batch = []
                        for offset in range(index, min(index+32, len(units)), 2):
                            code = int.from_bytes(units[offset:offset+2], "little")
                            batch += [self._api.key(scan=code, flags=4), self._api.key(scan=code, flags=6)]
                        self._api.send(batch)
                        time.sleep(.01)
                elif kind == "scroll":
                    self._api.send([self._api.move_input(*point), self._api.mouse(flags=0x800, data=delta*120)])
                else:
                    self._api.send(keys)
                time.sleep(.08)
                self._guard(target, epoch)
            finally:
                self._monitor.active = False
                self._active_cancel_epoch = None
                # A used snapshot can never be replayed, even on partial input.
                self._snapshots.pop(snapshot_id, None)
            after = self.capture(target["target_id"])
            controls = self.observe_controls(target["target_id"])
            changed = not _same_content(snapshot.image, self._snapshots[after["snapshot_id"]].image)
            expected = str(action.get("expected_text", ""))
            verified = any(expected in str(control.get("name", "")) or expected in str(control.get("value", "")) for control in controls) if expected else None
            return {"kind": kind, "status": "input_sent", "target_id": target["target_id"],
                    "snapshot_id": snapshot_id, "result_snapshot": after, "controls": controls,
                    "observed_change": changed, "expected_result_verified": verified,
                    "detail": "Input was sent and the target was captured again. The requested outcome needs observation."}

    def cancel(self):
        """Stop the next input batch without waiting for the action lock."""
        self._cancel_epoch += 1

    def close(self):
        self.cancel()
        self._closed = True
        if self._monitor: self._monitor.close()
        if self._uia: self._uia.close()
        self._snapshots.clear()
