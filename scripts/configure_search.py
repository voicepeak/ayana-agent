"""Save a search credential with Windows DPAPI, without printing it."""
from __future__ import annotations

import getpass
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from services.agent.credentials import save_key


def main():
    root = Path(os.environ.get("AYANA_DATA_DIR", str(Path(__file__).resolve().parents[1])))
    if "--installed" in sys.argv:
        root = Path(os.environ["APPDATA"]) / "Ayana"
    key = getpass.getpass("Brave Search API key (hidden): ").strip()
    if not key or len(key) > 1000:
        raise SystemExit("A non-empty key up to 1000 characters is required.")
    save_key(root / ".runtime/search-credentials.dpapi", key)
    print("Search credential encrypted and saved. Refresh Task & Results or restart Ayana.")


if __name__ == "__main__":
    main()
