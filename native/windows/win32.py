"""Small, typed ctypes binding to the public Windows desktop APIs.

No global input is sent by importing or constructing this module.
"""
from __future__ import annotations

import ctypes as C
from ctypes import wintypes as W
import io
import os
import threading
import time


MARKER = 0x4159414E
ULONG_PTR = C.c_size_t


class MOUSEINPUT(C.Structure):
    _fields_ = [("dx", W.LONG), ("dy", W.LONG), ("mouseData", W.DWORD),
                ("dwFlags", W.DWORD), ("time", W.DWORD), ("dwExtraInfo", ULONG_PTR)]


class KEYBDINPUT(C.Structure):
    _fields_ = [("wVk", W.WORD), ("wScan", W.WORD), ("dwFlags", W.DWORD),
                ("time", W.DWORD), ("dwExtraInfo", ULONG_PTR)]


class HARDWAREINPUT(C.Structure):
    _fields_ = [("uMsg", W.DWORD), ("wParamL", W.WORD), ("wParamH", W.WORD)]


class INPUTUNION(C.Union):
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]


class INPUT(C.Structure):
    _anonymous_ = ("u",)
    _fields_ = [("type", W.DWORD), ("u", INPUTUNION)]


class BITMAPINFOHEADER(C.Structure):
    _fields_ = [("biSize", W.DWORD), ("biWidth", W.LONG), ("biHeight", W.LONG),
                ("biPlanes", W.WORD), ("biBitCount", W.WORD), ("biCompression", W.DWORD),
                ("biSizeImage", W.DWORD), ("biXPelsPerMeter", W.LONG),
                ("biYPelsPerMeter", W.LONG), ("biClrUsed", W.DWORD),
                ("biClrImportant", W.DWORD)]


class BITMAPINFO(C.Structure):
    _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", W.DWORD * 3)]


class KBDLLHOOKSTRUCT(C.Structure):
    _fields_ = [("vkCode", W.DWORD), ("scanCode", W.DWORD), ("flags", W.DWORD),
                ("time", W.DWORD), ("dwExtraInfo", ULONG_PTR)]


class MSLLHOOKSTRUCT(C.Structure):
    _fields_ = [("pt", W.POINT), ("mouseData", W.DWORD), ("flags", W.DWORD),
                ("time", W.DWORD), ("dwExtraInfo", ULONG_PTR)]


class GUITHREADINFO(C.Structure):
    _fields_ = [("cbSize", W.DWORD), ("flags", W.DWORD),
                ("hwndActive", W.HWND), ("hwndFocus", W.HWND), ("hwndCapture", W.HWND),
                ("hwndMenuOwner", W.HWND), ("hwndMoveSize", W.HWND), ("hwndCaret", W.HWND),
                ("rcCaret", W.RECT)]


def _fn(lib, name, restype, *argtypes):
    fn = getattr(lib, name)
    fn.restype, fn.argtypes = restype, list(argtypes)
    return fn


