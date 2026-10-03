"""Local, current-Windows-user DPAPI credential storage; never sent to renderer."""
from __future__ import annotations

import ctypes
import os
from pathlib import Path
from ctypes import wintypes


class Blob(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_ubyte))]


def _crypt(data: bytes, protect: bool) -> bytes:
    if os.name != "nt":
        raise RuntimeError("Use AYANA_API_KEY outside Windows")
    buf = (ctypes.c_ubyte * len(data)).from_buffer_copy(data)
    src, out = Blob(len(data), buf), Blob()
    crypt = ctypes.WinDLL("crypt32", use_last_error=True)
    func = crypt.CryptProtectData if protect else crypt.CryptUnprotectData
    func.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    func.restype = wintypes.BOOL
    if not func(ctypes.byref(src), None, None, None, None, 1, ctypes.byref(out)):
        raise ctypes.WinError(ctypes.get_last_error())
    kernel = ctypes.WinDLL("kernel32")
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    try:
        return ctypes.string_at(out.pbData, out.cbData)
    finally:
        kernel.LocalFree(out.pbData)


def save_key(path: Path, key: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(_crypt(key.encode("utf-8"), True))


def load_key(path: Path) -> str:
    if not path.exists():
        return ""
    try:
        return _crypt(path.read_bytes(), False).decode("utf-8")
    except OSError:
        return ""
