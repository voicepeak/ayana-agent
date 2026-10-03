"""Guardrail regression tests and an opt-in integration test on an owned app."""
from __future__ import annotations

import base64
import copy
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from PIL import Image, ImageDraw
from native.windows.desktop import DesktopError, WindowsDesktop, image_point_to_screen, _same_content


class FakeApi:
    def __init__(self):
        self.target = {"hwnd": 42, "process_id": 7, "process_created": 1234,
                       "class_name": "OwnedDemo", "title": "Demo", "dpi": 144,
                       "bounds": {"left": -800, "top": 20, "right": -400, "bottom": 320},
                       "window_state": "visible", "elevated": False}
        self.image_value = Image.new("RGB", (400, 300), "white")
        ImageDraw.Draw(self.image_value).rectangle((60, 60, 150, 120), fill="#357080")
        self.front = 42
        self.sent = []
        self.user = self

    def identity(self, hwnd):
        return copy.deepcopy(self.target)

    def image(self, target):
        return self.image_value.copy()

    def foreground(self):
        return self.front

    def focus(self, hwnd):
        self.front = hwnd
        return True

    def GetAsyncKeyState(self, vk):
        return 0

    def point_root(self, x, y):
        return 42

    def move_input(self, x, y):
        return ("move", x, y)

    def mouse(self, **kwargs):
        return ("mouse", kwargs)

    def key(self, vk=0, scan=0, flags=0):
        return ("key", vk, scan, flags)

    def send(self, inputs):
        self.sent.append(inputs)


def fake_desktop():
    with patch("native.windows.desktop.os.name", "unavailable"):
        desktop = WindowsDesktop()
    desktop.available = True
    desktop._api = FakeApi()
    desktop._monitor = type("Monitor", (), {"epoch": 0, "active": False, "failed": None,
                                            "ready": threading.Event(), "close": lambda self: None})()
    desktop._monitor.ready.set()
    desktop._uia = type("Uia", (), {"status": "ready", "detail": "", "observe": lambda *args: [],
                                    "close": lambda self: None})()
    return desktop


class CoordinateTests(unittest.TestCase):
    def test_negative_screen_coordinates_and_dpi(self):
        result = image_point_to_screen({"x": 20, "y": 40}, {"width": 100, "height": 100},
                                       {"origin_x": -1920, "origin_y": -100, "scale_x": 1.5, "scale_y": 1.5})
        self.assertEqual(result, (-1890, -40))

    def test_reject_nonfinite_and_outside_coordinates(self):
        for point in ({"x": float("nan"), "y": 2}, {"x": 100, "y": 2}, {"x": -1, "y": 2}):
            with self.assertRaises(DesktopError):
                image_point_to_screen(point, {"width": 100, "height": 100}, {"origin_x": 0, "origin_y": 0, "scale_x": 1, "scale_y": 1})


