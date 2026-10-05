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

TEST_PYTHON = getattr(sys, "_base_executable", sys.executable)


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

    def test_high_dpi_native_caption_focus_change_is_excluded(self):
        first = Image.new("RGB", (704, 544), "white")
        second = first.copy()
        ImageDraw.Draw(second).rectangle((0, 0, 703, 51), fill="#204080")
        client = {"left": 12, "top": 52, "right": 692, "bottom": 532}
        self.assertTrue(_same_content(first, second, client))
        # A small application-content change still invalidates the action.
        ImageDraw.Draw(second).rectangle((100, 100, 105, 105), fill="red")
        self.assertFalse(_same_content(first, second, client))

    def test_high_dpi_caret_blink_is_excluded_but_text_changes_are_not(self):
        first = Image.new("RGB", (704, 544), "white")
        second = first.copy()
        client = {"left": 12, "top": 52, "right": 692, "bottom": 532}
        ImageDraw.Draw(second).rectangle((100, 100, 102, 149), fill="black")
        self.assertFalse(_same_content(first, second, client))
        self.assertTrue(_same_content(first, second, client, dpi=168))
        ImageDraw.Draw(second).rectangle((103, 100, 106, 149), fill="black")
        self.assertFalse(_same_content(first, second, client, dpi=168))


