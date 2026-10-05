"""Windows open operation: explicit target and arguments, never a command string."""
from __future__ import annotations

import ctypes as C
import os
from ctypes import wintypes as W

from services.agent.tools.registry import ToolError


class ShellExecuteInfo(C.Structure):
    _fields_ = [("cbSize", W.DWORD), ("fMask", W.ULONG), ("hwnd", W.HWND),
                ("lpVerb", W.LPCWSTR), ("lpFile", W.LPCWSTR), ("lpParameters", W.LPCWSTR),
                ("lpDirectory", W.LPCWSTR), ("nShow", C.c_int), ("hInstApp", W.HINSTANCE),
                ("lpIDList", C.c_void_p), ("lpClass", W.LPCWSTR), ("hkeyClass", W.HKEY),
                ("dwHotKey", W.DWORD), ("hIcon", W.HANDLE), ("hProcess", W.HANDLE)]


def open_target(target, parameters=None, cancelled=None):
    if os.name != "nt":
        raise ToolError("platform_unavailable", "系统打开工具目前仅支持 Windows")
    shell = C.WinDLL("shell32", use_last_error=True)
    kernel = C.WinDLL("kernel32", use_last_error=True)
    ole = C.WinDLL("ole32", use_last_error=True)
    shell.ShellExecuteExW.argtypes = [C.POINTER(ShellExecuteInfo)]
    shell.ShellExecuteExW.restype = W.BOOL
    kernel.GetProcessId.argtypes = [W.HANDLE]
    kernel.GetProcessId.restype = W.DWORD
    kernel.CloseHandle.argtypes = [W.HANDLE]
    ole.CoInitializeEx.argtypes = [C.c_void_p, W.DWORD]
    ole.CoInitializeEx.restype = C.c_long
    initialized = ole.CoInitializeEx(None, 2 | 4)
    try:
        if cancelled and cancelled.is_set():
            raise ToolError("cancelled", "打开请求已经取消")
        info = ShellExecuteInfo(cbSize=C.sizeof(ShellExecuteInfo), fMask=0x40 | 0x100 | 0x400,
                                lpVerb="open", lpFile=str(target), lpParameters=parameters, nShow=1)
        if not shell.ShellExecuteExW(C.byref(info)):
            error = C.get_last_error()
            messages = {2: "目标不存在", 3: "目标路径不存在", 5: "Windows 拒绝访问",
                        1155: "没有可打开该文件的默认应用", 1223: "用户取消了打开请求"}
            raise ToolError("open_failed", messages.get(error, f"Windows 未能打开目标（错误 {error}）"))
        try:
            return {"status": "open_requested", "process_id": kernel.GetProcessId(info.hProcess) if info.hProcess else None,
                    "detail": "Windows 已接受打开请求；是否显示窗口还需观察。"}
        finally:
            if info.hProcess:
                kernel.CloseHandle(info.hProcess)
    finally:
        if initialized in {0, 1}:
            ole.CoUninitialize()
