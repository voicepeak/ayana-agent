"""Install the pinned, optional UFO runtime without changing Ayana dependencies."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
COMMIT = "a795552d976c4c019d7c2f778a0effb5cef7de6b"
ARCHIVE_SHA256 = "9e7e3ef6d49800e50416871a97db95f7e9e4e3a7d1303b043ce2ccc89637afac"


def install(home, reuse=False):
    home = home.resolve()
    home.mkdir(parents=True, exist_ok=True)
    if (home / "runtime.json").exists():
        print(f"Already installed: {home}")
        return
    if sys.version_info[:2] != (3, 11):
        raise RuntimeError("Use the project's Python 3.11 to install the pinned UFO runtime")
    archive = ROOT / ".runtime/experiments/ufo2/upstream.zip"
    if not archive.exists():
        archive = home / "upstream.zip"
        if not archive.exists():
            print("Downloading pinned Microsoft UFO source", flush=True)
            url = f"https://codeload.github.com/microsoft/UFO/zip/{COMMIT}"
            with urllib.request.urlopen(url, timeout=90) as response, archive.open("wb") as output:
                shutil.copyfileobj(response, output)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != ARCHIVE_SHA256:
        raise RuntimeError("UFO source archive checksum does not match the tested commit")
    upstream = home / "upstream"
    upstream.mkdir(exist_ok=True)
    with zipfile.ZipFile(archive) as source:
        for item in source.infolist():
            relative = Path(*Path(item.filename).parts[1:])
            if not relative.parts or relative.parts[0] not in {"ufo", "config", "aip", "galaxy", "LICENSE", "NOTICE.md"}:
                continue
            if "__pycache__" in relative.parts or relative.name == "agents.yaml":
                continue
            target = (upstream / relative).resolve()
            if not target.is_relative_to(upstream.resolve()):
                raise RuntimeError("Invalid path in UFO archive")
            if item.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(source.read(item))
    packages = home / "site-packages"
    tested = ROOT / ".runtime/experiments/ufo2/venv/Lib/site-packages"
    if reuse:
        if not tested.is_dir():
            raise RuntimeError("The tested experiment environment does not exist")
        print("Copying tested dependencies into the independent runtime", flush=True)
        shutil.copytree(tested, packages, dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.pyo", "pip", "pip-*.dist-info", "tests", "test"))
    else:
        print("Installing pinned runtime dependencies from PyPI", flush=True)
        subprocess.run([sys.executable, "-m", "pip", "install", "--target", str(packages),
                        "--index-url", "https://pypi.org/simple", "-r", str(ROOT / "requirements/ufo2.txt")], check=True)
    # A child worker adds these packages itself; verify the isolated imports now.
    code = "import sys,site; sys.path.insert(0,sys.argv[1]); site.addsitedir(sys.argv[1]); import pywinauto,fastmcp,openai,yaml,PIL"
    subprocess.run([sys.executable, "-I", "-c", code, str(packages)], check=True)
    manifest = {"commit": COMMIT, "archive_sha256": ARCHIVE_SHA256, "python_minor": [3, 11],
                "repository": "https://github.com/microsoft/UFO", "format": 1}
    (home / "runtime.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"Computer use ready: {home}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--home", type=Path, default=ROOT / ".runtime/computer-use/ufo2")
    parser.add_argument("--reuse-experiment", action="store_true", help="Copy this machine's previously tested dependency environment")
    options = parser.parse_args()
    install(options.home, options.reuse_experiment)