class Win32:
    def __init__(self):
        if os.name != "nt":
            raise RuntimeError("Windows desktop APIs are unavailable on this platform")
        self.user = C.WinDLL("user32", use_last_error=True)
        self.kernel = C.WinDLL("kernel32", use_last_error=True)
        self.gdi = C.WinDLL("gdi32", use_last_error=True)
        self.advapi = C.WinDLL("advapi32", use_last_error=True)
        self._bind()
        # Every worker enters PMv2 before querying physical pixels. Setting the
        # process awareness here could interfere with an embedding GUI process.
        self.dpi_context()

    def dpi_context(self):
        if hasattr(self.user, "SetThreadDpiAwarenessContext"):
            self.user.SetThreadDpiAwarenessContext(C.c_void_p(-4))

    def _bind(self):
        u, k, g, a = self.user, self.kernel, self.gdi, self.advapi
        self.enum_proc = C.WINFUNCTYPE(W.BOOL, W.HWND, W.LPARAM)
        self.hook_proc = C.WINFUNCTYPE(C.c_ssize_t, C.c_int, W.WPARAM, W.LPARAM)
        _fn(u, "EnumWindows", W.BOOL, self.enum_proc, W.LPARAM)
        for name in ("IsWindow", "IsWindowVisible", "IsIconic", "SetForegroundWindow"):
            _fn(u, name, W.BOOL, W.HWND)
        _fn(u, "GetForegroundWindow", W.HWND)
        _fn(u, "GetAncestor", W.HWND, W.HWND, W.UINT)
        _fn(u, "GetWindowRect", W.BOOL, W.HWND, C.POINTER(W.RECT))
        _fn(u, "GetClientRect", W.BOOL, W.HWND, C.POINTER(W.RECT))
        _fn(u, "ClientToScreen", W.BOOL, W.HWND, C.POINTER(W.POINT))
        _fn(u, "GetWindowTextLengthW", C.c_int, W.HWND)
        _fn(u, "GetWindowTextW", C.c_int, W.HWND, W.LPWSTR, C.c_int)
        _fn(u, "GetClassNameW", C.c_int, W.HWND, W.LPWSTR, C.c_int)
        _fn(u, "GetWindowThreadProcessId", W.DWORD, W.HWND, C.POINTER(W.DWORD))
        _fn(u, "GetGUIThreadInfo", W.BOOL, W.DWORD, C.POINTER(GUITHREADINFO))
        _fn(u, "GetWindow", W.HWND, W.HWND, W.UINT)
        _fn(u, "AttachThreadInput", W.BOOL, W.DWORD, W.DWORD, W.BOOL)
        _fn(u, "BringWindowToTop", W.BOOL, W.HWND)
        _fn(u, "GetDC", W.HDC, W.HWND)
        _fn(u, "ReleaseDC", C.c_int, W.HWND, W.HDC)
        _fn(u, "PrintWindow", W.BOOL, W.HWND, W.HDC, W.UINT)
        _fn(u, "SendInput", W.UINT, W.UINT, C.POINTER(INPUT), C.c_int)
        _fn(u, "GetSystemMetrics", C.c_int, C.c_int)
        _fn(u, "WindowFromPoint", W.HWND, W.POINT)
        _fn(u, "GetCursorPos", W.BOOL, C.POINTER(W.POINT))
        _fn(u, "GetAsyncKeyState", C.c_short, C.c_int)
        _fn(u, "SetWindowsHookExW", W.HANDLE, C.c_int, self.hook_proc, W.HINSTANCE, W.DWORD)
        _fn(u, "UnhookWindowsHookEx", W.BOOL, W.HANDLE)
        _fn(u, "CallNextHookEx", C.c_ssize_t, W.HANDLE, C.c_int, W.WPARAM, W.LPARAM)
        _fn(u, "GetMessageW", W.BOOL, C.POINTER(W.MSG), W.HWND, W.UINT, W.UINT)
        _fn(u, "PeekMessageW", W.BOOL, C.POINTER(W.MSG), W.HWND, W.UINT, W.UINT, W.UINT)
        _fn(u, "TranslateMessage", W.BOOL, C.POINTER(W.MSG))
        _fn(u, "DispatchMessageW", C.c_ssize_t, C.POINTER(W.MSG))
        _fn(u, "PostThreadMessageW", W.BOOL, W.DWORD, W.UINT, W.WPARAM, W.LPARAM)
        _fn(u, "SendMessageTimeoutW", C.c_ssize_t, W.HWND, W.UINT, W.WPARAM,
            W.LPARAM, W.UINT, W.UINT, C.POINTER(ULONG_PTR))
        if hasattr(u, "GetDpiForWindow"):
            _fn(u, "GetDpiForWindow", W.UINT, W.HWND)
            _fn(u, "SetThreadDpiAwarenessContext", W.HANDLE, W.HANDLE)
        _fn(k, "GetCurrentThreadId", W.DWORD)
        _fn(k, "OpenProcess", W.HANDLE, W.DWORD, W.BOOL, W.DWORD)
        _fn(k, "CloseHandle", W.BOOL, W.HANDLE)
        _fn(k, "GetProcessTimes", W.BOOL, W.HANDLE, C.POINTER(W.FILETIME),
            C.POINTER(W.FILETIME), C.POINTER(W.FILETIME), C.POINTER(W.FILETIME))
        _fn(k, "QueryFullProcessImageNameW", W.BOOL, W.HANDLE, W.DWORD,
            W.LPWSTR, C.POINTER(W.DWORD))
        _fn(g, "CreateCompatibleDC", W.HDC, W.HDC)
        _fn(g, "CreateCompatibleBitmap", W.HBITMAP, W.HDC, C.c_int, C.c_int)
        _fn(g, "SelectObject", W.HANDLE, W.HDC, W.HANDLE)
        _fn(g, "DeleteObject", W.BOOL, W.HANDLE)
        _fn(g, "DeleteDC", W.BOOL, W.HDC)
        _fn(g, "GetDIBits", C.c_int, W.HDC, W.HBITMAP, W.UINT, W.UINT,
            C.c_void_p, C.POINTER(BITMAPINFO), W.UINT)
        _fn(a, "OpenProcessToken", W.BOOL, W.HANDLE, W.DWORD, C.POINTER(W.HANDLE))
        _fn(a, "GetTokenInformation", W.BOOL, W.HANDLE, C.c_int, C.c_void_p,
            W.DWORD, C.POINTER(W.DWORD))

    def root(self, hwnd):
        return int(self.user.GetAncestor(hwnd, 2) or 0)

    def foreground(self):
        return int(self.user.GetForegroundWindow() or 0)

    def focused_window(self, hwnd):
        info = GUITHREADINFO(cbSize=C.sizeof(GUITHREADINFO))
        thread_id = self.user.GetWindowThreadProcessId(hwnd, None)
        if self.user.GetGUIThreadInfo(thread_id, C.byref(info)):
            return int(info.hwndFocus or 0)
        return None

    def identity(self, hwnd):
        self.dpi_context()
        if not self.user.IsWindow(hwnd):
            raise RuntimeError("Target window has closed")
        pid = W.DWORD()
        self.user.GetWindowThreadProcessId(hwnd, C.byref(pid))
        handle = self.kernel.OpenProcess(0x1000, False, pid.value)
        if not handle:
            raise PermissionError("Cannot inspect target process identity")
        try:
            times = [W.FILETIME() for _ in range(4)]
            if not self.kernel.GetProcessTimes(handle, *[C.byref(t) for t in times]):
                raise RuntimeError("Cannot obtain target process creation time")
            creation = (times[0].dwHighDateTime << 32) | times[0].dwLowDateTime
            size, path = W.DWORD(32768), C.create_unicode_buffer(32768)
            self.kernel.QueryFullProcessImageNameW(handle, 0, path, C.byref(size))
            token = W.HANDLE()
            elevated = None
            if self.advapi.OpenProcessToken(handle, 8, C.byref(token)):
                try:
                    val, used = W.DWORD(), W.DWORD()
                    if self.advapi.GetTokenInformation(token, 20, C.byref(val), C.sizeof(val), C.byref(used)):
                        elevated = bool(val.value)
                finally:
                    self.kernel.CloseHandle(token)
        finally:
            self.kernel.CloseHandle(handle)
        rect, title, cls = W.RECT(), C.create_unicode_buffer(2048), C.create_unicode_buffer(256)
        if not self.user.GetWindowRect(hwnd, C.byref(rect)):
            raise RuntimeError("Cannot obtain target window bounds")
        self.user.GetWindowTextW(hwnd, title, len(title))
        self.user.GetClassNameW(hwnd, cls, len(cls))
        client, origin = W.RECT(), W.POINT()
        if not self.user.GetClientRect(hwnd, C.byref(client)) or not self.user.ClientToScreen(hwnd, C.byref(origin)):
            raise RuntimeError("Cannot obtain target client bounds")
        client_bounds = {"left": origin.x-rect.left, "top": origin.y-rect.top,
                         "right": origin.x-rect.left+client.right-client.left,
                         "bottom": origin.y-rect.top+client.bottom-client.top}
        return {"hwnd": int(hwnd), "process_id": pid.value, "process_created": creation,
                "title": title.value, "class_name": cls.value, "executable": path.value,
                "bounds": {"left": rect.left, "top": rect.top, "right": rect.right, "bottom": rect.bottom},
                "client_bounds_image_px": client_bounds,
                "dpi": int(self.user.GetDpiForWindow(hwnd) or 96) if hasattr(self.user, "GetDpiForWindow") else 96,
                "window_state": "minimized" if self.user.IsIconic(hwnd) else "visible" if self.user.IsWindowVisible(hwnd) else "hidden",
                "elevated": elevated}

    def enumerate(self):
        result = []
        @self.enum_proc
        def callback(hwnd, _):
            if self.user.IsWindowVisible(hwnd) and self.user.GetWindowTextLengthW(hwnd):
                try:
                    result.append(self.identity(int(hwnd)))
                except (OSError, RuntimeError, PermissionError):
                    pass
            return True
        self.user.EnumWindows(callback, 0)
        return result

    def image(self, target):
        """Capture the specified HWND, independent of the current foreground."""
        from PIL import Image
        self.dpi_context()
        hwnd, b = target["hwnd"], target["bounds"]
        width, height = b["right"] - b["left"], b["bottom"] - b["top"]
        if not 1 <= width <= 12000 or not 1 <= height <= 12000 or width * height > 35_000_000:
            raise RuntimeError("Target dimensions are invalid or exceed capture budget")
        probe = ULONG_PTR()
        if not self.user.SendMessageTimeoutW(hwnd, 0, 0, 0, 2, 250, C.byref(probe)):
            raise RuntimeError("Target window is unresponsive")
        dc = self.user.GetDC(hwnd)
        memory = self.gdi.CreateCompatibleDC(dc)
        bitmap = self.gdi.CreateCompatibleBitmap(dc, width, height)
        if not dc or not memory or not bitmap:
            if bitmap: self.gdi.DeleteObject(bitmap)
            if memory: self.gdi.DeleteDC(memory)
            if dc: self.user.ReleaseDC(hwnd, dc)
            raise RuntimeError("Cannot allocate capture surface")
        old = self.gdi.SelectObject(memory, bitmap)
        try:
            rendered = self.user.PrintWindow(hwnd, memory, 2)  # PW_RENDERFULLCONTENT
            info = BITMAPINFO()
            info.bmiHeader = BITMAPINFOHEADER(C.sizeof(BITMAPINFOHEADER), width, -height, 1, 32, 0, 0, 0, 0, 0, 0)
            buf = C.create_string_buffer(width * height * 4)
            self.gdi.SelectObject(memory, old)
            lines = self.gdi.GetDIBits(memory, bitmap, 0, height, buf, C.byref(info), 0)
            if not rendered or lines != height:
                raise RuntimeError("PrintWindow cannot capture this target")
            image = Image.frombuffer("RGB", (width, height), buf.raw, "raw", "BGRX", 0, 1).copy()
            extrema = image.getextrema()
            if all(high < 3 for low, high in extrema):
                raise RuntimeError("Target returned a blank/protected capture")
            return image
        finally:
            self.gdi.SelectObject(memory, old)
            self.gdi.DeleteObject(bitmap)
            self.gdi.DeleteDC(memory)
            self.user.ReleaseDC(hwnd, dc)

    def focus(self, hwnd):
        original = self.foreground()
        if original == hwnd:
            return True
        self.user.SetForegroundWindow(hwnd)
        def wait_for_focus(seconds):
            deadline = time.monotonic()+seconds
            while time.monotonic() < deadline:
                current = self.foreground()
                if current == hwnd:
                    return True
                if current not in (0, original):
                    return False  # user switched elsewhere: stop recovery
                time.sleep(.005)
            return self.foreground() == hwnd
        if wait_for_focus(.06):
            return True
        if not original or self.foreground() != original:
            return False
        # Electron's foreground GUI thread received the confirmation click;
        # the independent backend worker did not. Share that input queue only
        # for this guarded target activation, then detach on every exit path.
        # Desktop.execute already requires target/registered-assistant focus.
        message = W.MSG()
        self.user.PeekMessageW(C.byref(message), None, 0, 0, 0)
        current_thread = self.kernel.GetCurrentThreadId()
        foreground_thread = self.user.GetWindowThreadProcessId(original, None)
        target_thread = self.user.GetWindowThreadProcessId(hwnd, None)
        attached = []
        try:
            if foreground_thread and foreground_thread != current_thread:
                if not self.user.AttachThreadInput(current_thread, foreground_thread, True):
                    return False
                attached.append(foreground_thread)
            if self.foreground() != original:
                return self.foreground() == hwnd
            self.user.SetForegroundWindow(hwnd)
            if wait_for_focus(.06):
                return True
            if self.foreground() != original:
                return False
            if target_thread and target_thread not in {current_thread, foreground_thread}:
                if not self.user.AttachThreadInput(current_thread, target_thread, True):
                    return False
                attached.append(target_thread)
            if self.foreground() != original:
                return self.foreground() == hwnd
            self.user.BringWindowToTop(hwnd)
            self.user.SetForegroundWindow(hwnd)
            return wait_for_focus(.15)
        finally:
            for thread_id in reversed(attached):
                self.user.AttachThreadInput(current_thread, thread_id, False)

    def send(self, inputs):
        if not inputs:
            return
        array = (INPUT * len(inputs))(*inputs)
        sent = self.user.SendInput(len(inputs), array, C.sizeof(INPUT))
        if sent != len(inputs):
            # A down/up pair is always submitted in the same batch. Release all
            # possibly submitted keys/buttons if Windows accepted only part.
            release = []
            for value in inputs:
                if value.type == 1:
                    release.append(self.key(value.ki.wVk, value.ki.wScan, value.ki.dwFlags | 2))
                elif value.mi.dwFlags & 2:
                    release.append(self.mouse(0, 0, 4))
            if release:
                self.user.SendInput(len(release), (INPUT * len(release))(*release), C.sizeof(INPUT))
            raise RuntimeError("Windows rejected part of the input; target may be protected")

    @staticmethod
    def key(vk=0, scan=0, flags=0):
        result = INPUT(type=1)
        result.ki = KEYBDINPUT(vk, scan, flags, 0, MARKER)
        return result

    @staticmethod
    def mouse(x=0, y=0, flags=0, data=0):
        result = INPUT(type=0)
        result.mi = MOUSEINPUT(x, y, data & 0xFFFFFFFF, flags, 0, MARKER)
        return result

    def move_input(self, x, y):
        left, top = self.user.GetSystemMetrics(76), self.user.GetSystemMetrics(77)
        width, height = self.user.GetSystemMetrics(78), self.user.GetSystemMetrics(79)
        if not left <= x < left + width or not top <= y < top + height:
            raise RuntimeError("Action point is outside the virtual desktop")
        return self.mouse(round((x - left) * 65535 / max(1, width - 1)),
                          round((y - top) * 65535 / max(1, height - 1)), 0xC001)

    def point_root(self, x, y):
        return self.root(self.user.WindowFromPoint(W.POINT(x, y)))


