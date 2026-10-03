from __future__ import annotations

import asyncio
import base64
import io
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch
import wave

import httpx

from services.agent.providers.stt import SttError, SttService, decode_payload, validate_audio


def wav_bytes(seconds=.25, rate=16000, channels=1):
    output = io.BytesIO()
    with wave.open(output, "wb") as source:
        source.setnchannels(channels)
        source.setsampwidth(2)
        source.setframerate(rate)
        source.writeframes(b"\0\0"*int(seconds*rate)*channels)
    return output.getvalue()


def payload(raw=None):
    return base64.b64encode(wav_bytes() if raw is None else raw).decode()


class AudioValidationTests(unittest.TestCase):
    def assert_code(self, code, callback):
        with self.assertRaises(SttError) as caught:
            callback()
        self.assertEqual(caught.exception.code, code)

    def test_wav_duration_from_actual_pcm(self):
        raw, mime = decode_payload(payload(wav_bytes(.5)), "audio/wav; codecs=pcm", 100000)
        self.assertEqual(mime, "audio/wav")
        self.assertAlmostEqual(validate_audio(raw, mime, 60), .5)

    def test_empty_and_invalid_base64_rejected(self):
        self.assert_code("empty_audio", lambda: decode_payload("", "audio/wav", 1000))
        self.assert_code("invalid_audio", lambda: decode_payload("no!", "audio/wav", 1000))

    def test_encoded_size_checked_before_decode(self):
        self.assert_code("audio_too_large", lambda: decode_payload("A"*1001, "audio/wav", 100))

    def test_mime_mismatch_rejected(self):
        self.assert_code("invalid_audio", lambda: decode_payload(payload(), "audio/webm", 100000))
        self.assert_code("unsupported_audio", lambda: decode_payload(payload(), "text/plain", 100000))

    def test_duration_limit_cannot_be_ignored(self):
        self.assert_code("audio_too_long", lambda: validate_audio(wav_bytes(1.5), "audio/wav", 1))

    def test_too_short_and_truncated_wav_rejected(self):
        self.assert_code("audio_too_short", lambda: validate_audio(wav_bytes(.1), "audio/wav", 60))
        self.assert_code("invalid_audio", lambda: validate_audio(wav_bytes()[:-100], "audio/wav", 60))

    def test_unsupported_wav_channels_rejected(self):
        self.assert_code("unsupported_audio", lambda: validate_audio(wav_bytes(channels=3), "audio/wav", 60))

    def test_compressed_recording_needs_real_decoder(self):
        with patch("services.agent.providers.stt.importlib.util.find_spec", return_value=None):
            self.assert_code("decoder_unavailable", lambda: validate_audio(b"\x1a\x45\xdf\xa3dummy", "audio/webm", 60))