class SnapshotGuardTests(unittest.TestCase):
    def setUp(self):
        self.desktop = fake_desktop()
        self.target = self.desktop.bind(42)
        self.snapshot = self.desktop.capture(self.target["target_id"])

    def tearDown(self):
        self.desktop.close()

    def action(self, **extra):
        return {"kind": "click", "target_id": self.target["target_id"], "point": {"x": 100, "y": 100}, **extra}

    def reject(self, code, action=None):
        with self.assertRaises(DesktopError) as caught:
            self.desktop.execute(action or self.action(), self.snapshot["snapshot_id"])
        self.assertEqual(caught.exception.code, code)
        self.assertEqual(self.desktop._api.sent, [])

    def test_png_is_real_and_matches_bounds(self):
        image = Image.open(io.BytesIO(base64.b64decode(self.snapshot["png_base64"])))
        self.assertEqual(image.size, (400, 300))

    def test_moved_window_rejects_old_coordinates(self):
        self.desktop._api.target["bounds"]["left"] -= 100
        self.reject("geometry_changed")

    def test_handle_reuse_rejects_action(self):
        self.desktop._api.target["process_created"] += 1
        self.reject("identity_changed")

    def test_same_bounds_navigation_rejects_action(self):
        ImageDraw.Draw(self.desktop._api.image_value).rectangle((60, 60, 150, 120), fill="red")
        self.reject("content_changed")

    def test_even_small_button_content_change_invalidates(self):
        ImageDraw.Draw(self.desktop._api.image_value).rectangle((100, 100, 105, 105), fill="red")
        self.reject("content_changed")

    def test_minimized_target_rejects_action(self):
        self.desktop._api.target["window_state"] = "minimized"
        self.reject("window_unavailable")

    def test_elevated_target_rejects_action(self):
        self.desktop._api.target["elevated"] = True
        self.reject("elevated_target")

    def test_user_input_invalidates_action(self):
        self.desktop._monitor.epoch += 1
        self.reject("user_takeover")

    def test_wrong_foreground_cannot_be_stolen(self):
        self.desktop._api.front = 71
        self.reject("user_takeover")
        self.assertEqual(self.desktop._api.front, 71)

    def test_snapshot_expiry(self):
        self.desktop._snapshots[self.snapshot["snapshot_id"]].captured -= 31
        self.reject("stale_snapshot")

    def test_snapshot_target_mismatch(self):
        self.reject("target_mismatch", self.action(target_id="other-window"))

    def test_highlight_maps_to_physical_coordinates_without_input(self):
        result = self.desktop.execute(self.action(kind="highlight", rect={"x": 70, "y": 80, "width": 40, "height": 50}), self.snapshot["snapshot_id"])
        self.assertEqual(result["screen_rect"], {"x": -730, "y": 100, "width": 40, "height": 50})
        self.assertEqual(self.desktop._api.sent, [])

    def test_single_click_cannot_be_replayed(self):
        result = self.desktop.execute(self.action(), self.snapshot["snapshot_id"])
        self.assertEqual(result["status"], "input_sent")
        self.assertFalse(result["observed_change"])
        self.assertEqual(len(self.desktop._api.sent), 1)
        with self.assertRaises(DesktopError) as caught:
            self.desktop.execute(self.action(), self.snapshot["snapshot_id"])
        self.assertEqual(caught.exception.code, "unknown_snapshot")

    def test_cancellation_stops_long_typing_between_batches(self):
        original = self.desktop._api.send
        def send_and_cancel(values):
            original(values)
            self.desktop.cancel()
        self.desktop._api.send = send_and_cancel
        with self.assertRaises(DesktopError) as caught:
            self.desktop.execute(self.action(kind="type", point=None, text="a"*100), self.snapshot["snapshot_id"])
        self.assertEqual(caught.exception.code, "cancelled")
        self.assertEqual(len(self.desktop._api.sent), 1)
        self.assertNotIn(self.snapshot["snapshot_id"], self.desktop._snapshots)

    def test_assistant_focus_can_be_recovered(self):
        self.desktop._assistant_windows.add(71)
        self.desktop._api.front = 71
        self.desktop.execute(self.action(), self.snapshot["snapshot_id"])
        self.assertEqual(self.desktop._api.front, 42)


@unittest.skipUnless(os.name == "nt" and os.environ.get("AYANA_WINDOWS_INTEGRATION") == "1", "Set AYANA_WINDOWS_INTEGRATION=1 for an owned-window capture/input test")
class OwnedWindowIntegrationTests(unittest.TestCase):
    def test_owned_window_capture_type_and_button(self):
        from native.windows.win32 import Win32
        with tempfile.TemporaryDirectory(prefix="ayana-window-") as folder:
            state = Path(folder)/"state.json"
            process = subprocess.Popen([sys.executable, "-m", "native.windows.demo_target", "--state", str(state), "--auto-close", "20"],
                                       creationflags=subprocess.CREATE_NO_WINDOW)
            desktop = WindowsDesktop()
            try:
                deadline = time.monotonic()+8
                while not state.exists() and time.monotonic() < deadline:
                    time.sleep(.1)
                self.assertTrue(state.exists(), "Owned demo window did not start")
                # File may be briefly open for the next tick; retry reads.
                def read_state():
                    for _ in range(20):
                        try: return json.loads(state.read_text(encoding="utf-8"))
                        except (OSError, json.JSONDecodeError): time.sleep(.02)
                    raise RuntimeError("Cannot read demo window state")
                data = read_state()
                hwnd = data["hwnd"]
                self.assertTrue(desktop._api.focus(hwnd), "Test process could not focus its own demo target")
                target = desktop.bind(hwnd)
                snapshot = desktop.capture(target["target_id"])
                controls = desktop.observe_controls(target["target_id"])
                self.assertEqual(desktop._uia.status, "ready", desktop._uia.detail)
                self.assertTrue(controls, desktop._uia.detail)
                image = Image.open(io.BytesIO(base64.b64decode(snapshot["png_base64"])))
                self.assertGreater(image.width, 500)
                def point(widget):
                    b = snapshot["target"]["bounds"]
                    rect = data["widgets"][widget]
                    return {"x": rect["x"]+rect["width"]//2-b["left"], "y": rect["y"]+rect["height"]//2-b["top"]}
                result = desktop.execute({"kind": "type", "target_id": target["target_id"], "point": point("entry"), "text": "Ayana demo"}, snapshot["snapshot_id"])
                time.sleep(.2)
                self.assertEqual(read_state()["message"], "Ayana demo")
                snapshot = desktop.capture(target["target_id"])
                desktop.execute({"kind": "click", "target_id": target["target_id"], "point": point("button")}, snapshot["snapshot_id"])
                time.sleep(.2)
                self.assertEqual(read_state()["output"], "Received: Ayana demo")
                self.assertTrue(result["observed_change"])
            finally:
                desktop.close()
                process.terminate()
                process.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
