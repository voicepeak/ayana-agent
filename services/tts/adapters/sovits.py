"""GPT-SoVITS v2/v2Pro with explicit weight loading and cached reference state.

This reproduces the v2Pro inference path in the locally validated upstream
inference_webui.py (48b1a0169a28582a8984402f82cf438d3bfa6aca). The upstream
WebUI globals and cwd changes remain confined to the TTS subprocess.
"""

from __future__ import annotations

import inspect
import os
from pathlib import Path
import subprocess
import sys
import threading
import time

from services.tts.audio import condition_pcm, encode_pcm, split_sentences
from services.tts.semantics import infer_semantics


def exhaust_loader(result):
    """Some upstream loaders are generators; calling them does not load weights."""
    if inspect.isgenerator(result):
        for _ in result:
            pass


class SynthesisCancelled(Exception):
    pass


class SovitsEngine:
    name = "gpt-sovits-ayana"

    def __init__(self, config: dict):
        self.config = config
        self.metadata: dict = {}
        self.reference_cache_builds = 0

    def prepare(self):
        config = self.config
        root = Path(config["engine_root"]).expanduser().resolve()
        source = Path(config.get("source_root") or root).expanduser().resolve()
        paths = {
            "model_gpt": Path(config["model_gpt"]).expanduser().resolve(),
            "model_sovits": Path(config["model_sovits"]).expanduser().resolve(),
            "reference_audio": Path(config["reference_audio"]).expanduser().resolve(),
        }
        if not (root / "GPT_SoVITS" / "inference_webui.py").is_file():
            raise FileNotFoundError(f"GPT-SoVITS engine not found: {root}")
        for name, path in paths.items():
            if not path.is_file():
                raise FileNotFoundError(f"{name} not found: {path}")
        os.environ["TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD"] = "1"
        os.environ["is_half"] = "False"
        os.environ["gpt_path"] = str(paths["model_gpt"])
        os.environ["sovits_path"] = str(paths["model_sovits"])
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        os.environ["AYANA_GSV_ROOT"] = str(root)
        application_root = Path(__file__).resolve().parents[3]
        nltk_candidates = [
            config.get("nltk_data"),
            os.environ.get("NLTK_DATA"),
            application_root / "nltk_data",
            application_root / ".runtime/nltk_data",
            root / "nltk_data",
        ]
        nltk_data = next((Path(candidate).expanduser().resolve() for candidate in nltk_candidates
                          if candidate and Path(candidate).expanduser().is_dir()), None)
        if nltk_data is not None:
            # Configure before importing English G2P. NLTK's default Windows
            # profile path can be decoded incorrectly for non-ASCII usernames.
            os.environ["NLTK_DATA"] = str(nltk_data)
        if config.get("device", "cpu") == "cpu":
            os.environ["CUDA_VISIBLE_DEVICES"] = ""
            os.environ.pop("_CUDA_VISIBLE_DEVICES", None)
        sys.path[:0] = [str(root), str(root / "GPT_SoVITS"), str(source / "src")]
        os.chdir(root)
        import torch

        torch.set_num_threads(max(1, int(config.get("cpu_threads", 8))))
        torch.set_num_interop_threads(1)
        from GPT_SoVITS import inference_webui as upstream

        self.upstream = upstream
        self.torch = torch
        # The WebUI sets HIGH priority on import; restore ordinary scheduling.
        if os.name == "nt":
            import psutil
            psutil.Process().nice(psutil.NORMAL_PRIORITY_CLASS)
        language = upstream.i18n("日文")
        # Supplying both languages also avoids an upstream unbound UI-update
        # local when the SoVITS generator reaches its final yield.
        exhaust_loader(upstream.change_sovits_weights(
            str(paths["model_sovits"]), language, language))
        exhaust_loader(upstream.change_gpt_weights(str(paths["model_gpt"])))
        if upstream.model_version not in {"v1", "v2", "v2Pro", "v2ProPlus"}:
            raise ValueError(f"Unsupported cached inference version: {upstream.model_version}")
        self.language = upstream.dict_language[language]
        self.reference_path = paths["reference_audio"]
        self.reference_text = config.get("reference_text", "").strip()
        if not self.reference_text:
            reference_text_path = self.reference_path.with_suffix(".txt")
            self.reference_text = reference_text_path.read_text(encoding="utf-8").strip()
        if self.reference_text[-1] not in upstream.splits:
            self.reference_text += "。"
        self.sample_rate = int(upstream.hps.data.sampling_rate)
        if self.sample_rate != 32000:
            raise ValueError(f"Expected v2Pro 32000Hz, got {self.sample_rate}")
        cache_started = time.perf_counter()
        with torch.inference_mode():
            wav, _ = upstream.librosa.load(str(self.reference_path), sr=16000)
            if not 48000 <= wav.size <= 160000:
                raise ValueError("Reference audio must be 3–10 seconds")
            reference = torch.from_numpy(wav).to(upstream.device, dtype=upstream.dtype)
            # Preserve the upstream reference-conditioning padding exactly.
            reference = torch.cat([reference, torch.zeros(
                int(self.sample_rate * 0.3), device=upstream.device, dtype=upstream.dtype)])
            ssl = upstream.ssl_model.model(reference.unsqueeze(0))["last_hidden_state"].transpose(1, 2)
            self.prompt = upstream.vq_model.extract_latent(ssl)[0, 0].unsqueeze(0)
            self.reference_phones, self.reference_bert, _ = upstream.get_phones_and_bert(
                self.reference_text, self.language, upstream.version)
            pro = upstream.model_version in {"v2Pro", "v2ProPlus"}
            spec, ref_audio = upstream.get_spepc(
                upstream.hps, str(self.reference_path), upstream.dtype, upstream.device, pro)
            self.reference_specs = [spec]
            self.speaker_embedding = None
            if pro:
                if upstream.sv_cn_model is None:
                    upstream.init_sv_cn()
                self.speaker_embedding = [upstream.sv_cn_model.compute_embedding3(ref_audio)]
        self.reference_cache_builds += 1
        try:
            engine_revision = subprocess.check_output(
                ["git", "-C", str(root), "rev-parse", "HEAD"], text=True,
                stderr=subprocess.DEVNULL, timeout=5).strip()
        except (OSError, subprocess.SubprocessError):
            engine_revision = "unknown"
        self.metadata = {
            "engine": self.name,
            "device": str(upstream.device),
            "model_version": upstream.model_version,
            "engine_revision": engine_revision,
            "sample_rate": self.sample_rate,
            "model_gpt": str(paths["model_gpt"]),
            "model_sovits": str(paths["model_sovits"]),
            "reference_audio": str(self.reference_path),
            "reference_cache_builds": self.reference_cache_builds,
            "reference_cache_ms": (time.perf_counter() - cache_started) * 1000,
            "cpu_threads": torch.get_num_threads(),
            "nltk_data": str(nltk_data) if nltk_data else None,
            "semantic_tail_guard_frames": int(config.get("tail_guard_frames", 4)),
            "semantic_tail_guard_long_frames": int(config.get("long_tail_guard_frames", 6)),
        }

    def synthesize(self, text: str, cancellation: threading.Event) -> dict:
        import numpy as np

        chunks = split_sentences(text, int(self.config.get("max_chars", 24)))
        pieces = []
        started = time.perf_counter()
        upstream, torch = self.upstream, self.torch
        for chunk in chunks:
            self._check(cancellation)
            if chunk[-1] not in upstream.splits:
                chunk += "。"
            with torch.inference_mode():
                phones, bert, _ = upstream.get_phones_and_bert(chunk, self.language, upstream.version)
                if not phones:
                    raise ValueError("Japanese text frontend returned no phonemes")
                all_phones = torch.LongTensor(self.reference_phones + phones).to(upstream.device).unsqueeze(0)
                bert = torch.cat([self.reference_bert, bert], 1).to(upstream.device).unsqueeze(0)
                self._check(cancellation)
                semantic = infer_semantics(
                    upstream.t2s_model.model, all_phones, self.prompt, bert,
                    top_k=int(self.config.get("top_k", 20)),
                    top_p=float(self.config.get("top_p", 0.6)),
                    temperature=float(self.config.get("temperature", 0.6)),
                    max_tokens=upstream.hz * upstream.max_sec,
                    tail_frames=int(self.config.get("tail_guard_frames", 4)),
                    long_tail_frames=int(self.config.get("long_tail_guard_frames", 6)),
                    repetition_penalty=float(self.config.get("repetition_penalty", 1.35)),
                    check_cancel=lambda: self._check(cancellation))
                self._check(cancellation)
                kwargs = {"speed": float(self.config.get("speed", 1.0))}
                if self.speaker_embedding is not None:
                    kwargs["sv_emb"] = self.speaker_embedding
                audio = upstream.vq_model.decode(
                    semantic, torch.LongTensor(phones).to(upstream.device).unsqueeze(0),
                    self.reference_specs, **kwargs)[0][0].cpu().numpy()
                self._check(cancellation)
            # The cached path excludes upstream's 0.3s trailing zeros entirely.
            pieces.append(condition_pcm(
                audio, self.sample_rate, tail_padding_ms=0,
                pause_ms=float(self.config.get("pause_ms", 70)),
                lowpass_hz=float(self.config.get("lowpass_hz", 15000))))
        self._check(cancellation)
        result = encode_pcm(np.concatenate(pieces), self.sample_rate, self.name)
        result["synthesis_ms"] = (time.perf_counter() - started) * 1000
        result["chunk_count"] = len(chunks)
        result["reference_cache_builds"] = self.reference_cache_builds
        return result

    @staticmethod
    def _check(cancellation: threading.Event):
        if cancellation.is_set():
            raise SynthesisCancelled("Generation cancelled")
