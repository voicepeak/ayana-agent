"""Save a search credential with Windows DPAPI, without printing it."""
from __future__ import annotations

import argparse
import getpass
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from services.agent.credentials import save_key
from services.agent.config import Settings


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--installed", action="store_true")
    parser.add_argument("--proxy", help="Local HTTP proxy, for example http://127.0.0.1:7892; empty string disables it")
    args = parser.parse_args()
    root = Path(os.environ.get("AYANA_DATA_DIR", str(Path(__file__).resolve().parents[1])))
    if args.installed:
        root = Path(os.environ["APPDATA"]) / "Ayana"
    settings = Settings(data_root=root)
    if args.proxy is not None:
        settings.update({"search_proxy": args.proxy})
    key = getpass.getpass("Brave Search API key (hidden): ").strip()
    if not key or len(key) > 1000:
        raise SystemExit("A non-empty key up to 1000 characters is required.")
    save_key(root / ".runtime/search-credentials.dpapi", key)
    print("Search credential encrypted and saved. Refresh Task & Results or restart Ayana.")


if __name__ == "__main__":
    main()
