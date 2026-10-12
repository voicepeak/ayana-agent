"""Small, typed ctypes binding to the public Windows desktop APIs.

No user input is sent by importing or constructing this module.
"""
from __future__ import annotations

import ctypes as C
from ctypes import wintypes as W
import os


ULONG_PTR = C.c_size_t


class BITMAPINFOHEADER(C.Structure):
    _fields_ = [("biSize", W.DWORD), ("biWidth", W.LONG), ("biHeight", W.LONG),
                ("biPlanes", W.WORD), ("biBitCount", W.WORD), ("biCompression", W.DWORD),
                ("biSizeImage", W.DWORD), ("biXPelsPerMeter", W.LONG),
                ("biYPelsPerMeter", W.LONG), ("biClrUsed", W.DWORD),
                ("biClrImportant", W.DWORD)]


class BITMAPINFO(C.Structure):
    _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", W.DWORD * 3)]


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
        _fn(u, "EnumWindows", W.BOOL, self.enum_proc, W.LPARAM)
        for name in ("IsWindow", "IsWindowVisible", "IsIconic"):
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
        _fn(u, "GetDC", W.HDC, W.HWND)
        _fn(u, "ReleaseDC", C.c_int, W.HWND, W.HDC)
        _fn(u, "PrintWindow", W.BOOL, W.HWND, W.HDC, W.UINT)
        _fn(u, "GetSystemMetrics", C.c_int, C.c_int)
        _fn(u, "SendMessageTimeoutW", C.c_ssize_t, W.HWND, W.UINT, W.WPARAM,
            W.LPARAM, W.UINT, W.UINT, C.POINTER(ULONG_PTR))
        if hasattr(u, "GetDpiForWindow"):
            _fn(u, "GetDpiForWindow", W.UINT, W.HWND)
            _fn(u, "SetThreadDpiAwarenessContext", W.HANDLE, W.HANDLE)
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