class SttServiceTests(unittest.IsolatedAsyncioTestCase):
    async def test_disabled_service_never_calls_network(self):
        client = Mock()
        client.post = AsyncMock()
        service = SttService({"provider": "disabled"}, client=client)
        with self.assertRaises(SttError):
            await service.transcribe(payload(), "audio/wav")
        client.post.assert_not_called()
        self.assertFalse(service.status["ready"])
        await service.close()

    async def test_local_missing_dependency_never_falls_back_to_network(self):
        client = Mock()
        client.post = AsyncMock()
        service = SttService({"provider": "local"}, client=client)
        with patch("services.agent.providers.stt.importlib.util.find_spec", return_value=None):
            result = await service.start()
        self.assertEqual(result["state"], "unavailable")
        client.post.assert_not_called()
        await service.close()

    async def test_remote_requires_explicit_model_base_url_and_separate_key(self):
        with patch.dict(os.environ, {"AYANA_API_KEY": "llm-only"}, clear=True):
            service = SttService({"provider": "openai", "base_url": "https://stt.example/v1", "model": "speech"})
            self.assertFalse((await service.start())["ready"])
            self.assertIn("AYANA_STT_API_KEY", service.status["detail"])
            await service.close()

    async def test_explicit_remote_upload_and_chinese_transcript(self):
        requests = []
        def respond(request):
            requests.append(request)
            self.assertEqual(str(request.url), "https://stt.example/v1/audio/transcriptions")
            self.assertEqual(request.headers["Authorization"], "Bearer stt-only")
            self.assertIn(b"microphone.wav", request.content)
            return httpx.Response(200, json={"text": "请帮我看这个仓库"})
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            service = SttService({"provider": "openai", "base_url": "https://stt.example/v1", "model": "speech", "language": "zh"}, client=client)
            with patch.dict(os.environ, {"AYANA_STT_API_KEY": "stt-only"}):
                self.assertEqual(await service.transcribe(payload(), "audio/wav"), "请帮我看这个仓库")
            self.assertEqual(len(requests), 1)
            self.assertGreater(service.status["last_duration_s"], 0)
            await service.close()

    async def test_invalid_audio_is_rejected_before_remote_upload(self):
        client = Mock(post=AsyncMock())
        service = SttService({"provider": "openai"}, client=client)
        with self.assertRaises(SttError):
            await service.transcribe(payload(wav_bytes(.1)), "audio/wav")
        client.post.assert_not_called()
        await service.close()

    async def test_remote_error_does_not_echo_secrets_or_audio(self):
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda req: httpx.Response(400, text="stt-secret echoed by server"))) as client:
            service = SttService({"provider": "openai", "base_url": "https://stt.example/v1", "model": "speech"}, client=client)
            with patch.dict(os.environ, {"AYANA_STT_API_KEY": "stt-secret"}):
                with self.assertRaises(SttError) as caught:
                    await service.transcribe(payload(), "audio/wav")
            self.assertEqual(caught.exception.code, "remote_failed")
            self.assertNotIn("stt-secret", str(caught.exception))
            await service.close()

    async def test_empty_transcript_does_not_invent_speech(self):
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda req: httpx.Response(200, json={"text": " "}))) as client:
            service = SttService({"provider": "openai", "base_url": "https://stt.example/v1", "model": "speech"}, client=client)
            with patch.dict(os.environ, {"AYANA_STT_API_KEY": "key"}):
                with self.assertRaises(SttError) as caught:
                    await service.transcribe(payload(), "audio/wav")
            self.assertEqual(caught.exception.code, "no_speech")
            await service.close()

    async def test_packaged_weights_and_writable_model_root(self):
        with tempfile.TemporaryDirectory() as folder:
            project, model_root = Path(folder)/"backend", Path(folder)/"user-data"/".runtime"/"models"
            bundled = project/"models"/"stt"/"tiny"
            bundled.mkdir(parents=True)
            (bundled/"model.bin").write_bytes(b"owned test placeholder")
            with patch("services.agent.providers.stt.PROJECT", project):
                service = SttService({"model_root": str(model_root)})
                config, env = service._worker_config()
            self.assertEqual(Path(config["model_path"]), bundled)
            self.assertEqual(Path(config["cache_dir"]), model_root/"stt")
            self.assertEqual(Path(env["HF_HOME"]), model_root/"huggingface")
            await service.close()

    async def test_closed_service_rejects_transcription(self):
        service = SttService({"provider": "disabled"})
        await service.close()
        with self.assertRaises(SttError) as caught:
            await service.transcribe(payload(), "audio/wav")
        self.assertEqual(caught.exception.code, "closed")

    async def test_isolated_subprocess_flags_and_single_worker_protocol(self):
        process = Mock(returncode=None, pid=123)
        process.stdin = Mock(drain=AsyncMock())
        process.stdout = Mock(readline=AsyncMock(side_effect=[b'{"ready":true,"model":"tiny","cpu_threads":2}\n', '{"text":"こんにちは"}\n'.encode("utf-8")]))
        process.wait = AsyncMock(return_value=0)
        spawn = AsyncMock(return_value=process)
        with tempfile.TemporaryDirectory() as folder:
            service = SttService({"model_root": folder})
            with patch("services.agent.providers.stt.sys.flags", SimpleNamespace(isolated=1)), patch("services.agent.providers.stt.importlib.util.find_spec", return_value=object()), patch("services.agent.providers.stt.asyncio.create_subprocess_exec", spawn):
                await service.start()
                self.assertEqual(await service.transcribe(payload(), "audio/wav"), "こんにちは")
            self.assertEqual(spawn.call_args.args[1:4], ("-I", "-X", "utf8"))
            self.assertEqual(spawn.call_count, 1)
            await service.close()
            process.stdin.close.assert_called_once()

    async def test_cancelled_local_recognition_discards_worker(self):
        process = Mock(returncode=None, pid=123)
        process.stdin = Mock(drain=AsyncMock())
        process.wait = AsyncMock(return_value=0)
        service = SttService()
        service._status.update(ready=True, state="ready")
        service._process = process
        began = asyncio.Event()
        async def blocked():
            began.set()
            await asyncio.Future()
        service._read_worker = blocked
        task = asyncio.create_task(service.transcribe(payload(), "audio/wav"))
        await began.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertIsNone(service._process)
        self.assertFalse(service.status["ready"])
        process.stdin.close.assert_called_once()
        await service.close()


@unittest.skipUnless(os.environ.get("AYANA_STT_INTEGRATION") == "1", "Set AYANA_STT_INTEGRATION=1 with cached tiny weights and the real TTS benchmark sample")
class LocalSttIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_japanese_sample_with_cached_cpu_model(self):
        sample = Path(__file__).resolve().parents[1]/".runtime"/"benchmarks"/"tts"/"sample-1.wav"
        if not sample.is_file():
            self.skipTest("Run the actual Ayana TTS benchmark first")
        service = SttService({"provider": "local", "model": "tiny", "local_files_only": True, "language": "ja"})
        try:
            self.assertTrue((await service.start())["ready"], service.status["detail"])
            text = await service.transcribe(payload(sample.read_bytes()), "audio/wav")
            # Tiny is deliberately not treated as perfect recognition; verify
            # that the actual file-related speech traversed the local worker.
            self.assertIn("ファイル", text)
            self.assertGreater(service.status["last_duration_s"], 1)
        finally:
            await service.close()


if __name__ == "__main__":
    unittest.main()
