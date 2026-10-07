"""Restore a name's spelling only from trusted user text or character identity."""
from functools import lru_cache
import re
import sys
import unicodedata


@lru_cache(maxsize=1)
def chinese_mapper():
    import ctypes
    from ctypes import wintypes
    mapper = ctypes.WinDLL("kernel32", use_last_error=True).LCMapStringEx
    mapper.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.LPCWSTR, ctypes.c_int,
                       wintypes.LPWSTR, ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_ssize_t]
    mapper.restype = ctypes.c_int
    return mapper


@lru_cache(maxsize=512)
def chinese_comparison(value):
    value = unicodedata.normalize("NFKC", value)
    if sys.platform != "win32" or "\0" in value:
        return value
    import ctypes
    destination = ctypes.create_unicode_buffer(len(value) * 2 + 4)
    # Windows NLS, LCMAP_SIMPLIFIED_CHINESE. Used for comparison only;
    # an outgoing replacement always comes verbatim from a trusted source.
    if chinese_mapper()("zh-CN", 0x02000000, value, -1, destination, len(destination), None, None, 0):
        return destination.value
    return value


def original_spelling(name, source):
    if name in source or not re.fullmatch(r"[\u3400-\u9fff]{2,80}", name):
        return name
    folded = chinese_comparison(name)
    candidates = {source[i:i + len(name)] for i in range(len(source) - len(name) + 1)
                  if re.fullmatch(r"[\u3400-\u9fff]+", source[i:i + len(name)])
                  and chinese_comparison(source[i:i + len(name)]) == folded}
    return candidates.pop() if len(candidates) == 1 else name


def restore_search_terms(query, subject, user_text, identity=""):
    # User wording wins; identity is only a fallback for "search about yourself".
    def restore(name):
        original = original_spelling(name, user_text)
        return original if original != name or name in user_text else original_spelling(name, identity)
    restored = restore(subject) if subject else None
    if subject and restored != subject:
        query = query.replace(subject, restored)
    query = re.sub(r"[\u3400-\u9fff]{2,80}", lambda match: restore(match.group()), query)
    return query, restored
