# Welcome voice reactions

- `remember.wav`: retained Ayana greeting, extracted from the repository's
  generated `welcome/greeting.wav`, 0.00–3.50 seconds. Chinese caption:
  “记住了。以后就这么叫你。”
- `setting.wav`: generated with the configured local Ayana GPT-SoVITS voice.
  Spoken Japanese: “設定完了。” Chinese caption: “设定成功。”
- `champion.wav`: original game performance, extracted from the user's local
  `000ayana15th纯享.wav`, 00:10:26.320–00:10:29.320. The local transcript at
  `2_corpus/transcripts/000ayana15th纯享.segments.txt` identifies the line as
  “I'm humor champion.” This clip is not generated speech.

Rebuild the retained greeting with `scripts/build_welcome_snippets.py`.
Generate the setting reaction or extract the original completion recording with
`scripts/build_welcome_reactions.py`; pass the local source WAV using
`--game-recording`. Audio is converted to mono PCM16, normalized with bounded
gain, and given short edge fades. Pitch and speaking rate are unchanged.
