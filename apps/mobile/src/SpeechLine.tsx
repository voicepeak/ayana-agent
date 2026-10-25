import { useMemo } from 'react';
import type { Speech } from './types';
import { splitGraphemes } from './typography';

export function textFor(speech: Pick<Speech, 'ja' | 'zh' | 'en'>, language: string) {
  if (language === 'ja') return speech.ja;
  if (language === 'en') return speech.en || speech.zh || speech.ja;
  return speech.zh || speech.ja;
}
export function languageFor(speech: Pick<Speech, 'ja' | 'zh' | 'en'>, language: string) {
  return language === 'ja' ? 'ja' : language === 'en' && speech.en ? 'en' : speech.zh ? 'zh-CN' : 'ja';
}

export function SpeechLine({ speech, active, primary, translation }: {
  speech: Speech;
  active: boolean;
  primary: string;
  translation: string;
}) {
  const main = textFor(speech, primary);
  const candidate = translation !== 'none' && translation !== primary ? textFor(speech, translation) : '';
  const secondary = candidate !== main ? candidate : '';
  const progress = !active || speech.previewed || speech.state === 'played' || speech.state === 'partial' || !speech.audioEnabled
    ? 1
    : speech.total ? Math.min(1, Math.max(0, speech.played / speech.total)) : 0;
  const glyphs = useMemo(() => splitGraphemes(main), [main]);
  const shown = Math.round(glyphs.length * progress);
  return (
    <div className={`speech-line ${active ? 'is-active' : ''} ${speech.state === 'partial' ? 'is-partial' : ''}`}
         lang={languageFor(speech, primary)}>
      <p className="speech-main" aria-label={main}>
        {glyphs.map((glyph, index) => (
          <span key={index} className={index < shown ? 'is-shown' : ''}>{glyph}</span>
        ))}
      </p>
      {secondary && <p className="speech-secondary" lang={languageFor(speech, translation)}>{secondary}</p>}
      {speech.previewed && speech.state === 'generated' && <small className="speech-interrupted" role="status">语音准备中…</small>}
      {speech.state === 'partial' && <small className="speech-interrupted">已打断</small>}
    </div>
  );
}