class InputMonitor:
    """Observe public LL hooks; only known tagged input is excluded.

    Assistant panel windows can be explicitly registered, so clicking the
    confirmation button does not count as input into the target application.
    """
    def __init__(self, api, assistant_windows):
        self.api, self.assistant_windows = api, assistant_windows
        self.epoch = 0
        self.active = False
        self.ready = threading.Event()
        self.failed = None
        self.thread_id = None
        self.thread = threading.Thread(target=self._run, name="ayana-input-observer", daemon=True)
        self.thread.start()
        self.ready.wait(2)

    def _run(self):
        api = self.api
        api.dpi_context()
        self.thread_id = api.kernel.GetCurrentThreadId()
        @api.hook_proc
        def keyboard(code, message, ptr):
            if code >= 0:
                event = C.cast(ptr, C.POINTER(KBDLLHOOKSTRUCT)).contents
                if event.dwExtraInfo != MARKER and api.foreground() not in self.assistant_windows:
                    self.epoch += 1
            return api.user.CallNextHookEx(None, code, message, ptr)
        @api.hook_proc
        def mouse(code, message, ptr):
            if code >= 0:
                event = C.cast(ptr, C.POINTER(MSLLHOOKSTRUCT)).contents
                if event.dwExtraInfo != MARKER:
                    is_move = message == 0x200
                    if (not is_move or self.active) and api.point_root(event.pt.x, event.pt.y) not in self.assistant_windows:
                        self.epoch += 1
            return api.user.CallNextHookEx(None, code, message, ptr)
        hooks = [api.user.SetWindowsHookExW(13, keyboard, None, 0), api.user.SetWindowsHookExW(14, mouse, None, 0)]
        if not all(hooks):
            self.failed = "Cannot install user-input observer; execution disabled"
        # Create a message queue before signalling readiness (for shutdown).
        msg = W.MSG()
        api.user.PeekMessageW(C.byref(msg), None, 0, 0, 0)
        self.ready.set()
        try:
            while api.user.GetMessageW(C.byref(msg), None, 0, 0) > 0:
                api.user.TranslateMessage(C.byref(msg))
                api.user.DispatchMessageW(C.byref(msg))
        finally:
            for hook in hooks:
                if hook: api.user.UnhookWindowsHookEx(hook)

    def close(self):
        if self.thread_id:
            self.api.user.PostThreadMessageW(self.thread_id, 0x12, 0, 0)
            self.thread.join(timeout=1)
