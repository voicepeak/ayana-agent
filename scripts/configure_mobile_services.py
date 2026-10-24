"""Provision isolated local gateway/worker configs; never print provider credentials."""
from __future__ import annotations

import argparse
import base64
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from services.gateway.store import Store
from services.agent.credentials import load_key, save_key


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", type=Path, default=ROOT / ".runtime/mobile-services")
    parser.add_argument("--profile", type=Path, default=ROOT / "config/local.json")
    parser.add_argument("--gateway-url", default="")
    args = parser.parse_args()
    directory = args.directory.resolve()
    directory.mkdir(parents=True, exist_ok=True)
    profile = json.loads(args.profile.read_text(encoding="utf-8"))
    if not args.gateway_url:
        address = ""
        if os.name == "nt":
            command = "Get-NetAdapter -Physical | Where-Object Status -eq 'Up' | ForEach-Object { Get-NetIPConfiguration -InterfaceIndex $_.ifIndex } | Where-Object IPv4DefaultGateway | ForEach-Object { $_.IPv4Address.IPAddress } | ConvertTo-Json -Compress"
            result = subprocess.run(["powershell", "-NoProfile", "-Command", command],
                capture_output=True, text=True, creationflags=0x08000000, timeout=20)
            addresses = json.loads(result.stdout or "[]")
            if isinstance(addresses, str):
                addresses = [addresses]
            address = next((value for value in addresses if value.startswith(("192.168.", "10.", "172."))), "")
        if not address:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                sock.connect(("8.8.8.8", 80))
                address = sock.getsockname()[0]
        args.gateway_url = f"http://{address}:17330"
    key_path = directory / "deepseek.dpapi"
    source_key = os.environ.get("AYANA_GATEWAY_API_KEY") or os.environ.get("DEEPSEEK_API_KEY")
    if not source_key and profile.get("base_url", "").rstrip("/") in {"https://api.deepseek.com", "https://api.deepseek.com/v1"}:
        source_key = load_key(args.profile.parent.parent / ".runtime/credentials.dpapi")
    if source_key:
        save_key(key_path, source_key)
    previous = directory / "gateway.json"
    existing = json.loads(previous.read_text(encoding="utf-8")) if previous.exists() else {}
    worker_token = existing.get("worker_token") or secrets.token_urlsafe(40)
    config = {"data_dir": str(directory / "gateway"), "api_key_file": str(key_path),
              "base_url": "https://api.deepseek.com", "model": profile.get("model") or "deepseek-flash",
              "worker_token": worker_token, "voice_id": profile.get("character", "ayana"),
              "origins": [], "mobile_root": str(ROOT / "apps/mobile/dist")}
    store = Store(Path(config["data_dir"]) / "gateway.sqlite3")
    activation_file = directory / "activation-code.txt"
    if activation_file.exists():
        encoded = activation_file.read_text(encoding="ascii").strip().removeprefix("ayana1.")
        activation_key = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))["key"]
    else:
        activation_key = store.add_user("owner")
    store.close()
    code = "ayana1." + base64.urlsafe_b64encode(json.dumps({"url": args.gateway_url,
        "key": activation_key}, separators=(",", ":")).encode()).decode().rstrip("=")
    activation_file.write_text(code, encoding="ascii")
    previous.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
    worker = {"gateway": "http://127.0.0.1:17330", "worker_token": worker_token,
              "data_dir": str(directory / "worker"), "voice_id": config["voice_id"], "voice": profile["voice"]}
    if worker["voice"].get("voice_mode") != "sovits":
        raise ValueError("The selected profile must have a configured SoVITS voice")
    (directory / "worker.json").write_text(json.dumps(worker, ensure_ascii=False, indent=2), encoding="utf-8")
    print("Gateway URL:", args.gateway_url)
    print("Activation code file:", activation_file)
    print("Provider credentials configured:", bool(source_key or key_path.exists()))
    print("Configs ready. Credentials were not printed.")


if __name__ == "__main__":
    main()
