"""Version-bound authenticated read cursors; never grant access to a path."""
import base64
import hashlib
import hmac
import json
import secrets
import time
from .registry import ToolError


def version(path):
    stat = path.stat()
    return [stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns]


def context(policy, root_id, path):
    target = policy.resolve(root_id, path, allow_root=True)
    return {"root_id": root_id, "path": path, "resolved": str(target), "full_access": policy.full_access}


def key(policy):
    if not hasattr(policy, "_read_cursor_key"):
        policy._read_cursor_key = secrets.token_bytes(32)
    return policy._read_cursor_key


def encode(policy, payload):
    raw = json.dumps({**payload, "expires": time.time() + 600}, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(hmac.new(key(policy), raw, hashlib.sha256).digest() + raw).decode()


def decode(policy, token, expected):
    try:
        if not isinstance(token, str) or len(token) > 12000:
            raise ValueError()
        raw = base64.b64decode(token, altchars=b"-_", validate=True)
        if not hmac.compare_digest(raw[:32], hmac.new(key(policy), raw[32:], hashlib.sha256).digest()):
            raise ValueError()
        data = json.loads(raw[32:])
        if data["expires"] < time.time() or data["context"] != expected:
            raise ValueError()
        return data
    except (ValueError, KeyError, TypeError):
        raise ToolError("stale_cursor", "续读记录已过期或读取范围改变，请重新读取") from None
