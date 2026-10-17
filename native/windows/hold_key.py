"""Read only the configured PTT chord while the user is holding it."""
from __future__ import annotations

import asyncio
import os
import re
import time


def chord_codes(accelerator: str) -> tuple[int, ...]:
    if not isinstance(accelerator, str) or len(accelerator) > 100:
        raise ValueError("无效的说话快捷键")
    parts = accelerator.lower().split("+")
    modifiers = {"ctrl": 0x11, "control": 0x11, "commandorcontrol": 0x11,
                 "shift": 0x10, "alt": 0x12, "super": 0x5B, "meta": 0x5B}
    codes = []
    for part in parts[:-1]:
        if part not in modifiers or modifiers[part] in codes:
            raise ValueError("说话快捷键需使用 Ctrl、Shift、Alt 加字母、数字、空格或 F 键")
        codes.append(modifiers[part])
    key = parts[-1]
    if len(key) == 1 and key.isascii() and key.isalnum():
        code = ord(key.upper())
    elif key == "space":
        code = 0x20
    elif re.fullmatch(r"f(?:[1-9]|1[0-9]|2[0-4])", key):
        code = 0x70 + int(key[1:]) - 1
    else:
        raise ValueError("说话快捷键需使用字母、数字、Space 或 F1–F24")
    if not codes:
        raise ValueError("说话快捷键至少需要一个修饰键")
    return tuple(sorted([*codes, code]))


async def wait_for_release(accelerator: str, *, read_key=None, timeout=60.0) -> str:
    codes = chord_codes(accelerator)
    if read_key is None:
        if os.name != "nt":
            raise RuntimeError("全局按住说话目前仅支持 Windows")
        import ctypes
        get_state = ctypes.WinDLL("user32", use_last_error=True).GetAsyncKeyState
        get_state.argtypes, get_state.restype = [ctypes.c_int], ctypes.c_short
        read_key = lambda code: bool(get_state(code) & 0x8000)
    started = time.monotonic()
    while all(read_key(code) for code in codes):
        if time.monotonic() - started >= timeout:
            return "timeout"
        await asyncio.sleep(.02)
    return "released"
