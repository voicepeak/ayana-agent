import unittest
from types import SimpleNamespace

from services.tts.semantics import SentenceRelease, infer_semantics

try:
    import torch
except ImportError:
    torch = None


class SentenceReleaseTests(unittest.TestCase):
    def test_release_is_once_and_bounded(self):
        release = SentenceRelease(6)
        self.assertFalse(release.suppress_eos(20))
        self.assertFalse(release.finish(20))
        self.assertTrue(release.suppress_eos(25))
        self.assertFalse(release.suppress_eos(26))
        self.assertTrue(release.finish(26))
        self.assertTrue(release.finish(27))
        self.assertTrue(SentenceRelease(0).finish(20))
        with self.assertRaises(ValueError):
            SentenceRelease(100)

    def test_longer_speech_gets_a_small_additional_release(self):
        short = SentenceRelease(4, 6)
        self.assertFalse(short.finish(13))
        self.assertTrue(short.finish(17))
        longer = SentenceRelease(4, 6)
        self.assertFalse(longer.finish(30))
        self.assertTrue(longer.suppress_eos(35))
        self.assertTrue(longer.finish(36))


@unittest.skipIf(torch is None, "Run decoder checks in the isolated voice Python")
class SemanticDecoderTests(unittest.TestCase):
    def model(self):
        class Position:
            x_scale = 1
            alpha = 0
            pe = torch.zeros(1, 100, 1)
            def __call__(self, value):
                return value
        def embedding(value):
            return value.float().unsqueeze(-1)
        transformer = SimpleNamespace(
            process_prompt=lambda *args: (torch.zeros(1, 1, 1), None, None),
            decode_next_token=lambda *args: (torch.zeros(1, 1, 1), None, None))
        return SimpleNamespace(
            EOS=3, num_head=1, ar_text_embedding=embedding,
            bert_proj=lambda value: value, ar_text_position=Position(),
            ar_audio_embedding=embedding, ar_audio_position=Position(),
            t2s_transformer=transformer,
            ar_predict_layer=lambda value: torch.tensor([[0., 0., 0., 9.]]))

    def run_decoder(self, **options):
        def sampler(logits, previous, **kwargs):
            return torch.tensor([[3 if logits.shape[1] == 4 else 1]]), None
        return infer_semantics(
            self.model(), torch.ones(1, 3, dtype=torch.long),
            torch.full((1, 2), 99, dtype=torch.long), torch.zeros(1, 1, 3),
            top_k=20, top_p=.6, temperature=.6, max_tokens=options.pop('max_tokens', 30),
            sampler=options.pop('sampler', sampler), **options)

    def test_final_transition_tokens_survive_without_reference_or_eos(self):
        generated = self.run_decoder(tail_frames=6)
        self.assertEqual(tuple(generated.shape), (1, 1, 17))
        self.assertTrue(torch.all(generated == 1))
        self.assertEqual(self.run_decoder(tail_frames=0).shape[-1], 11)

    def test_argmax_eos_does_not_discard_a_sampled_speech_token(self):
        calls = 0
        def sampler(logits, previous, **kwargs):
            nonlocal calls
            calls += 1
            return torch.tensor([[3 if calls == 14 else 1]]), None
        generated = self.run_decoder(tail_frames=0, sampler=sampler)
        self.assertEqual(generated.shape[-1], 13)

    def test_limit_reports_failure_instead_of_playing_an_incomplete_prefix(self):
        with self.assertRaisesRegex(RuntimeError, "长度上限"):
            self.run_decoder(max_tokens=17, tail_frames=6)

    def test_cancel_is_checked_inside_semantic_generation(self):
        class Cancelled(Exception):
            pass
        checks = 0
        def cancel():
            nonlocal checks
            checks += 1
            if checks == 5:
                raise Cancelled()
        with self.assertRaises(Cancelled):
            self.run_decoder(check_cancel=cancel)
        self.assertEqual(checks, 5)


if __name__ == '__main__':
    unittest.main()
