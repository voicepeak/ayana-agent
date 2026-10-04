from __future__ import annotations

import asyncio
import base64
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

try:
    import numpy as np
except ImportError:
    np = None

from services.tts.adapters.sovits import exhaust_loader
from services.tts.audio import condition_pcm, encode_pcm, split_sentences
from services.tts.service import TtsService


class AudioTests(unittest.TestCase):
    def test_generator_weights_load_to_completion(self):
        stages = []

        def loader():
            stages.append("loaded")
            yield {"ui": "update"}
            stages.append("recorded")

        exhaust_loader(loader())
        self.assertEqual(stages, ["loaded", "recorded"])
        exhaust_loader(None)

    def test_split_preserves_entire_long_japanese_text(self):
        text = "まず、入口のファイルから一緒に見ていこう。" + "長い説明" * 20 + "。"
        chunks = split_sentences(text, 24)
        self.assertEqual("".join(chunks), text)
        self.assertTrue(all(0 < len(chunk) <= 24 for chunk in chunks))

    @unittest.skipIf(np is None, "Run PCM checks with the isolated voice Python runtime")
    def test_only_known_padding_is_removed(self):
        # 100ms speech, 100ms natural silence, 300ms known upstream padding.
        pcm = np.concatenate([np.ones(3200) * 0.2, np.zeros(12800)])
        result = condition_pcm(pcm, 32000, tail_padding_ms=300, pause_ms=70, lowpass_hz=0)
        self.assertEqual(result.size, 8640)
        self.assertTrue(np.all(result[3200:] == 0))

    @unittest.skipIf(np is None, "Run PCM checks with the isolated voice Python runtime")
    def test_pcm_encoding_is_finite_mono_little_endian(self):
        source = np.array([0.1, -0.4, 0.5], dtype=np.float32)
        packet = encode_pcm(source, 32000, "test")
        self.assertEqual(packet["sample_count"], 3)
        np.testing.assert_array_equal(np.frombuffer(base64.b64decode(packet["pcm_base64"]), dtype="<f4"), source)
        with self.assertRaises(ValueError):
            condition_pcm(np.array([np.nan]), 32000)


class ServiceTests(unittest.IsolatedAsyncioTestCase):
    async def test_missing_worker_file_reports_stderr_and_exit_code(self):
        with tempfile.TemporaryDirectory() as directory:
            service = TtsService({"python": sys.executable})
            # Reproduce a portable runtime losing its extracted worker file.
            with patch("services.tts.service.__file__", str(Path(directory) / "service.py")):
                with self.assertLogs("services.tts.service", level="WARNING"):
                    with self.assertRaisesRegex(RuntimeError, "exit code 2.*can't open file"):
                        await service.start()
            self.assertEqual(service.status["state"], "failed")
            self.assertIn("worker.py", service.status["error"])
            self.assertIsNone(service.process)

    async def test_known_worker_failure_survives_cleanup_with_readable_guidance(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            message = "No installed Japanese System.Speech voice. Install a Japanese voice or configure Ayana GPT-SoVITS."
            (root / "worker.py").write_text(
                "import json,sys\nsys.stdin.readline()\n"
                "print(json.dumps(" + repr({"type": "state", "state": "failed", "error": message}) + "),flush=True)\n",
                encoding="utf-8")
            service = TtsService({"python": sys.executable})
            with patch("services.tts.service.__file__", str(root / "service.py")):
                with self.assertLogs("services.tts.service", level="WARNING") as logs:
                    with self.assertRaisesRegex(RuntimeError, "未安装日语系统语音"):
                        await service.start()
            self.assertEqual(service.status["state"], "failed")
            self.assertIn("GPT-SoVITS", service.status["error"])
            self.assertNotIn("exited unexpectedly", service.status["error"])
            self.assertIn("未安装日语系统语音", " ".join(logs.output))
            self.assertIsNone(service.process)

    async def test_stderr_is_drained_and_sensitive_progress_is_not_logged(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            key = "sk-testPrivateCredential12345"
            warmup = "この文章をログに保存しないで。"
            (root / "worker.py").write_text(
                "import sys\nsys.stdin.readline()\n"
                "sys.stderr.write(" + repr(warmup + "\nRuntimeError: missing model token " + key + "\n") + ")\n"
                "sys.stderr.flush()\nsys.exit(7)\n", encoding="utf-8")
            service = TtsService({"python": sys.executable, "warmup_text": warmup})
            with patch("services.tts.service.__file__", str(root / "service.py")):
                with self.assertLogs("services.tts.service", level="WARNING") as logs:
                    with self.assertRaisesRegex(RuntimeError, "exit code 7.*missing model"):
                        await service.start()
            output = " ".join(logs.output)
            self.assertNotIn(key, output)
            self.assertNotIn(warmup, output)
            self.assertNotIn(key, service.status["error"])
            self.assertIn("[redacted]", service.status["error"])

    async def test_real_subprocess_lifecycle_with_explicit_silent_mode(self):
        service = TtsService({"voice_mode": "silent", "python": sys.executable})
        try:
            await service.start()
            self.assertEqual(service.status["state"], "ready")
            self.assertIsNotNone(service.process)
            packet = await service.synthesize("こんにちは。", 1)
            self.assertEqual(packet["engine"], "silent")
            self.assertEqual(packet["sample_count"], 0)
            await service.cancel(1)
            with self.assertRaises(asyncio.CancelledError):
                await service.synthesize("再生してはいけない。", 1)
            await service.synthesize("新しい世代。", 2)
        finally:
            await service.close()
        self.assertEqual(service.status["state"], "stopped")

    async def test_cancel_discards_late_inference_without_waiting_for_compute(self):
        service = TtsService({})
        service.process = type("Process", (), {"returncode": None})()
        service._send = AsyncMock()
        task = asyncio.create_task(service.synthesize("遅い文章。", 9))
        await asyncio.sleep(0)
        self.assertEqual(len(service._pending), 1)
        _, pending = next(iter(service._pending.values()))
        await service.cancel(9)
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(pending.cancelled())
        self.assertFalse(service._pending)
        # The new generation is free to queue even while old compute unwinds.
        next_task = asyncio.create_task(service.synthesize("新しい文章。", 10))
        await asyncio.sleep(0)
        _, next_future = next(iter(service._pending.values()))
        next_future.set_result({"generation_id": 10, "engine": "test"})
        self.assertEqual((await next_task)["generation_id"], 10)
        service.process = None


if __name__ == "__main__":
    unittest.main()
