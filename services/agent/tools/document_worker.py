"""Isolated parser entry point; input arrives only after the parent owns it."""
import json
import sys
import os
from .document_formats import extract_page
from .registry import ToolError


def main():
    if os.name != "nt":
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (768 * 1024 * 1024, 768 * 1024 * 1024))
    try:
        args = json.loads(sys.stdin.read())
        value = extract_page(**args)
    except MemoryError:
        value = {"error": "文档解析需要的内存超过上限，请拆分文档", "code": "document_size"}
    except ToolError as error:
        value = {"error": str(error), "code": error.code}
    except Exception:
        value = {"error": "文档无法解析，可能损坏或使用了不支持的格式", "code": "invalid_document"}
    print(json.dumps(value, ensure_ascii=False))


if __name__ == "__main__":
    main()
