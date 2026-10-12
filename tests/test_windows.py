"""Guardrail regression tests for Windows window capture."""
from __future__ import annotations

import base64
import copy
import io
import unittest
from unittest.mock import patch

from PIL import Image, ImageDraw
from native.windows.desktop import DesktopError, WindowsDesktop


class FakeApi:
    def __init__(self):
        self.target = {"hwnd": 42, "process_id": 7, "process_created": 1234,
                       "class_name": "OwnedDemo", "title": "Demo", "dpi": 144,
                       "bounds": {"left": -800, "top": 20, "right": -400, "bottom": 320},
                       "window_state": "visible", "elevated": False}
        self.image_value = Image.new("RGB", (400, 300), "white")
        ImageDraw.Draw(self.image_value).rectangle((60, 60, 150, 120), fill="#357080")
        self.front = 42
        self.user = self

    def identity(self, hwnd):
        return copy.deepcopy(self.target)

    def image(self, target):
        return self.image_value.copy()

    def foreground(self):
        return self.front

    def IsWindow(self, hwnd):
        return True

    def root(self, hwnd):
        return int(hwnd)


def fake_desktop():
    with patch("native.windows.desktop.os.name", "unavailable"):
        desktop = WindowsDesktop()
    desktop.available = True
    desktop._api = FakeApi()
    return desktop


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.desktop = fake_desktop()
        self.target = self.desktop.bind(42)

    def tearDown(self):
        self.desktop.close()

    def test_png_is_real_and_matches_bounds(self):
        snapshot = self.desktop.capture(self.target["target_id"])
        image = Image.open(io.BytesIO(base64.b64decode(snapshot["png_base64"])))
        self.assertEqual(image.size, (400, 300))
        self.assertEqual(snapshot["target_id"], self.target["target_id"])
        self.assertEqual(snapshot["target"]["title"], "Demo")

    def test_minimized_and_elevated_targets_cannot_bind(self):
        self.desktop._api.target["window_state"] = "minimized"
        with self.assertRaises(DesktopError) as caught:
            self.desktop.bind(43)
        self.assertEqual(caught.exception.code, "window_unavailable")
        self.desktop._api.target["window_state"] = "visible"
        self.desktop._api.target["elevated"] = True
        with self.assertRaises(DesktopError) as caught:
            self.desktop.bind(43)
        self.assertEqual(caught.exception.code, "elevated_target")

    def test_identity_change_invalidates_capture(self):
        self.desktop.capture(self.target["target_id"])
        self.desktop._api.target["process_created"] += 1
        with self.assertRaises(DesktopError) as caught:
            self.desktop.capture(self.target["target_id"])
        self.assertEqual(caught.exception.code, "identity_changed")

    def test_move_during_capture_is_rejected(self):
        original = self.desktop._api.image
        def move(values):
            self.desktop._api.target["bounds"]["left"] -= 100
            return original(values)
        self.desktop._api.image = move
        with self.assertRaises(DesktopError) as caught:
            self.desktop.capture(self.target["target_id"])
        self.assertEqual(caught.exception.code, "target_changed")

    def test_assistant_windows_are_not_targets(self):
        self.desktop.register_assistant_window(42)
        with self.assertRaises(DesktopError) as caught:
            self.desktop.bind(42)
        self.assertEqual(caught.exception.code, "assistant_target")


if __name__ == "__main__":
    unittest.main()
