import argparse
import json
from pathlib import Path
import secrets

import uvicorn

from .reader import MonitorReader
from .server import create_app


def main():
    parser = argparse.ArgumentParser(description="Local read-only mobile monitor; does not restart gateway or TTS")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--port", type=int, default=17340)
    args = parser.parse_args()
    root = args.root.resolve()
    services = root / ".runtime/mobile-services"
    gateway = json.loads((services / "gateway.json").read_text(encoding="utf-8-sig"))
    worker = json.loads((services / "worker.json").read_text(encoding="utf-8-sig"))
    def absolute(value):
        path = Path(value)
        return path if path.is_absolute() else root / path
    private = root / ".runtime/mobile-monitor"
    private.mkdir(parents=True, exist_ok=True)
    token_file = private / "admin-token.txt"
    if not token_file.exists():
        token_file.write_text(secrets.token_urlsafe(36), encoding="ascii")
    token = token_file.read_text(encoding="ascii").strip()
    labels = {"owner": "本机管理员"}
    for file, label in [("ios-tester-user.txt", "测试者 01 · iPhone"), ("android-tester-2-user.txt", "测试者 02 · Android")]:
        identity = services / file
        if identity.is_file():
            labels[identity.read_text(encoding="ascii").strip()] = label
    labels_file = private / "labels.json"
    if labels_file.exists():
        labels.update(json.loads(labels_file.read_text(encoding="utf-8-sig")))
    url = f"http://127.0.0.1:{args.port}/"
    (private / "login-url.txt").write_text(url + "#token=" + token, encoding="ascii")
    (private / "面板登录信息.txt").write_text(
        "Ayana 本机只读监控面板\n\n地址：" + url + "\n管理员口令：" + token +
        "\n\n口令仅用于本机面板，请勿发给测试者。\n完整登录链接保存在同目录 login-url.txt。\n", encoding="utf-8")
    reader = MonitorReader(absolute(worker["data_dir"]) / "dialogue.sqlite3", absolute(gateway["data_dir"]) / "gateway.sqlite3", labels)
    uvicorn.run(create_app(reader, token), host="127.0.0.1", port=args.port, access_log=False, log_level="warning")


if __name__ == "__main__":
    main()
