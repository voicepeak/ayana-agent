"""Stage an independent Windows Python/backend runtime for Electron packaging.

Downloads the official Python 3.11.9 AMD64 embeddable distribution, validated
against the published checksum at https://www.python.org/downloads/release/python-3119/.
Run after installing project dependencies into .venv; staged config contains
only defaults. Personal settings, credentials, history and voice weights stay
outside the executable.
"""

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
PYTHON_URL = "https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip"
PYTHON_MD5 = "6d9aa08531d48fcc261ba667e2df17c4"
NLTK_PACKAGES = {
    "corpora/cmudict": "d07cca47fd72ad32ea9d8ad1219f85301eeaf4568f8b6b73747506a71fb5afd6",
    "taggers/averaged_perceptron_tagger": "e1f13cf2532daadfd6f3bc481a49859f0b8ea6432ccdcd83e6a49a5f19008de9",
    "taggers/averaged_perceptron_tagger_eng": "6025f530624335c67d6547d44757b357b4e79bae030a0383e9887a92c1718f0b",
}


def prepare_nltk():
    """English code names in Japanese speech need the local G2P corpus/tagger."""
    destination = ROOT / ".runtime/nltk_data"
    for resource, checksum in NLTK_PACKAGES.items():
        archive = destination / (resource + ".zip")
        archive.parent.mkdir(parents=True, exist_ok=True)
        url = f"https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/packages/{resource}.zip"
        valid_cache = archive.exists() and hashlib.sha256(archive.read_bytes()).hexdigest() == checksum
        if not valid_cache:
            print(f"Downloading English pronunciation resource: {resource}", flush=True)
            request = urllib.request.Request(url, headers={"User-Agent": "Ayana-package-builder/0.1"})
            with urllib.request.urlopen(request, timeout=90) as source:
                payload = source.read()
            if hashlib.sha256(payload).hexdigest() != checksum:
                raise ValueError(f"NLTK resource checksum mismatch: {resource}")
            temporary = archive.with_suffix(".download")
            temporary.write_bytes(payload)
            temporary.replace(archive)
        with zipfile.ZipFile(archive) as zipped:
            for item in zipped.infolist():
                if not (archive.parent / item.filename).resolve().is_relative_to(archive.parent.resolve()):
                    raise ValueError("Invalid path in NLTK archive")
            zipped.extractall(archive.parent)
    return destination


def excluded(directory: str, names: list[str]) -> set[str]:
    return {name for name in names if (
        name in {"__pycache__", ".pytest_cache", "tests", "test", ".cache"}
        or name.endswith((".pyc", ".pyo", ".egg-link"))
        or name.startswith(("__editable__", "pytest-", "pip-"))
        or name in {"pip", "_pytest", "pytest"}
        or (name.startswith("ayana_agent-") and name.endswith(".dist-info"))
    )}


def reset_stage(path: Path):
    # Only rebuild these two derived outputs. Resolve and verify before delete.
    resolved = path.resolve()
    runtime = (ROOT / ".runtime").resolve()
    if not runtime.is_relative_to(ROOT.resolve()) or resolved.parent != runtime or resolved.name not in {"python", "backend"}:
        raise ValueError(f"Refusing to replace a path outside the package staging area: {resolved}")
    if resolved.exists():
        shutil.rmtree(resolved)
    resolved.mkdir(parents=True)


