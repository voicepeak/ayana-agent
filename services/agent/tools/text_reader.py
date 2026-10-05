"""UTF-8 text pagination with bounded output and version-bound seek cookies."""
import hashlib
import time
from .cursors import context, decode, encode, version
from .registry import ToolError

READ_LIMIT = 65536
SCAN_SECONDS = 3
FRAGMENT_CHARS = 16000


def read_piece(source, limit):
    piece = source.readline(limit)
    if piece.endswith("\r"):
        cookie = source.tell()
        following = source.read(1)
        if following == "\n":
            piece += following
        else:
            source.seek(cookie)
    return piece


def read_text(policy, root_id, path, start_line=None, max_lines=None, cursor=None):
    target = policy.path(root_id, path)
    if not target.is_file():
        raise ToolError("file_missing", "目标文本文件不存在")
    before = version(target)
    binding = context(policy, root_id, path)
    ranged = start_line is not None or max_lines is not None or cursor is not None
    raw, valid_utf8 = None, True
    if before[2] <= READ_LIMIT:
        with target.open("rb") as source:
            raw = source.read(READ_LIMIT + 1)
        if len(raw) > READ_LIMIT or version(target) != before:
            raise ToolError("file_conflict", "读取期间文件改变，请重新读取")
        if b"\0" in raw:
            raise ToolError("unsupported_file", "目标不是文本文件")
        try:
            whole_text = raw.decode("utf-8")
        except UnicodeDecodeError:
            valid_utf8 = False
            if not ranged:
                raise ToolError("unsupported_encoding", "文件不是 UTF-8，原文件保持不变") from None
            whole_text = raw.decode("utf-8", errors="replace")
        if not ranged:
            return {"root_id": root_id, "path": path, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(),
                    "content": whole_text, "line_count": len(whole_text.splitlines()), "line_count_is_complete": True,
                    "complete": True, "truncated": False, "next_cursor": None}
    start_line = 1 if start_line is None else start_line
    max_lines = 160 if max_lines is None else max_lines
    if type(start_line) is not int or start_line < 1 or type(max_lines) is not int or not 1 <= max_lines <= 200:
        raise ToolError("invalid_arguments", "读取行号必须为正整数，最多读取 200 行")
    if cursor:
        data = decode(policy, cursor, binding)
        if data["version"] != before:
            raise ToolError("file_conflict", "文件已改变，请重新读取，不能沿用旧游标")
        offset, line, column, requested = (data[k] for k in ("offset", "line", "column", "requested"))
    else:
        offset, line, column, requested = 0, 1, 0, start_line
    pieces, output_size, count, scanned = [], 0, 0, 0
    deadline = time.monotonic() + SCAN_SECONDS
    first_line, first_column = None, None
    with target.open("r", encoding="utf-8", errors="replace", newline="") as source:
        source.seek(offset)
        while count < max_lines and time.monotonic() < deadline and scanned < 8 * 1024 * 1024:
            # TextIO cookies preserve decoder and CRLF state. Bound characters
            # so multibyte text remains within the byte output limit.
            piece = read_piece(source, min(FRAGMENT_CHARS, (READ_LIMIT - output_size) // 4))
            if not piece:
                break
            scanned += len(piece)
            if "\0" in piece:
                raise ToolError("unsupported_file", "目标不是文本文件")
            ending = piece.endswith(("\n", "\r"))
            if line >= requested:
                if first_line is None:
                    first_line, first_column = line, column
                pieces.append(piece)
                output_size += len(piece.encode("utf-8"))
                count += int(ending)
            if ending:
                line, column = line + 1, 0
            else:
                column += len(piece)
            if output_size > READ_LIMIT - 4:
                break
        offset = source.tell()
        more = bool(source.read(1))
    if version(target) != before:
        raise ToolError("file_conflict", "读取期间文件改变，请重新读取")
    content = "".join(pieces)
    if content.endswith("\r\n"):
        content = content[:-2]
    elif content.endswith(("\r", "\n")):
        content = content[:-1]
    complete = bool(raw is not None and valid_utf8 and not cursor and requested == 1 and not more)
    if complete:
        content = whole_text
    next_cursor = encode(policy, {"context": binding, "version": before, "offset": offset,
                         "line": line, "column": column, "requested": requested}) if more else None
    return {"root_id": root_id, "path": path, "bytes": before[2],
            "sha256": hashlib.sha256(raw).hexdigest() if raw is not None and valid_utf8 else None,
            "content": content, "start_line": first_line or requested, "start_column": first_column or 0,
            "line_count": len(whole_text.splitlines()) if raw is not None else line - int(column == 0),
            "line_count_is_complete": raw is not None or not more, "complete": complete,
            "truncated": more, "next_cursor": next_cursor, "ends_mid_line": bool(column and more),
            "scanned_through_line": line, "truncation_reason": "page_limit" if pieces and more else "scan_budget" if more else None}
