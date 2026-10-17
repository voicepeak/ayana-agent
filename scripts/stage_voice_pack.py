"""Stage a relocatable Ayana voice pack from a validated local workspace.

The resulting directory can be passed to scripts/package_voice.py. A CUDA pack
must be staged from a venv containing a CUDA build of torch; this script does
not download or replace torch.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PYTHON_URL = "https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip"
PYTHON_MD5 = "6d9aa08531d48fcc261ba667e2df17c4"
PRETRAINED_ITEMS = (
    "chinese-hubert-base",
    "chinese-roberta-wwm-ext-large",
    "fast_langdetect",
    "gsv-v2final-pretrained",
    "sv",
    "s1v3.ckpt",
    "v2Pro/s2Gv2Pro.pth",
    "v2Pro/s2Dv2Pro.pth",
)
SKIP_NAMES = {"__pycache__", ".git", ".github", "docs", "Docker", "GPT_weights_v2Pro", "SoVITS_weights_v2Pro", "refs"}


def fail(message: str):
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def check_file(path: Path, label: str) -> Path:
    if not path.is_file():
        fail(f"missing {label}: {path}")
    return path


def check_dir(path: Path, label: str) -> Path:
    if not path.is_dir():
        fail(f"missing {label}: {path}")
    return path


def check_file_or_dir(path: Path, label: str) -> Path:
    if not path.exists():
        fail(f"missing {label}: {path}")
    return path


def copy_file(source: Path, destination: Path):
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)


def copy_tree(source: Path, destination: Path, ignore=None):
    if destination.exists():
        shutil.rmtree(destination)
    shutil.copytree(source, destination, ignore=ignore)


def ignore_code(directory: str, names: list[str]) -> set[str]:
    return {name for name in names if name in {"__pycache__", "pretrained_models"} or name.endswith((".pyc", ".pyo"))}


def ignore_tools(directory: str, names: list[str]) -> set[str]:
    return {name for name in names if name in {"__pycache__", "uvr5", "asr", "denoise-model"} or name.endswith((".pyc", ".pyo"))}


def source_python(venv: Path) -> Path:
    candidate = venv / "Scripts/python.exe"
    return check_file(candidate, "voice venv Python")


def site_packages(venv: Path) -> Path:
    return check_dir(venv / "Lib/site-packages", "voice venv site-packages")


def prepare_python_archive(cache: Path) -> Path:
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / "python-3.11.9-embed-amd64.zip"
    if not archive.exists():
        print(f"downloading {PYTHON_URL}", flush=True)
        temporary = archive.with_suffix(".download")
        request = urllib.request.Request(PYTHON_URL, headers={"User-Agent": "Ayana-voice-pack-builder/0.1"})
        with urllib.request.urlopen(request, timeout=180) as source, temporary.open("wb") as target:
            shutil.copyfileobj(source, target)
        temporary.replace(archive)
    checksum = hashlib.md5(archive.read_bytes(), usedforsecurity=False).hexdigest()
    if checksum != PYTHON_MD5:
        fail(f"official Python archive checksum mismatch: {checksum}")
    return archive


def stage_runtime(output: Path, venv: Path):
    archive = prepare_python_archive(ROOT / ".runtime/downloads")
    runtime = output / "runtime"
    runtime.mkdir(parents=True)
    with zipfile.ZipFile(archive) as zipped:
        for item in zipped.infolist():
            target = (runtime / item.filename).resolve()
            if not target.is_relative_to(runtime.resolve()):
                fail("invalid path in Python runtime archive")
        zipped.extractall(runtime)
    (runtime / "python311._pth").write_text(
        "python311.zip\n.\nLib/site-packages\nimport site\n", encoding="utf-8")
    ignore = shutil.ignore_patterns("__pycache__", "*.pyc", "*.pyo", "tests", "test", ".cache", "pip", "pip-*", "pytest", "_pytest")
    shutil.copytree(venv / "Lib/site-packages", runtime / "Lib/site-packages", ignore=ignore)


def stage_engine(output: Path, engine: Path):
    destination = output / "engine/GPT-SoVITS"
    destination.mkdir(parents=True)
    for name in ("config.py", "weight.json", "LICENSE", "README.md"):
        source = engine / name
        if source.is_file():
            copy_file(source, destination / name)
    copy_tree(engine / "GPT_SoVITS", destination / "GPT_SoVITS", ignore=ignore_code)
    if (engine / "tools").is_dir():
        copy_tree(engine / "tools", destination / "tools", ignore=ignore_tools)
    pretrained = engine / "GPT_SoVITS/pretrained_models"
    check_dir(pretrained, "GPT-SoVITS pretrained models")
    target_models = destination / "GPT_SoVITS/pretrained_models"
    for item in PRETRAINED_ITEMS:
        source = pretrained / item
        target = target_models / item
        if not source.exists():
            fail(f"missing pretrained model: {source}")
        if source.is_dir():
            copy_tree(source, target)
        else:
            copy_file(source, target)
    return destination


def find_ffmpeg(value: str | None) -> Path:
    if value:
        candidate = Path(value)
        if candidate.is_dir():
            candidate = candidate / "ffmpeg.exe"
        return check_file(candidate, "ffmpeg")
    located = shutil.which("ffmpeg")
    if not located:
        fail("ffmpeg not found; pass --ffmpeg <path to ffmpeg.exe>")
    return Path(located)


def stage_assets(output: Path, args, engine_destination: Path):
    models = output / "models"
    models.mkdir(parents=True)
    copy_file(check_file(args.model_gpt, "GPT checkpoint"), models / args.model_gpt.name)
    copy_file(check_file(args.model_sovits, "SoVITS checkpoint"), models / args.model_sovits.name)
    reference = check_file(args.reference_audio, "reference audio")
    refs = output / "refs"
    refs.mkdir()
    copy_file(reference, refs / reference.name)
    reference_text = args.reference_text
    if reference_text is None:
        text_file = reference.with_suffix(".txt")
        if not text_file.is_file():
            fail(f"reference text missing; pass --reference-text or create {text_file}")
        reference_text = text_file.read_text(encoding="utf-8-sig").strip()
    if not reference_text:
        fail("reference text is empty")
    ffmpeg = find_ffmpeg(args.ffmpeg)
    copy_file(ffmpeg, engine_destination / "ffmpeg.exe")
    nltk = args.nltk_data or (ROOT / ".runtime/nltk_data")
    if nltk and Path(nltk).is_dir():
        copy_tree(Path(nltk), output / "nltk_data")
    else:
        print("warning: nltk_data not staged; English code names may depend on the app's bundled data")
    licenses = output / "licenses"
    licenses.mkdir()
    for source, name in (
        (ROOT / "LICENSE", "ayana-agent-LICENSE"),
        (engine_destination / "LICENSE", "GPT-SoVITS-LICENSE"),
        (args.source_root / "publish/ayana_SoVITS/LICENSE", "ayana_SoVITS-LICENSE"),
        (args.source_root / "publish/ayana_SoVITS/model_card.md", "ayana_SoVITS-model-card.md"),
    ):
        if source.is_file():
            copy_file(source, licenses / name)
    return reference_text


def write_metadata(output: Path, metadata: dict):
    (output / "voice-pack.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def run_runtime(runtime_python: Path, engine: Path, device: str, allow_cpu: bool,
                gpt_path: Path, sovits_path: Path) -> dict:
    environment = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1",
                       TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD="1", HF_HUB_OFFLINE="1",
                       TRANSFORMERS_OFFLINE="1", gpt_path=str(gpt_path), sovits_path=str(sovits_path))
    probe = (
        "import json,sys,torch,librosa,transformers,psutil,pyopenjtalk,gradio;"
        "r={'python':sys.version.split()[0],'torch':torch.__version__,"
        "'cuda_available':bool(torch.cuda.is_available()),"
        "'torch_cuda':torch.version.cuda};"
        "r['device']=torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'cpu';"
        "print(json.dumps(r))"
    )
    check = subprocess.run([str(runtime_python), "-I", "-c", probe], cwd=engine,
                           env=environment, text=True, encoding="utf-8", capture_output=True, timeout=180, errors="replace")
    if check.returncode != 0:
        fail(f"runtime verification failed:\n{check.stdout}\n{check.stderr}")
    result = json.loads(check.stdout.strip().splitlines()[-1])
    if device == "cuda" and result.get("torch_cuda") is None:
        fail("the source venv contains CPU torch; create a CUDA torch venv before staging a CUDA pack")
    if device == "cuda" and not result["cuda_available"] and not allow_cpu:
        fail("this machine cannot see CUDA; use a CUDA torch venv on the target GPU machine, or pass --allow-cpu to stage without GPU verification")
    half = "True" if result["cuda_available"] else "False"
    engine_code = (
        "import json,os,sys;"
        "root=os.getcwd();sys.path[:0]=[root,os.path.join(root,'GPT_SoVITS')];"
        "os.environ['TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD']='1';"
        f"os.environ['is_half']='{half}';"
        "from GPT_SoVITS import inference_webui as upstream;"
        "print(json.dumps({'model_version':upstream.model_version,'device':str(upstream.device)}))"
    )
    engine_check = subprocess.run([str(runtime_python), "-I", "-c", engine_code], cwd=engine,
                                  env=environment, text=True, encoding="utf-8", capture_output=True, timeout=300, errors="replace")
    if engine_check.returncode != 0:
        fail(f"GPT-SoVITS engine verification failed:\n{engine_check.stdout}\n{engine_check.stderr}")
    result["engine"] = json.loads(engine_check.stdout.strip().splitlines()[-1])
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, required=True, help="Existing voice workspace (for example D:/ayana-voice)")
    parser.add_argument("--venv", type=Path, help="Voice venv; defaults to <source-root>/venv")
    parser.add_argument("--engine-root", type=Path, help="GPT-SoVITS checkout; defaults to <source-root>/GPT-SoVITS")
    parser.add_argument("--model-gpt", type=Path, help="Fine-tuned GPT checkpoint")
    parser.add_argument("--model-sovits", type=Path, help="Fine-tuned SoVITS checkpoint")
    parser.add_argument("--reference-audio", type=Path, help="Reference WAV; defaults to the published ref0308.wav")
    parser.add_argument("--reference-text", help="Reference transcript; defaults to the same-name .txt")
    parser.add_argument("--ffmpeg", help="ffmpeg.exe or its directory; defaults to PATH")
    parser.add_argument("--nltk-data", type=Path, help="Local nltk_data directory")
    parser.add_argument("--output", type=Path, help="Staging directory; defaults to .runtime/voice-pack/<id>-<version>-<device>")
    parser.add_argument("--pack-id", default="ayana-v2pro")
    parser.add_argument("--version", default="1.0.0")
    parser.add_argument("--device", choices=("cuda", "cpu"), required=True)
    parser.add_argument("--allow-cpu", action="store_true", help="Stage a CUDA venv even when the build machine has no visible GPU")
    parser.add_argument("--no-verify", action="store_true", help="Skip runtime and engine import checks")
    parser.add_argument("--dry-run", action="store_true", help="Validate inputs and print the plan without copying")
    parser.add_argument("--replace", action="store_true", help="Replace an existing staging directory")
    args = parser.parse_args()

    source = args.source_root.resolve()
    args.source_root = source
    venv = (args.venv or source / "venv").resolve()
    engine = (args.engine_root or source / "GPT-SoVITS").resolve()
    model_gpt = (args.model_gpt or source / "1_models/ayana-gpt-e14.ckpt").resolve()
    model_sovits = (args.model_sovits or source / "1_models/ayana-sovits-e8.pth").resolve()
    reference = (args.reference_audio or source / "publish/ayana_SoVITS/refs/ref0308.wav").resolve()
    args.model_gpt, args.model_sovits, args.reference_audio = model_gpt, model_sovits, reference
    check_dir(source, "source root")
    check_dir(venv, "voice venv")
    check_dir(engine, "GPT-SoVITS engine")
    check_file(source_python(venv), "voice venv Python")
    check_dir(site_packages(venv), "voice venv site-packages")
    check_file(model_gpt, "GPT checkpoint")
    check_file(model_sovits, "SoVITS checkpoint")
    check_file(reference, "reference audio")
    check_file(engine / "GPT_SoVITS/inference_webui.py", "GPT-SoVITS inference entry")
    for item in PRETRAINED_ITEMS:
        check_file_or_dir(engine / "GPT_SoVITS/pretrained_models" / item, f"pretrained model {item}")
    ffmpeg = find_ffmpeg(args.ffmpeg)
    output = (args.output or ROOT / ".runtime/voice-pack" / f"{args.pack_id}-{args.version}-{args.device}").resolve()
    if output.exists() and not args.replace:
        fail(f"output exists: {output} (use --replace)")
    if output == ROOT or len(output.parts) <= 1:
        fail("refusing to replace an unsafe output path")

    print(f"source:   {source}")
    print(f"venv:     {venv}")
    print(f"engine:   {engine}")
    print(f"models:   {model_gpt.name}, {model_sovits.name}")
    print(f"reference:{reference}")
    print(f"ffmpeg:   {ffmpeg}")
    print(f"output:   {output}")
    if args.dry_run:
        print("dry run: inputs are present; no files were copied")
        return

    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)
    stage_runtime(output, venv)
    engine_destination = stage_engine(output, engine)
    reference_text = stage_assets(output, args, engine_destination)
    metadata = {
        "format": 1,
        "pack_id": args.pack_id,
        "version": args.version,
        "model_version": "v2Pro",
        "reference_text": reference_text,
        "runtime": {"kind": args.device},
        "paths": {
            "python": "runtime/python.exe",
            "engine_root": "engine/GPT-SoVITS",
            "model_gpt": f"models/{model_gpt.name}",
            "model_sovits": f"models/{model_sovits.name}",
            "reference_audio": f"refs/{reference.name}",
        },
    }
    if (output / "nltk_data").is_dir():
        metadata["paths"]["nltk_data"] = "nltk_data"
    write_metadata(output, metadata)
    print(f"wrote {output / 'voice-pack.json'}")
    if not args.no_verify:
        result = run_runtime(output / "runtime/python.exe", engine_destination, args.device, args.allow_cpu,
                             output / "models" / model_gpt.name, output / "models" / model_sovits.name)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    print(f"staged: {output}")


if __name__ == "__main__":
    main()