def stage(args):
    runtime = ROOT / ".runtime"
    runtime.mkdir(exist_ok=True)
    site_packages = ROOT / ".venv/Lib/site-packages"
    if not site_packages.is_dir():
        raise FileNotFoundError("Create .venv and install project dependencies before packaging")
    nltk_data = prepare_nltk()
    cache = runtime / "downloads"
    cache.mkdir(exist_ok=True)
    archive = cache / "python-3.11.9-embed-amd64.zip"
    if not archive.exists():
        temporary = archive.with_suffix(".download")
        print(f"Downloading official Python runtime: {PYTHON_URL}", flush=True)
        request = urllib.request.Request(PYTHON_URL, headers={"User-Agent": "Ayana-package-builder/0.1"})
        with urllib.request.urlopen(request, timeout=120) as source, temporary.open("wb") as target:
            shutil.copyfileobj(source, target)
        temporary.replace(archive)
    checksum = hashlib.md5(archive.read_bytes(), usedforsecurity=False).hexdigest()
    if checksum != PYTHON_MD5:
        raise ValueError(f"Official Python archive checksum mismatch: {checksum}")
    python_root, backend_root = runtime / "python", runtime / "backend"
    reset_stage(python_root)
    reset_stage(backend_root)
    with zipfile.ZipFile(archive) as zipped:
        for item in zipped.infolist():
            target = (python_root / item.filename).resolve()
            if not target.is_relative_to(python_root.resolve()):
                raise ValueError("Invalid path in Python runtime archive")
        zipped.extractall(python_root)
    (python_root / "python311._pth").write_text(
        "python311.zip\n.\nLib/site-packages\n../backend\nimport site\n", encoding="utf-8")
    shutil.copytree(site_packages, python_root / "Lib/site-packages", ignore=excluded)
    for name in ("services", "native", "packages", "characters"):
        source = ROOT / name
        if source.is_dir():
            shutil.copytree(source, backend_root / name, ignore=excluded)
    config_root = backend_root / "config"
    config_root.mkdir()
    shutil.copy2(ROOT / "config/default.json", config_root / "default.json")
    # The example contains placeholders rather than this PC's paths.
    example = ROOT / "config/voice.example.json"
    if example.exists():
        shutil.copy2(example, config_root / example.name)
    registry = json.loads((ROOT / "characters/registry.json").read_text(encoding="utf-8"))
    for character, entry in registry["characters"].items():
        avatar_destination = backend_root / entry["avatar_root"]
        avatar_destination.mkdir(parents=True, exist_ok=True)
        mapping = json.loads((ROOT / entry["map"]).read_text(encoding="utf-8"))
        for filename in {item["file"] for item in mapping["assets"].values()}:
            image = ROOT / entry["avatar_root"] / filename
            if not image.is_file():
                raise FileNotFoundError(f"Import character resources before packaging ({character}): {image}")
            shutil.copy2(image, avatar_destination / image.name)
    model_source = ROOT / ".runtime/models/stt/tiny"
    stt_staged = not args.without_stt_model and (model_source / "model.bin").is_file()
    if stt_staged:
        shutil.copytree(model_source, backend_root / "models/stt/tiny", ignore=excluded)
    shutil.copytree(nltk_data, backend_root / "nltk_data", ignore=excluded)
    for name in ("LICENSE", "README.md"):
        if (ROOT / name).is_file():
            shutil.copy2(ROOT / name, backend_root / name)
    # Fail packaging if an accidental local file escaped the allowlist.
    forbidden = {"local.json", "credentials.dpapi", "history.sqlite3", ".env"}
    for path in backend_root.rglob("*"):
        if path.name in forbidden or path.name.endswith(".local.json") or path.suffix in {".ckpt", ".pth"}:
            raise ValueError(f"Personal state or external weights in packaged backend: {path}")
    imports = ["fastapi", "uvicorn", "httpx", "PIL", "websockets", "comtypes", "pypdf", "services.agent.server", "native.windows.desktop",
               "services.agent.capabilities", "services.agent.tools.files", "services.agent.tools.web", "services.agent.tools.system", "native.windows.shell", "services.agent.tasks"]
    imports.extend(["services.agent.tools.documents", "services.agent.tools.document_worker", "services.agent.tools.processes", "services.agent.tools.browser"])
    browser_staged = (python_root / "Lib/site-packages/playwright").is_dir()
    if browser_staged:
        imports.append("playwright.async_api")
        if not (python_root / "Lib/site-packages/playwright/driver/node.exe").is_file():
            raise FileNotFoundError("Playwright's browser driver was not included; reinstall .[browser] before packaging")
    if (python_root / "Lib/site-packages/faster_whisper").is_dir():
        imports.extend(["faster_whisper", "ctranslate2", "av", "services.agent.providers.stt"])
    code = "import importlib,json,sys; modules=" + repr(imports) + "; [importlib.import_module(name) for name in modules]; print(json.dumps({'version':sys.version,'executable':sys.executable,'modules':modules,'paths':sys.path}))"
    verification = subprocess.check_output([str(python_root / "python.exe"), "-I", "-c", code],
                                           cwd=backend_root, text=True, encoding="utf-8", timeout=90)
    result = {"python_url": PYTHON_URL, "python_archive_md5": checksum,
              "python": str(python_root), "backend": str(backend_root),
              "stt_model_included": stt_staged, "verification": json.loads(verification),
              "browser_component_included": browser_staged,
              "backend_bytes": sum(p.stat().st_size for p in backend_root.rglob("*") if p.is_file()),
              "python_bytes": sum(p.stat().st_size for p in python_root.rglob("*") if p.is_file())}
    (runtime / "package-backend-report.json").write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(result, indent=2, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--without-stt-model", action="store_true")
    parser.add_argument("--nltk-only", action="store_true", help="Prepare the small English pronunciation resources only")
    args = parser.parse_args()
    prepare_nltk() if args.nltk_only else stage(args)
