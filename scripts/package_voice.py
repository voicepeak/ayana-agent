"""Package a prepared Ayana voice runtime and update its download manifest.

The pack root must already contain a relocatable Python runtime, the
GPT-SoVITS engine, model weights, references and a voice-pack.json file. This
script validates that layout, writes a ZIP64 archive and records its SHA256 and
size in a release manifest.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import zipfile

REQUIRED_PATHS = ("python", "engine_root", "model_gpt", "model_sovits", "reference_audio")
DIRECTORY_KEYS = {"engine_root", "source_root", "nltk_data"}
SKIP_DIRECTORIES = {"__pycache__", ".git", ".pytest_cache"}


def fail(message: str):
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def resolved_relative(root: Path, value: str) -> Path:
    if not isinstance(value, str) or not value.strip():
        fail("voice-pack.json contains an empty path")
    target = (root / value).resolve()
    if not target.is_relative_to(root.resolve()):
        fail(f"path escapes the pack root: {value}")
    return target


def load_metadata(root: Path) -> dict:
    file = root / "voice-pack.json"
    if not file.is_file():
        fail(f"missing {file}")
    try:
        metadata = json.loads(file.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"cannot read voice-pack.json: {error}")
    if metadata.get("format") != 1:
        fail("voice-pack.json format must be 1")
    for key in ("pack_id", "version"):
        if not isinstance(metadata.get(key), str) or not metadata[key].strip():
            fail(f"voice-pack.json is missing {key}")
    paths = metadata.get("paths")
    if not isinstance(paths, dict):
        fail("voice-pack.json is missing paths")
    for key in REQUIRED_PATHS:
        if key not in paths:
            fail(f"voice-pack.json is missing paths.{key}")
    runtime = metadata.get("runtime")
    if runtime is not None:
        if not isinstance(runtime, dict) or runtime.get("kind") not in {"cuda", "cpu"}:
            fail("voice-pack.json runtime.kind must be cuda or cpu")
    return metadata


def validate_layout(root: Path, metadata: dict):
    paths = metadata["paths"]
    for key, value in paths.items():
        if key not in REQUIRED_PATHS and key not in {"source_root", "nltk_data"}:
            fail(f"voice-pack.json contains an unknown paths.{key}")
        target = resolved_relative(root, value)
        if key in DIRECTORY_KEYS:
            if not target.is_dir():
                fail(f"missing directory paths.{key}: {value}")
        elif not target.is_file():
            fail(f"missing file paths.{key}: {value}")
        elif target.stat().st_size <= 0:
            fail(f"empty file paths.{key}: {value}")
    engine = resolved_relative(root, paths["engine_root"])
    if not (engine / "GPT_SoVITS" / "inference_webui.py").is_file():
        fail("engine_root does not contain GPT_SoVITS/inference_webui.py")
    reference = resolved_relative(root, paths["reference_audio"])
    if not metadata.get("reference_text") and not reference.with_suffix(".txt").is_file():
        fail("provide reference_text or a same-name .txt next to reference_audio")


def write_archive(root: Path, output: Path, replace: bool):
    if output.exists() and not replace:
        fail(f"output already exists: {output} (use --replace)")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    if temporary.exists():
        temporary.unlink()
    count = 0
    total = 0
    with zipfile.ZipFile(temporary, "w", zipfile.ZIP_STORED, allowZip64=True) as archive:
        for item in sorted(root.rglob("*")):
            relative = item.relative_to(root)
            if any(part in SKIP_DIRECTORIES for part in relative.parts):
                continue
            if item.is_dir():
                continue
            archive.write(item, relative.as_posix())
            count += 1
            total += item.stat().st_size
            if count % 1000 == 0:
                print(f"packed {count} files, {total / (1024 ** 3):.2f} GB", flush=True)
    os.replace(temporary, output)
    print(f"archive: {output} ({count} files, {total / (1024 ** 3):.2f} GB before compression)")


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def update_manifest(path: Path, metadata: dict, variant: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        try:
            manifest = json.loads(path.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError) as error:
            fail(f"cannot read manifest {path}: {error}")
        if manifest.get("format") != 1:
            fail("manifest format must be 1")
        if manifest.get("pack_id") != metadata["pack_id"] or manifest.get("version") != metadata["version"]:
            fail("manifest pack_id/version does not match voice-pack.json")
    else:
        manifest = {"format": 1, "pack_id": metadata["pack_id"], "version": metadata["version"], "variants": []}
    variants = [item for item in manifest.get("variants", []) if item.get("id") != variant["id"]]
    variants.append(variant)
    variants.sort(key=lambda item: item["id"])
    manifest["variants"] = variants
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)
    print(f"manifest: {path}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pack-root", type=Path, required=True, help="Prepared voice pack directory")
    parser.add_argument("--output", type=Path, required=True, help="Output .zip archive")
    parser.add_argument("--manifest", type=Path, required=True, help="Release manifest JSON to create or update")
    parser.add_argument("--url", required=True, help="Public URL of the output archive")
    parser.add_argument("--variant-id", required=True, help="Variant id, for example cu124 or cpu")
    parser.add_argument("--kind", choices=("cuda", "cpu"), required=True)
    parser.add_argument("--min-driver")
    parser.add_argument("--min-vram-mb", type=int)
    parser.add_argument("--compute-capability", action="append", default=[])
    parser.add_argument("--replace", action="store_true", help="Replace an existing output archive")
    args = parser.parse_args()

    root = args.pack_root.resolve()
    if not root.is_dir():
        fail(f"pack root does not exist: {root}")
    metadata = load_metadata(root)
    validate_layout(root, metadata)
    runtime_kind = (metadata.get("runtime") or {}).get("kind")
    if runtime_kind and runtime_kind != args.kind:
        fail(f"voice-pack.json runtime.kind is {runtime_kind}, but --kind is {args.kind}")
    write_archive(root, args.output, args.replace)
    variant = {
        "id": args.variant_id,
        "kind": args.kind,
        "url": args.url,
        "sha256": digest(args.output),
        "size": args.output.stat().st_size,
    }
    if args.min_driver:
        variant["min_driver"] = args.min_driver
    if args.min_vram_mb:
        variant["min_vram_mb"] = args.min_vram_mb
    if args.compute_capability:
        variant["compute_capabilities"] = args.compute_capability
    update_manifest(args.manifest, metadata, variant)
    print(json.dumps(variant, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

