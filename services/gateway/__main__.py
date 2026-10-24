from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import uvicorn

from .server import create_app


def main():
    parser = argparse.ArgumentParser(description="Independent Ayana mobile gateway")
    parser.add_argument("--config", type=Path, default=Path(".runtime/mobile-services/gateway.json"))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=17330)
    args = parser.parse_args()
    config = json.loads(args.config.read_text(encoding="utf-8"))
    config["api_key"] = os.environ.get("AYANA_GATEWAY_API_KEY", "")
    key_file = config.pop("api_key_file", "")
    if not config["api_key"] and key_file:
        # DPAPI helper only; does not instantiate Settings or any Agent runtime.
        from services.agent.credentials import load_key
        config["api_key"] = load_key(Path(key_file))
    uvicorn.run(create_app(config), host=args.host, port=args.port, access_log=False,
                ws_max_size=17 * 1024 * 1024, log_level="warning")


if __name__ == "__main__":
    main()
