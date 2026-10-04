"""Bounded v2/v2Pro semantic decoding with a short sentence-final release.

The model can predict EOS while the vocoder still needs the final phoneme's
transition. Allow a few real continuation tokens once, then honor sampled EOS.
Do not stretch a minimum duration proportional to text: that invents speech.
"""
from __future__ import annotations


class SentenceRelease:
    def __init__(self, frames: int, long_frames: int | None = None):
        if not 0 <= frames <= 12:
            raise ValueError("Sentence release must be between 0 and 12 frames")
        self.frames = frames
        if long_frames is not None and not frames <= long_frames <= 12:
            raise ValueError("Long sentence release must be between base frames and 12")
        self.long_frames = long_frames
        self.first_eos: int | None = None

    def suppress_eos(self, index: int) -> bool:
        return self.first_eos is not None and index < self.first_eos + self.frames

    def finish(self, index: int) -> bool:
        if self.first_eos is None:
            self.first_eos = index
            if self.frames and self.long_frames is not None and index >= 20:
                self.frames = self.long_frames
            return self.frames == 0
        return not self.suppress_eos(index)


def infer_semantics(model, phones, prompt, bert, *, top_k: int, top_p: float,
                    temperature: float, max_tokens: int, tail_frames: int = 4,
                    long_tail_frames: int = 6,
                    repetition_penalty: float = 1.35, check_cancel=lambda: None,
                    sampler=None):
    """Return only generated codes; never send a length-limited prefix to audio."""
    import torch
    import torch.nn.functional as F

    if sampler is None:
        from AR.models.utils import sample as sampler
    release = SentenceRelease(tail_frames, max(tail_frames, long_tail_frames))
    text = model.ar_text_embedding(phones)
    text = model.ar_text_position(text + model.bert_proj(bert.transpose(1, 2)))
    codes = prompt
    prefix = prompt.shape[1]
    text_length = text.shape[1]
    audio = model.ar_audio_position(model.ar_audio_embedding(codes))
    position = torch.cat([text, audio], dim=1)
    text_mask = F.pad(torch.zeros((text_length, text_length), dtype=torch.bool),
                      (0, prefix), value=True)
    audio_mask = F.pad(torch.triu(torch.ones(prefix, prefix, dtype=torch.bool), diagonal=1),
                       (text_length, 0), value=False)
    length = text_length + prefix
    mask = (torch.cat([text_mask, audio_mask], dim=0).unsqueeze(0)
            .expand(text.shape[0] * model.num_head, -1, -1)
            .view(text.shape[0], model.num_head, length, length).to(text.device))
    keys = values = None
    sampling = dict(top_k=top_k, top_p=top_p, temperature=temperature,
                    repetition_penalty=repetition_penalty)
    for index in range(min(1500, max_tokens)):
        check_cancel()
        if index == 0:
            decoded, keys, values = model.t2s_transformer.process_prompt(position, mask, None)
        else:
            decoded, keys, values = model.t2s_transformer.decode_next_token(position, keys, values)
        logits = model.ar_predict_layer(decoded[:, -1])
        if index < 11 or release.suppress_eos(index):
            logits = logits[:, :-1]
        # The upstream sampler applies repetition penalties in place. Keep
        # untouched logits for the one resample at the first premature EOS.
        token = sampler(logits.clone(), codes, **sampling)[0]
        if token[0, 0].item() == model.EOS:
            if release.finish(index):
                generated = codes[:, prefix:]
                if generated.shape[1] == 0:
                    raise RuntimeError("Semantic inference returned no speech")
                return generated.unsqueeze(0)
            token = sampler(logits[:, :-1].clone(), codes, **sampling)[0]
        codes = torch.cat([codes, token], dim=1)
        embedding = model.ar_audio_embedding(codes[:, -1:])
        position = (embedding * model.ar_audio_position.x_scale
                    + model.ar_audio_position.alpha * model.ar_audio_position.pe[:, prefix + index]
                    .to(dtype=embedding.dtype, device=embedding.device))
    raise RuntimeError("语音模型在生成完整句尾前达到长度上限，请重试或缩短这句话。")