class FocusRecoveryTests(unittest.TestCase):
    def focus_api(self, mode):
        from native.windows.win32 import Win32
        api = Win32.__new__(Win32)
        front, calls, attached = [71], [], set()
        class User:
            def SetForegroundWindow(self, hwnd):
                calls.append(("foreground", hwnd))
                if mode == "success" and 2 in attached:
                    front[0] = hwnd
                elif mode == "takeover":
                    front[0] = 99
            def GetWindowThreadProcessId(self, hwnd, _):
                return 2 if hwnd == 71 else 3
            def PeekMessageW(self, *_): calls.append(("queue",))
            def AttachThreadInput(self, current, other, active):
                calls.append(("attach", current, other, active))
                if active: attached.add(other)
                else: attached.discard(other)
                return True
            def BringWindowToTop(self, hwnd): calls.append(("top", hwnd))
        api.user = User()
        api.kernel = type("Kernel", (), {"GetCurrentThreadId": lambda self: 1})()
        api.foreground = lambda: front[0]
        return api, calls, attached

    def test_attaches_only_while_recovering_and_always_detaches(self):
        api, calls, attached = self.focus_api("success")
        self.assertTrue(api.focus(42))
        self.assertIn(("queue",), calls)
        self.assertIn(("attach", 1, 2, True), calls)
        self.assertIn(("attach", 1, 2, False), calls)
        self.assertEqual(attached, set())

    def test_failure_detaches_both_queues_without_synthetic_input(self):
        api, calls, attached = self.focus_api("denied")
        self.assertFalse(api.focus(42))
        self.assertIn(("attach", 1, 2, False), calls)
        self.assertIn(("attach", 1, 3, False), calls)
        self.assertEqual(attached, set())

    def test_foreground_takeover_stops_before_queue_attachment(self):
        api, calls, attached = self.focus_api("takeover")
        self.assertFalse(api.focus(42))
        self.assertFalse(any(call[0] == "attach" for call in calls))
        self.assertEqual(attached, set())


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
        injected = [item for batch in self.desktop._api.sent for item in batch]
        self.assertEqual(sum(item == ("mouse", {"flags": 2}) for item in injected), 1)
        self.assertEqual(sum(item == ("mouse", {"flags": 4}) for item in injected), 1)
        batches = len(self.desktop._api.sent)
        with self.assertRaises(DesktopError) as caught:
            self.desktop.execute(self.action(), self.snapshot["snapshot_id"])
        self.assertEqual(caught.exception.code, "unknown_snapshot")
        self.assertEqual(len(self.desktop._api.sent), batches)

    def test_cancel_during_pointer_move_prevents_mouse_down(self):
        original = self.desktop._api.send
        def move_then_cancel(values):
            original(values)
            self.desktop.cancel()
        self.desktop._api.send = move_then_cancel
        with self.assertRaises(DesktopError) as caught:
            self.desktop.execute(self.action(), self.snapshot["snapshot_id"])
        self.assertEqual(caught.exception.code, "cancelled")
        injected = [item for batch in self.desktop._api.sent for item in batch]
        self.assertFalse(any(item[0] == "mouse" for item in injected))

    def test_user_takeover_during_pointer_move_prevents_mouse_down(self):
        original = self.desktop._api.send
        def move_then_takeover(values):
            original(values)
            self.desktop._monitor.epoch += 1
        self.desktop._api.send = move_then_takeover
        with self.assertRaises(DesktopError) as caught:
            self.desktop.execute(self.action(), self.snapshot["snapshot_id"])
        self.assertEqual(caught.exception.code, "user_takeover")
        injected = [item for batch in self.desktop._api.sent for item in batch]
        self.assertFalse(any(item[0] == "mouse" for item in injected))

    def test_cancel_after_mouse_down_always_releases(self):
        original = self.desktop._api.send
        def cancel_on_down(values):
            original(values)
            if values == [("mouse", {"flags": 2})]:
                self.desktop.cancel()
        self.desktop._api.send = cancel_on_down
        with self.assertRaises(DesktopError) as caught:
            self.desktop.execute(self.action(), self.snapshot["snapshot_id"])
        self.assertEqual(caught.exception.code, "cancelled")
        injected = [item for batch in self.desktop._api.sent for item in batch]
        self.assertEqual(injected[-2:], [("mouse", {"flags": 2}), ("mouse", {"flags": 4})])

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
    def test_inactive_target_restores_focus_from_registered_assistant(self):
        with tempfile.TemporaryDirectory(prefix="ayana-focus-") as folder:
            processes, desktop = [], WindowsDesktop()
            try:
                states = {}
                for name in ("target", "assistant"):
                    state = Path(folder)/(name+".json")
                    processes.append(subprocess.Popen([TEST_PYTHON, "-m", "native.windows.demo_target", "--state", str(state), "--auto-close", "30"], creationflags=subprocess.CREATE_NO_WINDOW))
                    deadline = time.monotonic()+8
                    while time.monotonic() < deadline:
                        try:
                            states[name] = json.loads(state.read_text(encoding="utf-8"))
                            break
                        except (OSError, json.JSONDecodeError): time.sleep(.05)
                    self.assertIn(name, states)
                assistant, data = states["assistant"], states["target"]
                desktop.register_assistant_window(assistant["hwnd"])
                target = desktop.bind(data["hwnd"])
                self.assertTrue(desktop._api.focus(assistant["hwnd"]))
                # Park the pointer on these owned windows' caption. A genuine
                # button hover/content change remains subject to rejection.
                bounds = target["bounds"]
                desktop._api.send([desktop._api.move_input(bounds["left"]+20, bounds["top"]+10)])
                time.sleep(.1)
                snapshot = desktop.capture(target["target_id"])
                entry = data["widgets"]["entry"]
                point = {"x": entry["x"]+entry["width"]//2-bounds["left"], "y": entry["y"]+entry["height"]//2-bounds["top"]}
                result = desktop.execute({"kind": "type", "point": point, "text": "Focus recovery demo"}, snapshot["snapshot_id"])
                self.assertEqual(result["status"], "input_sent")
                self.assertEqual(desktop._api.foreground(), target["hwnd"])
                deadline = time.monotonic()+2
                message = ""
                while time.monotonic() < deadline:
                    try:
                        message = json.loads((Path(folder)/"target.json").read_text(encoding="utf-8"))["message"]
                        if message == "Focus recovery demo": break
                    except (OSError, json.JSONDecodeError): pass
                    time.sleep(.05)
                self.assertEqual(message, "Focus recovery demo")
            finally:
                desktop.close()
                for process in processes:
                    process.terminate()
                    process.wait(timeout=5)

    def test_owned_window_capture_type_and_button(self):
        from native.windows.win32 import Win32
        with tempfile.TemporaryDirectory(prefix="ayana-window-") as folder:
            state = Path(folder)/"state.json"
            process = subprocess.Popen([TEST_PYTHON, "-m", "native.windows.demo_target", "--state", str(state), "--auto-close", "20"],
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
                deadline = time.monotonic()+2
                message = ""
                while time.monotonic() < deadline:
                    message = read_state()["message"]
                    if message == "Ayana demo": break
                    time.sleep(.05)
                self.assertEqual(message, "Ayana demo")
                data = read_state()
                snapshot = desktop.capture(target["target_id"])
                desktop.execute({"kind": "click", "target_id": target["target_id"], "point": point("button")}, snapshot["snapshot_id"])
                deadline = time.monotonic()+2
                output = ""
                while time.monotonic() < deadline:
                    output = read_state()["output"]
                    if output == "Received: Ayana demo": break
                    time.sleep(.05)
                self.assertEqual(output, "Received: Ayana demo")
                self.assertTrue(result["observed_change"])
            finally:
                desktop.close()
                process.terminate()
                process.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
