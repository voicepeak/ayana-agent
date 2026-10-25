"""Print the mobile access token used by the phone client."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from services.agent.config import Settings
from services.agent.mobile import load_or_create_token, token_path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", type=Path)
    args = parser.parse_args()
    settings = Settings(data_root=args.data_dir or Path(os.environ.get("AYANA_DATA_DIR", str(ROOT))))
    token = load_or_create_token(settings.data_root)
    print(token)
    print(f"token file: {token_path(settings.data_root)}")


if __name__ == "__main__":
    main()
